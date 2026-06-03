# FOSS E2E — Findings, Link-Coverage, Bug Staging

Working notes for the e2e suite that don't fit into the audit table.
What lives here:

| § | Content |
|---|---|
| §1 | Orthogonal coverage — tests this suite ships that the openspec doesn't claim (OWASP edge-layer, product UX, per-app admin gating) |
| §2 | The per-app link-coverage contract — L1 through L8, enforced by `tests/lib/link-coverage.ts` |
| §3 | Per-app branding assertions (where applicable) |
| §4 | Adding a new app — five-step checklist |
| §5 | Findings + known limitations (F1–F11) — hard-won caveats about what each test catches and what it doesn't |
| §6 | Implementation reference — pointers to the lib files |
| §7 | Bug staging — the `tests/bugs/` lifecycle, including the test-writer agent pipeline |

For the **openspec coverage table** (which test pins which requirement),
see [`docs/spec-coverage.md`](./docs/spec-coverage.md). For the **gap
pile with reasons**, see [`docs/spec-coverage-deferred.md`](./docs/spec-coverage-deferred.md).
For **how to walk a spec/test PR**, see
[`docs/spec-review-checklist.md`](./docs/spec-review-checklist.md).

The canonical SSO rule source is vendored at
[`vendor/openspec/specs/`](./vendor/openspec/specs/) and per-app +
security-hardening rules at [`vendor/openspec/skills/`](./vendor/openspec/skills/).
Run `make audit` for live coverage numbers.

---

## §1 — Orthogonal coverage (not in openspec)

Tests this suite ships that the openspec contract doesn't claim. Each
test answers a real production-incident risk that lives outside the
SSO contract's scope.

### Edge-layer hardening (infra / OWASP)

| Test | What it pins |
|---|---|
| `tests/security/http-no-plaintext.spec.ts` | Every host on port 80 redirects to https or refuses the connection — no 2xx ever served over plain HTTP. |
| `tests/security/headers.spec.ts` | Every `*-secure`, `*-bypass`, `oauth2-proxy-secure`, and `oauth2-apps` router emits the canonical security-headers set (HSTS ≥180d + includeSubDomains, X-Content-Type-Options=nosniff, X-Frame-Options=DENY/SAMEORIGIN, Referrer-Policy, Permissions-Policy denying camera/mic/geo). |
| `tests/security/open-redirect.spec.ts` | OWASP A01 — 4 `rd=` payload variants (absolute external, protocol-relative, backslash-bypass, triple-slash) × 5 apps = 20 cases. |
| `tests/security/session-fixation.spec.ts` | OWASP A07 — pre-planted `_oauth2_proxy` value must be rejected on its own (IDP bounce) before login overwrites it. |
| `tests/security/no-tokens-in-url.spec.ts` | OWASP A09 — no `access_token` / `id_token` / `code` / refresh-token / JWT in any post-login URL (query string or fragment). |
| `tests/security/csrf-logout.spec.ts` | SameSite=Lax defence on `/oauth2/sign_out` — cross-origin `<img>` / `fetch` cannot clear the SSO cookie. |

### Product contracts (not in SSO openspec)

| Test | What it pins |
|---|---|
| `tests/security/sso-mode-no-local-login.spec.ts` | `AUTH_TYPE=SSO` UI gate — every known local-auth route (Plane `/sign-in`, Outline `/auth/email`, etc.) MUST NOT render a reachable `<input type="password">` or a visible local-login affordance. |
| `tests/flows/deep-link-after-login.spec.ts` | UX contract — cold visit to a deep URL → SSO login → land on the deep URL (3 apps; Penpot uses hash routing and SurfSense forces `/login`, both documented in the test header). |

### Per-app admin gating (workspace-auto-join partial coverage)

These pin per-app authorization (separate from the SSO contract) and
together provide partial evidence that auto-joined NORMAL_USER does
NOT end up with admin access. The
`workspace-auto-join#auto-join-role-shall-be-the-app-s-regular-member-role-not-admin-or-guest`
requirement is tracked in [`docs/spec-coverage.md`](./docs/spec-coverage.md)
and its deferred entry in
[`docs/spec-coverage-deferred.md`](./docs/spec-coverage-deferred.md).

