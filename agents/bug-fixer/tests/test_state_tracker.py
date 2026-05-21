import json
import os
import pytest
from bug_fixer_agent.state_tracker import StateTracker


@pytest.fixture
def state_file(tmp_path):
    return str(tmp_path / "state.json")


def test_get_creates_pending_entry(state_file):
    st = StateTracker(state_file)
    entry = st.get("issue-1")
    assert entry["status"] == "pending"
    assert entry["repo"] is None


def test_get_persists_to_disk(state_file):
    st = StateTracker(state_file)
    st.get("issue-1")
    with open(state_file) as f:
        data = json.load(f)
    assert "issue-1" in data


def test_update_merges_fields(state_file):
    st = StateTracker(state_file)
    st.update("issue-1", status="routed", repo="plane", repo_path="/devstack/plane")
    entry = st.get("issue-1")
    assert entry["status"] == "routed"
    assert entry["repo"] == "plane"


def test_update_atomic_write(state_file, mocker):
    st = StateTracker(state_file)
    st.get("issue-1")  # pre-create so update() doesn't trigger an extra _save()
    replace_calls = []
    original_replace = os.replace

    def spy_replace(src, dst):
        replace_calls.append((src, dst))
        return original_replace(src, dst)

    mocker.patch("os.replace", side_effect=spy_replace)
    st.update("issue-1", status="routed")
    assert len(replace_calls) == 1
    src, dst = replace_calls[0]
    assert src.endswith(".tmp")
    assert dst == st._path


def test_is_done(state_file):
    st = StateTracker(state_file)
    assert not st.is_done("issue-1")
    st.update("issue-1", status="done")
    assert st.is_done("issue-1")


def test_mark_failed_and_reset(state_file):
    st = StateTracker(state_file)
    st.update("issue-1", status="routed")
    st.mark_failed("issue-1", error="subprocess timeout")
    assert st.is_failed("issue-1")
    assert st.get("issue-1")["error"] == "subprocess timeout"

    st.reset_failed("issue-1")
    assert st.get("issue-1")["status"] == "routed"
    assert st.get("issue-1")["error"] is None


def test_resume_from_returns_current_step(state_file):
    st = StateTracker(state_file)
    st.update("issue-1", status="test_written")
    assert st.resume_from("issue-1") == "test_written"


def test_state_survives_reload(state_file):
    st = StateTracker(state_file)
    st.update("issue-1", status="pr_opened", pr_url="https://github.com/pr/1")

    st2 = StateTracker(state_file)
    entry = st2.get("issue-1")
    assert entry["status"] == "pr_opened"
    assert entry["pr_url"] == "https://github.com/pr/1"
