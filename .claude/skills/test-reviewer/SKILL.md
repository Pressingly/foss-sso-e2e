---
name: test-reviewer
description: Review the Playwright suite for convention violations and refinement opportunities. Mechanical grep-based checks against CLAUDE.md conventions plus semantic review of test bodies. Produces a single categorized markdown report.
allowed-tools: Bash(grep:*) Bash(find:*) Bash(rg:*) Bash(awk:*) Read Write
---

# Test-suite reviewer

Scans `tests/` for convention violations and refinement opportunities, then
emits a single markdown report categorised by severity. Mechanical checks
catch the explicit "don't do this" rules from `CLAUDE.md`; the semantic
pass reads test bodies and evaluates against the conventions Claude can
judge but grep can't.

## When to use this skill

- Before a release, to find tests that drifted from conventions.
- After landing a large series of test changes, as a hygiene pass.
- When CLAUDE.md gains a new convention, to find existing tests that
  predate it.
- As a quarterly health-check on the suite.

## When NOT to use it

- For a single PR's diff — use code review, not a whole-suite scan.
- Mid-test-development — the conventions are guidance, not gates; let
  authors finish before judging.
- On `tests/bugs/` — **always excluded**. Staging tests are by
  definition WIP and don't pin a contract. The grep patterns below
  exclude `tests/bugs/` explicitly; if you copy them, keep that
  exclusion.

## Scope

All `.spec.ts` files under `tests/`, **except** `tests/bugs/**`. Lib
helpers (`tests/lib/`) and fixtures are reviewed against a reduced
ruleset (no `@spec` tag requirement, etc.).

## Output: the review report

Write a single markdown file at `docs/test-review-YYYY-MM-DD.md`.
Format:

```markdown
# Test-suite review — YYYY-MM-DD

Scope: tests/ (excluding tests/bugs/) — N files reviewed.

## Critical
(violations of non-negotiable rules; PRs should fix before merge)

- `<file:line>` — <one-line description>
  - **Why:** <which rule, from where>
  - **Fix:** <concrete suggestion>

## Important
(strong conventions; fix in a hygiene PR)

…

## Nit
(stylistic / minor refinements; fix opportunistically)

…

## Summary

| Severity | Count |
|---|---|
| Critical | … |
| Important | … |
| Nit | … |
```

## Mechanical checks (run all of these)

### 1. Hardcoded `https://foss.arbisoft.com` outside `constants.ts`

Convention: `constants.ts` derives every host from `FOSS_BASE_URL`. No
test should hardcode the platform URL.

```bash
grep -rnE 'https?://[a-z.-]*foss\.arbisoft\.com' tests/ \
  --include='*.spec.ts' --exclude-dir=bugs \
  | grep -v 'constants.ts'
```

**Expected:** 0 matches.
**If found:** import from `constants.ts` (`MAIN_URL`, `APP_URLS.<App>`,
`AUTH_PROXY_DOMAIN`, `COOKIE_DOMAIN`). Severity: **Critical** — host
overrides are explicit `FOSS_BASE_URL` users; a stray literal breaks
non-default deployments.

### 2. Hardcoded `_oauth2_proxy` outside `constants.ts` and tampering tests

Convention: import `AUTH_COOKIE` from `constants.ts`.

```bash
grep -rnE '"_oauth2_proxy"|'\''_oauth2_proxy'\''' tests/ \
  --include='*.spec.ts' --exclude-dir=bugs \
  | grep -vE '(cookie-tampering|session-fixation|constants\.ts)'
```

**Expected:** 0 matches (cookie-tampering / session-fixation tests
legitimately use the literal to assert tampering signals).
**If found:** import `AUTH_COOKIE` from `constants.ts`. Severity:
**Important**.

### 3. `waitForTimeout(` usage

Convention: no sleep-based waits; use locator-state waits
(`toBeVisible`, `toHaveURL`, `waitFor`).

```bash
grep -rnE 'waitForTimeout\s*\(' tests/ \
  --include='*.spec.ts' --exclude-dir=bugs
```

**Expected:** 0 matches.
**If found:** replace with `.waitFor({ state: 'visible' })`,
`.toBeVisible()`, or a `waitForURL(...)` that maps to the actual signal
being awaited. Severity: **Important**. Flakes from `waitForTimeout`
are the #1 cause of CI noise.

### 4. POM-style page-object classes

