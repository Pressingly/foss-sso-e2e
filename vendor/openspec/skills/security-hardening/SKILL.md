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

### Requirement: platform hosts SHALL NOT leak upstream Server version

The `Server` response header on the portal (and ideally every host)
MUST NOT match `<server>/<version>` shapes — specifically forbidden
matches include `nginx/<version>`, `apache/<version>`,
`openresty/<version>`. Server software names without versions are
fine; versions are what attackers fingerprint to pick CVEs against.

The check is currently portal-scoped (the bundle owns the portal
nginx config) but extends naturally to per-app routers when the
bundle takes ownership.

### Requirement: platform hosts SHALL enforce HTTPS, refusing plaintext

Plaintext (`http://`) requests to any platform host MUST NOT be
served — they MUST either be redirected to `https://` or refused
outright (connection close / 4xx). No authenticated endpoint may
respond over plaintext; an attacker on the network MUST NOT be able
to capture the SSO cookie by downgrading the connection.

### Requirement: OIDC state parameter SHALL be integrity-protected

The OIDC `state` parameter in the `/oauth2/start` → `/oauth2/callback`
flow MUST be cryptographically protected against tampering. A
modified `state` returned to the callback MUST be rejected; the
callback MUST NOT issue a session cookie when the state value
does not match what was issued at flow start.

This pins the CSRF protection on the OIDC handshake — without it,
an attacker could trick a user into completing a login flow against
the attacker's IdP session.

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

### Requirement: SSO chain SHALL NOT expose tokens in URL query params

Bearer tokens, session IDs, and authorisation codes MUST NOT appear
in URL query parameters at any point in the chain (request URL,
redirect URL, browser address bar). Tokens belong in headers and
cookies only.

URL-exposed tokens land in browser history, server access logs,
and `Referer` headers sent to third parties — every one of those
is a credential leak surface.

### Requirement: HTTP method tampering SHALL NOT bypass auth

The auth chain MUST be enforced uniformly across HTTP methods. A
request using an unexpected method (e.g., `OPTIONS`, `TRACE`,
`HEAD`, `CONNECT`, or made-up methods like `FOO`) to a protected
endpoint MUST be subject to the same auth check as the canonical
method. A 405 / 400 response without auth is acceptable; serving
the endpoint payload without auth is NOT.

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

### Requirement: per-app session cookies SHALL NOT be standalone bearer credentials

A per-app session cookie (Outline `accessToken`, Plane `sessionid`,
Penpot opaque, etc.) MUST NOT authenticate a request on its own.
The ForwardAuth chain in front of every app MUST refuse requests
without a valid `_oauth2_proxy` cookie regardless of the per-app
cookies present.

This pins the "two-cookie" defense-in-depth: an attacker who steals
a per-app cookie (XSS on the app, log exposure) does NOT gain
session access without ALSO obtaining the SSO cookie.

### Requirement: per-app session cookies SHALL be hardened at issue time

Per-app session cookies MUST be issued with:

- `HttpOnly: true` (no JS access)
- `Secure: true` (HTTPS-only transmission)
- `Domain` MUST be the app's specific host (NOT a wildcard of the
  cookie domain) — so an XSS on app A doesn't leak app B's cookie

### Requirement: SSO chain SHALL be immune to session fixation

A pre-authentication session cookie value MUST NOT survive the
login flow. After successful SSO sign-in, the issued
`_oauth2_proxy` cookie MUST have a different value than any cookie
the browser carried into the flow.

This pins the standard session-fixation defense — an attacker who
plants a known cookie value on a victim's browser BEFORE the victim
logs in MUST NOT then be able to use that cookie to hijack the
victim's authenticated session.

### Requirement: SSO-mode apps SHALL NOT expose local login forms

When an app is configured in SSO-only mode (e.g., Twenty's
`AUTH_TYPE=SSO`), the app's UI MUST NOT surface local-credential
forms (email/password inputs) — a user MUST NOT have a path to
log in via local credentials and bypass the SSO chain.

UI-only hiding is acceptable so long as the local-login API
endpoints are ALSO refused (consistent with the SSO-only
configuration); both surfaces together enforce the contract.

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

## References

- `oauth2-proxy.cfg` (in foss-server-bundle) — cookie attribute config
- `traefik/middlewares.yml` — `security-headers@docker` middleware
- `tests/security/cookie-attributes.spec.ts` — pins the 4 cookie attrs
- `tests/security/headers.spec.ts` — pins all 3 header requirements
