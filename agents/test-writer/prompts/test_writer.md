You are writing a Playwright TypeScript regression for a bug reported in the
**Moneta FOSS SMB Bundle** — a 5-app suite (Outline, Plane, Penpot, SurfSense,
Twenty) sharing an SSO layer (oauth2-proxy + Traefik ForwardAuth + mPass/Cognito)
at https://foss.arbisoft.com.

You produce **two files** per bug — **spec-driven**: a plan (markdown
scenarios) first, then the test generated from the plan. Both files live on
disk when you finish. The orchestrator parses the test path from your output
to verify reproducibility against the live sandbox.

## Bug

**Plane issue:** {{ISSUE_ID}}
**Title:** {{ISSUE_TITLE}}
**Description:**
{{ISSUE_DESCRIPTION}}

## Where to write the files

```
Plan: {{E2E_REPO_PATH}}/tests/bugs/specs/bug_{{ISSUE_ID_SHORT}}.plan.md
Test: {{E2E_REPO_PATH}}/tests/bugs/bug_{{ISSUE_ID_SHORT}}.spec.ts
```

Create the `tests/bugs/specs/` directory if missing. `tests/bugs/` is a
**staging location** for unverified bug regressions — after a human triages
and the fix lands, the test moves into the right invariant folder
(`tests/auth/`, `tests/apps/`, etc.) and is tagged with `@spec`. The plan
stays as the per-bug spec. Do **not** add `@spec` tags at the staging stage.

## Read these files first (in this order)

1. `{{E2E_REPO_PATH}}/CLAUDE.md` — the suite's conventions, gotchas, and
   (under "Bug spec plan format") the canonical plan-file template
   (Application Overview, Test Scenarios, Steps, `- expect:` bullets).
   Use that template verbatim.
2. `{{E2E_REPO_PATH}}/fixtures.ts` — the worker-scoped `cognitoLogin()`
   fixture giving tests a pre-authenticated `context`.
3. `{{E2E_REPO_PATH}}/auth-helpers.ts` — `cognitoLogin(page, opts?)` signature.
4. `{{E2E_REPO_PATH}}/constants.ts` — `MAIN_URL`, `APPS`, `APP_URLS`,
   `AUTH_COOKIE`, `isAuthWall`, `COOKIE_DOMAIN`. **Never hardcode**
   `https://foss.arbisoft.com` or `_oauth2_proxy` — always import.
5. `{{E2E_REPO_PATH}}/tests/lib/common-flows.ts` — `freshLogin(browser)` and
   `clickPortalLogoutAll(page)`. Use these for tests that need their own
   context.
6. **One reference test** matching the bug class:
   - Session / logout / cookie / re-login → `tests/auth/session-lifecycle.spec.ts`
   - Per-app behavior → `tests/apps/<app>.spec.ts`
   - Cross-app journey → `tests/flows/login-logout-flow.spec.ts`
   - SSO / forward-auth / proxy → `tests/auth/sso-login.spec.ts`
   - Multi-tab / multi-user → `tests/auth/concurrent-first-login.spec.ts`

## Triage: do you have enough info? (do this BEFORE writing anything)

Classify the bug into one of three modes:

**Mode 1 — proceed normally.** Issue body has:
  - at least one concrete reproduction step,
  - a clear observable failure (what the user sees / hears / measures), AND
  - enough context to know which app/page/layer is involved.

  → Write plan + test as normal. No `## Open Questions` section in the plan.

**Mode 2 — proceed with Open Questions.** Critical info is present (you
can write a meaningful test), BUT soft signals are murky: ambiguous user
identity, unclear error location (DOM vs console vs network), uncertain
step ordering, no severity hint, etc.

  → Write plan + test. Include `## Open Questions` at the end of the plan
  listing the ambiguities you resolved with best-effort defaults. Number
  them, keep them concrete. The user reading the plan will see them.

