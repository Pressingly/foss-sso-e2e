# Deferred Spec Coverage — Rationale

Spec requirements from [awais786/sso-rules-moneta](https://github.com/awais786/sso-rules-moneta) that this e2e suite does NOT cover, with the reason for each.

Categories:
- **Infra-only** — verifiable from infra config / IaC, not from a browser. The bundle-side `audit-sso.sh` covers these via grep.
- **Cognito-side** — requires Cognito console access or admin API; not reachable from CI.
- **Policy/doc** — negative or documentation requirement; verified by reasoning, not test.
- **Needs infra access** — would require an echo endpoint, access token exposure, or similar plumbing the bundle does not provide today.
- **Genuine test gap** — could be tested but not yet written. Tracked for follow-up.

Format: `<module>#<requirement>` — `<category>` — short rationale.

---

## proxy-auth-middleware

(no remaining gaps in this module — see Categories Summary below for the breakdown of what's covered.)
- `email-shape detection on header values SHALL avoid polynomial-backtracking regex` — **Covered elsewhere** — per-fork `sso-audit.sh` Row 21 catches static regression; live ReDoS probe (adversarial input + response-time bound) is a genuine test gap if you want behavioural coverage.

## oauth2-proxy-gateway

- `gateway SHALL use OIDC Discovery against the Cognito issuer` — **Infra-only** — bundle's `audit-sso.sh` greps for `OIDC_ISSUER_URL` config; behavioural verification would require breaking discovery to confirm.
- `cookie secret SHALL be 32 random bytes, base64-encoded` — **Infra-only** — bundle's audit verifies length + base64 shape of `OAUTH2_PROXY_COOKIE_SECRET`.
- `gateway SHALL use a redis-backed session store` — **Genuine test gap** — could be inferred by writing > 4KB worth of JWT into the session and asserting cookies stay small; not yet written.
- `gateway SHALL pass access token to downstream apps when requested` — **Needs infra access** — requires `pass_access_token = true` config and a downstream endpoint that echoes the token; not exposed in current bundle.
- `gateway SHALL use the configurable identity claim` — **Infra-only** — config-level.
- `single shared callback URL` — **Infra-only** — Traefik config.

## forwardauth-traefik

- `backend ports SHALL be bound to 127.0.0.1 only` — **Infra-only** — only verifiable from inside the host; bundle's audit checks `docker-compose` port bindings.
- `auth-response headers SHALL include exactly the three required headers` — **Infra-only** — Traefik config; bundle audit greps for `authResponseHeaders`.

## session-lifecycle

- `Layer 1 SHALL refresh transparently against OIDC` — **Genuine test gap** — would need to fast-forward time or shorten TTL in a test bundle; not yet wired.
- `Layer 1 expiry while Layer 2 is valid SHALL re-auth transparently` — **Genuine test gap** — same TTL constraint.
- `mPass-side session revocation SHALL be honoured on next refresh` — **Cognito-side** — requires admin API call to revoke a refresh token; not in CI scope today.
- `per-app session TTLs SHALL be uniformly configurable` — **Infra-only**.
- `Layer-2 session renewal SHALL be guarded against three regression paths` — **Partially covered** — `tests/auth/layer2-renewal-suppressed-on-4xx.spec.ts` pins the Penpot/`auth-token` case (4xx response must carry no fresh session cookie). Extending to Outline (`accessToken`) and Plane (`sessionid`) is the same shape with different per-app cookie names.
- `bridge state TTL SHALL be 3 minutes` — **Genuine test gap** — would need to wait 3 minutes or mock the TTL.

## cognito-claim-mapping

- `identity claim SHALL be configurable when email is unreliable` — **Partially covered** — `tests/auth/email-domain-consistency.spec.ts` proves cross-app `DEFAULT_EMAIL_DOMAIN` agreement (the load-bearing operational invariant); testing the *configurability* axis directly is infra-only.
- `claim mapping SHALL be the same across the cookie flow and the JWT-bearer flow` — **Genuine test gap** — Outline exposes a JWT-bearer endpoint (`/api/auth.info`-style with `Authorization: Bearer`); a test could log in via cookie, capture the access token (if exposed), and hit the JWT endpoint with the same identity to assert parity.
- `id_token vs access_token audience claim SHALL both be accepted` — **Needs infra access** — requires the JWT-bearer endpoint AND access token exposure.
- `display name SHALL be derived without round-trip when possible` — **Genuine test gap** — could be tested by asserting the SPA shows the user's display name on first paint without firing a /me call.

## logout-flow

- `per-app "Logout" SHALL NOT be relied on for security` — **Policy/doc** — negative requirement; verified by reasoning + the cross-cutting `session-lifecycle` reap test.
- `Cognito SSO teardown is operator-callable but not surfaced as a user action` — **Policy/doc** — operator-only convention.
- `Cognito allowlist SHALL include the portal main page` — **Cognito-side** — Cognito app client config.

## workspace-auto-join

- `auto-join SHALL run on every login, not just on user creation` — **Genuine test gap** — log in as an existing user previously removed from their workspace; assert they are re-joined on next login.
- `auto-join SHALL skip when no workspace exists yet` — **Genuine test gap** — fresh bundle with no workspace; assert user is created but unbound.
- `auto-join target SHALL be the oldest workspace` — **Genuine test gap** — create two workspaces with distinct creation times, log in as a fresh user, assert they land in the oldest.
- `auto-join role SHALL be the app's regular-member role, not Admin or Guest` — **Partially covered** — `tests/apps/{outline,twenty,penpot,surfsense,pm}-admin.spec.ts` each assert NORMAL_USER (the auto-joined identity) lands without admin/owner rights on the respective app. Tags now in place. A direct DB-role probe is still future work.
- `auto-join SHALL mark onboarding complete on the user profile` — **Genuine test gap** — assert profile shows onboarding skipped.
- `per-app workspace model SHALL be documented in workspaces.md` — **Policy/doc** — doc requirement; verified by file existence in `awais786/sso-rules-moneta`.
- `auto-join SHALL NOT leak across apps` — **Covered** — `tests/auth/workspace-auto-join-independence.spec.ts` probes each app's own workspace-id endpoint and asserts no two apps share an identifier (would only be possible with a shared backend).

---

## Coverage outside the openspec contract scope

These specs live in the suite but pin per-app *authorization gating* or *app-functionality* — a product-feature concern, not part of the SSO contract published in `awais786/sso-rules-moneta/openspec/specs/`. They're listed here so the traceability story is complete:

| Spec file | What it verifies | Why no `@spec` tag |
|---|---|---|
| `tests/apps/outline-admin.spec.ts` | FOSS_USER (Outline `users.role = 'admin'`) reaches every `/settings/*` admin page; NORMAL_USER is gated (404 / module-failed shell) for ADMIN_ONLY paths and reaches COMMON paths | Outline's per-team role model is product-internal; the SSO contract only delivers `X-Auth-Request-Email` and does not specify what each app does with it |
| `tests/apps/twenty-admin.spec.ts` | FOSS_USER reaches `/settings/admin-panel` (requires `User.canAccessFullAdminPanel`); NORMAL_USER is bounced to `/objects/companies` | `canAccessFullAdminPanel` is Twenty-internal; the spec contract doesn't touch instance-admin flags |
| `tests/apps/penpot-admin.spec.ts` | FOSS_USER (team Owner) sees "Invite people" + role combobox on `/#/dashboard/{invitations,members}`; NORMAL_USER (Editor) doesn't | Penpot team roles are product-internal |
| `tests/apps/surfsense-admin.spec.ts` | FOSS_USER (SearchSpace Owner) sees role-change `<button>` on other members' rows in the Manage Members modal; NORMAL_USER (Editor) sees them as static text | SurfSense `search_space_memberships.is_owner` is product-internal |
| `tests/apps/pm-admin.spec.ts` | FOSS_USER (workspace owner) reaches `/<slug>/settings/members`; NORMAL_USER (non-member) sees Plane's "Workspace not found" shell | Plane workspace membership is product-internal; distinct from god-mode which IS in scope (`forwardauth-traefik#bypass`) |
| `tests/apps/pm-project-create.spec.ts` | A logged-in user creates a new project from the workspace projects page; the full create round-trips (Plane API + SeaweedFS storage) without `"cannot upload"` / media-type regressions | Plane project creation exercises Plane's API + storage layer (AWS / SeaweedFS access-key alignment + browser-reachable presigned-URL hostname). Both are config / deployment concerns, not the SSO contract. Promoted from staging (formerly `tests/bugs/bug_4961d647.spec.ts`); may go red intermittently while the storage-credential fix rolls through deployments. |
| `tests/security/cookie-attributes.spec.ts` | `_oauth2_proxy` cookie is issued with `HttpOnly=true`, `Secure=true`, `SameSite=Lax\|Strict`, `Domain` exactly equal to the platform parent, and `Path=/` | The openspec only requires the cookie domain (`oauth2-proxy-gateway#cookie-domain-shall-be-the-platform-parent-domain`) and HMAC integrity (proven by `cookie-tampering.spec.ts`). HttpOnly/Secure/SameSite are oauth2-proxy defaults but the suite needs an explicit assertion so a config drift can't silently weaken the blast radius. |
| `tests/security/headers.spec.ts` (hardening rules beyond the openspec baseline) | CSP must include `default-src` and avoid `'unsafe-inline'` in `script-src` (HTML targets); Cross-Origin-Opener-Policy must equal `same-origin`; Cross-Origin-Resource-Policy must be set; Server header must not leak upstream version (`nginx/<n>`, `apache/<n>`, etc.) | None of these are in the openspec but they're standard defense-in-depth controls. Failures gate merges so config drift can't silently weaken the surface. |

These tests collectively give partial coverage to `workspace-auto-join#auto-join role SHALL be the app's regular-member role, not Admin or Guest` — they prove the auto-joined NORMAL_USER does NOT end up with admin access. If you'd like to formalise that mapping later, replace this section with a 🟡 Partial entry in the main matrix and add `@spec` tags to the admin specs.

---

## Categories summary

| Category | Count | Notes |
|---|---|---|
| Infra-only | 8 | Covered by bundle-side `audit-sso.sh` |
| Cognito-side | 2 | Out of CI scope |
| Policy/doc | 3 | Verified by reasoning |
| Needs infra access | 2 | Blocked on bundle exposing additional state |
| Genuine test gap | 8 | Open work — candidates for the next coverage PR |

Live counts from `scripts/check-spec-coverage.sh` (against current upstream):
**25 ✅ Covered + 26 ⚠️ Deferred + 0 ❌ Missing = 51 total.**

The Categories table above totals 23 deferred — the remaining 3 are upstream requirements added since this table was last refreshed; re-run the script and refresh manually when the gap matters. (Or vendor the openspec so the table can be regenerated automatically.)
