# Test-suite review — 2026-06-10

Scope: `tests/` (excluding `tests/bugs/`) — 55 spec files reviewed
(13 apps, 14 auth, 4 flows, 1 meta, 23 security, 1 zap).

Two questions drove this pass: (1) is the suite in good shape
(conventions, shape-correctness, flake patterns); (2) is every app
actually exercised — Outline, Plane/PM, Penpot, SurfSense, Twenty, plus
the mPass/Cognito identity layer.

**Headline:** mechanically clean (all 8 convention checks pass). No
unconditional skips, no `.only`, no vacuous-by-construction tests. All 5
apps + the identity layer are genuinely covered. The findings below are
all "passes when it shouldn't on a real but narrow break" — over-loose
assertions, not absent ones. The suite is unusually self-aware: most
partial checks already carry in-file LIMITATIONS comments.

## Coverage answer (question 2)

| App | Smoke verifies authed UI? | `-admin` asserts admin/non-admin distinction? | Verdict |
|---|---|---|---|
| **Outline** | Title-only smoke is thin, but link-coverage walks authed nav | **Yes** — strong three-way contract (cold-context SSO bounce / non-admin gated / admin reaches all paths) | Solid |
| **Plane/PM** | Link-coverage (no title smoke) | **Yes** — `pm-admin` + `pm-workspace-isolation` are the strongest in the suite (positive+negative, pre-conditioned) | Solid |
| **Penpot** | Title + hash-route walk | Partially — invitations "Invite people" pair is solid; members combobox is weak/unpaired | Mostly solid |
| **SurfSense** | Link-coverage | **Weakest** — owner/non-owner both lean on one unscoped role-label regex; positive side never verifies the control is actionable | Needs tightening |
| **Twenty** | Link-coverage (`commit` strategy) | Partially — negative (UI markers) is fine; positive accepts loose `markers OR api<400` | Needs tightening |
| **mPass/Cognito** | n/a — exercised as the identity layer under `tests/auth/` | identity-consistency, email-domain-consistency, concurrent-first-login, session-* all probe real backends | Solid |

