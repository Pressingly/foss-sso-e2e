# session-lifecycle — capability spec

How the layered session model behaves at the boundaries: when each layer expires, when each layer refreshes, what the user sees, what the apps see.

Source: original mPass design (PDF 2026-03-26, approved) §"Session Lifecycle".

## Requirements

### Requirement: the system SHALL maintain two distinct session layers

| Layer | Cookie / token | Scope | Default lifetime | Refresh |
|---|---|---|---|---|
| Layer 1 — Upstream OIDC session | `_oauth2_proxy` cookie | `.${PLATFORM_DOMAIN}` (shared across all apps) | 5 days (aligned to Cognito `RefreshTokenValidity`) | Auto via OIDC refresh token (~1h cycles) |
| Layer 2 — App-native session | per app (see below) | Per-app host only | Varies per app | Per-app rules |

Per-app Layer 2 defaults from the original PDF:

- **Outline:** JWT in `accessToken` cookie, 3 months
- **Penpot:** JWT in `auth-token` cookie, 7 days
- **Plane:** Django session cookie (`sessionid`), 2 weeks
- **SurfSense:** JWT bearer token, 1 day

A unified default applies across all apps via `SESSION_COOKIE_MAX_AGE_SECONDS` (5 days — aligned to Cognito `RefreshTokenValidity`) — apps that issue their own JWT use this as the issued-token lifetime where possible.

#### Scenario: Both layers exist simultaneously after a fresh login

- **GIVEN** the user has just authenticated via mPass on `pm.${PLATFORM_DOMAIN}`
- **WHEN** the post-login redirect lands at the app
- **THEN** the browser holds an `_oauth2_proxy` cookie scoped to `.${PLATFORM_DOMAIN}`
- **AND** the browser holds the app's native session cookie (`sessionid` for Plane) scoped to `pm.${PLATFORM_DOMAIN}`
- **AND** both cookies are Secure + HttpOnly

### Requirement: Layer 1 SHALL refresh transparently against OIDC

While the `_oauth2_proxy` cookie is within its absolute lifetime AND the Cognito refresh token is still valid, oauth2-proxy MUST silently refresh the upstream session on roughly the configured refresh interval (default 1 hour). Users SHALL NOT see a login prompt during this refresh.

#### Scenario: Hourly silent refresh

- **GIVEN** the `_oauth2_proxy` cookie is older than `OAUTH2_PROXY_COOKIE_REFRESH` seconds (default 3600)
- **AND** the user is still within the 5-day cookie lifetime
- **AND** the Cognito refresh token has not expired (30-day rolling window)
- **WHEN** a request flows through ForwardAuth
- **THEN** oauth2-proxy uses the refresh token to obtain a new access/id-token from Cognito
- **AND** the response is 202 with fresh identity headers
- **AND** no redirect to mPass login occurs
- **AND** the cookie is re-issued with refreshed timestamps

### Requirement: Layer 1 expiry SHALL force a fresh Cognito login

The oauth2-proxy cookie absolute lifetime is aligned to Cognito's `RefreshTokenValidity` (both 5 days), so they expire together. When the cookie expires, the refresh token is also dead — there is no "session alive on dead refresh" gap. The next request MUST trigger a redirect through Cognito (silent if Cognito's own SSO session is still valid, prompted otherwise). Layer 2 sessions remain valid but cannot be exercised because ForwardAuth re-runs on every request and 401s without a valid Layer 1 cookie.

#### Scenario: 5-day Layer-1 expiry, expired refresh token, valid Layer 2

- **GIVEN** the `_oauth2_proxy` cookie has just crossed its absolute lifetime
- **AND** the Cognito refresh token has expired at the same instant (5d validity)
- **AND** the app's Layer-2 session cookie is still valid
- **WHEN** the user makes their next request
- **THEN** ForwardAuth returns 401
- **AND** Traefik redirects the browser through Cognito
- **AND** if Cognito's own SSO session is still valid, the redirect is silent; otherwise the user sees the Cognito login form
- **AND** the existing Layer-2 cookie cannot be exercised (every request runs through ForwardAuth first)

### Requirement: Layer 2 expiry while Layer 1 is valid SHALL re-establish session from headers

