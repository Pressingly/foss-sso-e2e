---
name: app-rules
description: Use when editing docker-compose.yml, traefik/, or any fork repo (plane, outline, penpot, surfsense) in a foss-server-bundle-devstack — enforces SSO chain, bypass router, build pattern, logout, session TTL, and compose hygiene invariants for every app behind oauth2-proxy + Traefik ForwardAuth. Also use when adding a new app behind ForwardAuth.
---

# app-rules — devstack invariants check

Canonical rules every app in a foss-server-bundle-devstack must follow. Applies to existing apps (Plane, Outline, Penpot, SurfSense) and any future app added behind oauth2-proxy + Traefik ForwardAuth.

When editing `docker-compose.yml`, `traefik/`, or a fork repo, **read this skill's companion doc** at `skills/app-rules/RULES.md` (the canonical contract). Then verify the change against the invariants below.

## Steps

### 1. Load the canonical rules
Read [`RULES.md`](./RULES.md) — bundled with this skill, contains:
- §1 Universal invariants (every app, current + future)
- §2 App matrix (Plane / Outline / Penpot / SurfSense × shape columns)
- §3 "Adding a new app" 10-item checklist
- §4 Diagnosis quick-ref

### 2. Check the change against universal invariants

For every diff in scope (compose, Traefik labels, fork code), verify:

