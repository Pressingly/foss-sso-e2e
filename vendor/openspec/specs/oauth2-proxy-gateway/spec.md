# oauth2-proxy-gateway — capability spec

The centralised authentication gateway sitting between Traefik ForwardAuth and the mPass Cognito IdP. Validates upstream OIDC tokens, manages the shared `_oauth2_proxy` session cookie, and emits identity headers (`X-Auth-Request-*`) that downstream apps trust.

Source: original mPass design (PDF 2026-03-26, approved) §"oauth2-proxy Configuration" and §"Architecture".

## Requirements

### Requirement: gateway SHALL run as a single dedicated service

There SHALL be exactly one oauth2-proxy container in the bundle, deployed via `docker-compose.yml`. All five apps share it via Traefik ForwardAuth — no per-app oauth2-proxy instances.

#### Scenario: Compose defines exactly one oauth2-proxy service

- **WHEN** `docker-compose.yml` is rendered
- **THEN** exactly one service uses image `quay.io/oauth2-proxy/oauth2-proxy:v7.9.0`
- **AND** that service is named `oauth2-proxy`
- **AND** no app service embeds its own oauth2-proxy container or sidecar

### Requirement: gateway SHALL use OIDC Discovery against the Cognito issuer

The provider MUST be `oidc` with discovery against the configured Cognito issuer URL. Per-endpoint flags (`--oidc-auth-uri`, `--oidc-token-uri`, `--oidc-userinfo-uri`) MUST NOT be set — discovery is authoritative.

#### Scenario: Provider is oidc with discovery URL

- **WHEN** the oauth2-proxy container starts
- **THEN** the environment includes `OAUTH2_PROXY_PROVIDER=oidc`
- **AND** the environment includes `OAUTH2_PROXY_OIDC_ISSUER_URL` equal to the Cognito issuer (e.g. `https://cognito-idp.<region>.amazonaws.com/<pool-id>`)
- **AND** the environment does NOT include `OAUTH2_PROXY_OIDC_AUTH_URL`, `OAUTH2_PROXY_OIDC_TOKEN_URL`, or `OAUTH2_PROXY_OIDC_USERINFO_URL`

### Requirement: cookie domain SHALL be the platform parent domain

The `_oauth2_proxy` cookie MUST be set on the platform parent domain (`.${PLATFORM_DOMAIN}`) so it is sent on every protected subdomain in the bundle. Setting the cookie on a single host would prevent SSO across the apps.

#### Scenario: Cookie domain is parent

- **WHEN** the oauth2-proxy container starts
- **THEN** the environment includes `OAUTH2_PROXY_COOKIE_DOMAINS=.${PLATFORM_DOMAIN}`
- **AND** the environment includes `OAUTH2_PROXY_WHITELIST_DOMAINS=.${PLATFORM_DOMAIN}` (for the redirect-allowlist on `?rd=` parameters)

#### Scenario: Authenticating on one app authenticates the others

- **GIVEN** the user has logged in to `pm.${PLATFORM_DOMAIN}`
- **AND** the browser holds a valid `_oauth2_proxy` cookie on `.${PLATFORM_DOMAIN}`
- **WHEN** the user navigates to `docs.${PLATFORM_DOMAIN}`
- **THEN** ForwardAuth at the new host receives the same `_oauth2_proxy` cookie
- **AND** the user does not see another mPass login prompt
- **AND** the new app sees X-Auth-Request-* headers populated from the same Cognito session

### Requirement: gateway SHALL emit X-Auth-Request-* headers on authenticated responses

On every authenticated ForwardAuth response (HTTP 202), the gateway MUST set:

