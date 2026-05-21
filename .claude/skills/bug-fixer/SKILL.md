---
name: bug-fixer
description: Generate spec-driven Playwright reproductions for bugs filed in Plane. Reads a Plane ticket, writes a plan + test, runs the test to confirm reproducibility.
allowed-tools: Bash(.venv/bin/bug-fixer:*) Bash(npx:*) Bash(cd:*) Bash(source:*) Bash(set:*)
---

# Bug-fixer agent

Generates a Playwright reproduction (plan markdown + spec.ts) from a
Plane bug ticket, then runs the test against the live sandbox to
confirm the bug is reproducible. Lives at `agents/bug-fixer/` in this
repo. Full architecture: `agents/bug-fixer/ARCHITECTURE.md`.

## When to use this skill

- A Plane bug needs a reproduction test in the e2e suite under
  `tests/bugs/`.
- You want a structured plan-then-test artifact pair (so reviewers can
  see *what is being asserted and why* before reading TS).
- You want the agent to **ask clarifying questions** when the bug
  description is ambiguous (3-mode triage; mode 3 stops and asks
  rather than guessing).

## When NOT to use this skill

- The test is for a confirmed-and-already-fixed feature — write a
  normal `@spec`-tagged test under `tests/auth/`, `tests/apps/`, etc.
- The bug is intermittent and you have no clear repro steps — run the
  agent in `--list-only` mode first to see the bug exists in Plane,
  then iterate on the issue description.
- You need to fix the bug source itself (this skill only writes the
  reproduction; the fix is a separate workflow).

## Quick start

```bash
cd agents/bug-fixer
set -a; source .env; set +a    # PLANE_API_TOKEN, FOSS_USER, etc.

# Survey what's open in Plane without writing anything:
.venv/bin/bug-fixer --list-only

# Generate plan + test for a specific bug (Mode 1 or 2 path):
.venv/bin/bug-fixer --test-only --issue-id <plane-uuid>

# Retry a previously failed run:
.venv/bin/bug-fixer --retry-failed --issue-id <plane-uuid>
```

## CLI flags

| Flag | Behavior |
|---|---|
| `--list-only` | Pulls open Plane bugs (filtered to those labeled bug or `[bug]` in title), prints `[N]  <short-uuid>  <routed-app>  <title>`. No writes. Cheap. |
| `--test-only --issue-id <uuid>` | The main mode. Routes the bug, writes the plan, writes the test, runs Playwright (2 retries) to verify. Does NOT open a fix-PR. |
| `--issue-id <uuid>` | Without `--test-only`: full pipeline including fix-writing. **Not what you want most of the time** — the fix step spawns another subagent and writes to a different repo. |
| `--retry-failed` | Re-runs an issue whose previous attempt failed (state in `agents/state.json`). |
| `--dry-run` | Stops before opening any PR. Roughly equivalent to `--test-only` but doesn't retry the verify step. |

## Output: two files per bug

When the agent runs in Mode 1 or Mode 2 (see triage below), it writes:

```
tests/bugs/specs/bug_<short-id>.plan.md   — the per-bug spec
tests/bugs/bug_<short-id>.spec.ts          — the test, generated from the plan
```

`short-id` is derived from the Plane sequence number (`FOSSSMBBUN-N`)
or the first 8 chars of the UUID if no sequence is found.

The test file's first non-import line is `// spec: <path-to-plan>` so
the spec ↔ test linkage survives.

## 3-mode triage (what to expect)

Before writing anything, the agent classifies the bug:

| Mode | Trigger | Output |
|---|---|---|
| **1 — proceed normally** | Body has concrete repro steps, observable failure, identifiable app/page | Plan + test, no `## Open Questions` section |
| **2 — proceed with Open Questions** | Critical info present but soft signals murky (which user? which app? where is the error visible?) | Plan + test, plan ends with `## Open Questions` listing the ambiguities resolved with best-effort defaults |
| **3 — stop and ask** | Critical info missing or contradictory | Plan only (no test), with `## Critical Open Questions`. Orchestrator's lack of `TEST_PATH:` marker triggers a soft failure. User updates the Plane ticket, re-runs. |

Mode is decided from the Plane ticket body. Updates to that body
between runs (when the user clarifies things) feed the next run.

## How the agent picks the auth pattern

This isn't directly user-facing but matters when reading the
generated test:

| Bug class | Auth pattern in test |
|---|---|
| Post-auth UI behavior | `import { test } from "../../fixtures"` — shared worker auth, just `await context.newPage()` |
| Login / logout / session-lifecycle bugs | `freshLogin(browser)` from `tests/lib/common-flows.ts` — own context, full login choreography |
| Multi-tab / multi-user / concurrent-login bugs | Multiple `browser.newContext()` calls — cookies are per-context |
| Plane admin via SSO | Default fixture + `FOSS_USER`'s Plane workspace role |
| Plane admin via god-mode | Local creds at `/god-mode/` using `PLANE_ADMIN_USER`/`PLANE_ADMIN_PASS` — bypasses oauth2-proxy entirely |

The agent's prompt (in `agents/bug-fixer/prompts/test_writer.md`)
encodes the decision tree. The CLAUDE.md "Deployment gotchas" table
captures the per-app constraints.

## Readiness conventions in generated tests

`tests/bugs/` is **excluded** from the meta hygiene spec
(`tests/meta/playwright-practices.spec.ts`) because bug reproductions
are by definition WIP and sometimes need an exploratory wait shape
that the rule would reject. That carve-out is for the *first* draft
only — generated tests should still follow the CLAUDE.md
"Readiness is condition-based, never time-based" rule from the start:

- No `waitForLoadState("networkidle")` / `waitUntil: "networkidle"`.
  Use `waitForURL(regex)`, `locator.waitFor({ state: ... })`,
  `expect(page).toHaveTitle(...)`, or `expect.poll(() => page.url())`.
- No `page.waitForTimeout(...)` for readiness. For *pacing* (rate-limit
  politeness, deliberate spacing) import `delay` from
  `node:timers/promises` — never as a readiness escape hatch.

The prompt at `agents/bug-fixer/prompts/test_writer.md` is the place
to enforce this for new generations; the heal phase fixes existing
ones. When promoting a `tests/bugs/` spec into an invariant folder
(see "Promotion" below), the meta hygiene spec *will* enforce these
rules — so it's cheaper to write them right the first time.

## Heal-phase iteration

When a generated test fails for the wrong reason (selector drift, IDP
form shape mismatch, race condition), the iteration loop is:

1. Read the plan and the failure together. The plan documents the
   assumption that broke.
2. Update **both** the plan (to reflect observed reality) and the test
   (to match) — keep them in sync.
3. If the failure indicates a missing piece of CLAUDE.md (e.g. mPass
   IDP method picker discovery for FOSSSMBBUN-88), update CLAUDE.md
   too — that prevents future bug-fixer runs from repeating the same
   heal step.

The cycle is plan → generate → heal: write a plan markdown, generate
the test from it, heal failures by reconciling test + plan against
observed app behaviour. The agent runs via `claude -p` against Plane
tickets.

## Promotion (when the bug is fixed)

Move `tests/bugs/bug_<id>.spec.ts` into the appropriate invariant
folder (`tests/auth/`, `tests/apps/`, `tests/flows/`, …) and add a
`// @spec <module>#<requirement-slug>` tag. The plan can stay under
`tests/bugs/specs/` as a historical artifact OR be promoted into an
openspec change proposal (`sso-rules-moneta/openspec/changes/`) if
the bug exposed a gap in the contract.

See `agents/bug-fixer/ARCHITECTURE.md` §7 ("Build order") for the
broader roadmap (the dispatcher mode, the cron, the CI test-writer
workflow — all of which the local CLI covered by this skill is the
ground truth for).

## Cost

Local invocation uses your Claude Code subscription (no API spend).
A typical run is 3–6 minutes wall-clock (plan + test write + Playwright
verify with 2 retries). The plan is ~150–300 lines of markdown; the
test is ~100–200 lines of TS. The agent reads CLAUDE.md, `fixtures.ts`,
`auth-helpers.ts`, `constants.ts`, and 1–2 reference tests on each
run.

## Cross-references

- `agents/bug-fixer/ARCHITECTURE.md` — full pipeline design (Plane → issue → test-writer → test-runner)
- `agents/bug-fixer/prompts/test_writer.md` — the spec-driven prompt the agent uses
- `CLAUDE.md` → "Bug spec plan format" / "Heal-phase discipline" — canonical plan template + failure-recovery rules
- `skills.md` §8 — "Bug staging" overview of where `tests/bugs/` fits relative to the rest of the suite
- `CLAUDE.md` — suite conventions + per-app gotchas; the agent reads this on every run
