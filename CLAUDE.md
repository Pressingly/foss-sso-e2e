# Claude Code working notes

For a Claude session dropped into this repo. Human onboarding lives in
[`README.md`](./README.md); this file is the Claude-specific quick-start.

## What this suite is (in one paragraph)

End-to-end Playwright tests that verify the **SSO contract** (oauth2-proxy
+ Traefik ForwardAuth + per-app middleware) across 5 third-party apps —
**Outline**, **Plane (PM)**, **Penpot**, **SurfSense**, **Twenty** — plus
the **mPass/Cognito** identity layer. The unit under test is an *invariant*
(cookie shared, session re-established from headers, header overwrite
enforced, …) not a single product. Apps are upstream; we don't own their UI.

## Read these in order

1. [`README.md`](./README.md) — env setup, run commands, what's covered
2. [`skills.md`](./skills.md) — the contract organised by openspec module
3. [`docs/spec-coverage.md`](./docs/spec-coverage.md) — traceability matrix (which test pins which requirement)
4. [`docs/spec-coverage-deferred.md`](./docs/spec-coverage-deferred.md) — gap pile + categories
5. [`TESTS.md`](./TESTS.md) — per-test catalog

The canonical SSO rule source is the openspec at
[awais786/sso-rules-moneta](https://github.com/awais786/sso-rules-moneta/tree/main/openspec/specs)
(private repo — fetching needs `SPEC_REPO_TOKEN`).

## Conventions

- **One env var (`FOSS_BASE_URL`) drives the entire host topology.** All
  app hosts, the ForwardAuth host, and the cookie domain are derived in
  `constants.ts`. Never hardcode hosts. Hoisted per-deployment values
  also live in `constants.ts`: `COGNITO_EMAIL_DOMAIN`, `PENPOT_TEAM_ID`,
  `PLANE_WORKSPACE_SLUG`, `SURFSENSE_SEARCH_SPACE_ID` (each
  env-overridable).
- **Use the shared helpers, don't redefine them per-spec.**
  - `cognitoLogin()` from `auth-helpers.ts` — the one login choreography.
  - `freshLogin()` + `clickPortalLogoutAll()` from `tests/lib/common-flows.ts` — for tests that need their own non-worker context.
  - `openLogoutMenu[appName]` from `tests/lib/app-menus.ts` — per-app user-menu choreography.
  - `escapeHostForRegex(host)` from `constants.ts` — instead of `.replace(/\./g, "\\.")`.
- **`@spec <module>#<requirement-slug>` tag above the `test()`** is the
  canonical link between a test and the openspec requirement it pins.
  `scripts/check-spec-coverage.sh` enforces every requirement is either
  tagged or in `docs/spec-coverage-deferred.md`.
- **Tests behave like humans.** No cookie/storage mocking shortcuts.
  Flake fixes mirror human pacing (real clicks, locator state waits over
  `waitForTimeout`).
- **Readiness is condition-based, never time-based.** Banned suite-wide:
  `waitForLoadState("networkidle")`, `waitUntil: "networkidle"`, and
  `page.waitForTimeout` for readiness. Every SPA here breaks networkidle
  one way or another (Twenty's GraphQL websocket, Outline's chunk
  loader, Penpot's hash router, the portal's async session check).
  Replacements: `waitForURL(regex)`, `locator.waitFor({ state: ... })`,
  `expect(page).toHaveTitle(...)`, `expect.poll(() => page.url())` against
  the actual observable. For *pacing/throttling only* (rate-limit
  politeness, between-link gaps) import `delay` from
  `node:timers/promises` — never use it as a readiness escape hatch.
  Enforced by `tests/meta/playwright-practices.spec.ts` (CI gate).
- **Group tests by invariant, not by page.** `tests/security/` is OWASP
  / edge-layer; `tests/auth/` is SSO chain + session lifecycle;
  `tests/apps/` is per-app smoke + admin gating; `tests/flows/` is
  multi-app journeys; `tests/bugs/` is targeted bug-reproductions.
- **TS strict + `noUncheckedIndexedAccess`** are on. For provably-safe
  array access (e.g. `APPS[0]` where `APPS` is a hardcoded 5-entry
  ReadonlyArray), use the `!` non-null assertion rather than restructuring.

## Deployment gotchas

| | |
|---|---|
| **Twenty** | Keeps a GraphQL websocket open; never reaches `networkidle`. Use `waitUntil: "commit"` + explicit render checks. Top-level navs can hit `ERR_ABORTED` AND can bounce back to the previous page's host — see the retry-loop pattern in `tests/auth/session-sharing.spec.ts:148` (round-trip across all apps). |
| **Penpot** | Hash routing (`/#/...`) — deep-link preservation skips it. `localStorage["penpot-user:/profile"]` is a stale display cache after relogin; `identity-switch-after-relogin.spec.ts` skips Penpot via `SKIP_APPS_KNOWN_STALE` (cosmetic only, mutations correctly target the active user). |
| **Outline** | Rate-limits chunk loads under burst → intermittent 429 flakes in `link-coverage.ts` + `outline-admin.spec.ts /settings/authentication`. Not test bugs. |
| **Plane (PM)** | God-mode uses local creds, NOT SSO (`pm-godmode.spec.ts`). The shared SSO workspace is `fossarbisoft` — both `FOSS_USER` and `NORMAL_USER` are auto-joined as **Member** (role=15) there (the auto-join-role contract `pm-admin.spec.ts` pins); only `system-bot@foss.arbisoft.com` has the Admin role. A separate `aa` workspace exists where `FOSS_USER` IS Admin (role=20), but the shared admin tests use `fossarbisoft`. Slug overridable via `PLANE_ADMIN_WORKSPACE_SLUG`. `foss-server-bundle`'s `scripts/provision-admin/plane.py` (PR #63) can promote a chosen email to Admin in `fossarbisoft`, but it has NOT been run with `FOSS_USER`'s email on the live sandbox — the current state is the auto-join Member default. |
| **SurfSense** | Forces a `/login` redirect on every post-SSO landing — excluded from deep-link preservation test. |
| **IDP / mPass** | The unauthenticated landing on the IDP host is a **method picker** ("QR Code Login" / "Password Login") — NOT a direct username/password form. `cognitoLogin()` clicks "Password Login" internally before filling fields. Tests calling `cognitoLogin()` shouldn't pre-assert on `input[type="password"]` visibility before the helper runs — assert on the method picker (e.g. `getByText(/password login/i)`) or skip the pre-assertion and trust `cognitoLogin` to find the right form. |
| **Multi-tab login mutex** | Only **one** OAuth login flow can be in progress per browser at a time (FOSSSMBBUN-88 / `session-lifecycle#single-flight`). The portal Login button reads a non-HttpOnly `mpass_login_lock` cookie set by `/authorize`; mpass-auth-proxy returns **409** as a server-side backstop. TTL = 600s. Tests that start a login but **don't complete it** must either complete or close the context before starting a second concurrent flow — otherwise the second `/authorize` 409s. The lock cookie is cleared on successful `/mpass-callback`, on failed `/mpass-callback` (any path), and on `/mpass/logout`. |
| **Identities** | `FOSS_USER` is "User A" on the live sandbox (verified by direct API probes): Outline `users.role = "admin"` (workspace-level admin, team UUID `1a2e0bad-…` per `OUTLINE_TEAM_ID`), Penpot Owner of personal "Default" team (UUID `c16a7502-…` per `PENPOT_TEAM_ID`) and Editor on the `fossarbisoft` SMB team, SurfSense Owner of search space id 1 (`SURFSENSE_SEARCH_SPACE_ID`), Plane Member of `fossarbisoft` (role=15) / Admin of `aa` (role=20), Twenty `canAccessFullAdminPanel=true`. `NORMAL_USER` is "User B" — non-admin baseline everywhere; non-admin tests self-skip when unset. `PLANE_ADMIN_USER`/`PLANE_ADMIN_PASS` is the local-creds god-mode admin (separate from SSO). `foss-server-bundle`'s `scripts/provision-admin/*` (PR #63) can promote a chosen email to SMB-workspace admin/owner in each app; on the current sandbox it has NOT been run with FOSS_USER's email, so FOSS_USER stays at the auto-join Member role within the SMB scope. |
| **Private spec source** | `awais786/sso-rules-moneta` is private. The audit script reads `SPEC_REPO_TOKEN` for auth in CI; locally use `SPEC_DIR=/path/to/local/openspec/specs`. |

## What to work on (live)

Live coverage is **25 ✅ Covered / 26 ⚠️ Deferred / 0 ❌ Missing / 51
total** (re-run `make audit` to refresh). The deferred file's
**"Genuine test gap"** category is the next-coverage-PR pile.
Highest-value remaining items: the remaining workspace-auto-join
requirements (oldest-workspace target, runs-every-login,
onboarding-complete) and the cognito-claim-mapping cookie ↔ bearer
parity.

Don't touch the **"Infra-only"**, **"Cognito-side"**, **"Policy/doc"**, or
**"Needs infra access"** deferred entries — those are by-design out of
this suite's scope; the bundle-side `audit-sso.sh` covers infra-only.

## What NOT to do

- **Don't introduce Page Object Model.** The 5 apps are upstream-owned
  SPAs with churning selectors; per-app helpers in `tests/lib/app-menus.ts`
  are the right granularity. POM here adds indirection without reducing
  churn.
- **Don't add `data/` or `testData.json`.** All test inputs come from
  live deployment state and env vars. A static data file would either
  be empty or duplicate `constants.ts`.
- **Don't reorganise tests by feature/page.** Tests group by invariant —
  see `skills.md` §1/§2 for the organising principle.
- **Don't mock the SSO cookie or storage.** Tests behave like humans;
  cookie surgery is allowed for specific invariants (cookie tampering,
  session fixation) but always with a fresh-page navigation after.
- **Don't add tests for requirements the openspec doesn't claim**
  without documenting them in `docs/spec-coverage-deferred.md`'s
  "Coverage outside the openspec contract scope" section.
- **Don't add `Co-Authored-By: Claude …` to commit messages.**
  Plain commit bodies only; the trailer is noise in this repo's
  history.

## Bug spec plan format

Every file under `tests/bugs/specs/<bug>.plan.md` follows this shape.
The test-writer agent and human authors both write to this template; the
test file's leading `// spec:` comment points back at the plan.

```markdown
# <BUG-ID> — <short title>

## Status

<One paragraph: fix shipped / open / blocked. Link the upstream PR.>

## Application Overview

<One paragraph: what feature breaks, which layer of the stack the bug
lives at, why the test enters where it does.>

## Test Scenarios

### 1. <Group name>

**Seed:** `tests/seed.spec.ts`, the worker `cognitoLogin` fixture, or
`none` if the test owns its own `BrowserContext`.

#### 1.1. <kebab-case-scenario-name>

**File:** `tests/bugs/bug_<id>.spec.ts`

**Steps:**
  1. <Concrete user step>
    - expect: <observable outcome>
    - expect: <another observable outcome>
  2. <Next step>
    - expect: <outcome>
```

Guidelines:

- One scenario per test file. Describe name + test name come verbatim
  from the spec (minus the ordinal).
- Steps are user-level ("click Login"), not API-level ("call `fill`").
- Each `- expect:` bullet becomes one explicit assertion in the test.
- Scenarios are independent — never chain.
- Cover happy path, edge cases, negative flows, persistence.

## Heal-phase discipline

When a `tests/bugs/` test fails, the plan stays the source of intent
and the test must be made to match the plan (or vice versa). Workflow:

1. **Diagnose.** Common causes: selector drift, new wrapper element,
   ARIA/label rename, timing (transition, async load), assertion text
   the app changed, test data leaking between runs.
2. **Fix the test.** Update the locator, assertion, step order, or
   inputs. **Never** add `waitForLoadState("networkidle")`, raw
   `waitForTimeout` pacing, or `--no-verify` shortcuts. Use
   `waitForURL`, `locator.waitFor`, or `expect.poll`.
3. **Reconcile with the spec.**
   - Fix was purely technical (locator drift, better assertion shape)
     and the spec's user-level behaviour still matches the app →
     leave the spec alone.
   - Fix changed user-visible steps, inputs, order, or outcomes the
     spec describes → update the spec to match. Keep the scenario id
     and file path stable; only step / expect lines change.
   - Unclear whether the app change is intentional (spec is stale) or
     a regression (test was right, app is wrong) → **stop and ask**.
     Quote the scenario id, the spec lines that no longer match, and
     the observed app behaviour.

## Verifying changes

```bash
make pre-commit                                     # typecheck + audit
PW_SLOW_MO_MS=0 npx dotenv -- npx playwright test \
  tests/path/to/spec.ts --reporter=list --workers=1 # run one file
SPEC_DIR=/path/to/sso-rules-moneta/openspec/specs \
  make audit                                        # local audit only
```

`make pre-commit` runs `npx tsc --noEmit` + the spec-coverage audit.
For per-file runs prefer `--workers=1` — running 4 specs in parallel
can trip Twenty's SPA-state cross-contamination.

CI runs the full chromium suite + spec-coverage audit. The Outline 429
flakes and the known identity-switch-Penpot-skip behaviour are not
blockers — read the failure message before assuming a real regression.
