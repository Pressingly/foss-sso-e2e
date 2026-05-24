---
name: penpot-admin
description: Use when accessing or managing Penpot admin (team-level role), bootstrapping the first team owner, or wiring admin-related tests for Penpot in a foss-server-bundle-devstack. Penpot has NO global admin role — admin is per-team only, surfaced inside the normal app UI.
---

# penpot-admin — team-level admin access

Penpot has **no global admin / superuser** role. "Admin" in Penpot always means *admin of a specific team*. There is no `/admin` URL, no admin app, no `is_superuser` column on the profile.

The team-level roles, on `team_profile_rel`:

| Role | Capabilities |
|---|---|
| `is_owner = true` | Full team control. Exactly one owner per team. Can transfer ownership. |
| `is_admin = true` | Manage members, invite, change roles, settings |
| `can_edit = true` | Create/edit team content |
| (none) | Viewer — read-only access |

Defined in `backend/src/app/rpc/commands/teams.clj` and `backend/src/app/types/team.cljc`. Checked across the frontend via `(:is-admin permissions)` (see `frontend/src/app/main/ui/dashboard/team.cljs:281,330,800,1286`).

## UI access

Admin functions live inside the dashboard. **Penpot uses query-string routing**, not path-style — the team-id is a query parameter, not a path segment:

```
https://design.${PLATFORM_DOMAIN}/#/dashboard/members?team-id=<team-uuid>
https://design.${PLATFORM_DOMAIN}/#/dashboard/invitations?team-id=<team-uuid>
https://design.${PLATFORM_DOMAIN}/#/dashboard/webhooks?team-id=<team-uuid>
https://design.${PLATFORM_DOMAIN}/#/dashboard/settings?team-id=<team-uuid>
```

A path-style URL like `.../dashboard/team/<uuid>/members` (which other apps use) will fail with "Internal Error" because the team-id segment doesn't parse as a UUID.

**Admin sub-pages are NOT in the left sidebar.** The sidebar only lists content sections (Projects, Drafts, Libraries, Fonts). To reach admin pages from the UI:

1. Click the **team name** at the top of the left sidebar (or the chevron `▾` next to it).
2. A context menu opens with the admin entries: **Members / Invitations / Webhooks / Settings**.
3. Those four items only appear if your role is admin or owner — non-admins get a shorter menu.

The role-change dropdown surfaces on the Members page next to each member row, gated on `(or is-owner is-admin)` (`backend/src/app/rpc/commands/teams.clj:732`). You won't see a dropdown next to your own name (Penpot hides self-demote).

## First-admin bootstrap

Penpot uses **first-team-creator-becomes-owner**:

1. New SSO user lands. `backend/src/app/http/auth_request.clj` (the `wrap-authz` ForwardAuth middleware at line 79) auto-registers them as a `profile` row via `auth/create-profile`, gated on the `enable-x-auth-request-auto-register` flag being present in `PENPOT_FLAGS` (parsed as `:x-auth-request-auto-register` and checked at `auth_request.clj:62`).
2. `create-profile-rels` (in `backend/src/app/rpc/commands/auth.clj`) calls `teams/create-team` with the new profile as the owner, producing a "Default" team where this user is the sole `is_owner = true` member (`backend/src/app/rpc/commands/teams.clj:548` — `create-team-role`).
3. That user can now invite others into their default team and assign roles.

Two consequences:

- **Every SSO user gets their own private team** on first login. They are owner of *that* team, no one else's.
- **If you want a shared team that admins can join**, an existing team owner must invite by email through the UI — or you seed it via DB.

There is no "first user across the whole instance is global admin" path. There is no global admin to be.

## Promoting another user to team admin

**HTTP RPC** (the API call the UI makes):

```
POST https://design.${PLATFORM_DOMAIN}/api/rpc/command/update-team-member-role
Cookie: <penpot session, established after SSO landing>
Content-Type: application/transit+json

{:team-id   "<uuid>"
 :member-id "<uuid>"
 :role      :admin}   ; or :editor :viewer :owner
```

Source: `backend/src/app/rpc/commands/teams.clj:714-777`. Gated on the caller being team owner or admin (`teams.clj:732-734`). Owner transfers are restricted: `cant-change-role-to-owner` (raised at `teams.clj:737-739` when trying to demote an existing owner) and `cant-promote-to-owner` (raised at `teams.clj:742-744` when a non-owner tries to promote someone to owner).

**UI equivalent**: Team Settings → Members → member's role dropdown → Admin.

## Direct DB promotion (cross-team override)

If you need to make someone admin of a team they didn't create, and no existing admin is available to do it:

```sql
-- inside the postgres container, penpot DB
UPDATE team_profile_rel
   SET is_admin = true, can_edit = true
 WHERE profile_id = (SELECT id FROM profile WHERE email = '<email>')
   AND team_id    = (SELECT id FROM team   WHERE name  = '<team-name>');
```

To promote to **owner** (singular per team), also clear the prior owner:

```sql
UPDATE team_profile_rel SET is_owner = false WHERE team_id = '<uuid>';
UPDATE team_profile_rel SET is_owner = true, is_admin = true, can_edit = true
 WHERE profile_id = '<new-owner-uuid>' AND team_id = '<uuid>';
```

## PREPL — backend admin socket

The bundle's `PENPOT_FLAGS` enables `enable-prepl-server` → Penpot exposes a Clojure PREPL socket at `penpot-backend:6063` (`backend/src/app/main.clj:454`). Commands available (`backend/src/app/srepl/cli.clj`):