| Test | What it pins |
|---|---|
| `tests/apps/outline-admin.spec.ts` | FOSS_USER reaches every `/settings/*` admin page; NORMAL_USER is gated for the 8 admin-only paths. |
| `tests/apps/twenty-admin.spec.ts` | FOSS_USER reaches `/settings/admin-panel` (`canAccessFullAdminPanel`); NORMAL_USER is bounced. |
| `tests/apps/penpot-admin.spec.ts` | FOSS_USER (team Owner) sees "Invite people" + role combobox; NORMAL_USER (Editor) doesn't. |
| `tests/apps/surfsense-admin.spec.ts` | FOSS_USER (SearchSpace Owner) sees role-change buttons; NORMAL_USER (Editor) sees static text. |
| `tests/apps/pm-admin.spec.ts` | FOSS_USER (workspace owner) reaches `/<slug>/settings/members`; NORMAL_USER (non-member) sees Plane's "Workspace not found" shell. |

---

## §2 — Per-app link-coverage rules (this skill)

Implemented by `tests/lib/link-coverage.ts` and registered via
`registerLinkCoverage({ appName, baseUrl })` from each `tests/apps/<app>.spec.ts`.

| # | Rule | Why |
|---|------|-----|
| L1 | Visiting the app's `baseUrl` redirects to a **non-reserved** start URL on the same host | Confirms post-login routing isn't stuck on `/auth`, `/login`, `/onboarding`, etc. — the user has a real workspace. |
| L2 | The start page exposes ≥1 same-host `<a href>` | Catches blank-shell renders and SSR auth-loop failures. |
| L3 | Every discovered link returns HTTP `<400` on direct GET | Catches broken routes, dead views. |
| L4 | Every link stays on the app's host (no off-host bounce) | Catches mid-session SSO loss / bad OAuth state. |
| L5 | No link lands on the auth wall (`isAuthWall` = oauth2-proxy or any IDP host) | Same as L4 from a different angle — cookie scoping or expiry regression. |
| L6 | No visited page's title says `404` or `not found` | Catches "200 OK with error body" cases. |
| L7 | Clicking each visible link (when present in DOM) keeps the user on the app's host | Verifies actual click semantics, not just GETtable URLs. |
| L8 | Logout / sign-out paths are **excluded** from the link set | Crawling them would destroy the SSO cookie mid-test. |

### Reserved start-path segments (L1)

If `baseUrl` redirects to a path whose first segment is one of:

```
auth, login, signin, sign-in, sign_in, signup, sign-up,
logout, sign_out, signout, oauth2, onboarding,
create-workspace, invitations, god-mode, accounts, api, static, _next
```

…the test fails loudly: the user has no workspace or is unauthenticated.

### Excluded link patterns (L8)

Any link whose pathname matches `/(logout|sign_out|signout)/i` is dropped from
the discovery set before the assertions in L3–L7 run.

### Apps without `<a href>` nav (Penpot)

Apps whose UI uses click-handler-driven nav (listitem/button) instead of
anchor tags can't be covered by the generic factory. Penpot is the only
such app today — its spec hits well-known hash routes directly
(`/#/dashboard/recent`, `/#/settings/profile`, etc.) and asserts the
same invariants the factory would (host stays put, no auth wall, no 404
title). The `requireLinks: false` factory flag is still available for
future apps in the same shape.

### Tour overlay handling (SurfSense, etc.)

Apps that ship a product tour cover the page with an invisible
`aria-label="Close tour"` button that intercepts pointer events. The factory
calls a best-effort `dismissTour()` before discovery and before each click, and
all clicks use `force: true` to bypass any remaining overlay.

---

## §3 — Per-app branding (optional)

When an app sets a recognizable `<title>`, assert it once in
`tests/apps/<app>.spec.ts`:

| App | Title pattern | Verified |
|-----|---------------|----------|
| Outline   | `/outline/i` | ✅ `outline.spec.ts` |
| Penpot    | `/penpot/i`  | ✅ `penpot.spec.ts` |
| Plane (PM) | not branded reliably | — skip |
| SurfSense | not branded reliably | — skip |

