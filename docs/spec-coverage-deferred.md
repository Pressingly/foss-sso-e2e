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
- `gateway SHALL pass access token to downstream apps when requested` — **Needs infra access** — requires `pass_access_token = true` config and a downstream endpoint that echoes the token; not exposed in current bundle.
- `gateway SHALL use the configurable identity claim` — **Infra-only** — config-level.
- `single shared callback URL` — **Infra-only** — Traefik config.

## forwardauth-traefik

- `backend ports SHALL be bound to 127.0.0.1 only` — **Infra-only** — only verifiable from inside the host; bundle's audit checks `docker-compose` port bindings.
- `auth-response headers SHALL include exactly the three required headers` — **Infra-only** — Traefik config; bundle audit greps for `authResponseHeaders`.

## session-lifecycle

- `Layer 1 SHALL refresh transparently against OIDC` — **Genuine test gap** — would need to fast-forward time or shorten TTL in a test bundle; not yet wired.
- `Layer 1 expiry while Layer 2 is valid SHALL re-auth transparently` — **Genuine test gap** — same TTL constraint.
- `Layer 1 expiry shall force a fresh Cognito login` — **Genuine test gap** — same TTL constraint (would need a short-TTL bundle or time-fast-forward to expire Layer 1 deliberately).
- `mPass-side session revocation SHALL be honoured on next refresh` — **Cognito-side** — requires admin API call to revoke a refresh token; not in CI scope today.
- `per-app session TTLs SHALL be uniformly configurable` — **Infra-only**.
- `Layer-2 session renewal SHALL be guarded against three regression paths` — **Partially covered** — `tests/auth/layer2-renewal-suppressed-on-4xx.spec.ts` pins the Penpot/`auth-token` case (4xx response must carry no fresh session cookie). Extending to Outline (`accessToken`) and Plane (`sessionid`) is the same shape with different per-app cookie names.
- `bridge state TTL SHALL be 3 minutes` — **Genuine test gap** — would need to wait 3 minutes or mock the TTL.

## cognito-claim-mapping

- `identity claim SHALL be configurable when email is unreliable` — **Partially covered** — `tests/auth/email-domain-consistency.spec.ts` proves cross-app `DEFAULT_EMAIL_DOMAIN` agreement (the load-bearing operational invariant); testing the *configurability* axis directly is infra-only.
- `claim mapping SHALL be the same across the cookie flow and the JWT-bearer flow` — **Needs infra access** — same blocker as `id_token vs access_token audience` below: the Cognito access token is not exposed via oauth2-proxy on the current bundle (requires `pass_access_token = true` plus a downstream echo endpoint). The e2e test shape would log in via cookie, capture the access token, and replay it as `Authorization: Bearer` against an app that accepts both paths; without token exposure the bearer leg can't be reached.
- `id_token vs access_token audience claim SHALL both be accepted` — **Needs infra access** — requires the JWT-bearer endpoint AND access token exposure.
- `display name SHALL be derived without round-trip when possible` — **Infra-shaped** — the "when possible" qualifier makes this conditional on bundle config (header propagation of `X-Auth-Request-Preferred-Username` etc.) rather than on observable app behaviour. Both Outline and Twenty's SPAs make a first-paint user-info round-trip regardless of header presence, so the e2e signal collapses to "headers exist on the upstream response" — which is config-only.

## logout-flow

- `per-app "Logout" SHALL NOT be relied on for security` — **Policy/doc** — negative requirement; verified by reasoning + the cross-cutting `session-lifecycle` reap test.
- `Cognito SSO teardown is operator-callable but not surfaced as a user action` — **Policy/doc** — operator-only convention.
- `Cognito allowlist SHALL include the portal main page` — **Cognito-side** — Cognito app client config.

## workspace-auto-join

- `auto-join SHALL run on every login, not just on user creation` — **Needs admin mutation** — the test shape requires removing the user from the workspace out-of-band (admin API or direct DB) between logins, then asserting the next login re-joins them. Without that mutation step, the observable collapses to "user is in workspace" — already covered by `tests/auth/workspace-auto-join-independence.spec.ts` for the static case. Admin removal needs either a workspace-Admin SSO identity (not currently provisioned) or instance-admin DB access from CI.
- `auto-join SHALL skip when no workspace exists yet` — **Genuine test gap** — fresh bundle with no workspace; assert user is created but unbound.
- `auto-join target SHALL be the oldest workspace` — **Genuine test gap** — create two workspaces with distinct creation times, log in as a fresh user, assert they land in the oldest.
- `auto-join role SHALL be the app's regular-member role, not Admin or Guest` — **Partially covered** — `tests/apps/{outline,twenty,penpot,surfsense,pm}-admin.spec.ts` each assert NORMAL_USER (the auto-joined identity) lands without admin/owner rights on the respective app. Tags now in place. A direct DB-role probe is still future work.
- `per-app workspace model SHALL be documented in workspaces.md` — **Policy/doc** — doc requirement; verified by file existence in `awais786/sso-rules-moneta`.
- `auto-join SHALL NOT leak across apps` — **Covered** — `tests/auth/workspace-auto-join-independence.spec.ts` probes each app's primary-workspace endpoint and asserts the returned identifier matches the bundle-configured value in `constants.ts` (`PLANE_WORKSPACE_ID`, `OUTLINE_TEAM_ID`, `PENPOT_TEAM_ID`). A regression where app A's storage backend gets pointed at app B's workspace store would surface as a mismatch. SurfSense omitted — its `/users/me` returns a per-user PK, not a workspace identifier; SurfSense membership is covered by `tests/apps/surfsense-admin.spec.ts`. (Prior shape — "no two apps share an identifier" — was vacuous against 4 independent UUID generators and is replaced with this positive-correlation shape.)

---

## Coverage outside the spec-driven loop

After issues #32 and #34, every contract-bearing test in the suite carries an `@spec` tag pointing at a vendored requirement. The bidirectional gate in `tests/meta/playwright-practices.spec.ts` enforces this.

What's left here is the **soft allowlist** — files that don't pin a contract and have a documented reason. Maintained in `tests/meta/playwright-practices.spec.ts` as `UNTAGGED_ALLOWLIST`; reproduced here for visibility:

| Spec file | Why exempt |
|---|---|
| `tests/apps/pm-project-create.spec.ts` | Plane project creation exercises Plane's API + storage layer (AWS / SeaweedFS access-key alignment + browser-reachable presigned-URL hostname). Storage / deployment concern, not the SSO contract. |
| `tests/apps/{outline,penpot,pm,surfsense,twenty}.spec.ts` | Per-app shell files just call `registerLinkCoverage()` — the parameterised assertions live in `tests/lib/link-coverage.ts`. Will fold into per-app skills (or a new `link-coverage` skill) when that work lands. |

By-directory exemptions (also in the meta spec):

- `tests/bugs/**` — bug tests pin a scenario via plan.md, not a contract requirement
- `tests/zap/**` — DAST scan drivers, not assertions
- `tests/meta/**` — the gates themselves

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
**59 ✅ Covered + 25 ⚠️ Deferred + 0 ❌ Missing = 84 total.**

The Categories table above is a manual rationale breakdown and may lag module growth (especially when vendored skill modules add requirements). Use `make audit` as the source of truth for live counts.
