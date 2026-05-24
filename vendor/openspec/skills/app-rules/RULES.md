# App Rules — devstack invariants for every app behind ForwardAuth

Canonical rules every app in this devstack must follow. Applies to:
- Existing apps: **Plane**, **Outline**, **Penpot**, **SurfSense**, **Twenty**
- Any future app added behind oauth2-proxy + Traefik ForwardAuth

When editing `docker-compose.yml`, `traefik/`, or any fork repo, this doc is the contract. Violations break the SSO chain.

---

## 1. Universal invariants

These rules apply to **every** app. No exceptions without a written tradeoff in this doc.

### SSO chain
- Every protected `-secure` Traefik router **MUST** carry `strip-auth-headers@docker, mpass-auth@docker` middlewares, in that order. Strip first; otherwise inbound `X-Auth-Request-*` is trusted before being scrubbed.
- Every backend reads identity from `X-Auth-Request-Email` (primary) → `X-Auth-Request-User` (fallback). If neither contains `@`, synthesize `{user}@${DEFAULT_EMAIL_DOMAIN}`. Reject the request only if both are empty.
  - **Canonical pattern** (Python apps — Plane, SurfSense):
    ```python
    DEFAULT_EMAIL_DOMAIN = os.getenv("DEFAULT_EMAIL_DOMAIN", "askii.ai")
    ```
    Equivalent in Node (Outline) / Clojure (Penpot) — same env var name, same default.
  - **Email synthesis is universal** — every backend that accepts bare-username Cognito pools needs it. **Verified ground truth (source grep across all 4 forks):** Plane ✅ `apps/api/plane/settings/common.py:64`, Outline ✅ `server/env.ts:537` + `authentication.ts:319`, Penpot ✅ `backend/src/app/http/auth_request.clj:47` (env mapped to `:default-email-domain` keyword via Penpot config DSL), SurfSense ✅ `surfsense_backend/app/config/__init__.py:321`. All 4 default to `askii.ai`.
  - The same `DEFAULT_EMAIL_DOMAIN` env **MUST** be set on every app container so synthesis stays consistent across the stack — otherwise the same Cognito user gets `user@askii.ai` from one app and `user@somewhere-else.com` from another → two distinct user rows, two profiles, broken cross-app handoff.
  - **Anti-pattern — polynomial-backtracking regex for email-shape detection.** When deciding "is this header value already email-shaped?" before synthesising, **MUST NOT** use unanchored or repetition-heavy regex like `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. CodeQL flags it as `js/polynomial-redos` and it's exponentially slow on adversarial input (e.g. `!@!.` repeated). Use `indexOf`-based detection instead:
    ```js
    const trimmed = raw.toLowerCase().trim();
    const atIdx = trimmed.indexOf("@");
    const dotIdx = trimmed.indexOf(".", atIdx + 1);
    const isEmailShaped = atIdx > 0 && dotIdx > atIdx + 1;
    ```
    Same semantics, O(n) complexity. Outline's `normalizeProxyEmail` (server/middlewares/authentication.ts, post-Pressingly/outline#19) is the canonical reference. Plane / Penpot / SurfSense use simpler substring checks and so do not exhibit the issue — but any future implementer reaching for a regex MUST follow the indexOf shape. Formal contract: [`../../openspec/specs/proxy-auth-middleware/spec.md`](../../openspec/specs/proxy-auth-middleware/spec.md) §"email-shape detection on header values SHALL avoid polynomial-backtracking regex".
- Every backend port is **internal-only**. Never publish backend ports on the host (`ports: ["8000:8000"]` is forbidden); access is exclusively through Traefik. Without that, `strip-auth-headers` is bypassable.
- Every app **MUST** set `AUTH_TYPE=SSO` env on its container (and the equivalent `NEXT_PUBLIC_*_AUTH_TYPE=SSO` on split-process frontends). This is the **header-trust gate** — backend / SPA must refuse to act on `X-Auth-Request-*` unless the gate is set. Without it, a misconfigured local dev or staging deploy silently trusts spoofed headers. The SPA must also hide local login/register/forgot-password UI when SSO is set.

### Session-identity reconciliation

Every authenticated request **MUST** be reconciled against the upstream identity before the app's own session is trusted. The middleware/guard runs three checks in order:

1. **Bypass path** → pass through unchanged.
2. **Authenticated session + (no proxy header OR proxy email matches session email)** → short-circuit, no DB work.
3. **Authenticated session + proxy email DIFFERS from session email** → flush the app's native session **immediately**, then fall through to re-authenticate as the incoming user. The flush MUST happen before any subsequent bail-out path (inactive user, etc.) so the previous identity cannot survive a partial re-auth.

Header absence is **NOT** a logout signal — internal requests (celery / tests / OPTIONS preflight / bypass paths reached internally / direct `127.0.0.1:8000` debug hits) legitimately arrive without the header. Treating absence as logout breaks every internal call.

**Why this exists:** the portal "Logout all" clears only `_oauth2_proxy` (Layer 2). Per-app native session cookies on `<app>.<domain>` survive — different cookie scope, cross-host clearing not available. Without this reconciliation, a same-browser user-switch (A logs out → B logs in upstream → refresh app tab) keeps serving A from the surviving Layer-1 cookie.

**Canonical contract:** [`../../openspec/specs/proxy-auth-middleware/spec.md`](../../openspec/specs/proxy-auth-middleware/spec.md). Each app implements the flush in a framework-appropriate way:

| App | Flush mechanism |
|---|---|
| Plane | `django.contrib.auth.logout(request)` before fall-through |
| Outline | Throw 401 → outer `auth()` catch clears `accessToken` cookie via `err.headers` |
| Twenty | `response.clearCookie('tokenPair', { path: '/' })` before guard `return false` |
| Penpot | Three paths: **re-key** (resolvable+active — fresh `auth-token` cookie) / **403** (blocked/inactive — with session-renewal guard to prevent stale-cookie extension on the denial) / **drop+expire** (unresolvable — `session/delete-fn` expires the browser cookie) |
| SurfSense | N/A — FastAPI re-derives identity per request, no native session to leak |

**Verifying for an app:** see scenario list in the openspec — there are six required test cases (match short-circuit, header-absent short-circuit, case-insensitive match, mismatch → flush+reauth, mismatch with inactive incoming user, bypass dominates mismatch).

### Bypass discipline
- Bypass routers (no `mpass-auth`) get `priority=20` (or higher). Secure catch-all routers stay at `priority=1-10`.
- Bypass paths are restricted to:
  - Static assets (`/_next/static`, `/static/`, `/js/`, `/css/`, `/images/`, `/fonts/`)
  - Health/docs (`/health`, `/docs`, `/openapi.json`)
  - Webhooks with their own token auth (`/api/hooks`)
  - **Admin bootstrap endpoints isolated from normal users** (`/god-mode` for Plane; the principle is "separate session universe, not reachable from the main app shell" — apps may use different paths)
  - Out-of-band sync protocols with their own auth (`/zero` — bearer token)
- **Never** bypass for routes returning user data or accepting mutations. If unsure, default to secure.

### TLS
- Devstack uses mkcert wildcard at `traefik/certs/local.crt` for `*.${PLATFORM_DOMAIN}`.
- Routers use `tls=true` (default cert store). **Never** `tls.certresolver=letsencrypt` — ACME is not configured.

### No plaintext HTTP routes
- Traefik **MUST** redirect every request on the `web` entrypoint (port 80) to the `websecure` entrypoint (port 443) at the entrypoint level. Configure via the documented CLI flag form on the Traefik command:
  ```yaml
  command:
    - --entrypoints.web.http.redirections.entryPoint.to=websecure
    - --entrypoints.web.http.redirections.entryPoint.scheme=https
  ```
- The env-var form (`TRAEFIK_ENTRYPOINTS_WEB_HTTP_REDIRECTIONS_ENTRYPOINT_TO=…`) is **silently ignored** on Traefik 3.x — verified on `traefik:v3.6.12` by inspecting the static-config dump in `docker logs traefik`: the `web` entrypoint had no `redirections` key even though the env vars were set. Do not use the env-var form.
- After the entrypoint redirect is in place, every per-app HTTP router (`traefik.http.routers.<name>.entrypoints=web` with no middlewares) is dead config — Traefik catches the traffic at the entrypoint before any router matches. Such routers may still exist for historical reasons; they're harmless once the entrypoint redirect lands, but should be deleted in cleanup passes.
- An app HTTP router that *serves content directly* (no `redirectScheme` middleware, no entrypoint-level redirect catching it first) is forbidden. The 2026-04-30 Electric `/v1/shape` exfiltration was exactly this shape — HTTPS sibling had `mpass-auth`, HTTP twin did not. Same pattern repeats on the main `/` path of any app whose HTTP router lacks middlewares (verified live on prod 2026-05-04: `http://foss.arbisoft.com/` returned 105KB of plaintext portal HTML, `http://foss-research.arbisoft.com/` returned the SurfSense Next.js SPA).
- ACME HTTP-01 challenge (`/.well-known/acme-challenge/`) is the only legitimate exception. Traefik 3.x auto-registers the challenge router with higher priority than the entrypoint redirect, so cert renewal continues to work unchanged when the redirect is configured.

