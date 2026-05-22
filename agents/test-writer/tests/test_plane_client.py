import pytest
import respx
import httpx
from test_writer_agent.plane_client import PlaneClient, PlaneError, BUG_LABEL_ID

BASE = "https://plane.example.com"
SLUG = "testslug"
TOKEN = "test-token"
PROJECT = "proj-uuid"


@pytest.fixture
def client():
    return PlaneClient(BASE, SLUG, TOKEN)


def _issue(
    id="issue-1",
    name="Normal issue",
    labels=None,
    completed_at=None,
    archived_at=None,
    is_draft=False,
    description_html="",
):
    return {
        "id": id,
        "name": name,
        "labels": labels or [],
        "completed_at": completed_at,
        "archived_at": archived_at,
        "is_draft": is_draft,
        "description_html": description_html,
    }


def _page(results, next_page=False, next_cursor="1000:1:0"):
    return {
        "results": results,
        "next_page_results": next_page,
        "next_cursor": next_cursor,
    }


# ------------------------------------------------------------------
# _is_bug
# ------------------------------------------------------------------

def test_is_bug_by_label(client):
    issue = _issue(labels=[BUG_LABEL_ID])
    assert client._is_bug(issue)


def test_is_bug_by_name_prefix(client):
    assert client._is_bug(_issue(name="[Bug] Something broken"))
    assert client._is_bug(_issue(name="[bug] lowercase"))
    assert not client._is_bug(_issue(name="Feature request"))


def test_is_bug_by_name_and_label(client):
    issue = _issue(name="[Bug] Also labelled", labels=[BUG_LABEL_ID])
    assert client._is_bug(issue)


# ------------------------------------------------------------------
# _is_open
# ------------------------------------------------------------------

def test_is_open_default(client):
    assert client._is_open(_issue())


def test_is_open_completed_false(client):
    assert not client._is_open(_issue(completed_at="2026-05-01T00:00:00Z"))


def test_is_open_archived_false(client):
    assert not client._is_open(_issue(archived_at="2026-05-01T00:00:00Z"))


def test_is_open_draft_false(client):
    assert not client._is_open(_issue(is_draft=True))


# ------------------------------------------------------------------
# list_open_bug_issues — paginated
# ------------------------------------------------------------------

@respx.mock
def test_list_open_bug_issues_single_page(client):
    bugs = [
        _issue("b1", "[Bug] crash on login"),
        _issue("b2", "bug report", labels=[BUG_LABEL_ID]),
    ]
    non_bug = _issue("n1", "Regular task")

    respx.get(f"{BASE}/api/v1/workspaces/{SLUG}/projects/{PROJECT}/issues/").mock(
        return_value=httpx.Response(200, json=_page(bugs + [non_bug]))
    )

    results = client.list_open_bug_issues(PROJECT)
    assert len(results) == 2
    assert {r["id"] for r in results} == {"b1", "b2"}


@respx.mock
def test_list_open_bug_issues_pagination(client):
    page1 = _page(
        [_issue("b1", "[Bug] first")],
        next_page=True,
        next_cursor="1000:1:0",
    )
    page2 = _page([_issue("b2", "[Bug] second")])

    call_count = 0

    def side_effect(request):
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json=page1 if call_count == 1 else page2)

    respx.get(f"{BASE}/api/v1/workspaces/{SLUG}/projects/{PROJECT}/issues/").mock(
        side_effect=side_effect
    )
    results = client.list_open_bug_issues(PROJECT)
    assert len(results) == 2
    assert call_count == 2


# ------------------------------------------------------------------
# post_comment
# ------------------------------------------------------------------

@respx.mock
def test_post_comment(client):
    url = f"{BASE}/api/v1/workspaces/{SLUG}/projects/{PROJECT}/issues/issue-1/comments/"
    respx.post(url).mock(return_value=httpx.Response(201, json={"id": "comment-1"}))

    result = client.post_comment(PROJECT, "issue-1", "Bug confirmed in twenty repo.")
    assert result["id"] == "comment-1"


# ------------------------------------------------------------------
# create_child_issue
# ------------------------------------------------------------------

@respx.mock
def test_create_child_issue(client):
    url = f"{BASE}/api/v1/workspaces/{SLUG}/projects/{PROJECT}/issues/"
    respx.post(url).mock(return_value=httpx.Response(201, json={"id": "child-1"}))

    result = client.create_child_issue(PROJECT, "parent-1", "Fix crash", "Implement fix")
    assert result["id"] == "child-1"


# ------------------------------------------------------------------
# Error handling
# ------------------------------------------------------------------

@respx.mock
def test_raises_plane_error_on_401(client):
    respx.get(f"{BASE}/api/v1/workspaces/{SLUG}/projects/{PROJECT}/issues/").mock(
        return_value=httpx.Response(401, json={"detail": "unauthorized"})
    )
    with pytest.raises(PlaneError, match="401"):
        client.list_open_bug_issues(PROJECT)


@respx.mock
def test_retries_on_500(client):
    call_count = 0

    def flaky(request):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            return httpx.Response(500, text="server error")
        return httpx.Response(200, json=_page([]))

    respx.get(f"{BASE}/api/v1/workspaces/{SLUG}/projects/{PROJECT}/issues/").mock(
        side_effect=flaky
    )
    results = client.list_open_bug_issues(PROJECT)
    assert results == []
    assert call_count == 3


# ------------------------------------------------------------------
# plain_description
# ------------------------------------------------------------------

def test_plain_description_strips_html():
    issue = _issue(description_html="<h4><strong>Steps:</strong></h4><p>Click login.</p>")
    result = PlaneClient.plain_description(issue)
    assert "<" not in result
    assert "Steps" in result
    assert "Click login" in result
