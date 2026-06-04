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

## Requirements

The following requirements pin the per-app workspace-admin contract
for Plane. (God-mode / instance-admin coverage lives separately under
`tests/apps/pm-godmode.spec.ts` and is already tagged against
`forwardauth-traefik#bypass-routes-per-app-shall-match-the-documented-list`.)

Each is verified by a test in `tests/apps/pm-admin.spec.ts`, linked
via a `// @spec plane-admin#<requirement-slug>` tag.

### Requirement: workspace settings URLs SHALL NOT bypass the SSO chain

A cold context (no SSO cookie) hitting `/<workspace-slug>/settings/members`
MUST be redirected to the IDP / auth wall. Workspace-scoped settings
URLs are NOT in the ForwardAuth bypass list (unlike god-mode, which
deliberately is — see god-mode skill above).

#### Scenario: Cold visit to a workspace settings URL bounces to auth

- **GIVEN** a fresh browser context with no `_oauth2_proxy` cookie
- **WHEN** the context navigates to
  `https://pm.${PLATFORM_DOMAIN}/<workspace-slug>/settings/members`
- **THEN** the response chain ends at an `isAuthWall` host
- **AND** Plane's members table does NOT render

### Requirement: auto-joined Member SHALL reach Members page but lack Add controls

An SSO-authenticated user with `WorkspaceMember.role = 15` (Member)
in the shared SMB workspace MUST be able to navigate to
`/<workspace-slug>/settings/members` and see the members list
(reachable, not 404 / "Workspace not found"). But the admin-only
controls — specifically "Add member" — MUST NOT be rendered.

This pins the auto-join role contract from `workspace-auto-join` at
a UI-observable level: both FOSS_USER and NORMAL_USER auto-join as
Member (not Admin), so both see the page but neither can invite
others. The Admin role is held only by the bootstrap `system-bot`
(or whoever was promoted via `provision-admin/plane.py`).

#### Scenario: Member sees the members page but no Add-member control

- **GIVEN** an SSO-authenticated user with `WorkspaceMember.role = 15`
  (Member) on the shared SMB workspace
- **WHEN** the user navigates to
  `/<PLANE_WORKSPACE_SLUG>/settings/members`
- **THEN** the page renders the members table (not Plane's
  "Workspace not found" shell)
- **AND** the "Add member" / invite control is NOT in the DOM
- **AND** the user's own row appears in the members table

### Requirement: workspace membership SHALL gate UI access cross-workspace

An SSO-authenticated user with NO `WorkspaceMember` row for a given
workspace MUST be refused at the UI layer when navigating to that
workspace's routes. Specifically, hitting `/<other-slug>/` MUST
render Plane's "Workspace not found" shell — NOT a bounce to the
IDP (the user IS authenticated, just not authorised for that
workspace), and NOT a successful page load.

This pins defense-in-depth: a valid SSO session is necessary but
NOT sufficient for cross-workspace data access. NORMAL_USER's
membership of the shared SMB workspace MUST NOT leak access to
FOSS_USER's private workspace (`FOSS_USER_PRIVATE_WORKSPACE_SLUG`,
default `aa`).

#### Scenario: Non-member is refused at the UI layer (not bounced to IDP)

- **GIVEN** an SSO-authenticated user (`NORMAL_USER`) who has NO
  `WorkspaceMember` row on `FOSS_USER_PRIVATE_WORKSPACE_SLUG`
- **WHEN** the user navigates to
  `/<FOSS_USER_PRIVATE_WORKSPACE_SLUG>/`
- **THEN** the page settles on Plane's host (no IDP bounce — the
  user IS authenticated)
- **AND** the page renders the "Workspace not found" shell
- **AND** no workspace project / issue data from the other workspace
  is visible

### Requirement: workspace membership SHALL gate API access cross-workspace

The same workspace-membership check MUST be enforced at Plane's API
layer, not only the UI. An SSO-authenticated non-member hitting
`/api/workspaces/<other-slug>/<resource>/` MUST receive a 4xx
response (403 Forbidden or 404 Not Found are both acceptable —
404 is leak-resistant, 403 is informative).

2xx on this endpoint MUST NOT happen — that would indicate Plane's
view-level `is_authenticated` check has replaced the
workspace-membership check, opening every authenticated user to
every workspace's data via direct API access.

#### Scenario: Non-member's direct API call is refused at server

- **GIVEN** an SSO-authenticated user (`NORMAL_USER`) who has NO
  `WorkspaceMember` row on `FOSS_USER_PRIVATE_WORKSPACE_SLUG`
- **WHEN** the user issues a direct API GET to
  `/api/workspaces/<FOSS_USER_PRIVATE_WORKSPACE_SLUG>/projects/`
  with the user's SSO cookie attached
- **THEN** the response status is 4xx (403 OR 404 are both acceptable)
- **AND** the response body does NOT contain project / issue data
  from the other workspace
- **AND** specifically the response is NOT 2xx (which would indicate
  the membership check was bypassed)

## References

- `apps/api/plane/license/urls.py` — instance admin URL table
- `apps/api/plane/license/models.py` — `Instance`, `InstanceAdmin`
- `apps/api/plane/authentication/middleware/proxy_auth.py:65` — bypass-path check
- `apps/api/plane/settings/common.py:63` — `MPASS_BYPASS_PATHS`
- Bundle: `/Users/apple/Documents/devstack/foss-server-bundle-devstack/docker-compose.yml` — Plane Traefik labels include the god-mode bypass router