- **`-secure` routers** carry `strip-auth-headers@docker, mpass-auth@docker` in that order; **browser-facing routers also chain `security-headers@docker`** (response middleware — order within the chain doesn't affect the trust path; canonical order is `strip-auth-headers, security-headers, mpass-auth` for grep-ability)
- **Bypass routers** are `priority=20+`, only static / health / webhooks / admin-bootstrap / out-of-band-sync — never user data or mutations. Bypass routers still chain `strip-auth-headers@docker, security-headers@docker` (the bypass priority alone doesn't scrub inbound `X-Auth-Request-*`, and the browser still applies HSTS / X-Frame-Options to whatever the bypass returns)
- **Backend ports** are NOT published on host (no `ports:` block on app backends)
- **`AUTH_TYPE=SSO`** env is set on every app container (header-trust gate)
- **TLS** uses `tls=true` only — never `tls.certresolver=letsencrypt`
- **No plaintext HTTP** — Traefik command includes `--entrypoints.web.http.redirections.entryPoint.to=websecure` (CLI flag form; env-var form is silently ignored on Traefik 3.x). No per-app HTTP router serves content without a redirect; ACME HTTP-01 challenge is the only allowed exception
- **Build pattern** is consistent: Pattern A (interpreted) gets volume mounts; Pattern B (compiled) gets placeholder tokens (`__NEXT_PUBLIC_FOO__`), not real values, baked into the image
- **Session access TTL** wires `SESSION_TTL_SECONDS` or `SESSION_TTL_DURATION` into the app's native config (Django `SESSION_COOKIE_AGE`, Penpot `:auth-token-cookie-max-age`, oauth2-proxy `OAUTH2_PROXY_COOKIE_EXPIRE`, FastAPI `ACCESS_TOKEN_LIFETIME_SECONDS`, Twenty `ACCESS_TOKEN_EXPIRES_IN`, Outline JWT cookie via fork patch)
- **Refresh TTL** wires `SESSION_REFRESH_TTL_SECONDS` / `SESSION_REFRESH_TTL_DURATION` for apps that mint refresh tokens (SurfSense, Twenty, Outline OAuth-provider role)
- **Sliding-refresh** wires `SESSION_COOKIE_REFRESH_SECONDS` for oauth2-proxy + Penpot so active sessions never hit the access ceiling
- **Valkey consumers** declare `depends_on: valkey: { restart: true }` (sessions cascade on Valkey recreate)
- **Logout** clears app session + reads the **required** `SMB_NAME` env (no per-app default — crash loudly if unset) and rewrites the host: `hostname.replace(/^[^.]*\./, ` + `${smbName}.` + `)`. Container env name is always `SMB_NAME`; only the *exposure* mechanism varies per stack (Vite `define`, Next.js placeholder substitution, Outline `@Public` decorator, Twenty `generateFrontConfig`, Penpot `nginx-entrypoint.sh`). Hardcoded prefixes are forbidden — they silently break when the deployment moves domains
- **Identity-managed UI** hidden under SSO: signin/signup, password change/reset, email change, 2FA enforcement toggle, 2FA TOTP setup page (redirect, not just hide)
- **Compose commands** in scripts/Makefile use `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml ... --no-deps` — never bare `docker compose`

### 3. If adding a new app
Walk the "Adding a new app" 10-item checklist in `RULES.md` §3. Each item is required unless deferred with a written tradeoff documented in your repo's `docs/known-issues.md`.

### 4. If changing identity / cookies / session shape
Cross-check against the matrix in `RULES.md` §2. Confirm:
- The change applies consistently across all apps (SSO chain rules are uniform; per-app integration shape is the only variation)
- The "App-specific notes" subsection for the affected app stays accurate (update it if not)

### 5. Report

Print **only** the table below — no PASS/FAIL prose sections, no preamble. Replace each `<status>` placeholder with exactly one of `✅` (invariant holds), `❌` (invariant violated), or `n/a` (invariant doesn't apply to this scope — only allowed where the row's "Notes" guidance explicitly mentions n/a). The Notes cell carries a concrete file:line citation when ✅ and a file:line + the specific fix when ❌. If the change touches no SSO/ForwardAuth surface, skip the table and write a one-sentence "no in-scope changes" line instead.

The first three rows together cover Threat 1 in `RULES.md` §4 (external header forging). All three must be `✅` or the trust chain is open. Rows 4–6 cover Threat 3 (header-trust gate). Row 11 covers Threat 4 (cookie misconfiguration). Rows 12–13 cover Threats 5–6 (identity-managed UI + logout regression). Row 18 covers Threat 7 (browser-side attacks — clickjacking, MIME-sniff XSS, TLS downgrade, referrer leak). The remaining rows are operational invariants whose breakage doesn't directly open auth-bypass paths but breaks the deploy or the cross-app contract.

| # | Invariant | Status | Notes |
|---|-----------|--------|-------|
| 1 | strip-auth-headers + mpass-auth on -secure (in that order) | `<status>` | router(s) checked + file:line; on ❌ name the missing/misordered middleware. Reordering re-opens external header forging |
| 2 | backend ports unexposed | `<status>` | on ❌ list every service with a `ports:` block. Publishing a backend port bypasses the strip-auth chain entirely |
| 3 | bypass router priority + path discipline | `<status>` | router(s) checked at priority=20+; on ❌ flag the user-data / mutation path that was bypassed. A bypassed mutation is an unauthenticated write |
| 4 | AUTH_TYPE=SSO env (backend) | `<status>` | service(s) checked; on ❌ name the apps missing the env (header-trust gate disabled — backend may trust spoofed headers in non-SSO mode) |
| 5 | AUTH_TYPE mirror on split frontends (`NEXT_PUBLIC_*_AUTH_TYPE`, `window._env_.AUTH_TYPE`) | `<status>` | only split-FE apps (SurfSense web, Twenty SPA via `generateFrontConfig`); use `n/a` for unified-image apps |
| 6 | backend refuses identity headers when AUTH_TYPE≠SSO | `<status>` | grep the backend SSO middleware/controller for the early-return / 404 on the header-trust gate |
| 7 | TLS = mkcert (no certresolver) | `<status>` | on ❌ flag any `tls.certresolver=letsencrypt` |
| 8 | build pattern correctness | `<status>` | A vs B (and B1 vs B2) called out; on ❌ flag real values baked into a B image or source volume-mounted into a compiled container |
| 9 | session TTL wired (`SESSION_TTL_SECONDS`/`SESSION_TTL_DURATION`) | `<status>` | service(s) checked; on ❌ list apps not consuming the canonical envs |
| 10 | refresh TTL wired (`SESSION_REFRESH_TTL_*`) | `<status>` | only refresh-token apps (SurfSense, Twenty, Outline OAuth provider) — use `n/a` for apps that don't mint refresh tokens |
| 11 | sliding-refresh (`SESSION_COOKIE_REFRESH_SECONDS`) wired | `<status>` | oauth2-proxy + Penpot only — use `n/a` for everything else |
| 12 | cookie security flags (`secure` derives from SERVER_URL https; `sameSite: 'lax'`; `httpOnly` correct for cookie's role) | `<status>` | every `res.cookie(...)` / `Set-Cookie` site checked; on ❌ flag any hardcoded `secure: true` / `secure: false` (breaks dev / breaks prod), missing `sameSite`, or `httpOnly: false` on a long-lived cookie |
| 13 | valkey cascade declared | `<status>` | on ❌ list services missing `depends_on: valkey: { restart: true }` |
| 14 | logout shape (1-layer, no `/oauth2/sign_out`, `SMB_NAME` env required + exposed, no hardcoded prefix) | `<status>` | logout file + env-exposure file checked; on ❌ flag any re-introduction of `/oauth2/sign_out`, a hardcoded portal prefix (`"foss."` / `"moneta."` / etc), a `SMB_NAME` fallback / default, missing exposure (Vite `define` / Outline `@Public` / Twenty `generateFrontConfig` / Penpot `nginx-entrypoint.sh` / SurfSense `docker-entrypoint.js`), or `.env.example` not documenting the var |
| 15 | identity-managed UI hidden under SSO | `<status>` | gates checked: signin/signup, password change/reset, email change, 2FA enforcement toggle, 2FA TOTP setup. Each one must hide or hard-redirect — partial gating leaves the user a path to lock themselves out |
| 16 | compose hygiene (no bare `docker compose`) | `<status>` | on ❌ flag scripts/Makefile invoking compose without `COMPOSE_FILE` + `--no-deps` |
| 17 | global HTTP→HTTPS redirect at Traefik entrypoint | `<status>` | grep the Traefik `command:` block for `--entrypoints.web.http.redirections.entryPoint.to=websecure`; on ❌ flag the missing flag (env-var form `TRAEFIK_ENTRYPOINTS_WEB_HTTP_REDIRECTIONS_*` does NOT count — Traefik 3.x silently drops it) and any per-app `entrypoints=web` router that serves content without a `redirectScheme` middleware |
| 18 | `security-headers@docker` chained on every browser-facing router | `<status>` | confirm the central middleware is defined on the Traefik service (HSTS 1y + includeSubdomains, nosniff, X-Frame-Options=SAMEORIGIN, Referrer-Policy=strict-origin-when-cross-origin, Permissions-Policy denying camera/mic/geolocation/payment/usb; no `stsPreload=true`, no central CSP) and that it's chained on landing-secure, every app `-secure`, every bypass router, every auth surface (oauth2-proxy-secure, oauth2-apps, mpass-bridge), seaweedfs-s3-secure, and surfsense-zero-secure. On ❌ name the missing router(s) and remind the operator that label changes require `docker compose up -d` (recreate), not `restart` |
| 19 | user display name is Cognito ID or real name claim — NOT a `sub` UUID | `<status>` | grep each app's user-display column for UUID-shape values after a fresh SSO login (`name`/`fullname`/`display_name` ~ `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). On ❌ name the app(s) showing UUIDs, root-cause as either oauth2-proxy forwarding `sub` instead of `cognito:username` in the preferred-username claim OR the app's middleware reading the wrong header. Plane/SurfSense pass by ignoring preferred-username and using email local-part; Penpot/Outline historically failed because they read `X-Auth-Request-Preferred-Username` and accept whatever's there. Fix at oauth2-proxy (one-shot) or per-app middleware (more surgical) — see `RULES.md` §"User display name". |
| 20 | session-identity reconciliation present (Rule 2 mismatch flush) | `<status>` | grep each cookie-based app's middleware/guard for the flush call: Plane `logout(request)`, Outline `throw AuthenticationError`+outer-catch, Twenty `response.clearCookie('tokenPair'`, Penpot `(session/delete-fn cfg)` or in-place re-key via `(create-session!)`. SurfSense uses `n/a` (architecturally immune — `app.users.current_active_user` resolves `proxy_user` before `jwt_user`). On ❌ the app silently serves the previous user after portal "Logout all" + new-user login (see `proxy-auth-middleware/spec.md` §"Identity mismatch SHALL flush"). |
| 21 | email-shape detection uses indexOf, not polynomial regex | `<status>` | grep each app's header-normalisation code for `^[^\s@]+@[^\s@]+\.[^\s@]+$` (or close variants). On ❌ flag the regex — CodeQL's `js/polynomial-redos` rule fires on adversarial input; rewrite to indexOf-based check per `openspec/specs/proxy-auth-middleware/spec.md` §"email-shape detection SHALL avoid polynomial-backtracking regex". Plane/Penpot/SurfSense use simpler `"@" in s` substring checks (already `✅`); Outline uses indexOf post-PR#19 (`✅`); Twenty uses indexOf in `normalizeProxyEmail` (`✅`). |

End the table with one of:
- `**All invariants hold.**` — every row is ✅ or `n/a`
- `**N violations.**` followed by a single sentence calling out the most load-bearing fix first (the one that re-exposes auth bypass, leaks user data, or breaks the next deploy). Rows 1–7, 12, 17, 18, 20 are the security-critical ones (auth-bypass, header-injection, cookie-leak, browser-side defenses, cross-user identity leak) — flag any failure there ahead of the operational rows.

## What this skill is NOT
- Not a runtime health check — that's a separate `/review`-style skill.
- Not a design tool — for new app intake, brainstorm + write a plan first.
- Not a substitute for `RULES.md` — always re-read the doc; it evolves.
