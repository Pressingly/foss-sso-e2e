# SSO Contract → E2E Coverage Matrix

Traceability matrix between [awais786/sso-rules-moneta openspec contract](https://github.com/awais786/sso-rules-moneta/tree/main/openspec/specs) and this Playwright suite. Each requirement maps to either a covering test, a documented partial, or a deferred entry in [spec-coverage-deferred.md](spec-coverage-deferred.md).

**How to update:** when a new spec requirement lands upstream, either add a covering test with a `// @spec <module>#<requirement-slug>` tag above the `test()` call, or add an entry to `spec-coverage-deferred.md` explaining why it's not testable in this suite. `scripts/check-spec-coverage.sh` enforces that every requirement is in one column or the other.

**Legend:**
- ✅ Full — assertion directly pins the behaviour
- 🟡 Partial — covered indirectly or with a documented limitation
- ⚠️ Deferred — see [spec-coverage-deferred.md](spec-coverage-deferred.md) for rationale

---

## proxy-auth-middleware

| Requirement | Coverage | Test |
|---|---|---|
| Bypass paths SHALL short-circuit before any auth processing | ✅ | `tests/security/bypass-surface.spec.ts`, `tests/apps/pm-godmode.spec.ts` |
| Authenticated sessions with matching or absent proxy identity SHALL short-circuit | 🟡 Partial | `tests/auth/proxy-short-circuit.spec.ts` (Outline: session-cookie stability across 3 navigations; PM/Penpot/SurfSense/Twenty skip — no JS-readable session cookie, contract vacuously satisfied) |
| Identity mismatch SHALL flush the existing session immediately | ✅ | `tests/flows/identity-switch-after-relogin.spec.ts` |
| Unauthenticated requests with a valid proxy identity SHALL auto-provision and log in | ✅ | `tests/auth/sso-login.spec.ts` |
| Email normalisation SHALL be applied uniformly | 🟡 Partial | `tests/auth/identity-consistency.spec.ts` (pins final email, not normalisation rules) |
| Concurrent creation races SHALL fall back to read | 🟡 Partial | `tests/auth/concurrent-first-login.spec.ts` (3 parallel browser contexts → assert all see one identity; behavioural, doesn't count DB rows directly) |
| email-shape detection on header values SHALL avoid polynomial-backtracking regex | ⚠️ Deferred | — (per-fork `sso-audit.sh` Row 21 catches static regression) |

## oauth2-proxy-gateway

| Requirement | Coverage | Test |
|---|---|---|
| gateway SHALL run as a single dedicated service | 🟡 Partial | `tests/security/bypass-surface.spec.ts` (every protected path hits the same gateway) |
| gateway SHALL use OIDC Discovery against the Cognito issuer | ⚠️ Deferred | — |
| cookie domain SHALL be the platform parent domain | ✅ | `tests/auth/session-sharing.spec.ts`, `tests/auth/sso-login.spec.ts` |
| gateway SHALL emit X-Auth-Request-* headers on authenticated responses | ✅ | `tests/auth/identity-consistency.spec.ts` |
| cookie secret SHALL be 32 random bytes, base64-encoded | ⚠️ Deferred | — |
| gateway SHALL use a redis-backed session store | ⚠️ Deferred | — |
| gateway SHALL pass access token to downstream apps when requested | ⚠️ Deferred | — |
| gateway SHALL use the configurable identity claim | ⚠️ Deferred | — |
| single shared callback URL | ⚠️ Deferred | — |

## forwardauth-traefik

| Requirement | Coverage | Test |
|---|---|---|
| a single mpass-auth middleware SHALL be defined on the oauth2-proxy service | 🟡 Partial | `tests/security/header-spoofing.spec.ts` (auth gate) |
| every protected app router SHALL apply mpass-auth | ✅ | `tests/security/header-spoofing.spec.ts` |
| bypass paths SHALL route via higher-priority routers without mpass-auth | ✅ | `tests/security/bypass-surface.spec.ts`, `tests/security/strip-on-bypass.spec.ts` |
| bypass routes per app SHALL match the documented list | ✅ | `tests/security/bypass-surface.spec.ts` (per-app `APP_BYPASS_EXTRAS` map enumerates documented bypass paths AND regression guards — e.g. SurfSense `/docs` + `/openapi.json` correctly gate post 2026-04-30 audit), `tests/apps/pm-godmode.spec.ts` |
| header overwrite SHALL be enforced | ✅ | `tests/security/header-spoofing.spec.ts` (with documented partial — see file comment) |
| backend ports SHALL be bound to 127.0.0.1 only | ⚠️ Deferred | — (infra-level; not reachable from CI) |
| auth-response headers SHALL include exactly the three required headers | ⚠️ Deferred | — |

## session-lifecycle

| Requirement | Coverage | Test |
|---|---|---|
| the system SHALL maintain two distinct session layers | ✅ | `tests/auth/sso-login.spec.ts`, `tests/auth/session-sharing.spec.ts` |
| Layer 1 SHALL refresh transparently against OIDC | ⚠️ Deferred | — |
| Layer 1 expiry while Layer 2 is valid SHALL re-auth transparently | ⚠️ Deferred | — |
| Layer 2 expiry while Layer 1 is valid SHALL re-establish session from headers | ✅ | `tests/auth/layer2-re-establish.spec.ts` (all 5 apps: clear local cookies+storage, keep SSO, reload → silent re-establish) |
| simultaneous expiry of both layers SHALL redirect to mPass login | 🟡 Partial | `tests/auth/session-lifecycle.spec.ts` (cookie deletion proxies for expiry) |
| mPass-side session revocation SHALL be honoured on next refresh | ⚠️ Deferred | — |
| per-app session TTLs SHALL be uniformly configurable | ⚠️ Deferred | — (config-level, not behavioural) |
| Layer-2 session renewal SHALL be guarded against three regression paths | 🟡 Partial | `tests/auth/layer2-renewal-suppressed-on-4xx.spec.ts` (Penpot only — 4xx RPC response carries no fresh `auth-token` Set-Cookie. Extending to Outline/Plane is the same pattern with different per-app cookie names) |
| bridge state TTL SHALL be 3 minutes | ⚠️ Deferred | — |
| only one OAuth login flow SHALL be in progress per browser at a time | 🟡 Partial | `tests/bugs/bug_dc998ba0.spec.ts` (FOSSSMBBUN-88 — asserts the graceful-failure observable on the losing tab: `/mpass-callback` → 302 to portal with `login_error=expired_flow`. Doesn't directly assert the `mpass_login_lock` cookie / 409 backstop — those are the wire-level mechanism, this is the user-visible consequence) |

## cognito-claim-mapping

| Requirement | Coverage | Test |
|---|---|---|
| standard claim → header mapping | ✅ | `tests/auth/identity-consistency.spec.ts` |
| identity claim SHALL be configurable when email is unreliable | 🟡 Partial | `tests/auth/email-domain-consistency.spec.ts` (asserts cross-app email-domain agreement — proves `DEFAULT_EMAIL_DOMAIN` is consistently applied; doesn't test the configurability axis itself) |
| claim mapping SHALL be the same across the cookie flow and the JWT-bearer flow | ⚠️ Deferred | — |
| id_token vs access_token audience claim SHALL both be accepted | ⚠️ Deferred | — |
| display name SHALL be derived without round-trip when possible | ⚠️ Deferred | — |

## logout-flow

| Requirement | Coverage | Test |
|---|---|---|
| per-app "Logout" SHALL be navigation-only | ✅ | `tests/auth/logout-invariants.spec.ts` sub-test 3 (per-app helper in `tests/lib/app-menus.ts` opens each app's user menu; click asserts no `/sign_out`/`/auth/sign-out`/cognito-logout call, SSO cookie untouched. Landing host is intentionally not pinned down — that's the portal Logout-all semantic, not per-app's) |
| per-app "Logout" SHALL NOT be relied on for security | ⚠️ Deferred | — (negative policy; verified by reasoning, not test) |
| portal "logout all" SHALL clear only the _oauth2_proxy cookie | ✅ | `tests/auth/session-lifecycle.spec.ts` + `tests/auth/logout-invariants.spec.ts` sub-test 1 (latter explicitly asserts per-app cookies survive — the "only" half) |
| stale app-native sessions SHALL be reaped on next request, not eagerly | ✅ | `tests/auth/session-lifecycle.spec.ts` ("deleting cookie locks every app") |
| Cognito SSO teardown is operator-callable but not surfaced as a user action | ⚠️ Deferred | — (operator-only, not user-facing) |
| logout SHALL be observable and idempotent | ✅ | `tests/auth/logout-invariants.spec.ts` sub-test 2 (`/oauth2/sign_out` invoked twice → no 5xx, lands on portal or auth wall both times) |
| Cognito allowlist SHALL include the portal main page | ⚠️ Deferred | — (Cognito-side config, not reachable from CI) |

## workspace-auto-join

| Requirement | Coverage | Test |
|---|---|---|
| auto-join SHALL run on every login, not just on user creation | ⚠️ Deferred | — |
| auto-join SHALL skip when no workspace exists yet | ⚠️ Deferred | — |
| auto-join target SHALL be the oldest workspace | ⚠️ Deferred | — |
| auto-join role SHALL be the app's regular-member role, not Admin or Guest | 🟡 Partial | `tests/apps/{outline,twenty,penpot,surfsense,pm}-admin.spec.ts` (each app's admin spec asserts NORMAL_USER auto-joined as non-admin: gated from owner-only controls; admin panel renders no markers; etc.) |
| auto-join SHALL mark onboarding complete on the user profile | ⚠️ Deferred | — |
| per-app workspace model SHALL be documented in workspaces.md | ⚠️ Deferred | — (doc requirement, not behavioural) |
| auto-join SHALL NOT leak across apps | ✅ | `tests/auth/workspace-auto-join-independence.spec.ts` (4 apps: Plane, Outline, Penpot, SurfSense each surface their OWN workspace identifier via `/me`-style endpoints; assertion checks no two apps share an identifier, which would prove a shared backend) |

---

## Adding new coverage

When you write a new test that pins a spec requirement, add a one-line tag immediately above the `test()` call:

```ts
// @spec proxy-auth-middleware#identity-mismatch-shall-flush
test("user switch reflects in /me on next request", async ({ context }) => {
  // ...
});
```

The slug is the requirement title, lowercased, with `SHALL`/`SHALL NOT`/etc. preserved literally and non-alphanumerics collapsed to `-`. Match the format already used in [scripts/check-spec-coverage.sh](../scripts/check-spec-coverage.sh) — when you add a tag the script's coverage count goes up automatically; no doc edit needed.

When you can't write a test (infra-only, Cognito-side, policy-level), add an entry to [spec-coverage-deferred.md](spec-coverage-deferred.md) instead.