### Security response headers
- Every **browser-facing** Traefik router **MUST** chain the `security-headers@docker` middleware. Cheap, no fork patches — one middleware definition on the Traefik service, one label per router.
- Canonical middleware definition (`docker-compose.yml`, on the `traefik` service):
  ```yaml
  - traefik.http.middlewares.security-headers.headers.stsSeconds=31536000
  - traefik.http.middlewares.security-headers.headers.stsIncludeSubdomains=true
  - traefik.http.middlewares.security-headers.headers.contentTypeNosniff=true
  - traefik.http.middlewares.security-headers.headers.customFrameOptionsValue=SAMEORIGIN
  - traefik.http.middlewares.security-headers.headers.referrerPolicy=strict-origin-when-cross-origin
  - traefik.http.middlewares.security-headers.headers.permissionsPolicy=camera=(), microphone=(), geolocation=(), payment=(), usb=()
  ```
- What each header buys:
  - **HSTS** (`stsSeconds=31536000` + `stsIncludeSubdomains`) — forces TLS for 1y, blocks first-visit MITM downgrade on the apex and every subdomain.
  - **X-Content-Type-Options: nosniff** — blocks MIME-sniffing XSS on file uploads / binary downloads (hardens SeaweedFS S3 too).
  - **X-Frame-Options: SAMEORIGIN** — blocks clickjacking. Highest-risk gap this closed was admin-bootstrap paths inside `plane-bypass` (`/god-mode`, `/api/instances`, `/auth/get-csrf-token`) — privileged admin UI under the same cookie scope as `plane-secure`, intentionally bypassing ForwardAuth, was clickjack-able cross-origin before this middleware landed.
  - **Referrer-Policy: strict-origin-when-cross-origin** — stops leaking full URLs (including query-string identifiers) to third-party sites.
  - **Permissions-Policy** — denies camera / microphone / geolocation / payment / usb by default; opt back in per-app if a real need lands.