Convention: **no Page Object Model.** Apps are upstream-owned SPAs;
selector churn makes POM net-negative. Helpers live in
`tests/lib/app-menus.ts` (per-app function map), not classes.

```bash
grep -rnE 'class\s+\w+Page\s*\{' tests/ \
  --include='*.ts' --exclude-dir=bugs
```

**Expected:** 0 matches.
**If found:** decompose into per-app functions under `tests/lib/`.
Severity: **Important**.

### 5. `testData.json` / `data/` imports

Convention: all test inputs come from env vars and live deployment
state. Static data files would either be empty or duplicate
`constants.ts`.

```bash
grep -rnE 'from\s+["'\''].*/?(data/|testData)' tests/ \
  --include='*.ts' --exclude-dir=bugs
```

**Expected:** 0 matches.
**If found:** move the inputs into env (`FOSS_USER`, `NORMAL_USER`,
…) or into `constants.ts`. Severity: **Important**.

### 6. `tests/auth/` files missing `@spec` tag

Convention (per `skills.md` §1 vs §2): tests under `tests/auth/` map
to the openspec contract — each should pin at least one requirement
via `// @spec module#slug`. Tests under `tests/security/`,
`tests/apps/`, and `tests/flows/` are **orthogonal coverage**
(`skills.md` §2) — OWASP / per-app smoke / cross-app journeys that
the openspec doesn't claim — and **don't require `@spec` tags**.

```bash
find tests/auth -name '*.spec.ts' \
  | while read f; do
      grep -q '// @spec ' "$f" || echo "$f: no @spec tag"
    done
```

**Expected:** 0 lines printed.
**If found:** add `// @spec <module>#<requirement-slug>` above the
`test()` block. If the test belongs to orthogonal coverage,
**move it** under `tests/security/`, `tests/apps/`, or
`tests/flows/` rather than tagging.
Severity: **Important**.

> Earlier iterations of this check scanned all of `tests/` and
> over-flagged the 16+ files in `security/`, `apps/`, and `flows/`
> that are orthogonal by design. The `scripts/check-spec-coverage.sh`
> audit (run separately) already gets this right: it walks each
> openspec requirement and ensures it has a covering tag — agnostic
> to which directory the tag lives in. Use this check 6 only to
> catch *new* `tests/auth/` files that forgot to tag, not to enforce
> tagging everywhere.

### 7. `networkidle` usage anywhere in the suite

Convention (CLAUDE.md "Readiness is condition-based, never time-based"):
networkidle is unreliable across every SPA in this suite — Twenty's
GraphQL websocket, Outline's chunk loader, Penpot's hash router, the
portal's async session check all break it. Banned in both
`waitForLoadState("networkidle")` and `waitUntil: "networkidle"`
forms.

The meta hygiene spec (`tests/meta/playwright-practices.spec.ts`)
already fails CI on any match; this check exists for triage when the
meta spec reports violations or when scanning new files before they
land.

```bash
grep -rnE "waitForLoadState\s*\(\s*['\"]networkidle|waitUntil\s*:\s*['\"]networkidle" \
  tests/ --include='*.spec.ts' --exclude-dir=bugs
```

