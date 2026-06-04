---
name: security-hardening
description: Defense-in-depth controls beyond the SSO chain itself — SSO-cookie hygiene, HTTP security headers, and portal-side HTML hardening. These don't gate the chain (the openspec already requires the chain to work); they reduce the blast radius if the chain is somehow bypassed or a cookie is lifted.
---

# security-hardening — defense-in-depth controls

The openspec contract requires the SSO chain to authenticate and
authorise correctly. This skill captures the **hardening layer on
top**: standard browser-security controls that reduce blast radius
when a primary control is bypassed, a cookie is lifted, or a piece
of HTML is rendered with attacker-controlled input.

These are explicitly OUT of the openspec because each one is either:
- a defensive default that oauth2-proxy / Traefik provides
  out-of-the-box, OR
- a portal-specific concern (the bundle owns the portal HTML; the
  5 apps each ship their own HTML and we don't impose CSP on them).

But they need machine-checked assertions in this suite because a
silent config drift (e.g. someone flips `secure_cookie: false` in
oauth2-proxy.cfg) would weaken the blast radius without breaking
the chain — no other test would catch it.

## Requirements

The following requirements pin the hardening layer.
Each is verified by a test in `tests/security/cookie-attributes.spec.ts`
or `tests/security/headers.spec.ts`, linked via a
`// @spec security-hardening#<requirement-slug>` tag.

### Requirement: SSO cookie SHALL be issued with defense-in-depth attributes

The `_oauth2_proxy` cookie (or whatever `FOSS_AUTH_COOKIE` resolves
to) MUST carry these attributes when issued:

- `HttpOnly` — true (no JS access; mitigates XSS-lift)
- `Secure` — true (HTTPS-only; mitigates MITM-lift)
- `SameSite` — `Lax` or `Strict` (no CSRF cross-site send)
- `Domain` — exactly the platform parent (`COOKIE_DOMAIN`), not a
  wildcard or a different host
- `Path` — `/`

A regression on any one of these silently widens the cookie's blast
radius without breaking the SSO chain. Only an explicit assertion
catches it.

#### Scenario: SSO cookie carries all five defense-in-depth attributes after login

- **GIVEN** a fresh browser context that completes the SSO login flow
- **WHEN** the resulting `_oauth2_proxy` cookie is read from the
  Playwright `context.cookies()`
- **THEN** every one of these MUST hold:
  - `httpOnly` is `true`
  - `secure` is `true`
  - `sameSite` is `Lax` or `Strict`
  - `domain` equals `COOKIE_DOMAIN` (with or without leading dot)
  - `path` is `/`

### Requirement: all platform hosts SHALL emit canonical security headers

Every host the suite probes (portal + 5 apps) MUST respond with the
canonical browser-protection headers:

- `Strict-Transport-Security` with a `max-age >= 31536000` (1 year)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy` (any non-empty value; the bundle picks the
  policy, but absence is the regression we guard against)
- `Permissions-Policy` with at least one feature set to `()`
  (empty origin list — denying that feature platform-wide)

These are emitted by Traefik via a shared `security-headers@docker`
middleware. The check fires per-host so a misconfigured router's
missing middleware reference is caught at the host level.

#### Scenario: Every platform host returns the four canonical headers

- **GIVEN** an unauthenticated HTTP probe (the redirect to the IDP
  is itself the response we measure — headers fire pre-auth)
- **WHEN** the probe issues a GET to each of: portal + Outline +
  Plane + Penpot + SurfSense + Twenty + every bypass / oauth2
  router target
- **THEN** every response carries:
  - `Strict-Transport-Security` whose `max-age=` integer is `>= 31536000`
  - `X-Content-Type-Options: nosniff` (exact value)
  - `Referrer-Policy` set to any non-empty value
  - `Permissions-Policy` containing at least one `feature=()` directive
- **AND** no host is silently exempted from the middleware

### Requirement: portal HTML responses SHALL emit CSP + COOP + CORP

The main portal (the page at `MAIN_URL`) serves the bundle's own
HTML and MUST carry these HTML-hardening headers:

- `Content-Security-Policy` with `default-src` defined AND
  `script-src` MUST NOT include `'unsafe-inline'`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy` (any of `same-origin`, `same-site`,
  or `cross-origin` — the bundle picks; the regression we guard is
  absence)

Deliberately scoped to portal only — the 5 apps ship their own HTML
under upstream control and CSP requirements would break their SPA
needs (Penpot/Plane/SurfSense/Twenty don't ship CSP; Outline does
its own). The portal is the only HTML surface the bundle controls.

#### Scenario: Portal HTML carries CSP + COOP + CORP

- **GIVEN** an HTTP probe to the portal's HTML response (`MAIN_URL`)
- **WHEN** the response headers are inspected
- **THEN** `Content-Security-Policy` is present AND its body matches
  BOTH:
  - contains a `default-src` directive
  - the `script-src` directive does NOT include `'unsafe-inline'`
- **AND** `Cross-Origin-Opener-Policy` is exactly `same-origin`
- **AND** `Cross-Origin-Resource-Policy` is one of `same-origin`,
  `same-site`, or `cross-origin` (never absent)

### Requirement: platform hosts SHALL NOT leak upstream Server version

The `Server` response header on the portal (and ideally every host)
MUST NOT match `<server>/<version>` shapes — specifically forbidden
matches include `nginx/<version>`, `apache/<version>`,
`openresty/<version>`. Server software names without versions are
fine; versions are what attackers fingerprint to pick CVEs against.

The check is currently portal-scoped (the bundle owns the portal
nginx config) but extends naturally to per-app routers when the
bundle takes ownership.

#### Scenario: Server header does not leak an upstream version

- **GIVEN** an HTTP probe to any platform host
- **WHEN** the response's `Server` header is inspected
- **THEN** either:
  - the header is absent, OR
  - the value does NOT match `<server>/<version>` patterns —
    specifically not `nginx/<digits>`, `apache/<digits>`,
    `openresty/<digits>`, `traefik/<digits>`, etc.
- **AND** no other response header (e.g. `X-Powered-By`) discloses
  the version either

### Requirement: platform hosts SHALL enforce HTTPS, refusing plaintext

Plaintext (`http://`) requests to any platform host MUST NOT be
served — they MUST either be redirected to `https://` or refused
outright (connection close / 4xx). No authenticated endpoint may
respond over plaintext; an attacker on the network MUST NOT be able
to capture the SSO cookie by downgrading the connection.

#### Scenario: Plaintext requests are not served on any platform host

- **GIVEN** a low-level HTTP probe targeting port 80 on each
  platform host (portal + 5 apps)
- **WHEN** the response is observed
- **THEN** one of:
  - the response is a 3xx redirect whose `Location:` is `https://...`
    on the same host, OR
  - the connection is refused / reset at the transport layer
- **AND** the response status is never 2xx (no payload served over
  plaintext)

### Requirement: OIDC state parameter SHALL be integrity-protected

The OIDC `state` parameter in the `/oauth2/start` → `/oauth2/callback`
flow MUST be cryptographically protected against tampering. A
modified `state` returned to the callback MUST be rejected; the
callback MUST NOT issue a session cookie when the state value
does not match what was issued at flow start.

This pins the CSRF protection on the OIDC handshake — without it,
an attacker could trick a user into completing a login flow against
the attacker's IdP session.

#### Scenario: Tampered or forged state is rejected at the callback

- **GIVEN** an in-flight OIDC handshake whose state has been
  captured from the `/oauth2/start` redirect
- **WHEN** a forged callback is issued to `/oauth2/callback` with a
  modified `state` value (e.g. trimmed, mangled, or replayed
  cross-flow)
- **THEN** the callback response status is `>= 400` (4xx, or a
  bounded-set 5xx tracked separately)
- **AND** no `_oauth2_proxy` cookie is set on the response
- **AND** the user is not landed on a platform host with a fresh
  session

### Requirement: JWT algorithm confusion SHALL be mitigated

The SSO chain MUST NOT accept JWTs signed with algorithms outside
the configured allow-list (typically `RS256` only). Specifically:

- Tokens with `alg: none` MUST be rejected.
- Tokens with `alg: HS256` (or any symmetric alg) using the RSA
  public key as the HMAC secret MUST be rejected.
- Tokens with unexpected algorithms MUST be rejected even if the
  payload would otherwise be valid.

This pins the standard "alg confusion" attack defense — the chain
verifies BOTH the signature AND that the algorithm matches what's
configured.

#### Scenario: Forged alg=none or alg=HS256 bearer token is rejected

- **GIVEN** a forged JWT with `alg: none` (empty signature) AND a
  matching forged JWT with `alg: HS256` using arbitrary symmetric
  signature, both carrying a payload that names an attacker email
- **WHEN** each token is sent to a protected JWT-bearer endpoint
  (e.g. Outline's `/api/auth.info`) as `Authorization: Bearer <jwt>`
- **THEN** for each forged token, EITHER:
  - the response status is non-2xx (i.e. `status < 200 || status >= 300`), OR
  - if 2xx, the response body does NOT contain the forged email
    (the validator decoded but did not trust the forged identity)
- **AND** specifically a 2xx response with the forged email in the
  body MUST NOT happen

### Requirement: SSO chain SHALL NOT expose tokens in URL query params

Bearer tokens, session IDs, and authorisation codes MUST NOT appear
in URL query parameters at any point in the chain (request URL,
redirect URL, browser address bar). Tokens belong in headers and
cookies only.

URL-exposed tokens land in browser history, server access logs,
and `Referer` headers sent to third parties — every one of those
is a credential leak surface.

#### Scenario: Post-login settled URLs carry no token-shaped query params

- **GIVEN** an SSO-authenticated user
- **WHEN** the user navigates to each platform host (portal + 5 apps)
  and the page is allowed to settle
- **THEN** the URL `page.url()` does NOT contain any of:
  `access_token`, `id_token`, `refresh_token`, `token`,
  `bearer`, OR a query-param value matching the JWT shape
  (`[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
- **AND** the URL fragment does NOT contain those either

### Requirement: HTTP method tampering SHALL NOT bypass auth

The auth chain MUST be enforced uniformly across HTTP methods. A
request using an unexpected method (e.g., `OPTIONS`, `TRACE`,
`HEAD`, `CONNECT`, or made-up methods like `FOO`) to a protected
endpoint MUST be subject to the same auth check as the canonical
method. A 405 / 400 response without auth is acceptable; serving
the endpoint payload without auth is NOT.

#### Scenario: Non-GET methods on a protected route do not bypass auth

- **GIVEN** an unauthenticated HTTP client
- **WHEN** the client issues each of `OPTIONS`, `TRACE`, `HEAD`,
  `CONNECT`, and `FOO` (a made-up method) to a protected route on
  every platform host
- **THEN** for each method/host combination, the response is one of:
  - a 3xx redirect to the IDP / oauth2-proxy auth wall, OR
  - a 4xx (typically 405 Method Not Allowed or 400 Bad Request)
- **AND** the response body does NOT contain the protected
  endpoint's payload — i.e. the method-override did not bypass
  the auth check

### Requirement: redirects SHALL NOT permit open-redirect to off-platform hosts

Any endpoint that takes a redirect target (e.g., `?rd=`, `?next=`,
post-logout redirect) MUST validate the target against an allow-list
of platform hosts. Off-platform redirects MUST be refused or
silently coerced to the platform root.

Specifically:
- Naive URL substring matches (`startsWith(MAIN_URL)`) MUST NOT be
  used — the attacker can craft `https://foss.arbisoft.com.evil.com`
  to bypass them.
- CRLF-injection attempts (`\r\n` in the target value) MUST NOT
  result in additional headers being emitted.

#### Scenario: Off-platform redirect payloads are refused

- **GIVEN** an unauthenticated HTTP client
- **WHEN** the client visits `/oauth2/sign_in?rd=<payload>` on each
  platform host, for each of these payload shapes:
  - absolute external (`https://evil.example/`)
  - protocol-relative (`//evil.example/`)
  - backslash-bypass (`/\\evil.example/`)
  - triple-slash (`///evil.example/`)
  - prefix-attached (`https://foss.arbisoft.com.evil.example/`)
  - CRLF-injection (`/path%0d%0aX-Injected: yes`)
- **THEN** the post-login (or settled) URL stays on a platform host
- **AND** for the CRLF payload, no additional response headers are
  emitted (no injected `X-Injected:`)

### Requirement: per-app session cookies SHALL NOT be standalone bearer credentials

A per-app session cookie (Outline `accessToken`, Plane `sessionid`,
Penpot opaque, etc.) MUST NOT authenticate a request on its own.
The ForwardAuth chain in front of every app MUST refuse requests
without a valid `_oauth2_proxy` cookie regardless of the per-app
cookies present.

This pins the "two-cookie" defense-in-depth: an attacker who steals
a per-app cookie (XSS on the app, log exposure) does NOT gain
session access without ALSO obtaining the SSO cookie.

#### Scenario: Per-app cookie alone does not authenticate (SSO cookie is required)

- **GIVEN** an SSO-authenticated user on app A whose per-app session
  cookie has been captured
- **WHEN** a fresh browser context is built that carries ONLY the
  per-app cookie (no `_oauth2_proxy`)
- **THEN** navigating to a protected route on app A bounces to the
  IDP / auth wall
- **AND** the per-app cookie alone never grants access — the
  ForwardAuth chain rejects the request before app A's middleware
  sees it

### Requirement: per-app session cookies SHALL be hardened at issue time

Per-app session cookies MUST be issued with:

- `HttpOnly: true` (no JS access)
- `Secure: true` (HTTPS-only transmission)
- `Domain` MUST be the app's specific host (NOT a wildcard of the
  cookie domain) — so an XSS on app A doesn't leak app B's cookie

#### Scenario: Each app's session cookie has the three required attributes

- **GIVEN** an SSO-authenticated user with active sessions on every
  app
- **WHEN** the browser's per-app session cookies are inspected
  (Outline `accessToken`, Plane `sessionid`, Penpot opaque, etc.)
- **THEN** for each per-app cookie present:
  - `httpOnly` is `true`
  - `secure` is `true`
  - `domain` exactly matches the app's host (e.g. `docs.<COOKIE_DOMAIN>`)
    — NOT the bare `COOKIE_DOMAIN` (which would scope it cross-app)

### Requirement: SSO chain SHALL be immune to session fixation

A pre-authentication session cookie value MUST NOT survive the
login flow. After successful SSO sign-in, the issued
`_oauth2_proxy` cookie MUST have a different value than any cookie
the browser carried into the flow.

This pins the standard session-fixation defense — an attacker who
plants a known cookie value on a victim's browser BEFORE the victim
logs in MUST NOT then be able to use that cookie to hijack the
victim's authenticated session.

#### Scenario: Pre-planted SSO cookie value is rejected on its own and overwritten on login

- **GIVEN** a fresh browser context that pre-plants a known
  `_oauth2_proxy` cookie value (matching the domain + name but with
  an attacker-chosen value) BEFORE any sign-in
- **WHEN** the context navigates to a protected route
- **THEN** the request bounces to the IDP / auth wall (the planted
  value alone is rejected via HMAC failure)
- **AND** when the user subsequently completes SSO sign-in
- **THEN** the post-login `_oauth2_proxy` cookie value DIFFERS from
  the pre-planted one

### Requirement: SSO-mode apps SHALL NOT expose local login forms

When an app is configured in SSO-only mode (e.g., Twenty's
`AUTH_TYPE=SSO`), the app's UI MUST NOT surface local-credential
forms (email/password inputs) — a user MUST NOT have a path to
log in via local credentials and bypass the SSO chain.

UI-only hiding is acceptable so long as the local-login API
endpoints are ALSO refused (consistent with the SSO-only
configuration); both surfaces together enforce the contract.

#### Scenario: No reachable local-login affordance on SSO-mode apps

- **GIVEN** every known local-auth route on each app (e.g. Plane
  `/sign-in`, Outline `/auth/email`, Twenty's local-login routes)
- **WHEN** an unauthenticated browser navigates to each route
- **THEN** for each route, EITHER:
  - the route does NOT exist (4xx / 5xx returned), OR
  - the route exists but renders NO reachable
    `<input type="password">` AND no visible local-login affordance
    (e.g. no "Sign in with email" button, no "Forgot password" link)
- **AND** any matching local-login API endpoint, when posted to,
  returns a non-2xx response (the API is also gated, not just hidden)

### Requirement: logout endpoint SHALL require CSRF protection

The `/oauth2/sign_out` endpoint (and any per-app logout endpoint
that materially clears state) MUST be protected against CSRF.
Either:

- The endpoint requires `POST` with a CSRF token, OR
- The endpoint is `GET` but performs no state-changing action
  beyond a redirect (the actual cookie clear happens on the next
  authenticated request)

A drive-by GET to `/oauth2/sign_out` that logs the user out without
any user intent is the failure mode this prevents.

#### Scenario: Cross-origin GET to /oauth2/sign_out does not clear the SSO cookie

- **GIVEN** an SSO-authenticated browser context
- **WHEN** the browser navigates to a cross-origin page (e.g. a
  `data:` URL) that embeds `<img src="https://<MAIN>/oauth2/sign_out">`
  AND issues `fetch(..., {credentials: "include"})` to the same URL
- **THEN** after both attack shapes have fired (observable via a
  Playwright request listener), the `_oauth2_proxy` cookie:
  - is still present in the browser
  - has the SAME value it had before the cross-origin attempts
- **AND** navigating to a protected app still loads without an IDP
  bounce — the session is intact (`SameSite=Lax` suppressed the
  CSRF cookie attachment)

### Requirement: post-login redirect SHALL preserve the original intent

When a user lands on a protected URL while unauthenticated, the
SSO chain MUST preserve the original intent — after completing
login, the user MUST be redirected to the original URL (or as
close as the chain can manage given hash routing, SPA quirks,
etc.) rather than dropped on a default landing page.

Per-app SPA quirks are expected (Penpot's hash routes, SurfSense's
forced `/login` bounce); the requirement is "best effort
preservation" with documented per-app exceptions, not strict
equality.

#### Scenario: Cold deep link is preserved across the SSO chain

- **GIVEN** a fresh browser context with no `_oauth2_proxy` cookie
- **WHEN** the context cold-navigates to a deep URL on a platform
  app (e.g. `https://docs.<COOKIE_DOMAIN>/settings/people`)
- **AND** the user completes SSO login
- **THEN** the post-login settled URL matches the original deep URL
  (host + pathname), with documented per-app exceptions:
  - Penpot's hash routes are not preserved (hash strips on the chain)
  - SurfSense forces a `/login` bounce on every post-SSO landing
- **AND** for the unaffected apps, the user is NOT dropped on a
  default landing page

### Requirement: platform hosts SHALL refuse rendering inside cross-origin frames

Authenticated responses on every platform host (portal + 5 apps)
MUST refuse to render when embedded by a cross-origin parent. This
is the load-bearing clickjacking and UI-spoofing defence — header
presence (`X-Frame-Options`, CSP `frame-ancestors`) is necessary
but not sufficient because middleware drift can attach headers to
the 302-to-IDP without attaching them to the actual app response.

The contract is observable browser-side: from a cross-origin parent
(opaque origin), the parent MUST NOT be able to read the iframe's
`contentDocument` or `contentWindow.location.href` for any platform
host. A frame that the browser blanks (XFO bite) and a frame that
renders but is cross-origin-isolated both satisfy the contract; a
frame whose DOM the parent can read does not.

This is distinct from "the canonical security headers are present"
(covered above) — header-presence is a static check; this is the
behavioural check that proves the headers actually fire on the
authed response path.

#### Scenario: Authed response on every platform host carries an effective frame-protection header

- **GIVEN** an SSO-authenticated user
- **WHEN** the authed `request.context` (cookies attached) fetches
  the response for each platform host (portal + 5 apps)
- **THEN** the response status is `< 300` (authed surface, not the
  IDP redirect)
- **AND** for each response, AT LEAST ONE is true:
  - `X-Frame-Options` is exactly `deny` or `sameorigin`
  - `Content-Security-Policy` includes a `frame-ancestors` directive
    set to `'none'` or `'self'`

### Requirement: authenticated responses SHALL forbid shared-cache storage

The HTML responses served by the portal and each protected app to an
authenticated user MUST set `Cache-Control` to a value that prevents
shared-cache storage. Acceptable values:

- `no-store` (preferred — nothing is cached anywhere), or
- `private, no-cache` (browser-only cache, forces revalidation), or
- `private, max-age=0` (equivalent)

Bare `public`, missing header, or any directive that allows a
shared cache (corporate forward proxy, CDN, kiosk shared browser)
to store the response is forbidden. The threat is same-network
session-bleed: user A's authenticated HTML being served from a
shared cache to user B on the same network. Static assets (JS,
CSS, fonts, images) are out of scope — those SHOULD be cacheable.

#### Scenario: Portal authenticated HTML sets a shared-cache-forbidding Cache-Control

- **GIVEN** an SSO-authenticated user
- **WHEN** the authed page navigates to the portal HTML response
- **THEN** the response's `Cache-Control` header matches one of:
  - contains `no-store`
  - OR contains BOTH `private` AND one of `no-cache` / `max-age=0`
- **AND** specifically the response's `Cache-Control` does NOT
  contain a bare `public` directive, nor a positive `s-maxage`,
  nor is the header absent entirely

### Requirement: SSO entry points SHALL ignore spoofed Host headers

The SSO chain entry points (portal landing, `oauth2-proxy`
`/oauth2/sign_in` on every host binding) MUST build redirect URLs,
Set-Cookie `Domain=` attributes, and response-body absolute URLs
from configured platform domain values — NOT from the inbound
`Host` request header.

Specifically, a request to a legitimate entry point with
`Host: attacker.example` MUST NOT:

- Emit a `Location:` header containing `attacker.example`
- Emit a response body that echoes `attacker.example` as part of
  any URL (meta refresh, form action, JS string, …)
- Emit a `Set-Cookie: Domain=attacker.example`
- Return 5xx (parse-failure DoS is its own bug)

This pins the OIDC variant of password-reset-poisoning: the chain
MUST NOT be tricked into emitting attacker-controlled URLs that the
victim's browser would then follow as part of the legitimate-looking
authorisation handshake.

#### Scenario: SSO entry point ignores a spoofed Host header

- **GIVEN** a low-level HTTP client that can set the `Host` request
  header independently of SNI / DNS
- **AND** the client sends a request with `Host: <attacker>.invalid`
  to each SSO entry point (portal landing + every host's
  `/oauth2/sign_in`)
- **WHEN** the response is inspected
- **THEN** if a `Location:` header is present, its host points at the
  configured platform domain (`<COOKIE_DOMAIN>` or a subdomain of it)
  OR is a relative path — never `<attacker>.invalid`
- **AND** the response body does NOT include `<attacker>.invalid`
  anywhere
- **AND** any `Set-Cookie: Domain=` value does NOT include
  `<attacker>.invalid`
- **AND** the response status is `< 500` (a 5xx parse-failure on
  Host injection is itself a DoS vector tracked separately)

### Requirement: SSO chain SHALL fail closed under oversized request headers

Every SSO entry point — portal landing, `oauth2-proxy/sign_in` on
every host binding — MUST respond with a clean 4xx (typically 431
"Request Header Fields Too Large", or 400) or close the connection
at the transport layer when a request arrives with an oversized
`Cookie:` (or other) header. A 5xx response is forbidden.

The specific byte limit is the bundle's call (8KB, 16KB, 32KB are
all defensible). What this requirement pins is the failure SHAPE:

- 4xx / connection-close: acceptable — fail-closed
- 5xx: forbidden — indicates a parser crash or buffer overflow
  that an attacker can trigger by inflating cookies on the
  configured cookie-domain (via subdomain XSS, sibling-domain
  cookie write, etc.), which becomes a same-browser DoS for the
  victim, worst case an authz bypass via silent header truncation

#### Scenario: Oversized Cookie does not produce a 5xx

- **GIVEN** a request with a 32KB junk `Cookie:` header attached
  (well above typical 8KB defaults but under any sane upper bound)
- **WHEN** the request is sent to each SSO entry point (portal
  landing + every host's `/oauth2/sign_in`)
- **THEN** the response is one of:
  - Status `< 500` (any of 2xx / 3xx-to-IDP / 4xx-explicit-reject)
  - Connection close at the transport layer (ECONNRESET /
    socket-hang-up before any HTTP response is sent)
- **AND** no 5xx response is returned (a parser crash / buffer
  overflow remotely triggerable on every victim with an in-scope
  cookie write is the failure mode we forbid)

## References

- `oauth2-proxy.cfg` (in foss-server-bundle) — cookie attribute config
- `traefik/middlewares.yml` — `security-headers@docker` middleware
- `tests/security/cookie-attributes.spec.ts` — pins the 4 cookie attrs
- `tests/security/headers.spec.ts` — pins all 3 header requirements
