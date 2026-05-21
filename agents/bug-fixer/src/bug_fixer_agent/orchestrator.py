from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys

from bug_fixer_agent.config import load, Config
from bug_fixer_agent.gh_client import GHClient, branch_name_for_issue, pr_body
from bug_fixer_agent.plane_client import PlaneClient
from bug_fixer_agent.repo_router import route, RoutingError, GITHUB_URLS
from bug_fixer_agent.state_tracker import StateTracker
from bug_fixer_agent.subagents import (
    BugNotReproducible,
    SubagentError,
    verify_test_fails,
    write_fix,
    write_reproduction_test,
)

log = logging.getLogger(__name__)

# Agent now lives inside the e2e repo; the e2e root is four levels up
# from this file (bug_fixer_agent → src → bug-fixer → agents → repo root).
E2E_REPO_PATH_DEFAULT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily bug-fixer agent")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed issues")
    parser.add_argument("--dry-run", action="store_true", help="Stop before pushing PRs")
    parser.add_argument("--issue-id", help="Process a single issue by ID (for testing)")
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="List open Plane bugs (with keyword-routed repo) and exit. "
             "Skips test/fix/PR steps. Only PLANE_* env vars required.",
    )
    parser.add_argument(
        "--test-only",
        action="store_true",
        help="Stop after the reproduction test runs (no fix, no PR, no Plane comment). "
             "Useful for sanity-checking that a bug is reproducible locally.",
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
        dry_run=args.dry_run,
        only_issue=args.issue_id,
        test_only=args.test_only,
    )


def list_only() -> int:
    """Fetch open bugs from Plane and print them with keyword-routed repo. Returns exit code."""
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
    dry_run: bool = False,
    only_issue: str | None = None,
    test_only: bool = False,
) -> None:
    plane = PlaneClient(cfg.plane_base_url, cfg.plane_workspace_slug, cfg.plane_api_token)
    gh = GHClient(cfg.github_token)
    state = StateTracker(cfg.state_file_path)
    e2e_path = os.path.realpath(E2E_REPO_PATH_DEFAULT)

    _ensure_repos_cloned(cfg.devstack_path)

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

        log.info(f"[{issue_id[:8]}] processing: {issue['name'][:60]}")
        _process_issue(issue, cfg, state, plane, gh, e2e_path, dry_run, test_only)


