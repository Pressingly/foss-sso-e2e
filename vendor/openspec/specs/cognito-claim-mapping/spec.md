# cognito-claim-mapping — capability spec

How Cognito ID-token claims become oauth2-proxy headers, and how apps turn those headers into user records.

Source: original mPass design (PDF 2026-03-26, approved) §"User Claim Mapping".

## Requirements

### Requirement: standard claim → header mapping

The bundle's default configuration maps Cognito's standard OIDC claims to `X-Auth-Request-*` headers as follows:

| Cognito claim | Header | Purpose |
|---|---|---|
| `sub` | `X-Auth-Request-User` | Stable unique identifier per Cognito principal. Never changes for the same user. |
| `email` | `X-Auth-Request-Email` | Primary lookup key in per-app user tables. |
| `name` | (not forwarded as a header) | Used by apps when auto-provisioning a new user; pulled from the access token or `/userinfo` response, not from a header. |

#### Scenario: Standard claim mapping is applied

- **GIVEN** Cognito issues an ID token with `sub=892ae5ac-…`, `email=alice@example.com`, `name="Alice Smith"`
- **WHEN** an authenticated user passes through ForwardAuth
- **THEN** `X-Auth-Request-User` is `892ae5ac-…`
- **AND** `X-Auth-Request-Email` is `alice@example.com`
- **AND** the app's middleware uses `alice@example.com` as the DB lookup key

### Requirement: identity claim SHALL be configurable when email is unreliable

When the Cognito pool's `email` claim is not populated (e.g. carries a placeholder like `cognito:default_val`), the operator MAY configure `OAUTH2_PROXY_USER_ID_CLAIM` to a different claim — typically `cognito:username` — and that value MUST be forwarded as `X-Auth-Request-Email` instead of the standard `email`.

When this configuration is in effect, the `X-Auth-Request-Email` header value may not be email-shaped (no `@`). Apps' `proxy-auth-middleware` implementations MUST handle bare-username values per the rules in `proxy-auth-middleware/spec.md`.

#### Scenario: cognito:username forwarded as identity

- **GIVEN** `OAUTH2_PROXY_USER_ID_CLAIM=cognito:username` is set in the gateway environment
- **AND** Cognito issues an ID token with `cognito:username=1020010000019120` and `email=cognito:default_val`
- **WHEN** an authenticated user passes through ForwardAuth
- **THEN** `X-Auth-Request-Email` is `1020010000019120` (no `@`)
- **AND** the downstream app must apply the bare-username handling rule (synthesise email or refuse, per the app's `proxy-auth-middleware` implementation)

### Requirement: claim mapping SHALL be the same across the cookie flow and the JWT-bearer flow

Apps that accept both `_oauth2_proxy` cookie auth (web flow) and `Authorization: Bearer` JWT auth (e.g. plane-mcp) MUST receive identical claim mappings from both paths. A user reaching the app via either path MUST resolve to the same internal user record.

#### Scenario: Cookie flow and bearer flow resolve same user

- **GIVEN** the same Cognito principal authenticates once via cookie and once via bearer token in separate requests
- **WHEN** each request flows through ForwardAuth and the app's middleware
- **THEN** the app's resolved internal user is identical in both cases (same `User.pk`)
- **AND** no duplicate user is created

### Requirement: id_token vs access_token audience claim SHALL both be accepted

Cognito populates the audience claim in different fields for ID tokens (`aud`) versus access tokens (`client_id`). The oauth2-proxy configuration MUST list both for the OIDC audience-validation step.

If only `aud` were listed, access-token validation would fail (Cognito access tokens don't include `aud`), breaking the bearer flow. If only `client_id` were listed, ID-token validation would fail (Cognito ID tokens don't include `client_id`), breaking the cookie flow.

#### Scenario: Both audience claims are accepted

- **WHEN** the oauth2-proxy container starts
- **THEN** `OAUTH2_PROXY_OIDC_AUDIENCE_CLAIMS` equals `aud,client_id` (in some order)
- **AND** ID-token validation succeeds (uses `aud`)
- **AND** access-token validation succeeds (uses `client_id`)

### Requirement: display name SHALL be derived without round-trip when possible

Apps that auto-provision users (Plane, Outline, Penpot, SurfSense) MUST prefer reading the `name` claim from the validated access token over making a separate request to Cognito's `/userinfo` endpoint. The userinfo round-trip is only acceptable when the access token does not carry `name`.

This is a performance requirement, not a security one: every auto-provision should not add a synchronous HTTP call to Cognito.

#### Scenario: Display name from access token

- **GIVEN** a newly-authenticated user's access token carries `name="Alice Smith"`
- **WHEN** the app's middleware auto-provisions the user
- **THEN** the `User.display_name` (or equivalent) field is set to `Alice Smith`
- **AND** no `/userinfo` HTTP call is made

#### Scenario: Display name fallback to userinfo

- **GIVEN** the access token does NOT carry `name`
- **AND** the user has just been first-seen by the app
- **WHEN** the middleware auto-provisions the user
- **THEN** a single `/userinfo` call to Cognito is made
- **AND** the `name` field from that response is used as the display name
- **AND** the result is cached per-session to avoid repeating the call
