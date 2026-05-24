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

## References

- `oauth2-proxy.cfg` (in foss-server-bundle) — cookie attribute config
- `traefik/middlewares.yml` — `security-headers@docker` middleware
- `tests/security/cookie-attributes.spec.ts` — pins the 4 cookie attrs
- `tests/security/headers.spec.ts` — pins all 3 header requirements
