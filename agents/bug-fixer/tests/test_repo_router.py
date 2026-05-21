import pytest
from bug_fixer_agent.repo_router import _keyword_route, route, RoutingError, RouteResult


def _issue(name, desc=""):
    return {"name": name, "description_html": f"<p>{desc}</p>"}


# ------------------------------------------------------------------
# Keyword routing
# ------------------------------------------------------------------

def test_routes_twenty_by_name():
    assert _keyword_route("bug in twenty app crm login") == "twenty"


def test_routes_plane_by_name():
    assert _keyword_route("plane pm issue tracker broken") == "plane"


def test_routes_outline_by_name():
    assert _keyword_route("outline docs wiki page not loading") == "outline"


def test_routes_penpot_by_name():
    assert _keyword_route("penpot design tool canvas error") == "penpot"


def test_routes_surfsense_by_name():
    assert _keyword_route("surfsense research tab broken") == "SurfSense"


def test_routes_sso_by_session_keywords():
    text = "after re-login all service apps retain previous user session"
    assert _keyword_route(text) == "sso-rules-moneta"


def test_routes_sso_by_logout_keywords():
    assert _keyword_route("log out of all apps cookie not cleared") == "sso-rules-moneta"


def test_sso_wins_tie_over_twenty():
    # Session bug in twenty — SSO should win the tie
    text = "twenty app session not cleared after logout sso cookie"
    result = _keyword_route(text)
    assert result == "sso-rules-moneta"


def test_returns_none_for_no_match():
    assert _keyword_route("completely unrelated text about databases") is None


# ------------------------------------------------------------------
# route() integration (no LLM, keyword only)
# ------------------------------------------------------------------

def test_route_returns_result(tmp_path):
    # Create a fake devstack dir with a twenty subdir
    twenty_dir = tmp_path / "twenty"
    twenty_dir.mkdir()
    (twenty_dir / ".git").mkdir()

    issue = _issue("[Bug] Twenty CRM crashes on login")
    result = route(issue, str(tmp_path))
    assert result.repo_name == "twenty"
    assert result.repo_path.endswith("twenty")


def test_route_returns_sso_for_session_bug(tmp_path):
    (tmp_path / "sso-rules-moneta").mkdir()
    issue = _issue("[Bug] session persists after logout in all apps")
    result = route(issue, str(tmp_path))
    assert result.repo_name == "sso-rules-moneta"