No app is skipped-by-default. The skips that exist are all *conditional*:
the `appHealth` block-on-smoke gate (skips a cross-app test only when
that app's SSO chain is already broken — by design, per CLAUDE.md), the
env-gated Plane god-mode (`PLANE_ADMIN_USER`), and the documented
Penpot stale-cache skip (correctly scoped to Penpot only). One
`test.fixme` (real coverage hole, tracked) — see Important #7.

## Critical
None. No test pins nothing / can never fail.

## Important
(weak shape — would pass on a real but narrow regression; fix in a hygiene PR)

1. `tests/apps/surfsense-admin.spec.ts:148-151` — **vacuous / unscoped (SurfSense admin distinction not truly pinned).**
   - **Why:** Owner positive and non-owner negative both use the same
     unscoped regex `getByRole("button",{name:/^(owner|editor|viewer|admin)$/i})`,
     not scoped to *other members' rows*. The positive side never verifies
     the matched control is an actionable role-change button vs. a static
     role label, so it can pass without any owner-only affordance present.
   - **Fix:** Scope the owner assertion to other-members' rows and assert
     the control is an interactive role-change button distinct from static
     text; pair it with a non-owner negative on the same surface.

2. `tests/apps/twenty-admin.spec.ts:235-240` — **over-loose (Twenty admin positive can pass without admin UI).**
   - **Why:** `markerLooksAdmin || apiLooksAdmin`, where
     `apiLooksAdmin = adminApiResponse.status() < 400`. A bare 2xx on
     `/admin-panel-graphql-api` is accepted as proof of
     `canAccessFullAdminPanel` even with zero admin UI markers — and that
     endpoint can answer 200 with an error envelope for a non-admin in some
     Twenty builds.
   - **Fix:** Drop the `|| apiLooksAdmin` fallback, or require the API
     response body to carry actual admin data (not just HTTP < 400).

3. `tests/auth/layer2-re-establish.spec.ts:74-79` — **over-loose (does not prove header-driven re-establishment).**
   - **Why:** The headline re-establishment test only asserts
     `hostname === app host` and `isAuthWall === false`. An app that
     re-establishes by silently re-running the *full SSO bounce*
     (Cognito round-trip) lands on-host and passes identically — the
     docstring claims "no IDP bounce" but nothing asserts the absence of
     an intermediate IDP redirect.
   - **Fix:** Add a `/me`-style live-session probe (as `sso-login.spec.ts`
     already does at :48-56), or assert no IDP host appeared in the
     redirect chain.

4. `tests/auth/session-store-redis-backed.spec.ts:97-103` — **near-tautology ("cookie does not grow" is guaranteed).**
   - **Why:** `sizeAfter === sizeBefore` only catches growth if the worker
     session was freshly established *within this test*. The shared worker
     SSO cookie is already at steady-state size before this test runs, so
     the navigation loop cannot grow it — the assertion is effectively
     always-true regardless of Redis vs. cookie store. (The single-cookie /
     no-split-form / `< 3500` byte checks are the real load-bearing ones.)
   - **Fix:** Either establish a fresh login inside the test before the
     before/after measurement, or drop the growth assertion and lean on
     the size-bound check.

5. `tests/security/header-spoofing.spec.ts:91-124` (block B) — **over-loose (self-acknowledged).**
   - **Why:** On a Traefik stack that *replaces* `authResponseHeaders`, the
     spoofed header is overwritten by mpass-auth whether or not
     `strip-auth-headers` exists — so block B passes on the very
     misconfiguration it claims to catch. Documented in-file (:26-50).
   - **Fix:** Rely on `cross-user-impersonation.spec.ts` (which uses the
     *real* admin email and is the strong version of this) as the
     load-bearing test; consider downgrading block B to a documented smoke
     or adding the bundle-side `audit-sso.sh` invariant as the real gate.

6. `tests/security/jwt-algorithm-confusion.spec.ts:93-133` — **partial (HS256 leg can't prove true alg-confusion).**
   - **Why:** The HS256 leg signs with an arbitrary key, so it only catches
     "validator skips signature entirely," not the real attack (HMAC with
     the RSA *public* key). A server that rejects bad HS256 signatures but
     is still alg-confusable would pass. Documented at :96-101. The
     `alg:none` leg (:55-91) is sound.
   - **Fix:** Sign the HS256 token with the IdP's published RSA public key
     to exercise the genuine confusion path; if the public key isn't
     reachable at test time, note that as a deferred-coverage entry.

7. `tests/security/cache-control-authed.spec.ts:113` (`test.fixme`) — **real, tracked coverage hole.**
   - **Why:** The portal's authenticated landing HTML ships with *no*
     `Cache-Control` header today, so it is shared-cacheable and nothing
     enforces otherwise. The contract
     (`security-hardening#authenticated-responses-shall-forbid-shared-cache-storage`)
     is parked as `.fixme` pending `foss-server-bundle#83` (nginx config).
   - **Fix:** No test change — this is a bundle-side fix. Keep the `.fixme`
     so the contract text stays visible; un-skip when bundle#83 lands.

## Nit
(minor; tighten opportunistically)

- `tests/apps/pm-godmode.spec.ts:173` — CSRF endpoint asserted
  `status() < 400`; a 3xx into the auth chain would pass. Tighten to
  `toBe(200)` or assert the JSON `{csrf_token}` body.
- `tests/apps/outline.spec.ts:8-11` & `tests/apps/penpot.spec.ts:22-25` —
  title-only smoke ("page loaded," not "authenticated app UI rendered").
  Real depth comes from link-coverage; consider one authed-element assert.
- `tests/apps/penpot-admin.spec.ts:135` — "can manage members" leans on
  `getByRole("combobox").first()`, which a non-owner may also see. Add a
  paired non-owner `/members` check or target the role-change control
  specifically.
- `tests/apps/penpot.spec.ts:50` — `landed.includes(hash.split("?")[0])`
  is a loose substring match under hash routing; low risk (auth-wall +
  host checks carry the weight).
- `tests/security/per-app-cookie-theft.spec.ts:165,221` — if an app's
  session cookie is renamed outside `APP_SESSION_COOKIE_PATTERNS`, the
  theft test silently `test.skip`s as "vacuously safe" rather than
  failing. Add a loud assertion that ≥1 session cookie was found per
  known-stateful app.
- `tests/security/strip-on-bypass.spec.ts:52-94` — intentionally toothless
  (strip middleware unobservable on `/favicon.ico` + `/god-mode`); honestly
  labeled as a router-health smoke. No action, just noted.
- `tests/auth/identity-consistency.spec.ts:213-224` — the "canonical"
  anti-vacuous check derives `upstreamUser` from `/oauth2/userinfo`, the
  same chain under test; a shared-env-var misconfig passes vacuously.
  Self-documented (:150-160); the cross-backend check at :228-232 is the
  sound one.

## What's genuinely strong (don't touch)

- `tests/apps/pm-admin.spec.ts` + `pm-workspace-isolation.spec.ts` —
  the model the other `-admin` tests should follow: positive+negative,
  pre-conditioned so a blanket-broken session can't false-pass, API
  checks that accept 403/404 and reject any 2xx.
- `tests/security/host-header-injection.spec.ts` — best-engineered:
  low-level `node:https` to actually send a spoofed Host, randomized
  `.invalid` nonce, positive Location-allowlist on top of reflection.
- `tests/security/session-fixation.spec.ts` — proves the planted cookie
  is *rejected first*, defeating the classic vacuous "login overwrote it"
  pass.
- `tests/security/cross-user-impersonation.spec.ts` /
  `cookie-surgery-cross-user.spec.ts` — real identities, pre-conditioned
  baselines, genuinely pin the identity-mismatch-flush invariant.
- `tests/flows/cross-tab-logout-propagation.spec.ts` /
  `login-logout-flow.spec.ts` — prove logout *invalidated the session*
  (cookie cleared AND re-navigation bounces to IDP), not just that a
  button was clicked.
- `tests/auth/workspace-auto-join-independence.spec.ts` — head comment
  documents a *removed* vacuous UUID-collision check; current shape is a
  positive correlation against `constants.ts` with an emptiness guard.
  Good example of a fixed shape bug.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| Important | 7 |
| Nit | 7 |

Mechanical convention checks (hardcoded hosts, `_oauth2_proxy` literals,
`waitForTimeout`, POM classes, `testData`/`data` imports, untagged
`tests/auth/`, `networkidle`, one-shot `page.title()`): **all pass.**

Coverage: all 5 apps + the mPass/Cognito identity layer are exercised;
no app is skipped-by-default or wholesale-vacuous. The two apps whose
admin-distinction tests are weakest are **SurfSense** (Important #1) and
**Twenty** (Important #2) — both pass on a loose signal that doesn't
prove the admin/non-admin split. Tightening those two closes the only
real per-app coverage soft spots.