---

## §4 — Adding a new app

1. Add a URL to `APP_URLS` in `constants.ts` (env-overridable via `FOSS_APP_<NAME>`).
2. Create `tests/apps/<app>.spec.ts`:
   ```ts
   import { APP_URLS } from "../../constants";
   import { registerLinkCoverage } from "../lib/link-coverage";

   registerLinkCoverage({ appName: "MyApp", baseUrl: APP_URLS.MyApp });
   ```
3. (Optional) add a branding assertion in the same file.
4. The shared suites that iterate `APPS` pick the new app up automatically
   (the `forwardauth-traefik` bypass / header-spoofing checks, the
   `session-lifecycle` two-layer + re-establish tests, the `logout-flow`
   portal-logout tests, the `oauth2-proxy-gateway` cookie-domain checks).
5. Manual wiring for the per-app gated suites:
   - **`tests/security/sso-mode-no-local-login.spec.ts`** — add a
     `LOCAL_AUTH_ROUTES` entry mapping the new app's name to its
     local-auth paths (`/sign-in`, `/auth/email`, etc.). Apps without
     an entry self-skip.
   - **`tests/auth/identity-consistency.spec.ts`** — add a `PROBES`
     entry with the app's `/me`-shape endpoint and an email-extraction
     function (pins `cognito-claim-mapping#standard-claim-header-mapping`).
   - **`tests/security/bypass-surface.spec.ts`** — extend
     `APP_BYPASS_EXTRAS` with the new app's documented bypass paths and
     any regression-guarded gated paths.
   - **`tests/lib/app-menus.ts`** — add an `openLogoutMenu` entry for
     the new app's user-menu choreography (used by
     `tests/auth/logout-invariants.spec.ts` sub-test 3).

---

## §5 — Findings + known limitations

Tests that catch SOME failure modes but not all, plus deployment-state
observations that affect interpretation.

### Limitations of individual tests

| # | Test | What it catches | What it does NOT catch | Why |
|---|------|-----------------|------------------------|-----|
| F1 | `tests/security/header-spoofing.spec.ts` (authed strip-middleware test) | Backend that explicitly prefers inbound headers over ForwardAuth-injected ones; mpass-auth accidentally removed from a router | Missing `strip-auth-headers` on stacks where Traefik REPLACES (rather than appends) `X-Auth-Request-Email` with oauth2-proxy's value | Traefik's `authResponseHeaders` behavior varies; when it replaces, the spoofed value gets overwritten by mpass-auth even with strip removed, and the test passes vacuously. `forwardauth-traefik#header-overwrite-shall-be-enforced` remains a partial audit invariant |
| F2 | `tests/auth/identity-consistency.spec.ts` (canonical-derivation check) | One backend's `DEFAULT_EMAIL_DOMAIN` env diverges from the others | Every backend AND oauth2-proxy uniformly misconfigured (e.g. all containers reading the same wrong env var) | `/oauth2/userinfo` is itself part of the chain we're verifying; closing this fully would need a direct Cognito `/userInfo` call from outside the proxy |
| F3 | `tests/security/strip-on-bypass.spec.ts` | Bypass router pointed at a misconfigured / dead backend | `strip-auth-headers` actually running before the bypass upstream | None of the tested bypass paths (`/favicon.ico`, `/god-mode`) read `X-Auth-Request-*`, so the presence of strip is unobservable from outside |
| F4 | `tests/auth/identity-consistency.spec.ts` (per-backend probes) | Per-backend identity divergence for Plane/Outline/Penpot/SurfSense | Twenty's backend identity | Twenty's `/rest/*` endpoints require a JWT Bearer (not the SSO cookie); the SPA also hides identity-managed fields by design. Twenty's identity goes through one SSO controller (`sso-proxy-login.controller.ts:resolveEmail`), audited manually |
| F5 | `tests/security/sso-mode-no-local-login.spec.ts` (local-login affordance regex) | Routes that render an explicit `forgot password` / `continue with email` / `sign in with password` affordance | A SPA that renders a local-login form using only generic "Sign in" / "Log in" button text and no other affordance | Broadening the regex to bare "Sign in" would false-positive on the legitimate SSO redirect page itself. The `<input type=password>` check is the stronger primary signal |
| F6 | `tests/flows/identity-switch-after-relogin.spec.ts` | Stale identity caches on relogin across all apps | **Penpot is currently skipped** (`SKIP_APPS_KNOWN_STALE`) — the localStorage `penpot-user:/profile` cache and `/#/settings/profile` form pre-fill render the previous user, but mutations correctly target the active user, so it's a cosmetic display issue not a functional leak |