- `create-profile` — create a profile with email + password
- `update-profile` — change fullname/email/password/is-active
- `delete-profile` — soft or hard delete
- `search-profile` — find by email

**No role-change command.** PREPL is for profile lifecycle and password reset only.

From inside the bundle:

```bash
docker compose exec penpot-backend bash -lc \
  'echo "{:cmd \"search-profile\" :params {:email \"you@example.com\"}}" | nc localhost 6063'
```

## E2E test fixtures

### Bypass the email-invitation flow with a direct DB INSERT (verified working)

Most SSO Penpot deployments don't have outbound SMTP configured, so the UI's "Invite Members" button creates a `team_invitation` row that never reaches anyone. For e2e you can skip the invitation entirely and INSERT the membership directly. **The invitee's `profile` row must already exist** — they need to have completed at least one SSO login. If they haven't, either log them in once first or the INSERT will fail on the foreign key.

```sql
-- 1. Verify the invitee profile exists (must return 1 row)
SELECT id, email, fullname FROM profile WHERE email = '<invitee-email>';

-- 2. INSERT them onto the target team. Idempotent via ON CONFLICT.
INSERT INTO team_profile_rel (team_id, profile_id, is_owner, is_admin, can_edit, created_at, modified_at)
SELECT '<team-uuid>',
       (SELECT id FROM profile WHERE email = '<invitee-email>'),
       false, false, true,    -- Editor (set is_admin=true for Admin)
       now(), now()
ON CONFLICT (team_id, profile_id) DO NOTHING
RETURNING team_id, profile_id, is_admin, can_edit;

-- 3. Verify the team now has both members
SELECT p.email, p.fullname, tpr.is_owner, tpr.is_admin, tpr.can_edit
  FROM team_profile_rel tpr
  JOIN profile p ON p.id = tpr.profile_id
 WHERE tpr.team_id = '<team-uuid>'
 ORDER BY tpr.is_owner DESC;
```

The unique constraint on `team_profile_rel` is `(team_id, profile_id)` — `ON CONFLICT (team_id, profile_id) DO NOTHING` is the right idempotent shape.

If you ALSO want to clear the pending `team_invitation` row that the UI may have created earlier (cosmetic — leaving it doesn't break anything), `DELETE FROM team_invitation WHERE team_id = '<team-uuid>' AND email_to = '<invitee-email>'`. Skip this if your test asserts the invitation lifecycle separately.

### Standard test patterns

- **UI behaviour test** (e.g. role dropdown only renders for admins): drive Playwright/Cypress against the dashboard URL above, assert dropdown visibility per role.
- **Multi-user flow setup**: do SSO landing once to grab the session cookie, then drive `update-team-member-role` RPC for role state; assert via UI navigation.
- **Negative auth tests**: DB-seed two profiles with known roles, hit the RPC as the wrong user, assert `:insufficient-permissions`.

### Diagnostic — what email is the current browser session authenticated as?

In DevTools console:

```javascript
JSON.parse(localStorage.getItem("penpot")).profile.email
```

Useful when verifying the SSO chain delivered the right identity (e.g. when the sidebar `profile-fullname` shows a UUID because the IdP didn't send a name claim). The DOM class for the sidebar profile button is `main_ui_dashboard_sidebar__profile-fullname`.

## Common gotchas

- **No global admin.** Don't write tests assuming an "admin user can do X across all teams" — admin scope is always per-team in Penpot.
- **Owner ≠ admin.** Owner is a superset: `is_owner` implies admin capabilities. `cant-change-role-to-owner` (`teams.clj:737-739`) and `cant-promote-to-owner` (`teams.clj:742-744`) are explicit business rules — only the existing owner can transfer ownership.
- **Each SSO user starts isolated.** The auto-created Default team has only them in it. They will not see your "main" team unless invited explicitly.
- The fork's ForwardAuth implementation auto-registers — see [`penpot-security.md`](../../penpot-security.md) for the audit. The `:x-auth-request-auto-register` flag is what enables this.

## References

- `backend/src/app/http/auth_request.clj:79` — `wrap-authz` ForwardAuth middleware (auto-register at line 62 when `:x-auth-request-auto-register` flag is set; `valid-email?` at 37, `resolve-email` at 41)
- `backend/src/app/rpc/commands/teams.clj:714-777` — `update-team-member-role`
- `backend/src/app/rpc/commands/teams.clj:548` — `create-team-role` (used for initial owner)
- `backend/src/app/rpc/commands/auth.clj` — `create-profile`, `create-profile-rels`
- `backend/src/app/srepl/cli.clj` — PREPL admin commands (`exec-command` multimethod; `create-profile` at line 51, `update-profile` at 67, `delete-profile` at 93, `search-profile` at 111)
- `backend/src/app/main.clj:453-455` — PREPL server binding (`:prepl-port`, default `6063`)
- `frontend/src/app/main/ui/dashboard/team.cljs` — UI role display gates: lines 117, 133 (invitations/members panels), 281 (`is-admin` in team-members), 330 (`admin?` in team-settings), 800 (`admin?` in invitations), 1286 (members-row visibility)
- Bundle compose: `PENPOT_FLAGS` line in `foss-server-bundle-devstack/docker-compose.yml` (must include `enable-x-auth-request-headers enable-x-auth-request-auto-register`)