When an app's native Layer-2 session expires while the `_oauth2_proxy` cookie remains valid, the app's `proxy-auth-middleware` MUST establish a new Layer-2 session from the `X-Auth-Request-*` headers on the next request, with no user-visible disruption.

#### Scenario: App session expires, proxy cookie valid

- **GIVEN** the app's Layer-2 session cookie has expired
- **AND** the `_oauth2_proxy` cookie is still valid
- **WHEN** the user makes a request to the app
- **THEN** ForwardAuth returns 202 with X-Auth-Request-Email populated
- **AND** the app's middleware re-establishes Layer-2 session from the header (per `proxy-auth-middleware` Rule 3)
- **AND** the user experiences no prompt or redirect

### Requirement: simultaneous expiry of both layers SHALL redirect to mPass login

When the `_oauth2_proxy` cookie cannot be refreshed (e.g. refresh token expired past the 30-day window) AND the app's Layer-2 session is also expired, the user MUST be redirected to mPass for a fresh login.

#### Scenario: Both layers gone

- **GIVEN** the `_oauth2_proxy` cookie is absent or unrefreshable
- **AND** the app's Layer-2 session cookie is also absent or expired
- **WHEN** the user makes a request to the app
- **THEN** ForwardAuth returns 401
- **AND** Traefik returns a redirect to oauth2-proxy's `/oauth2/sign_in`
- **AND** oauth2-proxy redirects the user to mPass for fresh authentication

### Requirement: mPass-side session revocation SHALL be honoured on next refresh

If the operator revokes the user's session in Cognito (e.g. forced sign-out from the admin console), the next refresh attempt by oauth2-proxy MUST fail. The `_oauth2_proxy` cookie MUST be cleared. The user MUST be redirected to mPass and the revocation MUST be observable to them (they cannot re-authenticate without operator action).

#### Scenario: Cognito revocation propagates to the app

- **GIVEN** an active user with valid `_oauth2_proxy` cookie and valid Layer-2 session
- **WHEN** an operator revokes the user's session in Cognito
- **AND** the next OAuth refresh fires (within `OAUTH2_PROXY_COOKIE_REFRESH` seconds)
- **THEN** oauth2-proxy's refresh request to Cognito fails (typically `invalid_grant`)
- **AND** oauth2-proxy clears the `_oauth2_proxy` cookie
- **AND** subsequent requests redirect to mPass login
- **AND** the user cannot re-authenticate while the revocation remains in effect

### Requirement: per-app session TTLs SHALL be uniformly configurable

The bundle exposes a single environment variable per category, applied across apps:

- `SESSION_COOKIE_MAX_AGE_SECONDS` (default `432000` = 5 days, aligned to Cognito `RefreshTokenValidity`) — Layer-2 session lifetime where the app uses cookie-backed sessions
- `SESSION_REFRESH_TOKEN_MAX_AGE_SECONDS` (default `1209600` = 14 days) — for apps that issue their own refresh tokens (Twenty, SurfSense, Outline-as-provider)
- `OAUTH2_PROXY_COOKIE_EXPIRE` — Layer-1 cookie absolute lifetime
- `OAUTH2_PROXY_COOKIE_REFRESH` — Layer-1 refresh cadence

Operators SHALL NOT need per-app TTL configuration except where an app's framework doesn't support reading these values.

### Requirement: Layer-2 session renewal SHALL be guarded against three regression paths

Apps that auto-renew their native session cookie when it's near expiry MUST gate the renewal on **four** conditions. If any one is false, renewal MUST be skipped. The combined guard prevents three distinct regression paths from re-introducing the stale-session leak class of bug.

The four conditions:

1. **Session exists** (decoded from the incoming cookie successfully).
2. **Renewal is actually due** (`renew-session?` or equivalent per-app rule).
3. **Response status is success-shaped.** Use the framework's qualified status key (e.g. Yetti's `::yres/status`, not bare `:status`). Treat absent/nil status as success (matches Ring default-200 semantics).
4. **Response does NOT already carry a fresh session cookie** issued by an inner middleware (e.g. `proxy-auth-middleware` Rule 2 just re-keyed).