- `X-Auth-Request-Email` — from the mapped identity claim (default: `email`; configurable via `OAUTH2_PROXY_USER_ID_CLAIM` when the IdP uses a non-`email` identity claim)
- `X-Auth-Request-User` — the OIDC `sub` claim
- `X-Auth-Request-Access-Token` — the validated upstream access token (so downstream apps that need to call Cognito on the user's behalf can do so)

#### Scenario: Authenticated request gets identity headers

- **GIVEN** a request carries a valid `_oauth2_proxy` cookie
- **WHEN** Traefik calls oauth2-proxy's `/oauth2/auth` endpoint
- **THEN** the response status is 202
- **AND** the response sets header `X-Auth-Request-Email` to the user's identity claim value
- **AND** the response sets header `X-Auth-Request-User` to the user's `sub` claim
- **AND** the response sets header `X-Auth-Request-Access-Token` to the user's current access token

#### Scenario: Unauthenticated request gets no identity headers

- **GIVEN** a request has no `_oauth2_proxy` cookie (or one that fails validation)
- **WHEN** Traefik calls oauth2-proxy's `/oauth2/auth` endpoint
- **THEN** the response status is 401
- **AND** no X-Auth-Request-* headers are set on the response

### Requirement: cookie secret SHALL be 32 random bytes, base64-encoded

The cookie secret MUST be generated as a 32-byte random value encoded as base64. It MUST NOT be a human-chosen string. The platform setup script generates this once and persists it in the bundle's `.env`.

#### Scenario: Setup generates cookie secret

- **WHEN** the platform setup script runs for the first time
- **THEN** a fresh 32-byte random value is generated
- **AND** the value is base64-encoded
- **AND** it is written to `OAUTH2_PROXY_COOKIE_SECRET` in `.env`
- **AND** subsequent runs reuse the existing value if present (do not rotate without explicit operator action)

### Requirement: gateway SHALL use a redis-backed session store

Cognito ID tokens routinely exceed 4 KB, which breaks browser cookie-size limits if sessions are stored in cookies. The session store MUST be Redis (the bundle's Valkey instance), not the default cookie store.

#### Scenario: Session store is redis

- **WHEN** the oauth2-proxy container starts
- **THEN** the environment includes `OAUTH2_PROXY_SESSION_STORE_TYPE=redis`
- **AND** `OAUTH2_PROXY_REDIS_CONNECTION_URL` points at the bundle's Valkey instance on a dedicated logical DB index

### Requirement: gateway SHALL pass access token to downstream apps when requested

For the JWT-bearer flow (e.g. plane-mcp calling Plane API directly with an Authorization header), the gateway MUST be configured to forward access tokens AND to skip the cookie check when a valid bearer token is present.

#### Scenario: Bearer-token requests bypass cookie auth

- **GIVEN** a request carries `Authorization: Bearer <valid-cognito-id-token>` AND no `_oauth2_proxy` cookie
- **WHEN** Traefik calls oauth2-proxy's ForwardAuth endpoint
- **THEN** oauth2-proxy validates the bearer token against the configured JWKS
- **AND** the response status is 202 with X-Auth-Request-* headers set from the bearer-token claims

### Requirement: gateway SHALL use the configurable identity claim

When the Cognito pool's `email` claim is unreliable (e.g. populated with a placeholder), the gateway MAY be configured via `OAUTH2_PROXY_USER_ID_CLAIM` to forward a different claim (e.g. `cognito:username`) as the identity. Downstream apps see this in `X-Auth-Request-Email`. Apps that depend on email shape MUST handle bare-username values — see `proxy-auth-middleware` capability for the rules.

#### Scenario: cognito:username flow

- **GIVEN** `OAUTH2_PROXY_USER_ID_CLAIM=cognito:username` is set
- **WHEN** an authenticated user passes through ForwardAuth
- **THEN** `X-Auth-Request-Email` carries the user's `cognito:username` value (which may not contain `@`)
- **AND** downstream apps must apply the bare-username handling defined in `proxy-auth-middleware/spec.md`

### Requirement: single shared callback URL

The OAuth callback URL registered in Cognito MUST be the single shared `https://auth.${PLATFORM_DOMAIN}/oauth2/callback`. Per-app callback URLs (used in the pre-mPass design) MUST be removed from Cognito's app-client allowlist.

#### Scenario: Callback is the single shared URL

- **WHEN** the oauth2-proxy container starts
- **THEN** `OAUTH2_PROXY_REDIRECT_URL` equals `https://auth.${PLATFORM_DOMAIN}/oauth2/callback`
- **AND** Cognito's app-client "Allowed callback URLs" contains exactly this one entry (no `https://pm.…/oauth/callback`, `https://docs.…/oauth/callback`, etc. — those were retired with the mPass migration)
