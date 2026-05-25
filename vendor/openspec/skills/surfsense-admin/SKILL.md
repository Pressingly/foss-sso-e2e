---
name: surfsense-admin
description: Use when accessing or managing SurfSense admin (search-space Owner role), bootstrapping the first owner, or wiring admin-related tests for SurfSense in a foss-server-bundle-devstack. SurfSense has NO global admin — admin is scoped per SearchSpace via RBAC roles (Owner/Editor/Viewer).
---

# surfsense-admin — search-space-scoped RBAC access

SurfSense has **no global admin / superuser**. The `User` model has no `is_admin` / `is_superuser` flag that grants instance-wide privileges — `is_superuser=False` is hard-coded for proxy-auth users (`surfsense_backend/app/middleware/proxy_auth.py:131`). All admin operations are **scoped to a SearchSpace** via three system roles:

| Role | Capabilities |
|---|---|
| `Owner` | Full control of one SearchSpace: members, roles, settings, all data |
| `Editor` | Create/update content; no delete, no member management |
| `Viewer` | Read-only |

Permission enum: `surfsense_backend/app/db.py:352` (`class Permission(StrEnum)` — the enum body runs until ~line 525 where `class Base(DeclarativeBase)` begins). Member-management gate: `MEMBERS_MANAGE_ROLES = "members:manage_roles"` (`db.py:417`), only granted to Owner (`is_system_role=True`, set in the system-role seed at `db.py:2417,2424,2431`).

## UI access