- **`stsPreload` is intentionally NOT set.** The flag only takes effect after manual submission to hstspreload.org — setting it without submitting is cargo-cult. Removal from the preload list takes months-to-years if anyone ever does submit it, and pre-empts any future subdomain that doesn't ship TLS. Verified gap (the marginal MITM-on-first-visit defense) is not worth the side-effect.
- **CSP is intentionally NOT set in this central middleware.** A blanket policy breaks SPAs (Vite inline scripts, Next.js eval, Penpot ClojureScript image hosts) and a useful policy needs per-app tuning. Apps that want CSP should mint their own per-router middleware and chain it alongside `security-headers@docker`.
- **Chain ordering on `-secure` routers:** `strip-auth-headers@docker, security-headers@docker, mpass-auth@docker`. `security-headers` is a **response** middleware (Traefik runs response middlewares in reverse order), so its actual relative position vs. `strip-auth-headers` and `mpass-auth` (both request middlewares) doesn't affect the trust chain — but keep the canonical order for grep-ability and so future readers don't second-guess.
- **Chain ordering on bypass routers:** `strip-auth-headers@docker, security-headers@docker` (no `mpass-auth`). Bypass routers still need `strip-auth-headers` (the bypass priority alone doesn't scrub inbound `X-Auth-Request-*`) and still need `security-headers` (browser eats the static asset / health response and applies HSTS / X-Frame-Options to the origin regardless of whether the path bypassed auth).
- **Routers currently chained** (verified ground truth, `docker-compose.yml`):
  - Apex / landing: `landing-secure`
  - Auth surfaces: `oauth2-proxy-secure`, `oauth2-apps`, `mpass-bridge`
  - App `-secure`: `outline-secure`, `penpot-secure`, `plane-secure`, `surfsense-secure`, `surfsense-api-secure`, `twenty-secure`
  - Bypass: `outline-bypass`, `plane-bypass`, `penpot-bypass`, `surfsense-bypass`, `surfsense-api-bypass`
  - Out-of-band: `seaweedfs-s3-secure` (S3 endpoint; nosniff hardens binary downloads), `surfsense-zero-secure` (Zero cache WebSocket; chained alongside the existing `surfsense-zero-strip`)
- **Routers NOT chained (intentional):** Traefik internal `api@internal` (dashboard via SSH tunnel only, not browser-internet-reachable). Anything else missing the middleware is a bug.
- **After a label change:** Docker labels are read at container *create* time, not on compose file change. Add the label → `docker compose up -d` (recreates the container) — `restart` is not enough.
- **Verify a single router:**
  ```bash
  curl -sI https://<host>/<path> | grep -iE 'strict-transport|x-frame-options|x-content-type|referrer-policy|permissions-policy'
  ```
  All 5 headers should appear. Missing any header = middleware not chained on that router.

### Build pattern
Every fork is one of:
- **Pattern A (interpreted):** Pull official image. Volume-mount fork source. Edit → restart service → live.
  - Restart shape: `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml docker compose restart <svc> --no-deps`
- **Pattern B (compiled):** Build image once. Two sub-patterns for getting env values into the bundle:
  - **B1 — build-arg injection:** values baked at `docker build` time via Dockerfile `ARG` + `ENV`. Immutable per image. Plane Vite frontend uses this. Changing a value = rebuild.
  - **B2 — runtime placeholder substitution:** bake **placeholder tokens** (`__NEXT_PUBLIC_FOO__`) into the bundle, entrypoint script (e.g., `docker-entrypoint.js`, `nginx-entrypoint.sh`) substitutes real env values on container start. Same image, different deploys; changing a value = recreate container, no rebuild. SurfSense Next.js + Penpot nginx use this.
  - Build shape: `make dev.build.<app>.<component>` then recreate via `dev.restart.<app>`.

Pick A vs B (and B1 vs B2) before writing the Dockerfile. Don't volume-mount source into a Pattern B container — values were baked at build, mounting source has zero effect. Don't bake real values into a B2 image — terser will dead-code-eliminate placeholder branches if it sees them as falsy literals.

### Session TTL
- Five canonical env vars in `.env`. Two access-pair (seconds + duration), two refresh-pair (seconds + duration), and one sliding-refresh interval. Apps wire whichever shape their native config takes:
  ```
  SESSION_TTL_SECONDS=28800            # 8h — access cookie / app session, seconds
  SESSION_TTL_DURATION=8h              # same window, duration string

  SESSION_REFRESH_TTL_SECONDS=57600    # 16h — refresh token, seconds (must be >= access)
  SESSION_REFRESH_TTL_DURATION=16h     # same window, duration string

  SESSION_COOKIE_REFRESH_SECONDS=3600  # 1h — sliding-refresh interval (must be < SESSION_TTL_SECONDS)
  ```
- The sliding-refresh window controls how often oauth2-proxy + Penpot **re-validate** the cookie while the user is active. Set to a value < `SESSION_TTL_SECONDS` (typically 1h). Result: an actively-clicking user never hits the 8h ceiling — the cookie keeps rolling forward as long as activity continues. Set to `0` to disable. Compose default is `3600`.
- Every session-issuing app **MUST** wire one of these into its native config — verified ground truth in `docker-compose.yml`:
  - **Plane (Django):** `SESSION_COOKIE_AGE = ${SESSION_TTL_SECONDS}`
  - **SurfSense (FastAPI):** `ACCESS_TOKEN_LIFETIME_SECONDS = ${SESSION_TTL_SECONDS}`, `REFRESH_TOKEN_LIFETIME_SECONDS = ${SESSION_REFRESH_TTL_SECONDS}`
  - **Penpot:** `PENPOT_AUTH_TOKEN_COOKIE_MAX_AGE = ${SESSION_TTL_SECONDS}s`, `PENPOT_AUTH_TOKEN_COOKIE_RENEWAL_MAX_AGE = ${SESSION_COOKIE_REFRESH_SECONDS}s`
  - **oauth2-proxy:** `OAUTH2_PROXY_COOKIE_EXPIRE = ${SESSION_TTL_SECONDS}s`, `OAUTH2_PROXY_COOKIE_REFRESH = ${SESSION_COOKIE_REFRESH_SECONDS}s`
  - **Outline (ForwardAuth JWT cookie):** `SESSION_TTL_SECONDS` — fork patch in `server/middlewares/authentication.ts`, `server/utils/authentication.ts`, `server/routes/auth/index.ts` replaces the upstream `addMonths(3)` constant. Outline-as-OAuth-provider also wires `OAUTH_PROVIDER_ACCESS_TOKEN_LIFETIME` / `OAUTH_PROVIDER_REFRESH_TOKEN_LIFETIME`.
  - **Twenty (NestJS):** `ACCESS_TOKEN_EXPIRES_IN = ${SESSION_TTL_DURATION}`, `REFRESH_TOKEN_EXPIRES_IN = ${SESSION_REFRESH_TTL_DURATION}` — also drives the SSO cookie maxAge (refresh, not access).
- **Refresh-keeps-session invariant.** A page reload while the `_oauth2_proxy` SSO cookie is still valid **MUST NOT** bounce the user to the IDP or portal login. If an app's local session expires sooner than `SESSION_TTL_SECONDS` (Twenty's `ACCESS_TOKEN_EXPIRES_IN`, Plane's `SESSION_COOKIE_AGE`, etc.), the app's auth middleware **MUST** fall through to oauth2-proxy → ForwardAuth so a fresh app session can be re-issued from the still-valid SSO cookie. Apps **MUST NOT** short-circuit to their own `/login` route on missing local session — that breaks the chain and forces a real re-auth even though the SSO credential is fine. Verify by clearing every non-`_oauth2_proxy` cookie + Twenty-origin localStorage/sessionStorage in a logged-in browser, reloading the app, and confirming the URL stays on the app host.

### Logout

Two flows. Per-app and portal-wide are NOT chained.

**Per-app "Logout" (every SPA):** navigation-only. Top-level navigate the browser to the portal host. **MUST NOT** call any session-clearing endpoint — not the app's own `/auth/sign-out/`, not `/oauth2/sign_out`, not Cognito. Effective sign-out happens at the portal; per-app Logout is purely "take me back to the portal".

**Portal "Logout all":** the only flow that actually ends the session. Navigates to `https://auth.${PLATFORM_DOMAIN}/oauth2/sign_out?rd=https://${PLATFORM_DOMAIN}` to clear the shared `_oauth2_proxy` cookie. Does NOT touch per-app sessions and does NOT touch Cognito SSO. After this, ForwardAuth gates every subsequent app visit (no `_oauth2_proxy` → 401 → redirect to mPass) and `proxy-auth-middleware` Rule 2 reaps any stale per-app session on the next request.

**Drift (current 2026-05-16):** existing per-fork frontends (Plane, Outline, Penpot, Twenty) still POST to their app's `/auth/sign-out/` before navigating. That's redundant under this rule and harmless — the cleared session is recreated on the next request from `X-Auth-Request-Email` anyway. Tolerated; remove when touching the file for unrelated reasons. Future forks **MUST NOT** add this call.

**Why not advertise per-app Logout as a security boundary:** users clicking it expect to be "logged out" of that app. They aren't. UI copy / docs / onboarding must direct users to the portal "Logout all" when they actually need to end their session (e.g. before lending a device). See [`../../openspec/specs/logout-flow/spec.md`](../../openspec/specs/logout-flow/spec.md) for the formal scenarios.

**Per-app navigation target — every SPA still needs to compute the portal host correctly:**
- Two deployment shapes are in production. The portal-host derivation must work for whichever shape the app is deployed to:

  | Shape | Example app host | Portal host |
  |-------|------------------|-------------|
  | **4-label** `<app>.<smb>.<domain>` | `twenty.foss.arbisoft.com` | `foss.arbisoft.com` |
  | **3-label** `<app>-<smb>.<domain>` (legacy local devstack) | `foss-twenty.local.moneta.dev` | `foss.local.moneta.dev` |

- **Canonical regex (4-label sandbox + prod):**
  ```js
  window.location.hostname.replace(/^[^.]+\.(?=[^.]*\.[^.]*\.)/, "")
  // twenty.foss.arbisoft.com → foss.arbisoft.com
  ```
  The lookahead requires ≥2 trailing labels with dots, so single-label (`localhost`) and 2-label (`foo.example.com`) hosts no-op safely.
- **Does not cover the 3-label legacy local-devstack shape.** On `foss-twenty.local.moneta.dev` it strips to `local.moneta.dev` (missing the `foss.` prefix). If you need one image to work for both shapes, use the env-var path below instead.
- **Durable fix — read the deployer-supplied URL** (SurfSense PR #17 reference impl, `surfsense_web/lib/auth-utils.ts`):
  ```js
  const url = process.env.NEXT_PUBLIC_LOGOUT_REDIRECT_URL; // or VITE_*, REACT_APP_*
  if (!url) { console.error("..."); return false; }
  window.location.href = url;
  ```
  Compose env is already wired: `NEXT_PUBLIC_LOGOUT_REDIRECT_URL=${PLATFORM_PROTOCOL}://${SMB_NAME}.${PLATFORM_DOMAIN}` (and per-fork equivalents — `VITE_LOGOUT_REDIRECT_URL` for Plane, `REACT_APP_LOGOUT_REDIRECT_URL` for Twenty). Build pipeline in devstack `Makefile` (`dev.build.surfsense.web` line 635, `dev.build.plane.web` line 550) passes the matching `--build-arg`. New forks **MUST** consume the env, not regex-derive.
- Per-fork status (verified ground truth):
  | Fork | File | Approach | Works for |
  |------|------|----------|-----------|
  | Plane | `apps/web/core/store/user/index.ts` | regex (4-label) | sandbox + prod |
  | Outline | `app/stores/AuthStore.ts` | regex (4-label) | sandbox + prod |
  | Penpot | `frontend/src/app/main/data/auth.cljs` | regex (4-label) | sandbox + prod |
  | SurfSense | `surfsense_web/lib/auth-utils.ts` | regex (4-label); env-var migration in flight (Pressingly/SurfSense#17) | sandbox + prod |
  | Twenty | `packages/twenty-front/src/modules/auth/utils/buildPortalUrl.ts` | regex (4-label) — Pressingly/twenty#6 | sandbox + prod |
- Current state: 1-layer (app session only). `_oauth2_proxy` and Cognito cookies survive. Trade-off documented in CLAUDE.md.
- Restoring 3-layer requires Cognito hosted `/logout` and the steps in CLAUDE.md "Logout simplification — 2026-04-17".
- Port-preservation caveat: where the SPA passes a hostname-like value through to the rewriter, prefer `window.location.host` over `window.location.hostname` — `hostname` strips the port per the URL spec, breaking logout on non-standard-port deployments. Twenty's `buildPortalUrl` callsite uses `host`. Other apps may need the same treatment if ever deployed on non-standard ports.

### Identity-managed fields
In SSO mode, email + password are owned by Cognito. Hide or hard-disable:
- Local password change UI
- Local email change UI / RPC (changing email locally breaks `X-Auth-Request-Email` lookup → user locked out)

### User display name
The visible identifier in member lists, sidebars, comments, and audit UIs **MUST** be one of:
- A real Cognito name claim (`given_name` / `name`), forwarded by oauth2-proxy
- The Cognito numeric ID (the local-part of `X-Auth-Request-Email`)

It **MUST NOT** be the Cognito `sub` (a UUID) or any auto-generated UUID. UUID-shaped display names make users unidentifiable in cross-app workflows — you can't tell who commented on what, who edited a record, or who's in a member list.

**Common cause:** oauth2-proxy forwards `sub` (UUID) as the preferred-username header. Apps that read that header (e.g. Penpot's `fullname`, Outline's `name`) end up with UUIDs. Apps that read only `X-Auth-Request-Email` (Plane, SurfSense) use the email local-part instead and are fine.

**Two valid fixes:**
1. **At oauth2-proxy** (one-and-done): map the preferred-username claim from `cognito:username` instead of `sub`. All consumers benefit.
2. **At each app's ForwardAuth middleware**: ignore the preferred-username header and use the email local-part. Per-app PRs.

**Audit:** after a fresh SSO login, grep each app's user-display column for UUID-shaped values. Any match is a bug:

```sql
-- Penpot (DB: penpot)
SELECT email, fullname FROM profile
 WHERE fullname ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Outline (DB: outline)
SELECT email, name FROM users
 WHERE name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Plane (DB: plane) — checks both display_name and username
SELECT email, username, display_name FROM users
 WHERE display_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR username     ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- SurfSense (DB: surfsense) — note "user" is quoted (reserved word)
SELECT email, display_name FROM "user"
 WHERE display_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Twenty (DB: twenty, schema: core) — checks firstName + lastName
SELECT email, "firstName", "lastName" FROM core."user"
 WHERE "firstName" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR "lastName"  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```

A clean instance returns 0 rows from every query. Any match means an app is storing a UUID where a human-readable identifier should be.

Backfill existing rows once after the upstream fix lands:
```sql
UPDATE <user_table> SET <name_col> = split_part(email, '@', 1)
 WHERE <name_col> ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```
The regex matches only UUID-shaped values, so users with real names (manually edited or set by a name claim) are untouched.

### Compose hygiene
- **Never** run bare `docker compose ...` — drops the dev overlay's bind mounts.
- **Always:**
  ```bash
  COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml docker compose <cmd> --no-deps
  ```
- `--no-deps` prevents cascade into Valkey/Postgres unless explicitly intended.

### Stale-container hygiene
Old containers without the `foss-devstack-` prefix (left from prior compose-project names) get registered with Traefik and cause WRR 504s. Periodic check:
```bash
docker ps --format "{{.Names}}" | grep -v "foss-devstack-"
```
Stop anything that doesn't belong.

### Valkey cascade
Every Valkey consumer **MUST** declare:
```yaml
depends_on:
  valkey:
    restart: true
```
When Valkey is recreated, Compose restarts the dependent. Without this, oauth2-proxy and friends hold stale connection pools after a Valkey bounce → silent session-lookup failures.

---

## 2. App matrix (current state)

| Field | Plane | Outline | Penpot | SurfSense | Twenty |
|-------|-------|---------|--------|-----------|--------|
| Subdomain | `foss-pm` | `foss-docs` | `foss-design` | `foss-research` | `foss-twenty` |
| Build pattern (backend) | A — Python/Django | B — Node compiled | B — Clojure uberjar | A — Python/FastAPI | B — NestJS unified image |
| Build pattern (frontend) | B — Vite baked | (single image) | B — ClojureScript | B — Next.js placeholder tokens | B2 — `window._env_` runtime injection (`generateFrontConfig`) |
| Backend image | `ghcr.io/pressingly/plane-backend:v1.2.3-sso` | `foss-devstack/outline:dev` | `foss-devstack/penpot-backend:dev` | `ghcr.io/pressingly/surfsense-backend:latest` | `foss-devstack/twenty:dev` |
| Frontend image | `foss-devstack/plane-web:dev` | (same as backend) | `foss-devstack/penpot-frontend:dev` | `ghcr.io/pressingly/surfsense-web:latest` | (same as backend) |
| Fork branch (SSO) | `main` (foss-main) | `sso-auth` | `implement-sso-v2` | `foss-main` | `sso-auth` |
| 1-layer logout file | `apps/web/core/store/user/index.ts` | `app/stores/AuthStore.ts` + `app/scenes/Logout.tsx` | `frontend/src/app/main/data/auth.cljs` | `surfsense_web/lib/auth-utils.ts` | `packages/twenty-front/src/modules/auth/hooks/useAuth.ts` |
| TTL env consumed | `SESSION_COOKIE_AGE` ← `SESSION_TTL_SECONDS` | ⚠️ hardcoded `addMonths(3)` (fork patch pending) | `PENPOT_AUTH_TOKEN_COOKIE_MAX_AGE` ← `SESSION_TTL_SECONDS` | `ACCESS_TOKEN_LIFETIME_SECONDS` + `REFRESH_TOKEN_LIFETIME_SECONDS` ← `SESSION_TTL_SECONDS` / `SESSION_REFRESH_TTL_SECONDS` | `ACCESS_TOKEN_EXPIRES_IN` ← `SESSION_TTL_DURATION`; `REFRESH_TOKEN_EXPIRES_IN` ← `SESSION_REFRESH_TTL_DURATION` (cookie maxAge tracks **refresh**) |
| Bypass paths | `/god-mode`, `/api/instances`, `/_next/static`, `/static/` | `/api/hooks`, `/_next/static` | `/js/`, `/css/`, `/images/`, `/fonts/` | `/health`, `/docs`, `/openapi.json`, `/_next/static`, `/zero` | none — Twenty's SSO controller server-side redirects unauth users before assets load, so no bypass router needed |
| SSO integration shape | Django middleware (unified process) | Inside `authentication.ts` middleware (unified) | Reitit RPC middleware (unified) | Cookie handoff at `/auth/jwt/proxy-login` (split FE/BE) | Standalone NestJS controller `GET /auth/sso/proxy-login` (unified) — sets `tokenPair` cookie consumed by Jotai, no Passport ceremony |
| Email synthesis from username | ✅ `DEFAULT_EMAIL_DOMAIN` at `apps/api/plane/settings/common.py:64` + `proxy_auth.py:66,70` | ✅ `DEFAULT_EMAIL_DOMAIN` at `server/env.ts:537` + `authentication.ts:319` | ✅ `DEFAULT_EMAIL_DOMAIN` (env → `:default-email-domain` config key) at `auth_request.clj:47` | ✅ `DEFAULT_EMAIL_DOMAIN` at `config/__init__.py:321` + `proxy_auth.py:90,94` | ✅ `DEFAULT_EMAIL_DOMAIN` at `sso-proxy-login.controller.ts:resolveEmail` — rejects when env unset (no silent `user@undefined`) |

⚠️ = known issue, see `docs/known-issues.md`.

### App-specific notes

**Plane**
- `/god-mode` is a separate session universe; ForwardAuth must not touch it. Bypass router required.
- Postgres role for Plane needs `SUPERUSER` for first-time setup (init script in `postgres/initdb.d/`).
- Native auth URL patterns (`/auth/google/`, `/auth/github/`, `/auth/email/`, magic-link) are still mounted but unreachable. Disabling under `MPASS_SSO_ENABLED=true` is a pending hardening.

**SurfSense**
- Split process: Next.js frontend can't read `X-Auth-Request-Email` directly. Cookie handoff pattern at `/auth/jwt/proxy-login` issues a JWT, sets short-lived cookies (60s TTL), redirects to `/`. Frontend `(home)/page.tsx` reads cookies, stores JWT in localStorage.
- Alembic chain in fork **MUST** stay synced with upstream MODSetter/SurfSense. Drift → backend crash-loops with `Can't locate revision`. Fix: pull missing revisions from `real-upstream/main`. See CLAUDE.md.
- HuggingFace model + ffmpeg downloads on cold start (~5-10 min). Persisted by `surfsense-hf-cache` named volume.
- Streaming/SSE calls **MUST** use `authenticatedFetch`, not raw `fetch()`. Raw fetch bypasses the 401 wrapper — when JWT expires mid-stream the connection neither closes nor re-auths and the chat hangs silently. Affects `new-chat/page.tsx` and any future streaming surface.
- Zero cache replicas (port 4848) need their own replication slot on Postgres. Wiping the DB requires dropping the slot first (`SELECT pg_drop_replication_slot(...)`), then the volume `foss-devstack_surfsense-zero-cache-data`.
- Frontend uses Pattern B2 — env vars injected at startup by `docker-entrypoint.js`. Don't bake real `NEXT_PUBLIC_*` values via build-args; terser will dead-code-eliminate placeholder branches.

**Penpot**
- No dedicated SSO route — Reitit RPC middleware reads `X-Auth-Request-Email` as fallback (after session + access-token). Auto-provisions when `enable-x-auth-request-auto-register` is set in `PENPOT_FLAGS`.
- nginx-entrypoint substitutes runtime values (`MPASS_SIGNOUT_URL`, etc.) into the static bundle.
- `request-email-change` RPC is gated to reject when external IdP manages identity (commit `10441cf7d`).

**Outline**
- ForwardAuth integration is **inside** `server/middlewares/authentication.ts`, not a standalone middleware file. Two earlier standalone attempts hit a request/response race on first call.
- Auth check order: bearer header → `body.token` → `query.token` → `accessToken` cookie → `X-Auth-Request-Email`. SSO header last so subsequent requests short-circuit on the cookie.

**Twenty**
- Multi-workspace by design, but SSO is single-tenant: `SMB_NAME` env tells the dev-seeder which workspace to create (subdomain + capitalised displayName). Multi-tenant SSO would require routing by Cognito attribute / email domain / host — not implemented.
- Workspace bootstrap is automated end-to-end via two CLI commands invoked by the bundle's provisioning step (devstack: `provision/provision-twenty.sh`; prod: `twenty-bootstrap` one-shot compose service mirroring `plane-migrator`):
  1. `yarn command:prod workspace:seed:dev --light` — creates the `${SMB_NAME}` workspace with default Admin + Member roles. Idempotent: re-runs skip on `already exists` / `duplicate key` / `UNIQUE constraint` markers; unrecognised failures abort instead of being swallowed.
  2. `yarn command:prod workspace:bootstrap-sso-admin --email "${ADMIN_EMAIL}"` — finds-or-creates the user, attaches as Admin. Idempotent on existing memberships: if the user is already a Member (e.g. SSO sign-in beat bootstrap), promotes them via `assignRoleToManyUserWorkspace` (atomic create+delete in one migration). See twenty-fork commit `16f51d8`.
- The fork's image bundles its own postgres + redis but the bundle wires it to shared `postgres` + `valkey`. The init-db script auto-detects external mode via `PG_DATABASE_URL` (function `psql_target` in `init-db.sh`); reordering or hardcoding localhost would break startup against shared postgres.
- Cookie carries both access + refresh tokens — cookie `maxAge` derives from `REFRESH_TOKEN_EXPIRES_IN`, **not** the access TTL, so the browser doesn't drop the refresh token alongside the access token expiring. `Secure` flag derives from `SERVER_URL.startsWith('https')` so http:// dev setups work.
- Logout: `useAuth.ts` calls `buildPortalUrl(window.location.host, window.location.protocol)` — **`host` not `hostname`** because `hostname` strips the port per the URL spec (logout on `:8080` would otherwise lose the port). The `^([^-]+)-[^.]+\.(.+)` regex preserves the port automatically since the captured group 2 includes everything after the first label.
- SECURITY: `auth/sso/proxy-login` is a `@PublicEndpointGuard` route that trusts `X-Auth-Request-Email`. Trust chain (any link broken = auth-bypass): (1) Twenty's `:3000` is unpublished; (2) Traefik's `twenty-secure` runs `strip-auth-headers` BEFORE `mpass-auth`; (3) oauth2-proxy ForwardAuth re-injects the headers from the validated session. Documented inline at the controller class header.
- Identity-managed UI gating: login/signup form, password reset, change-password button, email field, 2FA workspace toggle, and 2FA setup page (`/settings/profile/two-factor-authentication/TOTP`) all read `useIsSsoEnabled()` and either hide or redirect to `/settings/profile`.
- **Image build:** `--target twenty` is required (selects the server+frontend prod stage at line 137 of `packages/twenty-docker/twenty/Dockerfile`). Without `--target`, Docker default-builds the last stage `twenty-app-dev` (s6 multi-process dev image), which is wrong for prod. Bundle's `build-images.sh build_twenty` and devstack's `dev.build.twenty` Makefile target both pass `--target twenty`.
- **Upstream SSO coexistence:** Twenty upstream has native OIDC + SAML SSO ([twentyhq/twenty#7246](https://github.com/twentyhq/twenty/pull/7246), Oct 2024) with active iteration. Our fork's `auth/sso/proxy-login` is **additive**, not a replacement — upstream's browser-mediated SSO still works for standalone deploys, our header-trust path is the bundle-mode entry. Both gate on `AUTH_TYPE=SSO`. No merge conflict expected on rebase since fork additions are sibling files, not edits to upstream SSO modules.

---

## 3. Adding a new app — checklist

When introducing a 5th (or Nth) app, work through this list. Each item is required unless explicitly deferred with a written tradeoff.

1. **Subdomain.** Pick `foss-<name>.${PLATFORM_DOMAIN}`. Add to mkcert SAN list if not already covered by `*.${PLATFORM_DOMAIN}` wildcard.
2. **Cognito.** No new client needed — all 4 existing apps share one. The single callback `https://foss-auth.${PLATFORM_DOMAIN}/oauth2/callback` covers any new subdomain.
3. **Build pattern.** Decide A or B before writing the Dockerfile. Document choice in this file.
4. **Image source.** Pull upstream + volume-mount source (Pattern A) OR fork + bake placeholder tokens (Pattern B). Don't mix.
5. **Compose service.**
   - `image:` — set
   - `depends_on: valkey: { restart: true }` — required if it touches sessions
   - `depends_on: postgres: ...` — if it has its own DB
   - **No** `ports:` mapping (internal-only)
   - `AUTH_TYPE=SSO` env
   - `SESSION_TTL_*` env wired into the app's native config var
6. **Traefik routers.**
   - `<name>-secure` router with full host rule, `priority=1`, middlewares `strip-auth-headers@docker, security-headers@docker, mpass-auth@docker`
   - Bypass routers at `priority=20+` for static / health / webhooks. Middlewares `strip-auth-headers@docker, security-headers@docker` (no `mpass-auth`). Justify each bypass path against the bypass discipline.
   - If the router is browser-facing (returns HTML, JS, CSS, JSON, or anything a browser renders / executes) it **MUST** carry `security-headers@docker`. Out-of-band protocols (S3 API, bearer-token WebSocket) also benefit from `nosniff` — default to chaining unless you have a specific reason not to.
7. **Backend identity reading.** `X-Auth-Request-Email` first, `X-Auth-Request-User` fallback, synthesize `{user}@${SMB_NAME}.com` if no `@`.
8. **Logout.** Implement the 1-layer shape: app endpoint clears session → SPA clears client state → navigate to portal host. Read the deployer-supplied URL (`process.env.NEXT_PUBLIC_LOGOUT_REDIRECT_URL` or per-fork equivalent) when possible; if the SPA must derive from hostname, use `hostname.replace(/^[^.]+\.(?=[^.]*\.[^.]*\.)/, "")` (4-label sandbox + prod shape — see §1 Logout for the full table).
9. **Hide local auth UI.** Login/register/forgot-password/email-change/password-change. SSO mode owns identity.
10. **Smoke test.** Add `docs/<name>-smoke-test.md` covering: SSO redirect, JWT/session issuance, app-API call with `X-Auth-Request-Email`, logout → portal, re-auth round-trip.

If the app is split frontend/backend (like SurfSense), expect to add a **JWT cookie handoff step**: dedicated backend endpoint (e.g., `/auth/jwt/proxy-login`) reads `X-Auth-Request-Email`, issues JWT + refresh as **short-lived cookies (60s TTL)**, 302 → `/`. Frontend root reads cookies, stores JWT in localStorage / client state, clears cookies, navigates to `/dashboard`. No `/auth/callback` route — keeps Traefik routing simple.

If unified process (like Plane/Outline/Penpot), the middleware can read the header directly.

---

## 4. Threat model & security verification

Every change to compose, Traefik labels, or fork auth code must preserve the **trust chain that closes external header forging**. This section spells out which invariant defends against which threat, so the per-app `<status>` cells in the report can be set with a clear rationale.

### Threat 1 — external attacker forges identity headers

A client on the public internet sends `GET /<protected>` with `X-Auth-Request-Email: admin@askii.ai`.

**Closed by all three of:**

| Layer | What stops the attack |
|-------|----------------------|
| `:port` not published on host | The attacker can't reach the backend directly. Traefik on `:443` is the only ingress. |
| `strip-auth-headers` applied BEFORE `mpass-auth` on every `<app>-secure` router | Inbound `X-Auth-Request-*` from any browser is deleted at the edge before any handler sees it. |
| `mpass-auth` (oauth2-proxy ForwardAuth) | Without a valid `_oauth2_proxy` cookie → 302 to Cognito. With a valid cookie → oauth2-proxy injects the **real** authenticated user's email, overwriting any client-supplied value. |

**Verifying for an app:** confirm all three for its `<app>-secure` router. Reordering, removing, or downgrading any link silently re-opens the forgery path.

### Threat 2 — sibling-container compromise (internal)

An attacker who breaks one app's process gets shell on a docker container with full network access to every other app's backend port. From there they can dial `twenty:3000` directly with a forged header and impersonate any user.

**Not fully closed.** Network isolation contains external attackers but not lateral movement on the docker network. Acknowledged limitations:

- The compromised app already has its own DB credentials in env, so direct postgres queries bypass auth-at-app entirely.
- Valkey is unauthenticated in this devstack, so session fixation is also reachable.
- `_oauth2_proxy` cookies in Valkey can be read by anyone on the docker network.

**Defense-in-depth options (none currently applied):**

- Per-app docker network (Traefik bridges to all apps; apps can't dial each other) — strongest, ~15 lines of compose.
- App-level shared-secret header injected by Traefik on every `*-secure` router and validated server-side — narrower, requires a fork patch in every app.
- Per-app valkey passwords / ACL'd databases.
- Read-only postgres roles for any code path that doesn't write.

If a PR proposes a shared-secret guard or similar narrow hardening, weigh it against the cross-cutting nature of the threat: a per-endpoint check leaves postgres / valkey / S3 access untouched. Either roll the same pattern across all 5 apps or document the limitation in `docs/known-issues.md`.

### Threat 3 — backend acts on `X-Auth-Request-*` without ForwardAuth verifying

If `AUTH_TYPE=SSO` is missing from a backend container, the app may default to a non-SSO mode where it doesn't enforce the header-trust gate. A misconfigured local dev or staging then silently trusts spoofed headers.

**Closed by:** `AUTH_TYPE=SSO` (and the `NEXT_PUBLIC_*_AUTH_TYPE` mirror on split frontends) on every app container, plus a backend-side check that refuses to act on `X-Auth-Request-Email` unless the env is set.

**Verifying for an app:** grep the backend for `AUTH_TYPE` reads; confirm the SSO middleware/controller refuses identity headers when the env is anything other than `SSO`.

### Threat 4 — cookie misconfiguration (Secure / SameSite / HttpOnly)

If a session cookie is minted with `secure: false` on https origins, or `sameSite: 'none'` without `secure`, it can be read by intermediaries or accessed cross-origin. If `httpOnly: false` is required for the SPA to read it, the cookie must be short-lived and cleared after use.

**Closed by, per-app:**

- `secure` flag derives from `SERVER_URL.startsWith('https')`, never hardcoded `true` (breaks http:// dev) or `false` (breaks production).
- `sameSite: 'lax'` for cross-tab session continuity.
- `httpOnly: true` for cookies the SPA never reads. SurfSense + Twenty use short-lived `httpOnly: false` cookies for the SSO handoff (60s TTL, cleared by SPA after read).

**Verifying for an app:** find every `res.cookie(...)` / `Set-Cookie` site; confirm the flags. Hardcoded `secure: true` is the most common drift (works in prod, breaks dev).

### Threat 5 — identity-managed UI lets the user break their own SSO lookup

If the SPA exposes "change email" or "change password" while `AUTH_TYPE=SSO`, a user can change their local email to something Cognito doesn't return as `X-Auth-Request-Email` — locking themselves out on the next request.

**Closed by:** SSO-aware gating on every identity-managed surface — login/signup form, password change, password reset, email change, 2FA enforcement toggle, 2FA TOTP setup. Either hide the UI or hard-redirect away.

**Verifying for an app:** grep for `useIsSsoEnabled` / `AUTH_TYPE` reads in the frontend; confirm each identity-managed component checks it.

### Threat 6 — logout regression to `/oauth2/sign_out`

The 2026-04-17 simplification dropped the oauth2-proxy `/sign_out` hop because Cognito hosted `/logout` isn't available on this app client and the intermediate hop produces a visibly broken redirect. A future PR re-introducing `/oauth2/sign_out` would re-introduce the broken UX.

**Closed by:** every app's logout target is the bare portal host (env-supplied URL, or `window.location.hostname.replace(/^[^.]+\.(?=[^.]*\.[^.]*\.)/, "")` — see §1 Logout), with no `/oauth2/sign_out` suffix.

**Verifying for an app:** grep the SPA's logout handler for the literal `oauth2/sign_out` — should not appear unless the app has explicit Cognito hosted logout config.

### Threat 7 — browser-side attacks bypass the SSO trust chain

Even with the full SSO chain intact, a browser hitting an app over a stripped-down HTTP connection, an iframe embed, a MIME-confused upload, or a referrer leak can bypass the auth model entirely:

- **TLS downgrade on first visit** — attacker on the network injects an `http://` redirect before HSTS is cached. Steals the `_oauth2_proxy` cookie if `Secure` isn't enforced end-to-end.
- **Clickjacking** — attacker iframes the app (or its admin-bootstrap bypass path) into their own page, overlays UI, tricks the user into one-click actions. Plane's `/god-mode` was the highest-risk surface here — privileged UI under the same cookie scope as `plane-secure`, no auth challenge, framed without protection.
- **MIME-sniffing XSS** — user-uploaded file served back; browser guesses MIME type from content, executes as HTML/JS in the origin. SeaweedFS binary downloads + any per-app upload surface.
- **Referrer leak** — full URL (with embedded tokens / IDs in the query) bleeds to third-party sites on outbound links.
- **Powerful API abuse** — embedded third-party script silently turns on camera / microphone / geolocation.

**Closed by:** the `security-headers@docker` middleware chained on every browser-facing router. Each header pins one mitigation: HSTS (downgrade), X-Frame-Options (clickjacking), X-Content-Type-Options (sniff), Referrer-Policy (leak), Permissions-Policy (API). See §1 "Security response headers" for the canonical settings and the no-preload / no-CSP rationale.

**Not closed by this middleware:** CSP (per-app, not central — needs script-src / style-src / img-src tuning), COOP/COEP (would break embedded media + cross-origin iframes the apps actually use), application-layer auth (separate threats above).

**Verifying for a router:** `curl -sI https://<host>/<path>` should return all 5 headers — `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. Missing any one = middleware not chained. After fixing a label, **recreate the container** (`docker compose up -d`), not just restart — Docker labels are read at create-time.

### Threat 8 — stale per-app session survives upstream user switch

When the portal's "Logout all" clears the shared `_oauth2_proxy` cookie, each app's native session cookie (Django `sessionid`, Outline `accessToken`, Penpot `auth-token`, Twenty `tokenPair`) survives on its own subdomain — the portal cannot clear cookies scoped to another host. If a different user then logs in upstream and visits the app, the legacy "skip if session present" middleware path keeps serving the previous user.

Concrete repro on a vulnerable build:

1. User A logs in to Plane. `_oauth2_proxy=A` (shared) and `sessionid=A's session` (per-app) both set.
2. User clicks "Logout all" on the portal. `_oauth2_proxy` cleared. `sessionid` survives.
3. User B logs in via mPass on the same browser. `_oauth2_proxy=B` issued.
4. User refreshes Plane. ForwardAuth passes (B is valid). Without reconciliation, the middleware short-circuits on A's `sessionid` → request served as A.

**Closed by:** §1 "Session-identity reconciliation" — every authenticated request compares the proxy header against the session's user email and flushes on mismatch before any other work.

**Per-app fix references:**

- Plane — [Pressingly/plane#29](https://github.com/Pressingly/plane/pull/29) (merged on branch)
- Outline — `Pressingly/outline:fix/proxy-auth-stale-session-on-user-switch` (commit `974e04153`)
- Twenty — `Pressingly/twenty:fix/proxy-auth-stale-session-on-user-switch` (commit `0cf32920ca`)
- Penpot — `Pressingly/penpot:fix/proxy-auth-stale-session-on-user-switch` (commit `041d167f0`)
- SurfSense — N/A (architecturally immune; FastAPI re-derives per request)

**Verifying for an app:** run the 6-scenario test suite from `openspec/specs/proxy-auth-middleware/spec.md`. The bail-out scenario (mismatch + inactive incoming user → no `user_login`, AnonymousUser) is the regression guard for the subtle case where the flush could be skipped.

**Why this isn't "just patch the portal logout":** chasing the per-app cookies from the portal would require per-app CORS allow-lists, single-use logout tokens, and a chain across every app subdomain on every portal logout. Any one app offline → leak returns. Closing the leak at the in-app middleware boundary is cheap, framework-appropriate, and works under the documented Layer-2-only portal logout model.

---

## 5. Diagnosis quick-reference

Symptoms and first-check (full table in CLAUDE.md):

| Symptom | First check |
|---------|-------------|
| 504 on a healthy container | Stale container without `foss-devstack-` prefix in `docker ps` |
| Cognito redirect loop | Valkey recreated without cascading oauth2-proxy → `make dev.restart.valkey` |
| Compiled app using wrong URL | Image was Pattern B but built with hardcoded values, not placeholders |
| Stuck at `/auth/jwt/proxy-login` (SurfSense) | Backend bind mount missing — check `/app` not `/code` |
| User logged in after logout | Expected since 2026-04-17 (1-layer). For 3-layer see CLAUDE.md. |
| Logout lands on wrong host (e.g. `foss.foss.<domain>`) | Image was built before the 4-label-shape regex landed; rebuild + recreate the SPA container. If the deployment hostname shape isn't 4-label, switch to env-supplied URL — see §1 Logout. |
| `tls.certresolver=letsencrypt` errors | Remove — devstack uses mkcert |
| All apps down | oauth2-proxy crash-looping (DNS to Cognito OIDC discovery) |
| Streaming chat / SSE hangs after token TTL | Frontend using raw `fetch()` instead of `authenticatedFetch` — stream never closes when JWT expires |
| App accepts `X-Auth-Request-Email` but not from oauth2-proxy | `AUTH_TYPE=SSO` env not set on the container — header-trust gate disabled |
| Page refresh bounces to login despite valid `_oauth2_proxy` cookie | App's local session TTL is shorter than `SESSION_TTL_SECONDS` and its auth path short-circuits to its own `/login` instead of falling through to ForwardAuth. Check `OAUTH2_PROXY_COOKIE_REFRESH` is set on oauth2-proxy and that the app re-issues its session from `X-Auth-Request-Email` on missing local session. See §1 Session TTL — Refresh-keeps-session invariant. |
| `Strict-Transport-Security` / `X-Frame-Options` missing on a router | `security-headers@docker` not in the router's middleware chain — add the label, then **`docker compose up -d` to recreate the container** (labels are read at create-time, `restart` won't pick them up) |
| App embeds in an iframe / `frame-ancestors` violation on legitimate use | `customFrameOptionsValue=SAMEORIGIN` denied the embed. Either move the iframer to the same origin or carve out a per-router middleware that overrides X-Frame-Options for that specific router (don't change the central middleware — it'll re-open clickjacking everywhere) |

---

## 6. References

- `CLAUDE.md` — narrative + full diagnosis table
- `docs/known-issues.md` — open issues (Outline TTL hardcode, Penpot bare-username, etc.)
- `docs/mpass-sso.md` — full design narrative
- `docs/mpass-sso-rollout.md` — stage-by-stage delivery log
- `docs/<app>.md` + `docs/<app>-smoke-test.md` — per-app integration + verification