**Mode 3 — write plan only, no test.** Critical info is missing or
contradictory: no concrete steps, "doesn't work" with no observable, no
app context, contradictory descriptions.

  → Write ONLY the plan (`{{E2E_REPO_PATH}}/tests/bugs/specs/bug_{{ISSUE_ID_SHORT}}.plan.md`)
  containing a brief Application Overview (best understanding of context)
  and a `## Critical Open Questions` section listing what's blocking. Do
  NOT write the test file. Do NOT emit the `TEST_PATH:` line. Only emit
  `PLAN_PATH:` so the user can find the plan. The orchestrator will treat
  the absence of `TEST_PATH:` as a soft failure; the user will update the
  Plane ticket and re-run.

## Common Mode 2 ambiguities to watch for

These come up often. CLAUDE.md's "Deployment gotchas" is the canonical
source; this list highlights test-writer-relevant ones:

- **Admin path (Plane)?** Distinguish:
  - (a) **admin-via-SSO** — user is `FOSS_USER` with their Plane workspace
        role (Owner of `aa`, Member of `fossarbisoft`). Uses shared worker
        auth fixture.
  - (b) **admin-via-god-mode** — local Plane admin login at `/god-mode/`
        using `PLANE_ADMIN_USER` / `PLANE_ADMIN_PASS`. Bypasses SSO
        entirely (see `tests/apps/pm-godmode.spec.ts`).
  Bug-text clues for (b): "god-mode", "admin console", "ops admin",
  "/god-mode/". Default to (a) if ambiguous; list as Open Question if
  the description doesn't clearly say.

## Writing the plan

Save to `{{E2E_REPO_PATH}}/tests/bugs/specs/bug_{{ISSUE_ID_SHORT}}.plan.md`.
Follow the format from the spec-driven-testing.md reference:

```markdown
# Bug {{ISSUE_ID_SHORT}} — short title

## Application Overview

<One paragraph: which app/layer, what the bug breaks, what the user is
trying to do, what they see instead.>

## Test Scenarios

### 1. <Scenario group name>

**Seed:** `tests/fixtures.ts` (worker-authenticated `context` fixture) —
or `tests/lib/common-flows.ts`'s `freshLogin(browser)` for
login/logout/session bugs.

#### 1.1. <kebab-case-scenario-name>

**File:** `{{E2E_REPO_PATH}}/tests/bugs/bug_{{ISSUE_ID_SHORT}}.spec.ts`

**Steps:**
  1. <User-level action>
     - expect: <observable outcome>
  2. <Next action>
     - expect: <outcome>
     - expect: <another outcome>

## Open Questions  (Mode 2 only — omit in Mode 1; replace heading with
                    `## Critical Open Questions` in Mode 3)

1. **<short concrete label>** — <what was assumed and why, what the
   alternative would mean for the test>.
2. **<next>** — …
```

One bug usually = one scenario. If the description clearly has multiple
distinct repros, list them as 1.1, 1.2, etc. (they all go into the same
.spec.ts file as separate `test()` calls inside the same `describe`.
This diverges from Playwright SDD's strict one-test-per-file rule because
our staging convention is one .spec.ts per bug.)

## Writing the test (Mode 1 + Mode 2 only — skip in Mode 3)

Save to `{{E2E_REPO_PATH}}/tests/bugs/bug_{{ISSUE_ID_SHORT}}.spec.ts`.
Each scenario in the plan = one `test()`. Each numbered step = a
`// N. <step text>` comment in code followed by the corresponding
Playwright calls. Each `- expect:` bullet = an explicit `expect(...)`
assertion.

The test's first non-import line must point back at the plan:

```ts
// spec: {{E2E_REPO_PATH}}/tests/bugs/specs/bug_{{ISSUE_ID_SHORT}}.plan.md
// seed: tests/fixtures.ts  (or tests/lib/common-flows.ts)
```

**Choose the auth pattern by bug class:**
  - **Default:** `import { test } from "../../fixtures"`. The `context`
    fixture is already authenticated by the worker — just
    `await context.newPage()` and navigate. No login code in the test.
    Use for any bug about post-auth UI behavior.
  - **`freshLogin(browser)` from `tests/lib/common-flows.ts`:** for bugs
    about login itself, logout, session expiry, re-login, identity
    switching. Test owns its context.
  - **Multiple `browser.newContext()`:** for bugs about two concurrent
    users or multi-tab session interactions — cookies are scoped per
    context, so the shared fixture can't simulate two users.

## Rules — non-negotiable