Admin operations live inside the normal SurfSense app. There is no `/admin` URL and no admin app. SurfSense is hosted at `research.${PLATFORM_DOMAIN}` (NOT `surfsense.${PLATFORM_DOMAIN}` — that subdomain doesn't exist; trying it gets a TLS warning because Traefik has no router for it). The bundle's `docker-compose.yml` defines `surfsense-secure` with `Host(\`research.${PLATFORM_DOMAIN}\`)`.

```
https://research.${PLATFORM_DOMAIN}/                              # main app (after SSO redirect)
https://research.${PLATFORM_DOMAIN}/dashboard/<search-space-id>   # SearchSpace dashboard
https://research.${PLATFORM_DOMAIN}/dashboard/<search-space-id>/user-settings  # personal settings
```

**Member management UI shape varies by SurfSense release.** Pre-2026-05 the same React content (`team-content.tsx`) was rendered inside a modal dialog (`components/settings/team-dialog.tsx`); after that the bundle's SurfSense renders it on a dedicated page route. The contract — what's visible to Owners vs. non-Owners — is identical in both shapes. Tests target the rendered content (Invite Members button, role-change buttons on member rows) rather than the dialog vs. page wrapper, so they survive the shape change.

The trigger is the **SearchSpace name dropdown** at the top of the left sidebar:

1. Click the SearchSpace name (with the `⇅` `ChevronsUpDown` icon) at the top of the sidebar.
2. Dropdown shows two items (defined in `components/layout/ui/sidebar/SidebarHeader.tsx:50-58`):
   - **Manage Members** → opens TeamContent (as dialog OR page, depending on release)
   - **Search Space Settings** → opens settings (same shape rules apply)

The TeamContent (`surfsense_web/app/dashboard/[search_space_id]/team/team-content.tsx`) gates these UI surfaces on RBAC permissions checked at lines 205-207:

| Permission | UI surface unlocked |
|---|---|
| `members:invite` | `+ Invite Member` button |
| `members:manage_roles` | Role dropdown next to each non-owner member row |
| `members:remove` | Remove button next to each non-owner member row |

Owners short-circuit any permission check (`team-content.tsx:131` — `if (access.is_owner) return true`). You won't see a role dropdown next to your own row (Penpot-style self-protection).

## First-admin bootstrap

SurfSense uses **first-user-becomes-owner-of-their-default-SearchSpace**:

1. New SSO user lands. `app/middleware/proxy_auth.py` auto-creates the `User` row (with `is_superuser=False`).
2. `app/users.py:184-190` creates the user's default SearchSpace and inserts a membership row with `is_owner=True`.
3. That user is now Owner of *their* default SearchSpace — not anyone else's.

Identical posture to Penpot: every SSO user gets their own private workspace; there's no instance-wide admin. To share a SearchSpace, an existing Owner invites others.

There is **no bootstrap CLI** and no Alembic seed for an initial admin. SurfSense's `manage`-style tooling is Alembic for migrations only.

## Promoting another user to Owner of a SearchSpace

```
PUT https://research.${PLATFORM_DOMAIN}/api/rbac/searchspaces/<search-space-id>/members/<membership-id>
Cookie: <surfsense session, set after SSO landing>
Content-Type: application/json

{ "role_id": <owner-role-id> }
```

Source: `surfsense_backend/app/routes/rbac_routes.py:527-528` (the `PUT /searchspaces/{id}/members/{membership_id}` route — full RBAC surface spans lines 115–1147). Gated on the caller having `MEMBERS_MANAGE_ROLES` permission on that SearchSpace.

Note: `<search-space-id>` is an **integer**, not a UUID — that's a key difference from Penpot's UUID team IDs.

To find the membership ID and role IDs first:

```
GET /api/rbac/searchspaces/<id>/members         # → list of {membership_id, user_id, role_id, …}
GET /api/rbac/searchspaces/<id>/roles           # → list of {role_id, name, is_system_role, …}
```

## Direct DB promotion

Schema verified against a running deployment (foss-platform sandbox, 2026-05-14):

| Table | Notes |
|---|---|
| `"user"` (singular, **must be quoted** in psql — `user` is reserved) | `id` (uuid), `email` (varchar 320, unique), `is_superuser` (boolean — hard-coded false for proxy users) |
| `searchspaces` (one word, no underscore) | `id` (**integer**, not uuid), `name`, `user_id` (uuid → owner) |
| `search_space_memberships` | `user_id`, `search_space_id` (int), `role_id` (int, nullable), `is_owner` (bool); unique on `(user_id, search_space_id)` |
| `search_space_roles` | per-SearchSpace role catalog (`search_space_id` is `NOT NULL`); `name` like `'Owner'`, `'Editor'`, `'Viewer'`; `is_system_role` flags the seed roles |

```sql
-- inside the postgres container, surfsense DB

-- Promote a user to Owner of an existing SearchSpace
UPDATE search_space_memberships
   SET is_owner = true,
       role_id  = (SELECT id FROM search_space_roles
                    WHERE name = 'Owner'
                      AND search_space_id = <ss-id-int>
                    LIMIT 1)
 WHERE user_id = (SELECT id FROM "user" WHERE email = '<email>')
   AND search_space_id = <ss-id-int>;

-- Add a new member as Owner (if no membership row exists yet)
INSERT INTO search_space_memberships (user_id, search_space_id, role_id, is_owner, joined_at, created_at)
SELECT (SELECT id FROM "user" WHERE email = '<email>'),
       <ss-id-int>,
       (SELECT id FROM search_space_roles WHERE name = 'Owner' AND search_space_id = <ss-id-int> LIMIT 1),
       true, now(), now()
ON CONFLICT (user_id, search_space_id) DO NOTHING;
```

**Owner reference duplication:** SearchSpace ownership is recorded in *two* places — `searchspaces.user_id` AND `search_space_memberships.is_owner`. To fully transfer ownership, update both. To merely promote an additional admin without dethroning the original creator, just touch `search_space_memberships`.

## E2E test fixtures

- **UI test**: drive the SearchSpace settings UI; the actor must be Owner or have `MEMBERS_MANAGE_ROLES`.
- **API setup**: hit `/api/rbac/searchspaces/<id>/members` with PUT to set roles; faster than UI.
- **DB-seed for negative tests**: insert two users with different roles via SQL, then exercise the RBAC endpoint as the wrong role and assert 403.

## What about `SURFSENSE_ZERO_ADMIN_PASSWORD`?

You'll see `ZERO_ADMIN_PASSWORD: ${SURFSENSE_ZERO_ADMIN_PASSWORD:-surfsense-zero-admin}` in the bundle's docker-compose (line 1060). **This is NOT a SurfSense admin credential.** It's the admin password for **Rocicorp Zero**, the local-first sync engine that SurfSense uses for real-time collaboration. Zero exposes its own admin UI on port 4848. SurfSense's backend does not authenticate against it.

If you're auditing SurfSense admin paths, ignore `ZERO_ADMIN_*` — they belong to the `surfsense-zero` container, not to SurfSense itself.

## Common gotchas

- **No global admin.** Don't assume "admin can see everything" — admin only sees their own SearchSpace's data.
- **Each SSO user is auto-Owner of one SearchSpace.** That space is private to them by default.
- **`is_superuser` is hard-coded false** for proxy-auth users. Even if some legacy code checks it, your SSO users will never satisfy that check. Stop looking for an `is_superuser` toggle — it isn't a path.
- **`SURFSENSE_ZERO_ADMIN_PASSWORD` is not for SurfSense.** Don't try to log into SurfSense with it.

## Requirements

The following requirements pin the per-app admin contract for SurfSense.
Each is verified by a test in `tests/apps/surfsense-admin.spec.ts`, linked
via a `// @spec surfsense-admin#<requirement-slug>` tag.

### Requirement: SearchSpace dashboard URLs SHALL NOT bypass the SSO chain

A cold context (no SSO cookie) hitting any
`/dashboard/<search-space-id>/...` URL MUST be redirected to the IDP
/ auth wall. SurfSense's dashboard URLs are not in the ForwardAuth
bypass list.

### Requirement: non-Owner SHALL NOT see role-change buttons in Manage Members

An SSO-authenticated user with `search_space_memberships.is_owner = false`
on a SearchSpace MUST be able to reach the Manage Members surface
(modal or page, depending on release) but MUST NOT see role-change
`<button>` controls next to other members' rows. Roles render as
static text. This pins the server-side check in
`surfsense_backend/app/routes/rbac_routes.py` that `MEMBERS_MANAGE_ROLES`
is gated to Owners — the UI mirrors what the backend would refuse.

### Requirement: Owner SHALL see role-change buttons on other members' rows

A user with `is_owner = true` on a SearchSpace MUST see a role-change
`<button>` element on each other-member row in the Manage Members
surface (modal or page, depending on release). This pins the
positive side of the same gate — the Owner has the
`MEMBERS_MANAGE_ROLES` permission and the UI surfaces the control.

SurfSense (like Penpot) deliberately hides the self-row dropdown —
the Owner sees the control next to OTHER members, not themselves.

## References

- `surfsense_backend/app/db.py:352` — `class Permission(StrEnum)` (enum body runs to ~525); `MEMBERS_MANAGE_ROLES` at line 417
- `surfsense_backend/app/db.py:1796` — `is_system_role` column on the Role model; system-role seed rows at lines 2417, 2424, 2431
- `surfsense_backend/app/users.py:175,189` — system-role seed (`is_system_role=True`) and auto-Owner membership (`is_owner=True`) on default SearchSpace creation
- `surfsense_backend/app/middleware/proxy_auth.py:131` — `is_superuser=False` for proxy users
- `surfsense_backend/app/routes/rbac_routes.py:527-528` — `PUT /searchspaces/{id}/members/{membership_id}` (full RBAC surface 115–1147)
- Bundle: `foss-server-bundle-devstack/docker-compose.yml` line 1060 — Zero admin (unrelated)
