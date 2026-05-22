# Test-writer — Architecture

> **Scope.** Reads open bugs from Plane, generates Playwright
> reproductions under `tests/bugs/`, and verifies they reproduce
> the bug against the live sandbox. **The agent does NOT write
> fixes, push to app repos, or open PRs.** Fixes are a separate
> manual workflow.

---

## 1. Goal

For each open Plane bug, produce:

1. A `tests/bugs/specs/bug_<short-id>.plan.md` — the spec describing
   what the test asserts and why.
2. A `tests/bugs/bug_<short-id>.spec.ts` — the Playwright test
   generated from the plan.
3. A Playwright verification run that confirms the test fails against
   `https://foss.arbisoft.com` (= bug is reproducible). If the test
   passes, the agent marks `test_written` and leaves the state there
   so the user can iterate on the test.

The point is to remove "set up Playwright on my laptop, write a
reproducer, run it once" so reviewers focus on judgement: does this
test actually prove the bug?

---

## 2. Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│ Plane (source of truth for what's broken)                        │
│ - workspace: moneta, project: FOSSSMBBUN                         │
│ - bugs labeled `bug`                                             │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Plane REST API (PLANE_API_TOKEN)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ test-writer agent (agents/test-writer/)                          │
│   1. fetch open bugs                                             │
│   2. dedupe: skip if tests/bugs/bug_<id>.spec.ts already exists  │
│   3. spawn `claude -p` subagent with prompts/test_writer.md      │
│      → writes plan + test                                        │
│   4. run Playwright (npx playwright test tests/bugs/bug_<id>.*)  │
│      → 2 retries; fail = bug reproduced; pass = stays at         │
│        `test_written` for user iteration                         │
│   5. update state.json                                           │
└──────────────────────────────────────────────────────────────────┘
```

There is **no** routing, no GitHub issue dispatch, no app-repo PR
opening, no fix subagent. Each was previously present and has been
removed — see `ARCHITECTURE.md` history for context.

---

## 3. Components

| File | Role |
|---|---|
| `src/test_writer_agent/orchestrator.py` | The state machine: fetch → dedupe → write → verify. Defines `main`, `list_only`, `run`, `_process_issue`. |
| `src/test_writer_agent/plane_client.py` | Plane REST API client (list bugs, comment, child-issue creation). |
| `src/test_writer_agent/subagents.py` | Spawns `claude -p` for the test-writing step; runs Playwright to verify. Two exceptions: `SubagentError` (infrastructure) and `BugNotReproducible` (test passed). |
| `src/test_writer_agent/state_tracker.py` | Per-bug JSON state at `agents/test-writer/state.json`. Tracks `pending → test_written → done`. |
| `src/test_writer_agent/config.py` | Loads required env vars: `PLANE_*`, `FOSS_USER`, `FOSS_PASS`. |
| `prompts/test_writer.md` | The spec-driven prompt fed to the Claude subagent. Encodes the 3-mode triage + auth-pattern decision table. |
| `scripts/bug-bootstrap.py` | Resolves human IDs (FOSSSMBBUN-N / N) to UUIDs and prints scope. Called by `make test ID=…` so the user sees what's being processed. |
| `Makefile` | Two-verb interface: `make list`, `make test ID=<N>`. Modifiers: `FORCE=1`, `RETRY=1`. |

---

## 4. State machine

```
            ┌──────────┐  test written successfully
pending  ──▶│test_written├──▶ verify run ──▶  done
            └──────┬───┘                ▲
                   │                    │
                   └─ verify fails ────┘  (stays here; user iterates)
            ┌──────────┐  any step raises SubagentError
pending  ──▶│  failed  │  (--retry-failed clears the marker)
            └──────────┘
```

- `is_done(issue_id)` → skip on next run.
- `is_failed(issue_id)` → skip on next run unless `--retry-failed`.
- Existing `tests/bugs/bug_<id>.spec.ts` on disk → skip unless
  `--force` (orthogonal to the state machine; protects user edits).

---

## 5. Required environment

Set in `agents/test-writer/.env` (gitignored):

| Var | Used by |
|---|---|
| `PLANE_API_TOKEN` | listing bugs, fetching ticket bodies |
| `PLANE_BASE_URL` | e.g. `https://projects.arbisoft.com` |
| `PLANE_WORKSPACE_SLUG` | the Plane workspace (e.g. `moneta`) |
| `PLANE_PROJECT_ID` | the Plane project UUID |
| `FOSS_USER`, `FOSS_PASS` | passed to Playwright at verify time |
| `STATE_FILE_PATH` (optional) | override default `agents/test-writer/state.json` |
| `LOG_LEVEL` (optional) | default `INFO` |

---

## 6. Why no fix-writing

Earlier versions of this agent also wrote fixes (in `outline`,
`plane`, `penpot`, `SurfSense`, `twenty` repos), opened PRs there,
and posted Plane comments linking the fix-PR. That path was removed
because:

- A fix subagent operating in an unfamiliar app repo often produced
  patches that needed substantial rework — creating PR-review burden
  rather than saving time.
- The test reproduction and the fix are better authored together by
  one human once the reproduction is solid.
- Removing the fix path collapsed the surface area: no `GITHUB_TOKEN`,
  no `gh_client.py`, no `DEVSTACK_PATH`, no app-repo cloning. The
  agent's job is now exactly "write a Playwright test."

If you want a fix, write it yourself in the routed app repo using
the generated reproduction as proof.

---

## 7. Cross-references

- `.claude/skills/test-writer/SKILL.md` — user-facing how-to
- `prompts/test_writer.md` — the test-writing prompt + 3-mode triage spec
- `CLAUDE.md` (repo root) — "Bug spec plan format" + "Heal-phase discipline"
- `tests/bugs/specs/` — existing plan examples to mirror