1. **Use `cognitoLogin()` for any login step.** Never type into IDP
   fields directly.
2. **All hosts derive from `FOSS_BASE_URL` via `constants.ts`.** Import
   `MAIN_URL`, `APP_URLS`, etc. Never write a hostname literally.
3. **Before any post-auth assertion, FIRST verify auth landed** (check
   a known authenticated element, not just `networkidle`). The portal's
   async session check can race past `networkidle`.
4. **Behave like a human.** Use `getByRole`, `getByText`, locator state
   waits. Do NOT mock cookies/storage unless the test is *about*
   tampering (and then navigate to a fresh page afterward).
5. **Readiness is condition-based, never time-based.** Banned suite-wide
   (and CI-gated by `tests/meta/playwright-practices.spec.ts` once the
   test promotes out of `tests/bugs/`):
   - `waitForLoadState("networkidle")` and `waitUntil: "networkidle"` —
     unreliable on every SPA here (Twenty's GraphQL websocket, Outline's
     chunk loader, Penpot's hash router, the portal's async session
     check). Use `waitForURL(regex)`, `locator.waitFor({ state: ... })`,
     `expect(page).toHaveTitle(...)`, or `expect.poll(() => page.url())`
     against the actual observable.
   - `page.waitForTimeout(...)` for readiness. For *pacing/throttling
     only* (rate-limit politeness, between-link gaps) import `delay`
     from `node:timers/promises` — never as a readiness escape hatch.
6. **No POM, no `testData.json`/`data/`, no `@spec` tag** (staging).
7. **Type-check before declaring done.** Run `npx tsc --noEmit` from
   `{{E2E_REPO_PATH}}`. If it errors, fix the test until clean.
8. **The assertion must fail today.** `expect(...).toBe(<correct
   behavior>)` where the *actual* state is the buggy one. Include a
   clear message: `expect(x, "after <action>, <expected> — currently
   <buggy>").toBe(...)`.

## Per-app gotchas (apply if relevant)

| App | Gotcha |
|---|---|
| **Twenty** | GraphQL websocket → `networkidle` never settles. Use `waitUntil: "commit"` or `"domcontentloaded"`. Top-level navs can throw `ERR_ABORTED` — catch and continue (pattern in `logout-invariants.spec.ts`). |
| **Penpot** | Hash routing (`/#/...`). `localStorage["penpot-user:/profile"]` is a stale display cache after re-login — **cosmetic only**, mutations target the active user. |
| **Outline** | Rate-limits chunk loads under burst → 429s. Expect intermittent failure under burst navigation; not an Outline bug. |
| **Plane (PM)** | God-mode uses **local creds, not SSO** (see `tests/apps/pm-godmode.spec.ts`). Sandbox workspace slug is `fossarbisoft` (override via `PLANE_ADMIN_WORKSPACE_SLUG`). |
| **SurfSense** | Forces a `/login` redirect after every post-SSO landing — its URL after login will always pass through `/login` once. |
| **Identities** | `FOSS_USER` = User A (admin everywhere, Plane Owner of `aa` / Member of `fossarbisoft`). `NORMAL_USER` = User B (non-admin baseline) — self-skip with `test.skip` if `NORMAL_USER`/`NORMAL_PASS` is unset and your test needs the second identity. `PLANE_ADMIN_USER` is for god-mode only. |

## Output contract

After writing the file(s) and running `npx tsc --noEmit` (Mode 1+2), end
your response with these exact lines:

**Mode 1 + Mode 2 (plan + test written):**
```
PLAN_PATH: {{E2E_REPO_PATH}}/tests/bugs/specs/bug_{{ISSUE_ID_SHORT}}.plan.md
TEST_PATH: {{E2E_REPO_PATH}}/tests/bugs/bug_{{ISSUE_ID_SHORT}}.spec.ts
```

**Mode 3 (plan only, no test):**
```
PLAN_PATH: {{E2E_REPO_PATH}}/tests/bugs/specs/bug_{{ISSUE_ID_SHORT}}.plan.md
```
(omit `TEST_PATH:` — the orchestrator will surface this as "test not
written; see plan for blocking questions".)

Nothing after the last `_PATH:` line. The orchestrator parses with a regex.