**Expected:** 0 matches.
**If found:** replace with the actual signal being awaited —
`waitForURL(regex)`, `locator.waitFor({ state: ... })`,
`expect(page).toHaveTitle(...)`, or `expect.poll(() => page.url()).toMatch(...)`.
Severity: **Critical** in `tests/auth/` and `tests/apps/twenty*`
(Twenty's websocket never settles, so the test will hang/timeout);
**Important** elsewhere.

### 8. `expect(await page.title())` instead of auto-retrying `toHaveTitle`

Convention: prefer Playwright's auto-retrying API form so the assertion
survives async render. The one-shot `expect(await page.title())` shape
fires once and is a known flake source.

```bash
grep -rnE 'expect\s*\(\s*await\s+page\s*\.\s*title\s*\(' tests/ \
  --include='*.spec.ts' --exclude-dir=bugs
```

**Expected:** 0 matches.
**If found:** rewrite as `await expect(page).toHaveTitle(/.../i)`.
Severity: **Nit** (rarely flakes in practice but trivial to fix).

## Semantic checks (read each test file and evaluate)

For each `.spec.ts` outside `tests/bugs/`, read and check:

### S1. Auth-landed pre-assertion before post-auth UI assertions

The lesson from FOSSSMBBUN-69 / FOSSSMBBUN-88: the FOSS portal does
an asynchronous session check on landing. `waitForLoadState('networkidle')`
returns before the check completes. A test that immediately asserts
on authenticated UI can race and hit the logged-out landing.

**Look for:** tests that `goto(MAIN_URL)` then immediately
`expect(...)` on authenticated-only elements without first verifying
a known authenticated element (or the absence of "Login" CTA).

**Fix:** before the bug-relevant assertion, add an explicit
`await expect(<auth-confirmed-element>).toBeVisible()`. Example:
the launchpad's app-card grid (`getByText('Outline')` etc.) renders
only when authenticated.

Severity: **Important**.

### S2. Shared-helper usage

Convention: use `cognitoLogin()`, `freshLogin()`,
`openLogoutMenu[<app>]`, `escapeHostForRegex()`. Never roll your own.

**Look for:** tests that type into IDP fields directly
(`page.locator('input[name="email"]').fill(...)` etc.) — possible
duplicated login choreography.

**Fix:** call `cognitoLogin(page)` or `freshLogin(browser)`.

Severity: **Important** if duplicated login logic exists; **Nit** if
the test has a partial helper-like internal function that could be
extracted.

### S3. Assertion messages

Convention: assertions include a message describing expected vs
observed. Default Playwright failure messages are often opaque.

**Look for:** `expect(x).toBe(y)` without the second message arg —
especially in branches where multiple expectations could fail.

**Fix:** `expect(x, "after <action>, <expected> — currently <buggy>").toBe(y)`.

Severity: **Nit** — but Critical for tests in `tests/auth/` where
failure context dictates the on-call response.

### S4. Locator vs sleep waits

Already caught by check 3 (`waitForTimeout`), but also look for:
- `await new Promise(r => setTimeout(r, ...))`
- `await page.waitForTimeout` (same thing, just syntactic variant)
- ad-hoc `for (let i = 0; i < N; i++) { await page.waitForTimeout(...); }` polling
- `delay(...)` / `setTimeout(...)` from `node:timers/promises` **used
  as a readiness wait** (the import is allowed only for *pacing* —
  rate-limit politeness, between-link gaps, throttle spacing — never
  to wait for UI/state to appear)

**Fix:** locator-state waits, `waitFor({ state: ... })`,
`waitForURL(...)`, or `expect.poll(...)` against the observable.

Severity: **Important**.

### S5. Test single-responsibility

Convention: tests are organised by invariant. A single test should
pin one invariant, not three.

**Look for:** tests with multiple `expect` blocks asserting unrelated
things, OR test names like "smoke" / "happy path" that paper over
multiple assertions.

**Fix:** split into named tests under the same `describe`. Each name
pins one invariant.

Severity: **Nit** — only flag when the multi-assertion is genuinely
unrelated, not when it's a chain pinning one observable.

### S6. Cookie/storage mocking shortcuts

CLAUDE.md: "Don't mock the SSO cookie or storage. Cookie surgery is
allowed for specific invariants (tampering, fixation) but always
with a fresh-page navigation after."

**Look for:** `context.addCookies` / `context.clearCookies` /
`localStorage.setItem` from page evaluate, in tests outside the
explicitly-allowed list (`cookie-tampering.spec.ts`,
`session-fixation.spec.ts`, identity-switch tests).

**Fix:** drive the state via the real flow (login, logout, navigate).
Cookie surgery in invariant tests is a shortcut that bypasses the
contract being tested.

Severity: **Critical** if the mocked state is the system-under-test;
**Important** otherwise.

## Workflow

1. Run the 8 mechanical checks. Collect findings.
2. For each `.spec.ts` outside `tests/bugs/`, read and apply the 6
   semantic checks. Collect findings.
3. Categorise by severity (Critical / Important / Nit).
4. Write the report at `docs/test-review-$(date +%F).md`.
5. If invoked interactively, also print the Critical + top-3 Important
   findings to chat for quick visibility.

## Cross-references

- `CLAUDE.md` — suite conventions + per-app gotchas (the source of
  truth for what's a violation)
- `skills.md` §1 / §2 / §8 — how tests are organised by invariant
- `scripts/check-spec-coverage.sh` — separate audit for `@spec` tag
  coverage against the openspec contract
