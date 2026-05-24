---
name: plane-admin
description: Use when accessing or managing Plane's god-mode instance admin panel, bootstrapping the first instance admin, or wiring admin-related tests for Plane in a foss-server-bundle-devstack. Plane is the only app in the bundle with a dedicated admin URL that bypasses oauth2-proxy ForwardAuth.
---

# plane-admin — instance-admin panel access

Plane has **two admin layers** that are easy to confuse:

| Layer | Role | Auth | Scope |
|---|---|---|---|
| **Instance admin** (god-mode) | `InstanceAdmin` row | Local email/password, **bypasses oauth2-proxy** | Whole Plane instance — license, instance config, instance-level admins |
| **Workspace admin** | `WorkspaceMember.role = 20 (Admin)` | Normal SSO session via ForwardAuth | One workspace — members, projects, settings within it |

The thing the bundle's `MPASS_BYPASS_PATHS` opens up is layer 1, not layer 2.

## URL

```
https://pm.${PLATFORM_DOMAIN}/god-mode
```

Sign-in / sign-up forms there hit the bypass-routed API endpoints under `/api/instances/` — both prefixes are on the bundle's `MPASS_BYPASS_PATHS` list, so they never see `X-Auth-Request-Email` and never enter `ProxyAuthMiddleware`. Auth is **local email/password**, completely separate from your Cognito identity.

Route table (in `apps/api/plane/license/urls.py`):

| URL | Endpoint | Line |
|---|---|---|
| `admins/` | `InstanceAdminEndpoint` (list/create) | 25 |
| `admins/me/` | `InstanceAdminUserMeEndpoint` | 26 |
| `admins/session/` | `InstanceAdminUserSessionEndpoint` | 28-29 |
| `admins/sign-in/` | `InstanceAdminSignInEndpoint` | 49-50 |
| `admins/sign-out/` | `InstanceAdminSignOutEndpoint` | 33-34 |
| `admins/sign-up/` | `InstanceAdminSignUpEndpoint` | 54-55 |

## First-admin bootstrap

Fresh Plane deployment has zero `InstanceAdmin` rows. Two paths:

**Option A — UI signup (recommended)**

1. Open `https://pm.${PLATFORM_DOMAIN}/god-mode` in a browser.
2. Sign-up form is shown when no instance admin exists yet. Fill in email + password.
3. Submit → `InstanceAdminSignUpEndpoint` (`apps/api/plane/license/urls.py:54-55`) creates both the `User` row and the `InstanceAdmin` row.
4. You are now signed in to god-mode with a Django session for that user.

**Option B — DB seed**

```sql
-- inside the postgres container, plane DB
-- (Requires Postgres 13+ for gen_random_uuid(); for older deployments use
--  uuid_generate_v4() from the uuid-ossp extension.)
-- 1. Create the user (or use an existing one)
INSERT INTO users (id, email, username, password, is_password_autoset, is_active, is_email_verified)
VALUES (gen_random_uuid(), 'admin@example.com', 'admin', '<pbkdf2-hash>', false, true, true);

-- 2. Promote them to instance admin
INSERT INTO instance_admins (id, user_id, role, instance_id)
SELECT gen_random_uuid(), u.id, 20, i.id
  FROM users u, instances i
 WHERE u.email = 'admin@example.com'
 LIMIT 1;
```

Don't seed via the user's Cognito-synthesised email (`<numeric-id>@askii.ai`) — that record is created by `ProxyAuthMiddleware` and has `set_unusable_password()`. Instance-admin login wants a usable password.

## Promoting another user to instance admin

Once you have one instance admin:

```
POST https://pm.${PLATFORM_DOMAIN}/api/instances/admins/
Cookie: <god-mode session cookie, NOT the SSO session>

{ "user_id": "<uuid>", "role": 20 }
```

Or, from the UI: god-mode dashboard → Admins panel → invite by email.

## Why instance admin is bypassed

Plane's god-mode is the **bootstrap surface** — it must work before any SSO identity has been established (fresh install, post-restore, oauth2-proxy outage). If it sat behind ForwardAuth, a misconfigured Cognito would lock you out of your own instance.

Trade-off: any local-network attacker with HTTPS access to `/god-mode/sign-in/` can attempt to brute-force the local password. Mitigations:
- Use a strong randomly-generated password for the bootstrap admin.
- Restrict ingress to god-mode at the network layer if possible (e.g. VPN-only path to `/god-mode`).
- Plane enforces `IsInstanceAdmin` permission on the API side, so even if someone signs up via god-mode they get no privileges without an existing admin promoting them.

## E2E test fixtures

For tests that need instance-admin state:

- **API setup**: `POST /api/instances/admins/sign-up/` with `{email, password}` to create the first admin. After that, use `POST /admins/sign-in/` to log in and grab the session cookie. Drive subsequent admin API calls with that cookie.
- **DB setup**: insert the `instance_admins` row directly (faster, skips the signup throttle).
- Do **not** mix the SSO session cookie with the god-mode session — they live on the same host but are scoped to different views.

## Common gotchas

- `/god-mode` and `/api/instances/*` must both be in `MPASS_BYPASS_PATHS` (default `["/god-mode", "/api/instances"]`). If a deployment overrides that env and drops one, god-mode breaks silently with a 401.
- The first admin row determines who can promote subsequent admins. If you lose access to the credentials, the only recovery is DB-side.
- Workspace-level admin (`WorkspaceMember.role = 20`) is a completely separate concept — it's promoted from within a workspace by another workspace admin/owner, not from god-mode.

## References

- `apps/api/plane/license/urls.py` — instance admin URL table
- `apps/api/plane/license/models.py` — `Instance`, `InstanceAdmin`
- `apps/api/plane/authentication/middleware/proxy_auth.py:65` — bypass-path check
- `apps/api/plane/settings/common.py:63` — `MPASS_BYPASS_PATHS`
- Bundle: `/Users/apple/Documents/devstack/foss-server-bundle-devstack/docker-compose.yml` — Plane Traefik labels include the god-mode bypass router
