from __future__ import annotations

import argparse
import logging
import os
import sys

from test_writer_agent.config import load, Config
from test_writer_agent.plane_client import PlaneClient
from test_writer_agent.state_tracker import StateTracker
from test_writer_agent.subagents import (
    BugNotReproducible,
    SubagentError,
    verify_test_fails,
    write_reproduction_test,
)

log = logging.getLogger(__name__)

# Agent lives inside the e2e repo; the e2e root is four levels up from
# this file (test_writer_agent → src → test-writer → agents → repo root).
E2E_REPO_PATH_DEFAULT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Test-writer agent — turns Plane bugs into Playwright reproductions")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed issues")
    parser.add_argument("--issue-id", help="Process a single issue by ID (for testing)")
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="List open Plane bugs and exit. Only PLANE_* env vars required.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing tests/bugs/bug_<id>.spec.ts. Without this, the agent "
             "skips bugs whose reproduction test is already on disk.",
    )
    args = parser.parse_args()

    if args.list_only:
        logging.basicConfig(
            level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO")),
            format="%(asctime)s %(levelname)s %(message)s",
        )
        sys.exit(list_only())

    cfg = load()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    run(
        cfg,
        retry_failed=args.retry_failed,
        only_issue=args.issue_id,
        force=args.force,
    )


def list_only() -> int:
    """Fetch open bugs from Plane and print them. Returns exit code."""
    required = ["PLANE_API_TOKEN", "PLANE_BASE_URL", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_ID"]
    values = {k: os.environ.get(k, "").strip() for k in required}
    missing = [k for k, v in values.items() if not v]
    if missing:
        print(f"Missing required env vars: {', '.join(missing)}", file=sys.stderr)
        return 2

    plane = PlaneClient(
        values["PLANE_BASE_URL"], values["PLANE_WORKSPACE_SLUG"], values["PLANE_API_TOKEN"]
    )
    issues = plane.list_open_bug_issues(values["PLANE_PROJECT_ID"])
    if not issues:
        print("No open bug issues found.")
        return 0

    print(f"{len(issues)} open bug issue(s):\n")
    width = len(str(len(issues)))
    for idx, issue in enumerate(issues, start=1):
        seq = issue.get("sequence_id")
        seq_label = f"FOSSSMBBUN-{seq}" if seq is not None else "(no seq)"
        title = (issue.get("name") or "").strip()
        print(f"  [{idx:>{width}}]  {seq_label:<16}  {title[:110]}")
    return 0


def run(
    cfg: Config,
    retry_failed: bool = False,
    only_issue: str | None = None,
    force: bool = False,
) -> None:
    plane = PlaneClient(cfg.plane_base_url, cfg.plane_workspace_slug, cfg.plane_api_token)
    state = StateTracker(cfg.state_file_path)
    e2e_path = os.path.realpath(E2E_REPO_PATH_DEFAULT)

    log.info("Fetching open bug issues from Plane...")
    issues = plane.list_open_bug_issues(cfg.plane_project_id)
    log.info(f"Found {len(issues)} open bug issues")

    for issue in issues:
        issue_id = issue["id"]

        if only_issue and issue_id != only_issue:
            continue
        if state.is_done(issue_id):
            log.info(f"[{issue_id[:8]}] already done, skipping")
            continue
        if state.is_failed(issue_id):
            if retry_failed:
                state.reset_failed(issue_id)
            else:
                log.warning(f"[{issue_id[:8]}] failed on previous run, skipping (use --retry-failed)")
                continue

        existing_test = os.path.join(e2e_path, "tests", "bugs", f"bug_{issue_id[:8]}.spec.ts")
        if os.path.exists(existing_test) and not force and not retry_failed:
            log.info(
                f"[{issue_id[:8]}] reproduction test already exists at {existing_test} — "
                f"skipping (pass --force to overwrite)"
            )
            continue

        log.info(f"[{issue_id[:8]}] processing: {issue['name'][:60]}")
        _process_issue(issue, cfg, state, e2e_path)


def _process_issue(
    issue: dict,
    cfg: Config,
    state: StateTracker,
    e2e_path: str,
) -> None:
    issue_id = issue["id"]
    title = issue["name"]
    description = PlaneClient.plain_description(issue)

    resume_from = state.resume_from(issue_id)

    # ── Step 1: write reproduction test ────────────────────────────────
    if resume_from == "pending":
        try:
            test_path = write_reproduction_test(issue_id, title, description, e2e_path)
            state.update(issue_id, status="test_written", test_path=test_path)
            log.info(f"[{issue_id[:8]}] test written: {test_path}")
        except SubagentError as e:
            state.mark_failed(issue_id, f"test_writer: {e}")
            log.error(f"[{issue_id[:8]}] test writer failed: {e}")
            return

    test_path = state.get(issue_id)["test_path"]

    # ── Step 2: verify the test reproduces the bug ─────────────────────
    # Two attempts to better catch intermittent bugs without burning
    # tokens on the test-writing step.
    attempts = 2
    try:
        output = _verify_with_retries(
            test_path, e2e_path, cfg.foss_user, cfg.foss_pass, attempts, issue_id
        )
        log.info(f"[{issue_id[:8]}] bug confirmed — test fails as expected")
        state.update(issue_id, status="done", _verification_output=output[:500])
        log.info(f"[{issue_id[:8]}] done. test path: {test_path}")
    except BugNotReproducible:
        # Stay at `test_written` so the user can iterate on the test
        # (adjust loop count, fix selectors, etc.) and re-run.
        log.warning(
            f"[{issue_id[:8]}] test passed {attempts}/{attempts} attempts — "
            f"bug not reproduced. Test path: {test_path}. State left at 'test_written' "
            f"for iteration; pass --force to regenerate the test."
        )
    except SubagentError as e:
        state.mark_failed(issue_id, f"verify: {e}")
        log.error(f"[{issue_id[:8]}] verification infra error: {e}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _verify_with_retries(
    test_path: str,
    e2e_path: str,
    foss_user: str,
    foss_pass: str,
    attempts: int,
    issue_id: str,
) -> str:
    """Run verify_test_fails up to `attempts` times.
    Returns output on the first attempt that fails (= bug reproduced).
    Raises BugNotReproducible if all attempts passed.
    Raises SubagentError immediately (infrastructure issues don't benefit from retry).
    """
    last_exc: BugNotReproducible | None = None
    for i in range(1, attempts + 1):
        try:
            return verify_test_fails(test_path, e2e_path, foss_user, foss_pass)
        except BugNotReproducible as e:
            last_exc = e
            if i < attempts:
                log.info(
                    f"[{issue_id[:8]}] verify attempt {i}/{attempts}: "
                    f"test passed (bug not reproduced) — retrying"
                )
    assert last_exc is not None  # by loop structure
    raise last_exc
