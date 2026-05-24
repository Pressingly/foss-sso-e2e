# forwardauth-traefik — capability spec

The Traefik integration that calls oauth2-proxy on every protected request, copies identity headers from the response onto the upstream request, and routes bypass paths around the auth check entirely.

Source: original mPass design (PDF 2026-03-26, approved) §"Traefik ForwardAuth Middleware" and §"Bypass Rules".

## Requirements

### Requirement: a single mpass-auth middleware SHALL be defined on the oauth2-proxy service

The ForwardAuth middleware MUST be defined exactly once, as labels on the oauth2-proxy container. App-level Compose services MUST reference the same middleware by name; they MUST NOT define their own copies.

#### Scenario: Middleware lives on oauth2-proxy labels

- **WHEN** `docker-compose.yml` is rendered
- **THEN** the oauth2-proxy service has labels:
  - `traefik.http.middlewares.mpass-auth.forwardauth.address=http://oauth2-proxy:4180/oauth2/auth`
  - `traefik.http.middlewares.mpass-auth.forwardauth.trustForwardHeader=true`
  - `traefik.http.middlewares.mpass-auth.forwardauth.authResponseHeaders=X-Auth-Request-Email,X-Auth-Request-User,X-Auth-Request-Access-Token`
- **AND** no other service defines middlewares named `mpass-auth`

### Requirement: every protected app router SHALL apply mpass-auth

Each app's protected Traefik router (the one serving the main app UI / API) MUST include `mpass-auth` in its `middlewares` chain. Apps that omit it would receive unauthenticated traffic with no identity headers.

#### Scenario: Each app's main router carries mpass-auth

- **WHEN** the Traefik runtime config is queried (`/api/http/routers`)
- **THEN** for each of `pm.${PLATFORM_DOMAIN}`, `docs.${PLATFORM_DOMAIN}`, `design.${PLATFORM_DOMAIN}`, `research.${PLATFORM_DOMAIN}`, `twenty.${PLATFORM_DOMAIN}`:
  - the highest-priority router matching the Host has `mpass-auth@docker` in its middleware list
  - the router status is `enabled`

### Requirement: bypass paths SHALL route via higher-priority routers without mpass-auth

Routes that must skip authentication (god-mode admin, health checks, public webhooks, etc.) MUST be served by **separate Traefik routers** with **higher priority** than the protected router for the same host. These routers MUST NOT include the mpass-auth middleware.

Priorities used in the bundle:
- Protected router: priority `10`
- Bypass router: priority `20`
- Special routers (e.g. plane-mcp): priority `20`

Higher number wins in Traefik when both routers match.

#### Scenario: Plane god-mode bypasses mpass-auth

- **WHEN** the Traefik runtime config is queried
- **THEN** there is a router with rule `Host(\`pm.${PLATFORM_DOMAIN}\`) && PathPrefix(\`/god-mode\`)` at priority 20
- **AND** that router's middleware chain does NOT include `mpass-auth`
- **AND** the protected router for the same Host at priority 10 DOES include `mpass-auth`

#### Scenario: SurfSense health endpoint bypasses

- **WHEN** the Traefik runtime config is queried
- **THEN** there is a router matching `Host(\`research.${PLATFORM_DOMAIN}\`) && PathPrefix(\`/health\`)` at priority 20
- **AND** that router does NOT include `mpass-auth`

### Requirement: bypass routes per app SHALL match the documented list

The default bypass routes per app are:

| App | Bypassed paths | Reason |
|---|---|---|
| Plane | `/god-mode/*`, `/api/instances/*` | Admin panel uses local email/password |
| SurfSense | `/health`, `/docs`, `/openapi.json` | Health checks, API docs |
| Outline | `/api/hooks.*` | Webhook callbacks (token-authenticated) |
| Penpot | `/api/rpc/command/get-profile` | Frontend auth state check (intentionally unauthenticated) |
| All | static asset paths (`/_next/static/`, `/static/`, `/assets/`, etc.) | No auth needed |

New bypass routes added during implementation MUST be documented in this requirement.

#### Scenario: Static assets bypass on all apps

- **GIVEN** any app serving `/_next/static/`, `/static/`, or `/assets/`
- **WHEN** an unauthenticated request hits one of those paths
- **THEN** Traefik routes via a static-asset router at priority 20
- **AND** the asset is served without redirecting through mPass

### Requirement: header overwrite SHALL be enforced

ForwardAuth MUST overwrite any client-supplied `X-Auth-Request-*` headers with the values returned by oauth2-proxy. A client that sets these headers itself MUST NOT influence the request reaching the app.

This is the load-bearing trust-model invariant for `proxy-auth-middleware`. If it fails, header spoofing becomes a direct impersonation vector.

#### Scenario: Client-supplied X-Auth-Request-Email is overwritten

- **GIVEN** a client sends a request with `X-Auth-Request-Email: attacker@example.com` in the request headers
- **AND** the client also has a valid `_oauth2_proxy` cookie for the user `victim@example.com`
- **WHEN** the request flows through Traefik → oauth2-proxy → app
- **THEN** the app's middleware reads `X-Auth-Request-Email: victim@example.com` (NOT `attacker@example.com`)
- **AND** the spoofed value is dropped at the Traefik layer

### Requirement: backend ports SHALL be bound to 127.0.0.1 only

The trust-model invariant that "Traefik is the only path to each app" depends on the app's container port being bound to localhost only. External traffic on the host network MUST NOT be able to reach the app on its raw port.

#### Scenario: docker-compose binds API ports to 127.0.0.1

- **WHEN** any app service exposes a port for debugging (e.g. Plane's `8000`)
- **THEN** the port binding uses `127.0.0.1:8000:8000` (NOT `0.0.0.0:8000:8000` or `8000:8000`)
- **AND** external machines on the same network cannot reach the port directly
- **AND** all in-bundle access goes through Traefik on 443

### Requirement: auth-response headers SHALL include exactly the three required headers

The `authResponseHeaders` value on the mpass-auth middleware MUST list `X-Auth-Request-Email`, `X-Auth-Request-User`, and `X-Auth-Request-Access-Token`. Omitting any one breaks a downstream feature:

- Omitting `Email` → no identity for the per-app middleware to resolve.
- Omitting `User` → no `sub`-based fallback identity (used by some apps for stable user IDs).
- Omitting `Access-Token` → apps that need to call Cognito on behalf of the user cannot do so.

Adding extra headers to this list is permitted only after explicit review (some auth headers are sensitive and should not be readable by downstream app code).

#### Scenario: authResponseHeaders carries the three required headers

- **WHEN** the oauth2-proxy labels are inspected
- **THEN** `traefik.http.middlewares.mpass-auth.forwardauth.authResponseHeaders` is exactly:
  - `X-Auth-Request-Email,X-Auth-Request-User,X-Auth-Request-Access-Token`