Failure modes if any one guard is missing:

| Missing guard | Bug it allows |
|---|---|
| Status guard | A 4xx denial (e.g. blocked-user 403 from `proxy-auth-middleware`) renews the stale user's cookie on the denial response — extending their session past the upstream rejection. |
| Fresh-cookie guard | An inner middleware re-keys to bob; the outer renewal overwrites bob's fresh cookie with a renewed alice cookie — the re-key silently doesn't stick. |
| Qualified-status-key guard | Same as missing status guard, but worse: looking at `:status` instead of `::yres/status` always reads nil → defaults to 200 → renewal fires on every 4xx response. Subtle Yetti/Ring footgun. |
| Renewal-due guard | Renewal fires on every request, regardless of TTL → token churn, log noise, and burst write load on the session store. |

#### Scenario: Renewal is suppressed on a 4xx response with a stale cookie

- **GIVEN** the browser sends an `auth-token` cookie for `alice` that is past the renewal threshold
- **AND** the inner middleware returns a 403 response (e.g. mismatch with a blocked incoming user) with no fresh cookie attached
- **WHEN** the outer session middleware processes the response
- **THEN** the response status (qualified) is 403
- **AND** the renewal condition evaluates to false (status guard fails)
- **AND** no `Set-Cookie: auth-token=…` header is added to the response
- **AND** alice's session is NOT extended past her current expiry

#### Scenario: Renewal does not overwrite a fresh re-key cookie

- **GIVEN** the browser sends an `auth-token` cookie for `alice` that is past the renewal threshold
- **AND** the inner `proxy-auth-middleware` detects a mismatch and re-keys to `bob` (sets a fresh `auth-token` cookie on the response)
- **WHEN** the outer session middleware processes the response
- **THEN** the response carries bob's fresh cookie
- **AND** the renewal condition evaluates to false (fresh-cookie guard fails)
- **AND** bob's cookie is the one the browser receives — NOT a renewed-alice cookie

### Requirement: bridge state TTL SHALL be 3 minutes

The mpass-auth-proxy bridge holds OIDC `state` in Redis between the user starting an mPass login and completing the QR scan. The TTL MUST allow time for QR scanning but not so long that abandoned flows accumulate. Default: 3 minutes.

#### Scenario: User abandons the QR scan past the TTL

- **GIVEN** the user has hit `/authorize` and received the `mpass_bridge` cookie
- **AND** more than 3 minutes have passed without completing the mPass login
- **WHEN** the user finally scans the QR and Moneta calls `/mpass-callback`
- **THEN** the Redis lookup for the bridge state returns nothing
- **AND** the callback returns 400 `Bridge state expired or not found`
- **AND** the user must restart the login flow

### Requirement: only one OAuth login flow SHALL be in progress per browser at a time

The mPass bridge's `mpass_bridge` cookie is a single per-browser slot, not per-tab; oauth2-proxy's `_oauth2_proxy_csrf` cookie is likewise per-browser. If a second tab initiates a login flow while a first tab's flow is unfinished, the second tab's bridge/CSRF cookies overwrite the first's, and the first tab's eventual callback fails (PKCE mismatch and/or "Missing mpass_bridge cookie"). Origin: FOSSSMBBUN-88.

The system MUST enforce a single-flight login mutex per browser, gated **before** oauth2-proxy's `/oauth2/start` so the shared CSRF cookie is not overwritten by a concurrent flow.

**Mechanism (best-effort, defence-in-depth):**