def _process_issue(
    issue: dict,
    cfg: Config,
    state: StateTracker,
    plane: PlaneClient,
    gh: GHClient,
    e2e_path: str,
    dry_run: bool,
    test_only: bool = False,
) -> None:
    issue_id = issue["id"]
    title = issue["name"]
    description = PlaneClient.plain_description(issue)
    plane_issue_url = (
        f"{cfg.plane_base_url}/{cfg.plane_workspace_slug}"
        f"/projects/{cfg.plane_project_id}/issues/{issue_id}/"
    )

    entry = state.get(issue_id)
    resume_from = state.resume_from(issue_id)

    # ── Step 1: route ──────────────────────────────────────────────────
    if resume_from == "pending":
        try:
            result = route(issue, cfg.devstack_path)
            state.update(issue_id, status="routed", repo=result.repo_name, repo_path=result.repo_path)
            entry = state.get(issue_id)
            log.info(f"[{issue_id[:8]}] routed to {result.repo_name}")
        except RoutingError as e:
            state.mark_failed(issue_id, str(e))
            log.error(f"[{issue_id[:8]}] routing failed: {e}")
            return

    repo_name = entry["repo"]
    repo_path = entry["repo_path"]

    # ── Step 2: write reproduction test ────────────────────────────────
    if resume_from in ("pending", "routed"):
        try:
            test_path = write_reproduction_test(issue_id, title, description, e2e_path)
            state.update(issue_id, status="test_written", test_path=test_path)
            log.info(f"[{issue_id[:8]}] test written: {test_path}")
        except SubagentError as e:
            state.mark_failed(issue_id, f"test_writer: {e}")
            log.error(f"[{issue_id[:8]}] test writer failed: {e}")
            return

    test_path = state.get(issue_id)["test_path"]

    # ── Step 3: verify test fails (bug reproduced) ─────────────────────
    if resume_from in ("pending", "routed", "test_written"):
        # --test-only retries twice to better catch intermittent bugs.
        attempts = 2 if test_only else 1
        try:
            output = _verify_with_retries(
                test_path, e2e_path, cfg.foss_user, cfg.foss_pass, attempts, issue_id
            )
            log.info(f"[{issue_id[:8]}] bug confirmed — test fails as expected")
            state.update(issue_id, status="test_written", _verification_output=output[:500])
        except BugNotReproducible as e:
            if test_only:
                # Iteration mode: no Plane comment, no state advance.
                # User can re-run after adjusting the test (e.g., loop count).
                log.warning(
                    f"[{issue_id[:8]}] --test-only: test passed {attempts}/{attempts} attempt(s) "
                    f"(bug not reproduced this run). No Plane comment, no state change."
                )
                log.warning(f"[{issue_id[:8]}] test path: {test_path}")
                return
            log.warning(f"[{issue_id[:8]}] cannot reproduce — commenting on issue")
            _comment_not_reproducible(plane, cfg.plane_project_id, issue_id, test_path, str(e))
            state.update(issue_id, status="done")
            return
        except SubagentError as e:
            state.mark_failed(issue_id, f"verify: {e}")
            log.error(f"[{issue_id[:8]}] verification infra error: {e}")
            return

    if test_only:
        log.info(f"[{issue_id[:8]}] --test-only: stopping after test verification")
        log.info(f"[{issue_id[:8]}] test path: {test_path}")
        return

    # ── Step 4: write fix ──────────────────────────────────────────────
    if resume_from in ("pending", "routed", "test_written"):
        try:
            fix_paths = write_fix(issue_id, title, description, repo_name, repo_path, test_path)
            state.update(issue_id, status="fix_written", fix_paths=fix_paths)
            log.info(f"[{issue_id[:8]}] fix written: {fix_paths}")
        except SubagentError as e:
            state.mark_failed(issue_id, f"fix_agent: {e}")
            log.error(f"[{issue_id[:8]}] fix agent failed: {e}")
            return

    fix_paths = state.get(issue_id)["fix_paths"]

    if dry_run:
        log.info(f"[{issue_id[:8]}] dry-run: stopping before PR")
        return

    # ── Step 5: open PR ────────────────────────────────────────────────
    if resume_from in ("pending", "routed", "test_written", "fix_written"):
        branch = branch_name_for_issue(issue_id, repo_name)
        pr_url = gh.get_pr_url_for_branch(repo_path, branch)

        if not pr_url:
            try:
                # Also commit the test file into the e2e repo as a separate PR
                _open_test_pr(gh, e2e_path, issue_id, repo_name, test_path, title, plane_issue_url)

                if not gh.branch_exists_on_remote(repo_path, branch):
                    gh.create_branch(repo_path, branch)

                commit_msg = f"fix: {title[:72]} (Plane #{issue_id[:8]})"
                gh.commit_files(repo_path, fix_paths, commit_msg)
                gh.push_branch(repo_path, branch)

                body = pr_body(issue_id, title, test_path, plane_issue_url)
                pr_url = gh.open_pr(repo_path, branch, f"[Bug Fix] {title[:60]}", body)
                log.info(f"[{issue_id[:8]}] PR opened: {pr_url}")
            except Exception as e:
                state.mark_failed(issue_id, f"pr: {e}")
                log.error(f"[{issue_id[:8]}] PR failed: {e}")
                return

        state.update(issue_id, status="pr_opened", pr_url=pr_url, pr_branch=branch)

    pr_url = state.get(issue_id)["pr_url"]

    # ── Step 6: comment on Plane issue ─────────────────────────────────
    if resume_from in ("pending", "routed", "test_written", "fix_written", "pr_opened"):
        if not state.get(issue_id).get("comment_id"):
            try:
                comment_body = (
                    f"**Bug confirmed and fix submitted.**\n\n"
                    f"- Reproduction test: `{test_path}`\n"
                    f"- Fix PR: {pr_url}\n\n"
                    f"The test fails against https://foss.arbisoft.com, confirming the issue is reproducible."
                )
                comment = plane.post_comment(cfg.plane_project_id, issue_id, comment_body)
                state.update(issue_id, status="commented", comment_id=comment.get("id"))
                log.info(f"[{issue_id[:8]}] commented on Plane issue")
            except Exception as e:
                state.mark_failed(issue_id, f"comment: {e}")
                log.error(f"[{issue_id[:8]}] comment failed: {e}")
                return

    # ── Step 7: create sub-task ────────────────────────────────────────
    if not state.get(issue_id).get("sub_task_id"):
        try:
            sub = plane.create_child_issue(
                cfg.plane_project_id,
                issue_id,
                title=f"Fix: {title[:80]}",
                description=f"Fix PR: {pr_url}\nTest: {test_path}",
            )
            state.update(issue_id, status="done", sub_task_id=sub.get("id"))
            log.info(f"[{issue_id[:8]}] sub-task created, marking done")
        except Exception as e:
            state.mark_failed(issue_id, f"subtask: {e}")
            log.error(f"[{issue_id[:8]}] sub-task failed: {e}")
            return

    state.update(issue_id, status="done")
    log.info(f"[{issue_id[:8]}] done")


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


def _comment_not_reproducible(
    plane: PlaneClient, project_id: str, issue_id: str, test_path: str, reason: str
) -> None:
    body = (
        f"**Could not reproduce this bug against https://foss.arbisoft.com.**\n\n"
        f"A Playwright test was written at `{test_path}` but it passed, "
        f"meaning the described behavior was not observed.\n\n"
        f"Please verify the steps to reproduce and re-open or add more detail."
    )
    try:
        plane.post_comment(project_id, issue_id, body)
    except Exception as e:
        log.warning(f"Could not post non-reproducible comment: {e}")


def _open_test_pr(
    gh: GHClient,
    e2e_path: str,
    issue_id: str,
    repo_name: str,
    test_path: str,
    title: str,
    plane_issue_url: str,
) -> None:
    branch = f"bug-test/plane-{issue_id[:8]}"
    if gh.branch_exists_on_remote(e2e_path, branch):
        return
    gh.create_branch(e2e_path, branch)
    gh.commit_files(e2e_path, [test_path], f"test: add reproduction test for {title[:60]}")
    gh.push_branch(e2e_path, branch)
    body = (
        f"## Reproduction test for bug\n\n"
        f"**Plane issue:** {plane_issue_url}\n\n"
        f"This test reproduces the bug and currently fails against "
        f"https://foss.arbisoft.com.\n\n"
        f"---\n_Generated by the bug-fixer agent._"
    )
    gh.open_pr(e2e_path, branch, f"[Bug Test] {title[:60]}", body)


def _ensure_repos_cloned(devstack_path: str) -> None:
    for repo_name, clone_url in GITHUB_URLS.items():
        if repo_name == "sso-rules-moneta":
            continue
        repo_path = os.path.join(devstack_path, repo_name)
        if not os.path.isdir(os.path.join(repo_path, ".git")):
            log.info(f"Cloning {repo_name}...")
            subprocess.run(
                ["git", "clone", clone_url, repo_path],
                check=True, capture_output=True,
            )
