from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

STEPS = [
    "pending",
    "test_written",
    "done",
]

STEP_INDEX = {step: i for i, step in enumerate(STEPS)}


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _empty_entry(issue_id: str) -> dict[str, Any]:
    return {
        "status": "pending",
        "test_path": None,
        "error": None,
        "last_updated": _now(),
        "run_date": datetime.now(tz=timezone.utc).date().isoformat(),
    }


class StateTracker:
    def __init__(self, state_file_path: str) -> None:
        self._path = os.path.realpath(state_file_path)
        self._state: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if os.path.exists(self._path):
            with open(self._path) as f:
                self._state = json.load(f)

    def _save(self) -> None:
        tmp = self._path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._state, f, indent=2)
        os.replace(tmp, self._path)

    def get(self, issue_id: str) -> dict[str, Any]:
        if issue_id not in self._state:
            self._state[issue_id] = _empty_entry(issue_id)
            self._save()
        return self._state[issue_id]

    def update(self, issue_id: str, **updates: Any) -> None:
        entry = self.get(issue_id)
        updated = {**entry, **updates, "last_updated": _now()}
        self._state[issue_id] = updated
        self._save()

    def is_done(self, issue_id: str) -> bool:
        return self._state.get(issue_id, {}).get("status") == "done"

    def is_failed(self, issue_id: str) -> bool:
        return self._state.get(issue_id, {}).get("status") == "failed"

    def resume_from(self, issue_id: str) -> str:
        """Return the step to resume from for this issue."""
        status = self._state.get(issue_id, {}).get("status", "pending")
        if status in ("failed", "pending") or status not in STEP_INDEX:
            return "pending"
        return status

    def reset_failed(self, issue_id: str) -> None:
        """Step back one step so a failed issue is retried."""
        entry = self._state.get(issue_id)
        if not entry or entry.get("status") != "failed":
            return
        last_good = entry.get("_last_good_status", "pending")
        self.update(issue_id, status=last_good, error=None)

    def mark_failed(self, issue_id: str, error: str) -> None:
        entry = self.get(issue_id)
        self.update(
            issue_id,
            status="failed",
            _last_good_status=entry.get("status", "pending"),
            error=error,
        )
