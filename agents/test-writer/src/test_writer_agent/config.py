from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    plane_api_token: str
    plane_base_url: str
    plane_workspace_slug: str
    plane_project_id: str
    foss_user: str
    foss_pass: str
    state_file_path: str
    log_level: str


def load() -> Config:
    missing = []

    def require(name: str) -> str:
        value = os.environ.get(name, "").strip()
        if not value:
            missing.append(name)
        return value

    config = Config(
        plane_api_token=require("PLANE_API_TOKEN"),
        plane_base_url=require("PLANE_BASE_URL"),
        plane_workspace_slug=require("PLANE_WORKSPACE_SLUG"),
        plane_project_id=require("PLANE_PROJECT_ID"),
        foss_user=require("FOSS_USER"),
        foss_pass=require("FOSS_PASS"),
        # Default lives inside agents/test-writer/ so the package-local
        # .gitignore catches it. Override via STATE_FILE_PATH if you
        # want it elsewhere.
        state_file_path=os.environ.get(
            "STATE_FILE_PATH",
            os.path.join(os.path.dirname(__file__), "..", "..", "state.json"),
        ),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
    )

    if missing:
        raise EnvironmentError(
            f"Missing required environment variables: {', '.join(missing)}\n"
            "Set them before running the agent."
        )

    return config
