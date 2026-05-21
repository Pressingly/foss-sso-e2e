from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass

# Maps repo name → keywords that appear in bug titles/descriptions
_KEYWORD_MAP: dict[str, list[str]] = {
    "twenty":         ["twenty", "crm", "twenty app", "twenty.foss"],
    "plane":          ["plane", "pm", "project management", "pm.foss", "issue tracker"],
    "outline":        ["outline", "docs", "wiki", "knowledge base", "docs.foss"],
    "penpot":         ["penpot", "design", "design tool", "design.foss"],
    "SurfSense":      ["surfsense", "research", "research.foss", "surf sense"],
    "sso-rules-moneta": [
        "sso", "login", "logout", "session", "auth", "cookie",
        "redirect", "token", "oauth", "mpass", "cognito",
        "all apps", "all service apps", "foss app", "log out of all",
        "re-login", "re-authenticat", "missing state", "forward auth",
    ],
}

# Repo name → local directory name (for the clone path)
REPO_DIR: dict[str, str] = {
    "twenty":           "twenty",
    "plane":            "plane",
    "outline":          "outline",
    "penpot":           "penpot",
    "SurfSense":        "SurfSense",
    "sso-rules-moneta": "sso-rules-moneta",
}

GITHUB_URLS: dict[str, str] = {
    "twenty":           "https://github.com/Pressingly/twenty.git",
    "plane":            "https://github.com/Pressingly/plane.git",
    "outline":          "https://github.com/Pressingly/outline.git",
    "penpot":           "https://github.com/Pressingly/penpot.git",
    "SurfSense":        "https://github.com/Pressingly/SurfSense.git",
    "sso-rules-moneta": "https://github.com/awais786/sso-rules-moneta.git",
}


@dataclass
class RouteResult:
    repo_name: str
    repo_path: str


class RoutingError(Exception):
    pass


def route(issue: dict, devstack_path: str) -> RouteResult:
    """
    Map a Plane issue to the source repo responsible for the fix.
    Uses keyword scoring first; falls back to LLM classification.
    """
    text = _issue_text(issue)
    repo_name = _keyword_route(text) or _llm_route(text)
    if not repo_name:
        raise RoutingError(f"Could not route issue '{issue.get('name')}' to any repo")

    repo_path = f"{devstack_path.rstrip('/')}/{REPO_DIR[repo_name]}"
    return RouteResult(repo_name=repo_name, repo_path=repo_path)


def route_by_keyword(issue: dict) -> str | None:
    """Keyword-only routing for read-only use cases (no LLM subprocess)."""
    return _keyword_route(_issue_text(issue))


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _issue_text(issue: dict) -> str:
    from bug_fixer_agent.plane_client import PlaneClient
    name = issue.get("name") or ""
    desc = PlaneClient.plain_description(issue)
    return f"{name} {desc}".lower()


def _keyword_route(text: str) -> str | None:
    scores: dict[str, int] = {}
    for repo, keywords in _KEYWORD_MAP.items():
        score = sum(1 for kw in keywords if kw.lower() in text)
        if score:
            scores[repo] = score

    if not scores:
        return None

    top_score = max(scores.values())
    winners = [r for r, s in scores.items() if s == top_score]

    # SSO/auth wins ties — cross-app session bugs belong there by default
    if len(winners) > 1 and "sso-rules-moneta" in winners:
        return "sso-rules-moneta"

    return winners[0]


def _llm_route(text: str) -> str | None:
    """Single-turn claude -p call to classify which repo owns the bug."""
    repo_list = ", ".join(_KEYWORD_MAP.keys())
    prompt = (
        f"You are a routing assistant. Given a bug report, pick the single most relevant "
        f"repository from this list: {repo_list}.\n\n"
        f"If the bug involves SSO, login, logout, session management, cookies, or affects "
        f"multiple apps, pick sso-rules-moneta.\n\n"
        f"Bug report:\n{text[:1000]}\n\n"
        f"Reply with ONLY the repository name, nothing else."
    )
    try:
        result = subprocess.run(
            ["claude", "-p", prompt],
            capture_output=True, text=True, timeout=60,
        )
        name = result.stdout.strip().lower()
        for repo in _KEYWORD_MAP:
            if repo.lower() in name:
                return repo
    except Exception:
        pass
    return None