1. **Client-side gate (primary).** The portal's "Login" button MUST read the `mpass_login_lock` cookie before navigating to `/oauth2/start`. If the cookie is present and its timestamp is within `LOGIN_LOCK_TTL` (default 600s = `BRIDGE_STATE_TTL`), the button MUST refuse to navigate and surface a user-visible message ("Login already in progress in another tab").
2. **Server-side mutex (backstop).** mpass-auth-proxy's `/authorize` MUST check the same `mpass_login_lock` cookie and return HTTP 409 with a plain-text body if it's still active. Catches direct-URL navigation, scripted access, and any entry path that bypasses the portal button.
3. **Lock issuance.** `/authorize` MUST set `mpass_login_lock=<unix-second-timestamp>` alongside `mpass_bridge` on every successful 302 response. Cookie attributes: `Domain=.${PLATFORM_DOMAIN}`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=LOGIN_LOCK_TTL`. **NOT HttpOnly** — the client-side gate must be able to read it (the value is just a timestamp, no auth material).
4. **Lock release.** `/mpass-callback` and `/mpass/logout` MUST clear `mpass_login_lock` (and `mpass_bridge`) on every exit path, including error paths — so a failed callback does not strand the user for the full TTL. Idempotent.
5. **Lock expiry.** A lock whose timestamp is older than `LOGIN_LOCK_TTL` MUST be treated as no lock. Malformed / missing / non-integer cookies fail open (treated as no lock) so users always have a recoverable path.

This is a best-effort mutex. Two tabs that hit `/oauth2/start` within the same network round-trip can still both pass the client-side check before either has set the cookie; the server-side check has the same race for concurrent `/authorize` requests. The race window shrinks from "until tab 1's callback completes" (minutes) to ~milliseconds — acceptable for the human-clicking-two-tabs failure mode the requirement addresses.

#### Scenario: Tab B click while Tab A is mid-flow

- **GIVEN** Tab A has clicked the portal's "Login" button
- **AND** Tab A's `/authorize` has returned 302 with `mpass_login_lock=<recent-timestamp>` set
- **AND** Tab A is currently on the mPass IDP picker, not yet submitted
- **WHEN** the user opens Tab B, navigates to the portal, and clicks "Login"
- **THEN** Tab B's portal JS reads the `mpass_login_lock` cookie
- **AND** the timestamp is within `LOGIN_LOCK_TTL` seconds
- **AND** Tab B does NOT navigate to `/oauth2/start`
- **AND** Tab B displays a user-visible message naming the in-progress tab condition
- **AND** Tab A's `_oauth2_proxy_csrf` cookie is preserved (Tab B's `/oauth2/start` never fired)
- **AND** when Tab A then submits the IDP form, its full flow completes successfully (no PKCE mismatch, no "Missing mpass_bridge cookie")

#### Scenario: Direct `/authorize` call while a lock is active

- **GIVEN** an active `mpass_login_lock` cookie issued by a recent `/authorize`
- **WHEN** any caller (curl, another tab via direct URL, a script) sends `GET /authorize?state=…&redirect_uri=…&code_challenge=…` with the lock cookie present
- **THEN** mpass-auth-proxy returns HTTP 409
- **AND** the response body contains "Login already in progress"
- **AND** Redis is NOT touched (no new `bridge_state:` key is written)
- **AND** the response does NOT modify `mpass_bridge` or `mpass_login_lock`

#### Scenario: Successful callback releases the lock

- **GIVEN** an active `mpass_login_lock` cookie set by `/authorize`
- **AND** the user has completed the IDP flow
- **WHEN** mpass-auth-proxy's `/mpass-callback` returns its final 302
- **THEN** the response carries `Set-Cookie: mpass_login_lock=; Max-Age=0`
- **AND** the response carries `Set-Cookie: mpass_bridge=; Max-Age=0`
- **AND** the next `/authorize` (or portal Login click) proceeds normally

#### Scenario: Failed callback also releases the lock

- **GIVEN** an active `mpass_login_lock` cookie
- **WHEN** `/mpass-callback` exits via any failure path (missing id_token, invalid token, expired bridge state, JWKS fetch failure, etc.)
- **THEN** the response still clears both cookies (`mpass_login_lock`, `mpass_bridge`) with `Max-Age=0`
- **AND** the user can retry without waiting for `LOGIN_LOCK_TTL` to elapse

#### Scenario: Abandoned flow recovers via TTL

- **GIVEN** an active `mpass_login_lock` cookie
- **AND** the user has closed all browser tabs without completing or failing the flow
- **WHEN** `LOGIN_LOCK_TTL` seconds elapse
- **THEN** the cookie's `Max-Age` causes the browser to discard it
- **AND** any subsequent client-side check or server-side check sees no lock
- **AND** the next login attempt proceeds normally
