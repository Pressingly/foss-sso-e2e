#!/usr/bin/env python3
"""
Bug bootstrap — mode-agnostic ticket + scope dumper.

Fetches a Plane ticket, prints its title + description + UUID + URL,
and runs the root-cause-analyst skill's Step 0 scope detection
mechanically. Prints detected scope(s) and the files most worth
reading first.

Usage (typically called by `make test ID=…`, which extracts the
resolved UUID from the output and passes it to the test-writer CLI):
    python3 scripts/bug-bootstrap.py <FOSSSMBBUN-N | N | UUID>

Requires (read from os.environ; caller sources .env first):
    PLANE_API_TOKEN, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import textwrap
import urllib.request


# ---------------------------------------------------------------------------
# Scope detection — patterns Claude would have to discover by reading; we
# encode them here so the cheap pre-step does the obvious classification
# and Claude only does the actual investigation.
# ---------------------------------------------------------------------------

SCOPE_RULES: list[tuple[str, str, list[str]]] = [
    # (keyword regex, scope label, suggested files to read first)
    (
        r"\bplane\b|\bPM\b|workspace.*pm|pm\.foss",
        "Plane app (L5) + storage (L6)",
        [
            "plane/apps/api/plane/  (backend; pick views/, settings/, db/ files matching the symptom)",
            "plane/apps/web/  (frontend, only if symptom is UI-shaped)",
            "foss-server-bundle*/docker-compose*.yml  (Plane env block)",
        ],
    ),
    (
        r"\boutline\b|\bdocs\b|wiki|docs\.foss",
        "Outline app (L5)",
        ["outline/...", "foss-server-bundle*/docker-compose*.yml (Outline env block)"],
    ),
    (
        r"\bpenpot\b|design\.foss|design tool",
        "Penpot app (L5)",
        ["penpot/...", "foss-server-bundle*/docker-compose*.yml (Penpot env block)"],
    ),
    (
        r"\bsurfsense\b|surf sense|research\.foss|\bresearch\b",
        "SurfSense app (L5)",
        ["SurfSense/...", "foss-server-bundle*/docker-compose*.yml (SurfSense env block)"],
    ),
    (
        r"\btwenty\b|\bcrm\b|twenty\.foss",
        "Twenty app (L5)",
        ["twenty/...", "foss-server-bundle*/docker-compose*.yml (Twenty env block)"],
    ),
    (
        r"oauth2[\- ]?proxy|forward[\- ]?auth|traefik|auth.?wall|bypass",
        "SSO chain — Traefik + oauth2-proxy (L2–L3)",
        [
            "foss-server-bundle*/traefik/  (routing + middleware chain)",
            "foss-server-bundle*/oauth2-proxy*  (config + cookie/session settings)",
            "sso-rules-moneta/openspec/specs/forwardauth-traefik/spec.md",
            "sso-rules-moneta/openspec/specs/oauth2-proxy-gateway/spec.md",
        ],
    ),
    (
        r"mpass|cognito|qr (code )?login|password login|idp",
        "IDP / mPass (L4)",
        [
            "foss-server-bundle*/mpass-auth-proxy/",
            "sso-rules-moneta/openspec/specs/cognito-claim-mapping/spec.md",
        ],
    ),
    (
        r"\bsession\b|\bcookie\b|\blogout\b|re.?log[- ]?in|relogin|session.timeout",
        "Session lifecycle (L3)",
        [
            "sso-rules-moneta/openspec/specs/session-lifecycle/spec.md",
            "sso-rules-moneta/openspec/specs/logout-flow/spec.md",
            "foss-server-bundle*/oauth2-proxy*",
        ],
    ),
    (
        r"upload|attachment|cover image|\bmedia\b|cannot upload|presigned|s3|seaweedfs|bucket",
        "Upload / storage (L5 app + L6 storage)",
        [
            "<app>/apps/api/<app>/settings/storage*.py  (storage client + presigned URL generation)",
            "foss-server-bundle*/seaweedfs*  (container config + s3.json identities)",
            "foss-server-bundle*/docker-compose*.yml  (AWS_* env block for the affected app)",
        ],
    ),
    (
        r"two tabs|multi[\- ]?tab|concurrent|second tab|different tab|multi[\- ]?user|multiple browsers",
        "Multi-tab / concurrent (L3 cookie + L4 IDP state)",
        [
            "sso-rules-moneta/openspec/specs/session-lifecycle/spec.md",
            "foss-server-bundle*/mpass-auth-proxy/",
        ],
    ),
    (
        r"all apps|every app|all 5 apps|across apps|cross[\- ]?app",
        "Cross-app — SSO chain (L2–L4)",
        [
            "foss-server-bundle*/traefik/",
            "foss-server-bundle*/oauth2-proxy*",
            "sso-rules-moneta/openspec/specs/",
        ],
    ),
    (
        r"works locally.*not.*prod|sandbox|environment|deploy",
        "Deployment / env layer",
        [
            "foss-server-bundle*/docker-compose*.yml",
            "foss-server-bundle*/.env*  (or k8s manifests / secrets)",
        ],
    ),
]


# ---------------------------------------------------------------------------
# Plane API helpers
# ---------------------------------------------------------------------------


def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def plane_get(path: str) -> dict:
    url = f"{os.environ['PLANE_BASE_URL']}{path}"
    req = urllib.request.Request(url, headers={"X-Api-Key": os.environ["PLANE_API_TOKEN"]})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    return html.unescape(re.sub(r"\s+", " ", s).strip())


def resolve(input_id: str) -> tuple[str, int | None, str, str]:
    """Resolve FOSSSMBBUN-N / N / UUID → (uuid, sequence_id, title, description)."""
    slug = os.environ["PLANE_WORKSPACE_SLUG"]
    proj = os.environ["PLANE_PROJECT_ID"]

    uuid_re = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    if uuid_re.match(input_id):
        i = plane_get(f"/api/v1/workspaces/{slug}/projects/{proj}/issues/{input_id}/")
        return (i["id"], i.get("sequence_id"), i.get("name") or "", strip_html(i.get("description_html") or ""))

    # FOSSSMBBUN-N or just N
    digits = re.sub(r"\D", "", input_id)
    if not digits:
        fail(f"Cannot parse ID: {input_id!r}. Expected FOSSSMBBUN-N, N, or UUID.")
    seq = int(digits)

    data = plane_get(f"/api/v1/workspaces/{slug}/projects/{proj}/issues/?per_page=100")
    for i in data.get("results", []):
        if i.get("sequence_id") == seq:
            return (i["id"], seq, i.get("name") or "", strip_html(i.get("description_html") or ""))
    fail(f"No issue with sequence_id={seq} found in workspace.")
    raise SystemExit(1)  # unreachable; for type-check


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def detect_scopes(title: str, desc: str) -> list[tuple[str, list[str]]]:
    text = f"{title} {desc}".lower()
    return [(label, files) for rx, label, files in SCOPE_RULES if re.search(rx, text)]


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: debug-bug.py <FOSSSMBBUN-N | N | UUID>")

    for v in ("PLANE_API_TOKEN", "PLANE_BASE_URL", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_ID"):
        if not os.environ.get(v, "").strip():
            fail(f"Missing required env var: {v}. Did you source .env?")

    uuid, seq, name, desc = resolve(sys.argv[1])

    plane_url = (
        f"{os.environ['PLANE_BASE_URL']}/{os.environ['PLANE_WORKSPACE_SLUG']}"
        f"/projects/{os.environ['PLANE_PROJECT_ID']}/issues/{uuid}/"
    )

    print(f"Ticket: FOSSSMBBUN-{seq}" if seq is not None else "Ticket: (no sequence id)")
    print(f"Title:  {name}")
    print(f"URL:    {plane_url}")
    print(f"UUID:   {uuid}")
    print()
    print("Description:")
    if desc:
        for line in textwrap.wrap(desc, width=80, replace_whitespace=False):
            print(f"  {line}")
    else:
        print("  (no description)")
    print()

    scopes = detect_scopes(name, desc)
    if not scopes:
        print("Scope hint: no scope keywords detected.")
        print("Ticket may be too thin — push back to reporter for repro steps + observable,")
        print("OR investigate broadly using the root-cause-analyst skill's Step 0 manually.")
        sys.exit(0)

    print("Detected scope(s):")
    for label, _ in scopes:
        print(f"  • {label}")
    print()
    print("Files to read first (only these — skip everything else):")
    seen: set[str] = set()
    for _, files in scopes:
        for f in files:
            if f not in seen:
                print(f"  - {f}")
                seen.add(f)
    # No "next step" — caller (Makefile target) prints the appropriate
    # next-step prompt depending on whether we're in debug-mode or
    # e2e-test-mode.


if __name__ == "__main__":
    main()