### Deployment-state observations

| # | Observation | Implication |
|---|-------------|-------------|
| F7 | Cognito returns a **bare username** (verified: `1020010000019120`) | The `DEFAULT_EMAIL_DOMAIN` synthesis path IS exercised on this deployment. Every backend's `/me` returns `<sub>@askii.ai`. If the deployment migrates to email-as-subject, the cognito-claim-mapping consistency tests trivially pass without exercising synthesis — re-evaluate then |
| F8 | Twenty's first-paint client redirect aborts in-flight `load` / `domcontentloaded` navigations | `tests/apps/twenty.spec.ts` uses `waitUntil: "commit"`; `tests/auth/logout-invariants.spec.ts` catches `ERR_ABORTED` in its warm loop |
| F9 | Twenty's sidebar mutates by route — anchors discovered on one view aren't all rendered after a reset goto | L7 silently skips discovery-time hrefs not currently rendered; asserts `clicked > 0` so the test never silently degrades |
| F10 | Outline `accessToken` cookie currently expires in ~92 days (`addMonths(3)`) | Session-expiry tests use `FOSS_MAX_SESSION_TTL_SECONDS` (default 92 days) so deployments with multi-month TTL remain verifiable without hardcoding a 30-day ceiling |
| F11 | Outline deployment occasionally returns HTTP 429 on burst requests to `/home`, `/search`, `/drafts`, `/archive` and chunk loads | `tests/lib/link-coverage.ts` (Outline) and `tests/apps/outline-admin.spec.ts` (`/settings/authentication`) flake under load — surface as Outline-side rate-limit issues, not test bugs |

### Audit cadence

- F1 (strip-middleware caveat) and F2 (uniform DEFAULT_EMAIL_DOMAIN
  caveat) mean `forwardauth-traefik#header-overwrite` and
  `cognito-claim-mapping#identity-claim` remain partial audit
  invariants. Re-audit on every change to `docker-compose.yml` Traefik
  middleware chains or any container's identity-related env vars.
- F4 (Twenty omitted from per-backend identity probes) is acceptable so
  long as Twenty has exactly one SSO entry path
  (`sso-proxy-login.controller.ts`). If Twenty grows a second
  identity-issuance path (e.g. CLI auth), revisit and add a probe.
- F6 (Penpot skip in identity-switch test) remains until Penpot's SPA
  invalidates `penpot-user:/profile` localStorage on identity change.

---

## §6 — Implementation reference

Single source of truth: `tests/lib/link-coverage.ts`

- `resolveStartUrl(page, baseUrl)` → enforces L1.
- `waitForAnchors(page, { requireLinks })` → waits for anchor count to
  stabilize before discovery, so SPAs with streaming sidebars (Twenty)
  aren't sampled mid-hydration.
- `collectInternalHrefs(page, host)` → enforces L8 + dedupe + same-host filter.
- `registerLinkCoverage({ appName, baseUrl, includeClickTest?, waitUntil? })` →
  registers the L2 + L3–L6 + L7 tests inside a per-app `describe` block.

Per-app helpers: `tests/lib/app-menus.ts` — `openLogoutMenu` per app
(Outline / Plane / Penpot / SurfSense / Twenty), used by
`tests/auth/logout-invariants.spec.ts`.

Audit script: `scripts/check-spec-coverage.sh` — verifies every openspec
requirement is either covered by a `// @spec` tag or in
`docs/spec-coverage-deferred.md`. CI fails on uncovered new requirements.

