from __future__ import annotations

import html
import re
import time
from typing import Any

import httpx

BUG_LABEL_ID = "163c6160-2105-4fa8-8ee0-31607dbc1b00"
BUG_NAME_RE = re.compile(r"\[bug\]", re.IGNORECASE)

_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_RETRIES = 3


def _strip_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return html.unescape(re.sub(r"\s+", " ", text).strip())


class PlaneError(Exception):
    pass


class PlaneClient:
    def __init__(self, base_url: str, workspace_slug: str, api_token: str) -> None:
        self._base = base_url.rstrip("/")
        self._slug = workspace_slug
        self._client = httpx.Client(
            headers={"X-Api-Key": api_token},
            timeout=30,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list_open_bug_issues(self, project_id: str) -> list[dict]:
        """Return all open (non-completed, non-cancelled) bug issues."""
        all_issues = self._paginate(
            f"/api/v1/workspaces/{self._slug}/projects/{project_id}/issues/",
            params={"expand": "issue_reactions,draft_issue_activities"},
        )
        return [i for i in all_issues if self._is_bug(i) and self._is_open(i)]

    def post_comment(self, project_id: str, issue_id: str, body: str) -> dict:
        """Post a markdown comment on an issue. Returns the created comment dict."""
        return self._request(
            "POST",
            f"/api/v1/workspaces/{self._slug}/projects/{project_id}/issues/{issue_id}/comments/",
            json={"comment_html": f"<p>{body}</p>"},
        )

    def create_child_issue(
        self,
        project_id: str,
        parent_issue_id: str,
        title: str,
        description: str,
        state_id: str | None = None,
    ) -> dict:
        """Create a sub-task under parent_issue_id. Returns the created issue dict."""
        payload: dict[str, Any] = {
            "name": title,
            "description_html": f"<p>{description}</p>",
            "parent": parent_issue_id,
        }
        if state_id:
            payload["state"] = state_id
        return self._request(
            "POST",
            f"/api/v1/workspaces/{self._slug}/projects/{project_id}/issues/",
            json=payload,
        )

    def get_issue(self, project_id: str, issue_id: str) -> dict:
        return self._request(
            "GET",
            f"/api/v1/workspaces/{self._slug}/projects/{project_id}/issues/{issue_id}/",
        )

    @staticmethod
    def plain_description(issue: dict) -> str:
        """Strip HTML from description_html for use in prompts."""
        return _strip_html(issue.get("description_html") or "")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _is_bug(self, issue: dict) -> bool:
        labels: list[str] = issue.get("labels") or []
        if BUG_LABEL_ID in labels:
            return True
        return bool(BUG_NAME_RE.search(issue.get("name") or ""))

    def _is_open(self, issue: dict) -> bool:
        # state group values: backlog, unstarted, started → open
        # completed, cancelled → closed
        # Plane doesn't return group inline on issue list; we rely on
        # completed_at and archived_at being null as the open signal.
        return (
            issue.get("completed_at") is None
            and issue.get("archived_at") is None
            and not issue.get("is_draft", False)
        )

    def _paginate(self, path: str, params: dict | None = None) -> list[dict]:
        results: list[dict] = []
        cursor = "1000:0:0"
        while True:
            p = {**(params or {}), "cursor": cursor, "per_page": 100}
            page = self._request("GET", path, params=p)
            results.extend(page.get("results") or [])
            if not page.get("next_page_results"):
                break
            cursor = page["next_cursor"]
        return results

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        json: dict | None = None,
    ) -> dict:
        url = f"{self._base}{path}"
        for attempt in range(_MAX_RETRIES):
            try:
                resp = self._client.request(method, url, params=params, json=json)
            except httpx.RequestError as exc:
                raise PlaneError(f"Network error on {method} {url}: {exc}") from exc

            if resp.status_code in _RETRY_STATUSES and attempt < _MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue

            if not resp.is_success:
                raise PlaneError(
                    f"{method} {url} returned {resp.status_code}: {resp.text[:300]}"
                )
            return resp.json()

        raise PlaneError(f"{method} {url} failed after {_MAX_RETRIES} attempts")
