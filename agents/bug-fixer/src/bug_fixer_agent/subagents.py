from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path


class SubagentError(Exception):
    pass


class BugNotReproducible(Exception):
    """Raised when the written test passes (bug cannot be confirmed)."""


# Agent now lives inside the e2e repo; the e2e root is four levels up
# from this file (bug_fixer_agent → src → bug-fixer → agents → repo root).
E2E_REPO_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
)


def write_reproduction_test(
    issue_id: str,
    issue_title: str,
    issue_description: str,
    e2e_repo_path: str | None = None,
) -> str:
    """
    Spawns a claude subagent to write a Playwright test reproducing the bug.
    Returns the absolute path to the written test file.
    """
    e2e_path = os.path.realpath(e2e_repo_path or E2E_REPO_PATH)
    issue_id_short = issue_id[:8]

    prompt = _load_prompt(
        "test_writer.md",
        ISSUE_ID=issue_id,
        ISSUE_ID_SHORT=issue_id_short,
        ISSUE_TITLE=issue_title,
        ISSUE_DESCRIPTION=issue_description,
        E2E_REPO_PATH=e2e_path,
    )

    output = _invoke_claude(prompt, allowed_tools=["Read", "Write", "Bash"])

    match = re.search(r"TEST_PATH:\s*(.+)", output)
    if not match:
        raise SubagentError(
            f"Test writer did not emit TEST_PATH line for issue {issue_id}.\n"
            f"Output tail:\n{output[-500:]}"
        )
    return match.group(1).strip()


_INFRA_ERROR_PATTERNS = [
    "Error: Cannot find module",  # Node module resolution
    "MODULE_NOT_FOUND",            # Node module resolution (constant)
    "Error: No tests found",       # Playwright test discovery
    "Error: ENOENT:",              # Node file-not-found (canonical format)
    "SyntaxError:",                # JS syntax error
    "TSError:",                    # ts-node runtime error
]


def _ensure_npm_deps(e2e_path: str) -> None:
    """Install node_modules if missing."""
    if not os.path.isdir(os.path.join(e2e_path, "node_modules")):
        result = subprocess.run(
            ["npm", "install"],
            cwd=e2e_path,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise SubagentError(f"npm install failed:\n{result.stderr[:400]}")


def verify_test_fails(
    test_path: str,
    e2e_repo_path: str | None = None,
    foss_user: str | None = None,
    foss_pass: str | None = None,
) -> str:
    """
    Runs the Playwright test. Returns stdout+stderr.
    Raises BugNotReproducible if the test passes (exit 0).
    Raises SubagentError on infrastructure failures (missing deps, syntax errors).
    """
    e2e_path = os.path.realpath(e2e_repo_path or E2E_REPO_PATH)
    _ensure_npm_deps(e2e_path)

    env = {
        **os.environ,
        "FOSS_BASE_URL": "https://foss.arbisoft.com",
        "FOSS_USER": foss_user or os.environ.get("FOSS_USER", ""),
        "FOSS_PASS": foss_pass or os.environ.get("FOSS_PASS", ""),
        # tests/bugs/ is excluded from default discovery by playwright.config.ts;
        # the bug-fixer writes there, so we must opt in to discover the test.
        "PW_INCLUDE_STAGING": "1",
    }

    result = subprocess.run(
        ["npx", "playwright", "test", test_path, "--reporter=list"],
        cwd=e2e_path,
        capture_output=True,
        text=True,
        timeout=300,
        env=env,
    )

    output = result.stdout + result.stderr

    # Detect infra errors before interpreting exit code as test result
    matched = next((p for p in _INFRA_ERROR_PATTERNS if p in output), None)
    if matched:
        raise SubagentError(
            f"Playwright infrastructure error (not a test failure). "
            f"Matched pattern: {matched!r}\n"
            f"---output (first 3000 chars)---\n{output[:3000]}"
        )

    if result.returncode == 0:
        raise BugNotReproducible(
            f"Test at {test_path} passed — bug could not be reproduced.\n{output[-500:]}"
        )

    return output


def write_fix(
    issue_id: str,
    issue_title: str,
    issue_description: str,
    repo_name: str,
    repo_path: str,
    test_path: str,
) -> list[str]:
    """
    Spawns a claude subagent to fix the bug in the source repo.
    Returns list of absolute paths of modified/created files.
    """
    prompt = _load_prompt(
        "fix_agent.md",
        ISSUE_ID=issue_id,
        ISSUE_TITLE=issue_title,
        ISSUE_DESCRIPTION=issue_description,
        REPO_NAME=repo_name,
        REPO_PATH=repo_path,
        TEST_PATH=test_path,
    )

    output = _invoke_claude(prompt, allowed_tools=["Read", "Write", "Edit", "Bash"], timeout_seconds=1200)

    match = re.search(r"FIX_PATHS:\s*(.+)", output)
    if not match:
        raise SubagentError(
            f"Fix agent did not emit FIX_PATHS line for issue {issue_id}.\n"
            f"Output tail:\n{output[-500:]}"
        )

    paths = [p.strip() for p in match.group(1).split(",") if p.strip()]
    return paths


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_prompt(template_name: str, **substitutions: str) -> str:
    template_path = Path(__file__).parent.parent.parent / "prompts" / template_name
    text = template_path.read_text()
    for key, value in substitutions.items():
        text = text.replace(f"{{{{{key}}}}}", value)
    return text


def _invoke_claude(
    prompt: str,
    allowed_tools: list[str],
    timeout_seconds: int = 600,
) -> str:
    tools_str = ",".join(allowed_tools)
    result = subprocess.run(
        ["claude", "-p", prompt, "--allowedTools", tools_str],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    if result.returncode != 0:
        raise SubagentError(
            f"claude subagent exited {result.returncode}.\n"
            f"stderr: {result.stderr[-300:]}"
        )
    return result.stdout