---

## §7 — Bug staging (unverified reproductions)

A fourth class of tests, distinct from §1 (openspec coverage), §2
(orthogonal coverage), and §3 (per-app link coverage): **reproductions
for bugs that are not yet fixed**.

These live under `tests/bugs/` and **fail today** against the live
sandbox (failure = bug confirmed reproducible). The dedicated
`bug-tests-run.yml` workflow runs them with **normal red-on-fail CI
semantics** — a failing staging test fails the PR's CI. That red status
is the explicit signal that the underlying bug isn't fixed yet. They
are the output of the test-writer agent (`agents/test-writer/` — see
`agents/test-writer/ARCHITECTURE.md` for the full pipeline design) and
are spec-driven: each one has a sibling plan markdown:

```
tests/bugs/specs/bug_<short-id>.plan.md     — the per-bug spec (scenarios,
                                              steps, `- expect:` bullets,
                                              optional `## Open Questions`)
tests/bugs/bug_<short-id>.spec.ts            — the executable test;
                                              first non-import line is
                                              `// spec: <path-to-plan.md>`
```

### Lifecycle

1. **Stage.** Test-writer reads a Plane ticket, writes the plan + test
   under `tests/bugs/`, opens a PR. The test fails today. The plan is
   the spec of intent.
2. **Run in CI without polluting the main suite.** The default
   `playwright.config.ts` excludes `tests/bugs/` via `testIgnore`. The
   dedicated `bug-tests-run.yml` workflow opts in via
   `PW_INCLUDE_STAGING=1` and runs ONLY the files in the PR/push diff
   (not the whole `tests/bugs/` dir). It uses **normal red-on-fail CI
   semantics**: a failing test fails the workflow → PR stays red until
   the bug is actually fixed. Once the test passes (bug fixed), the
   workflow goes green and the test is ready for promotion (step 4).
3. **Iterate (heal phase).** If a generated test fails for the wrong
   reason (e.g. wrong selector, wrong IDP shape), update **both** the
   plan and the test to keep them in sync — the plan stays the source
   of intent. See `CLAUDE.md` → "Heal-phase discipline" for the
   diagnose / fix / reconcile workflow.
4. **Promote on fix.** Once the upstream fix lands and the test
   actually passes, **move** the spec out of `tests/bugs/` into the
   right invariant folder (most often `tests/auth/`, `tests/apps/<app>/`,
   or `tests/flows/`) and add a `// @spec module#requirement-slug` tag.
   At that point normal red-CI semantics resume — the test pins a
   requirement.
5. **What happens to the plan.** The plan can stay as a historical
   record in `tests/bugs/specs/` (renamed for clarity), or be promoted
   into a formal openspec change proposal if the contract should grow
   to cover the invariant. Decision is per-bug.

### No `@spec` tag on staging

Bug-staging tests deliberately do **not** carry `@spec` tags. They
don't pin a current contract requirement (the bug is, by definition,
something the system *should not* do). Adding a tag prematurely would
either link to a wrong requirement or trip the audit on a fake
"covered" entry. The audit script's grep over `tests/` includes
`tests/bugs/` but ignores files with no tags — which is exactly what
we want.

### Running staging tests

```bash
# All staging reproductions
PW_INCLUDE_STAGING=1 npx playwright test tests/bugs/ --reporter=list

# Single bug, headed with visual pacing
PW_INCLUDE_STAGING=1 PW_DEBUG_VISUAL=1 \
  npx playwright test tests/bugs/bug_<short-id>.spec.ts --headed --workers=1
```

### Generating a new staging reproduction

```bash
cd agents/test-writer
make list                  # see open Plane bugs (read-only)
make test ID=92            # resolve + scope + write plan + test + verify
make test ID=92 FORCE=1    # overwrite an existing tests/bugs/bug_<id>.spec.ts
```

The agent's prompt enforces the spec-driven flow (plan first, then
test) and a 3-mode triage so it asks before guessing on ambiguous
bug reports. Details in `agents/test-writer/ARCHITECTURE.md` and the
`test-writer` skill at `.claude/skills/test-writer/SKILL.md`.
