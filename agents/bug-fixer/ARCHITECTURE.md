# Bug-Fixer — Architecture

> **Status: design doc.** Captures the target architecture for the Plane→test→fix
> pipeline. Some of this is built (marked **DONE**), some is the next step
> (**NEXT**), some is future work (**LATER**). The contract between repos is
> the load-bearing piece — get that right and the parts inside each repo can
> evolve independently.

> **This doc is kept in two places:**
> - `foss-sso-e2e/agents/bug-fixer/ARCHITECTURE.md` (here, next to the agent code)
> - [`sso-rules-moneta/bug-fixer-architecture.md`](https://github.com/awais786/sso-rules-moneta/blob/main/bug-fixer-architecture.md) (next to the openspec rules + per-app `*-security.md` audits that drive the pipeline)
>
> Both are full copies. When updating, edit both — they should stay in
> sync. Drift here is a small smell, not a correctness bug; the
> tradeoff is that each repo's reader finds the design context next to
> the thing they were reading.

---

## 1. Goal

Turn every open Plane bug into:

1. A **runnable Playwright reproduction test** under
   `foss-sso-e2e/tests/bugs/`, automatically generated from the
   bug ticket.
2. A **CI run** of that test against the live sandbox, with trace + screenshots
   as artifacts.
3. (Later) An auto-drafted fix PR against the relevant app repo.

The point is *not* to fully replace human triage — it's to remove the work of
"set up Playwright on my laptop, write a reproducer, run it once" so reviewers
can focus on judgement (does this test prove the bug? is the fix right?).

---

## 2. The information problem

Bugs land in any of **six** places:

| # | Location | Example bug class |
|---|---|---|
| 1 | `outline` app | Docs renders wrong, rate-limit on chunk loads |
| 2 | `plane` (PM) app | Cannot create project, god-mode quirks |
| 3 | `penpot` app | Hash routing, stale localStorage display |
| 4 | `SurfSense` app | `/login` redirect loop |
| 5 | `twenty` app | GraphQL websocket → `networkidle` never settles |
| 6 | **SSO layer** (oauth2-proxy + Traefik ForwardAuth + mPass/Cognito) | Session bugs, login/logout flow, cookie scoping |

A generic prompt that says "write a Playwright test for this bug" produces a
generic test that misses app-specific gotchas (Twenty's `ERR_ABORTED`, Penpot's
hash routing, etc.). **For each bug, Claude needs the right slice of context.**

The bug-fixer plugin already has the signal that picks that slice:
`repo_router.py` classifies each Plane issue into one of those six locations,
using keyword matching plus an LLM fallback. We just don't currently use that
signal to load context — we use it to pick a fix-repo. The architecture below
fixes that.

---

## 3. Target information flow

```
┌────────────────────────────────────────────────────────────────────────┐
│ Plane (source of truth for what's broken)                              │
│ - workspace: moneta, project: FOSSSMBBUN                               │
│ - bugs labeled `bug`                                                   │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ Plane REST API (PLANE_API_TOKEN)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ bug-fixer plugin (this repo: agents/bug-fixer/)                        │
│   - fetch open bugs                                                    │
│   - route to one of 6 locations (existing _keyword_route + _llm_route) │
│   - build a per-bug context manifest (see §5)                          │
│   - open a GitHub issue in foss-sso-e2e                   │
│     with bug info + routed-location + manifest in the body             │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ gh issue create (label: bug-fixer-auto)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ foss-sso-e2e — Issue                                      │
│ Title: [FOSSSMBBUN-N] <bug title>                                      │
│ Body:                                                                  │
│   - Plane URL                                                          │
│   - Bug description (verbatim from Plane)                              │
│   - Routed location: outline | plane | penpot | SurfSense | twenty    │
│                    | sso-rules-moneta                                  │
│   - Files Claude should read for this bug                              │
│   - @claude (or label) → triggers the test-writer workflow             │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ on: issues (labeled `bug-fixer-auto`)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ claude-test-writer.yml — workflow (Claude Code GitHub Action)          │
│   - reads the issue body for bug info + manifest                       │
│   - reads files in the manifest (cross-repo fetch for openspec)        │
│   - writes tests/bugs/bug_<short-id>.spec.ts                           │
│   - opens a PR pointed at main, links back to the issue                │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ PR with tests/bugs/** change
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ bug-tests-run.yml — workflow      [DONE — PR #30 in e2e repo]          │
│   - npx playwright test tests/bugs/                                    │
│   - fail-on-test-failure (red CI = bug confirmed, not yet fixed)       │
│   - upload trace.zip + screenshots                                     │
│   - write outcome summary to $GITHUB_STEP_SUMMARY                      │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ artifacts + green dot
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Human review                                                           │
│   - inspect trace.zip / screenshots                                    │
│   - confirm the test asserts the right thing                           │
│   - merge OR comment on issue/PR to iterate                            │
└────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼ (LATER, optional)
┌────────────────────────────────────────────────────────────────────────┐
│ claude-fix-writer.yml — workflow in app repos                          │
│   - triggered by linked merged test PR                                 │
│   - writes a fix in the routed app repo                                │
│   - opens a fix PR, references the test                                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Where each piece of info lives

| Info | Source | Consumed by |
|---|---|---|
| Bug title, description, label, status | Plane API | bug-fixer plugin |
| Routed app/layer | `repo_router.py` keyword + LLM fallback | bug-fixer plugin → put in issue body |
| Test conventions (fixtures, helpers, hosts) | `foss-sso-e2e/CLAUDE.md` + repo files | claude-test-writer.yml |
| Per-app gotchas (Twenty no-networkidle, Penpot hash routing, …) | `foss-sso-e2e/CLAUDE.md` § "Deployment gotchas" | claude-test-writer.yml |
| Per-app SSO integration docs | `sso-rules-moneta/<app>-security.md`, `apps-overview.md` | claude-test-writer.yml (for SSO-relevant app bugs) |
| Canonical SSO contract | `sso-rules-moneta/openspec/specs/` | claude-test-writer.yml (for SSO-layer bugs) |
| Reference test for similar bug | `foss-sso-e2e/tests/auth/*.spec.ts` (SSO) or `tests/apps/<app>.spec.ts` (per-app) | claude-test-writer.yml |
| Per-app UI helpers (where Logout lives in each app) | `foss-sso-e2e/tests/lib/app-menus.ts` | claude-test-writer.yml |
| Sandbox creds (`FOSS_USER`, `FOSS_PASS`, …) | GitHub repo secrets in foss-sso-e2e | bug-tests-run.yml |

**Cross-repo gotcha:** `claude-test-writer.yml` runs in `foss-sso-e2e` but needs to read `sso-rules-moneta/openspec/specs/` for SSO-layer bugs. Options (pick one in implementation):
- **Git submodule** of `sso-rules-moneta` inside e2e repo (simple, but checkout cost on every run)
- **`gh api` fetch** in a setup step using a `SPEC_REPO_TOKEN` secret (already documented in `e2e CLAUDE.md`)
- **Pre-bundled in the issue body** — bug-fixer plugin attaches the relevant openspec excerpt when it creates the issue (lowest CI cost; some duplication)

---

## 5. Per-bug context manifest

This is the heart of the design. The bug-fixer's routing decision drives **which files Claude reads** before writing the test. Same prompt scaffold, different file list.

| Routed location | Always-read | Plus location-specific |
|---|---|---|
| `outline` | `e2e:CLAUDE.md`, `e2e:fixtures.ts`, `e2e:auth-helpers.ts`, `e2e:constants.ts` | `e2e:tests/apps/outline.spec.ts`, `e2e:tests/apps/outline-admin.spec.ts`, `sso:outline-security.md`, `e2e:tests/lib/app-menus.ts` (Outline section) |
| `plane` | (same always-read) | `e2e:tests/apps/pm.spec.ts`, `e2e:tests/apps/pm-admin.spec.ts`, `e2e:tests/apps/pm-godmode.spec.ts`, `sso:plane-security.md`, `e2e:tests/lib/app-menus.ts` (Plane section) |
| `penpot` | (same always-read) | `e2e:tests/apps/penpot.spec.ts`, `e2e:tests/apps/penpot-admin.spec.ts`, `sso:penpot-security.md`, `e2e:tests/lib/app-menus.ts` (Penpot section) |
| `SurfSense` | (same always-read) | `e2e:tests/apps/surfsense.spec.ts`, `e2e:tests/apps/surfsense-admin.spec.ts`, `sso:surfsense-security.md`, `e2e:tests/lib/app-menus.ts` (SurfSense section) |
| `twenty` | (same always-read) | `e2e:tests/apps/twenty.spec.ts`, `e2e:tests/apps/twenty-admin.spec.ts`, `sso:twenty-security.md`, `e2e:tests/lib/app-menus.ts` (Twenty section) |
| `sso-rules-moneta` | (same always-read) | `sso:openspec/specs/<module>.md` (closest to bug), `sso:authentication.md`, `sso:proxy-auth-contract.md`, `sso:mpass-security.md`, `e2e:tests/auth/<closest-match>.spec.ts`, `e2e:tests/lib/common-flows.ts` |

`e2e:` = `foss-sso-e2e/` · `sso:` = `sso-rules-moneta/`

**How the bug-fixer picks the closest spec/reference file for SSO-layer bugs:**
Today the openspec spec files are organized by module (`logout-flow`, `session-lifecycle`, `workspace-auto-join`, etc.). The bug-fixer can keyword-match the bug title against module names — same keyword-scoring approach already in `repo_router.py`. If no module match is confident, include the top three modules' READMEs.

---

## 6. Components — current vs target

### bug-fixer plugin (`agents/bug-fixer/` in this repo)

**Today (~1500 lines):**
- `plane_client.py` — fetch from Plane
- `repo_router.py` — classify which of 6 locations
- `subagents.py` — spawn `claude -p` to write test + write fix
- `gh_client.py` — branch, commit, push, open PRs in app repos
- `state_tracker.py` — resume mid-pipeline
- `orchestrator.py` — wire it all together
- CLI flags: `--list-only`, `--test-only`, `--dry-run`, `--retry-failed`, `--issue-id`

**Target (~150 lines):**
- `plane_client.py` — fetch from Plane (unchanged)
- `repo_router.py` — classify (unchanged)
- `manifest.py` — **NEW** — given routed-location, return list of files to include
- `dispatcher.py` — **NEW** — `gh issue create` in foss-sso-e2e with bug body + manifest
- `state_tracker.py` — slimmer (just track issue-created)
- CLI: `bug-fixer --dispatch` (default) or `bug-fixer --list-only` (preview)

**Deleted:** `subagents.py`, `prompts/`, `gh_client.py`'s heavier methods (`open_pr`, `commit_files`, `push_branch`), all the pipeline steps 2–7 in `orchestrator.py`.

### foss-sso-e2e

**Today:**
- Hand-curated tests under `tests/auth/`, `tests/apps/`, `tests/flows/`, `tests/security/`
- `.github/workflows/e2e-sandbox.yml` runs the full suite
- `.github/workflows/bug-tests-run.yml` runs `tests/bugs/` **[DONE — PR #30]**

**Target adds:**
- `.github/workflows/claude-test-writer.yml` — triggers on issue with label `bug-fixer-auto`, uses [Claude Code GitHub Action](https://github.com/anthropics/claude-code-action), writes test under `tests/bugs/`, opens PR
- `.github/prompts/test-writer.md` — the prompt template, lives next to the workflow that uses it (currently at `agents/bug-fixer/prompts/test_writer.md`; future refactor moves it under `.github/`)

### App repos (`twenty`, `plane`, `outline`, `penpot`, `SurfSense`)

**Today:** no automation.

**Target (LATER):** `.github/workflows/claude-fix-writer.yml` — triggers when a linked test PR merges in `foss-sso-e2e`. Out of scope until the test side is proven.

---

## 7. Build order

1. **DONE** `bug-tests-run.yml` in e2e repo — CI for `tests/bugs/`.
2. **NEXT** `bug-fixer --dispatch` flag — opens GitHub issues in `foss-sso-e2e` instead of writing tests. Doesn't delete anything; coexists with current `--test-only` for local iteration.
3. **NEXT** `bug-fixer/manifest.py` — given routed-location, returns the per-app file list (§5). Tested in isolation.
4. **NEXT** `claude-test-writer.yml` in e2e repo — triggered by labeled issue, uses Claude Code Action, opens a PR with the test. Smallest viable version: hardcoded prompt that includes the manifest from the issue body.
5. **NEXT** End-to-end smoke run on one bug — open issue manually, verify the test-writer workflow runs, PR opens, `bug-tests-run.yml` runs the test, artifacts upload.
6. **LATER** Wire `bug-fixer --dispatch` to a cron (daily) so new Plane bugs auto-flow into the system.
7. **LATER** Shrink the bug-fixer plugin: delete `subagents.py`, `prompts/`, `gh_client.py`'s heavier methods, orchestrator steps 2-7.
8. **LATER** `claude-fix-writer.yml` per app repo — react to merged test PRs by drafting fixes.

Each step is independently useful and can be paused after.

---

## 8. Open questions

1. **Billing.** Claude Code Action costs API credits per invocation. If every Plane bug auto-creates an issue and every issue auto-triggers an `@claude` run, the bill can grow. Mitigations:
   - Require the `bug-fixer-auto` label (not all issues) to gate the trigger.
   - Cap the bug-fixer's `--dispatch` to a max issues per run (e.g. 5).
   - Add a workflow-level concurrency limit.

2. **Cross-repo openspec access.** Pick one of submodule / `gh api` fetch / pre-bundled. Recommendation: **pre-bundled** — the bug-fixer plugin already has the spec files in the local checkout, so it can include the relevant excerpt directly in the issue body. Lowest CI cost, no extra secrets, but the manifest body grows by a few KB.

3. **Stale tests.** Bug gets closed in Plane but the test stays under `tests/bugs/` forever. Need a reaper (cron compares open Plane bugs vs files in `tests/bugs/`, marks orphans). Not blocking initial rollout.

4. **False-positive bug tests.** The FOSSSMBBUN-69 test (in branch `test/bug-476a2f08`) fails today — but for the wrong reason (worker fixture's auth state isn't sticking, page lands on "Checking session..."). Bug-tests-run.yml will see this as "bug confirmed" when really the test is broken. Two mitigations:
   - **Stronger prompt:** the test_writer prompt should require a pre-assertion that auth is *confirmed* before checking bug symptoms.
   - **Failure-mode summary in PR comment:** parse the trace to detect "test failed before reaching the bug-relevant assertion" and flag it.

5. **PR ↔ Plane status sync.** When the fix lands and CI for the moved test goes green, should the Plane bug auto-close? Out of scope for v1, but the contract should leave room (bug-fixer's state tracker already remembers the issue URL).

6. **Iteration loop on bad tests.** If a generated test is broken, what's the cycle? Manual edits + new commit on the test PR? Re-trigger `claude-test-writer.yml` by re-applying the label? Both should work — but the second needs idempotency (don't open a duplicate PR).

7. **Routing failures.** `_keyword_route` returns `None` for some bugs (FOSSSMBBUN-69 fell through to the LLM and got mis-routed to `outline`). Bad routing → wrong context manifest → bad test. Mitigation: include a "confidence" signal in the issue body so reviewers know to spot-check the manifest.

---

## 9. Contract between repos

This is the immutable interface — once committed to, the implementation behind each surface can change freely.

| Producer | Consumer | Medium | Format |
|---|---|---|---|
| Plane | bug-fixer plugin | Plane REST API | JSON; `PLANE_API_TOKEN` |
| bug-fixer plugin | foss-sso-e2e | `gh issue create` | Title: `[FOSSSMBBUN-N] <title>` · Label: `bug-fixer-auto` · Body: see §10 schema |
| foss-sso-e2e issue | claude-test-writer.yml | GitHub `issues.opened` event with the label | — |
| claude-test-writer.yml | foss-sso-e2e | git push + `gh pr create` | Branch: `bug-test/<short-id>` · PR title: `[Bug Test] <title>` · references issue |
| foss-sso-e2e test PR | bug-tests-run.yml | `paths: ['tests/bugs/**.spec.ts']` filter | — |
| bug-tests-run.yml | reviewer | `$GITHUB_STEP_SUMMARY` + uploaded artifacts | trace.zip, screenshots, HTML report |

---

## 10. Issue body schema (bug-fixer → e2e)

```markdown
**Plane:** https://projects.arbisoft.com/moneta/browse/FOSSSMBBUN-69/

**Title:** [Bug] The links under the Infrastructure & Tools section are non-functional and should be removed.

**Description:**
> Clicking the link appearing under the Infrastructure & Tools section
> shows an Access Denied error.

**Routed to:** `sso-rules-moneta` (confidence: keyword)

**Files to read before writing the test:**
- `CLAUDE.md`
- `fixtures.ts`
- `auth-helpers.ts`
- `constants.ts`
- `tests/auth/sso-login.spec.ts`
- `tests/lib/common-flows.ts`
- (cross-repo) `openspec/specs/portal-dashboard.md`

**Constraints:**
- Place the test at `tests/bugs/bug_<short-id>.spec.ts`
- Do not add an `@spec` tag (this is staging)
- Test must fail today against `https://foss.arbisoft.com`

---
_Auto-filed by `bug-fixer` from sso-rules-moneta. Apply the `bug-fixer-auto`
label and `@claude` will write the test._
```

The bug-fixer plugin builds this body by templating; the claude-test-writer
workflow parses it (front-matter or just regex on the headings) to load the
right context.

---

## 11. Failure modes & detection

| What goes wrong | How we detect | What we do |
|---|---|---|
| Bug-fixer can't reach Plane | API exception in dispatch run | Exit non-zero; cron retries next slot |
| Routing returns wrong app | Manual review of issue body before triggering test-writer | Reviewer edits manifest + re-applies label |
| Claude can't write a valid test | Workflow fails or opens a PR that doesn't compile | `tsc --noEmit` step in claude-test-writer.yml gates the commit |
| Test compiles but fails for wrong reason (session-check race, fixture error) | Inspect trace.zip artifact; absence of bug-relevant assertions in trace | Comment on PR; re-trigger test-writer or hand-edit |
| Two issues opened for the same Plane bug | State tracker dedupe on Plane issue UUID | Bug-fixer skips already-dispatched issues |
| Test passes when it should fail | bug-tests-run.yml outcome summary says "all passed" | Reviewer moves the test out of `tests/bugs/` or investigates regression |

---

## 12. Glossary

- **bug-fixer**: the plugin in `agents/bug-fixer/` (this repo).
- **routing**: classifying a Plane bug into one of `{outline, plane, penpot, SurfSense, twenty, sso-rules-moneta}`.
- **manifest**: the per-bug list of files Claude should read before writing the test. Derived from the routing decision.
- **Claude Code GitHub Action**: the [official action](https://github.com/anthropics/claude-code-action) that runs Claude Code inside GitHub Actions. Reacts to `@claude` mentions or issue labels.
- **Staging test**: a test under `tests/bugs/`. Not yet pinning a spec requirement; fails today (which fails the workflow); lives there until the bug is fixed and the test moves into the appropriate invariant folder with an `@spec` tag.

---

_Last updated: 2026-05-19. Owner: bug-fixer plugin maintainer._
