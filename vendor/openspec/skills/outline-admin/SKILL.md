---
name: outline-admin
description: Use when accessing or managing Outline's team-admin role, bootstrapping the first admin, or wiring admin-related tests for Outline in a foss-server-bundle-devstack. Outline uses a single global per-team `UserRole` enum (Admin/Member/Viewer/Guest); there is no separate /admin URL.
---

# outline-admin — team-admin role access

Outline's "admin" is a **per-user role** on the `User` model — there is no separate admin URL or admin app. The role is one of:

| Role | Value | Capabilities |
|---|---|---|
| `Admin` | `"admin"` | Full team management: members, settings, integrations, all collections |
| `Member` | `"member"` | Create/edit own content, see public collections |
| `Viewer` | `"viewer"` | Read-only |
| `Guest` | `"guest"` | Limited share-link access |

Defined at `shared/types.ts:2-7`. Role lives on `User.role` (`server/models/User.ts:156-158`).

## UI access

Admin operations are surfaced inside the normal Outline app:

```
https://docs.${PLATFORM_DOMAIN}/settings/people
```

Settings → **People** (members management) and Settings → **Details** (team settings) are gated on `user.role === "admin"`. Non-admins see a reduced settings menu.

The UI doesn't surface a "role dropdown" in a separate admin panel; it's inline on each member row in **Settings → People**.

## First-admin bootstrap

Outline auto-promotes the very first user on a fresh team:

```ts
// server/middlewares/authentication.ts:335-365
let isNewTeam = false;
// ...team-create branch sets isNewTeam = true...
role: isNewTeam ? UserRole.Admin : team.defaultUserRole,
```

So on the **first** SSO sign-in against a fresh Outline DB:
1. oauth2-proxy ForwardAuth admits the request.
2. Outline's `FORWARDAUTH_SERVICE` branch creates the `Team` (because none exists) and creates the first `User` for that email.
3. `isNewTeam === true` → that first user gets `role: Admin`.

Every subsequent SSO user gets `team.defaultUserRole` (which defaults to `Member` on a fresh team — configurable from Settings → Details).

If you want a specific email to be the bootstrap admin, the right move is to point oauth2-proxy at that account first before anyone else logs in. There is no `bootstrap-admin` CLI.

## Promoting another user to admin

```
POST https://docs.${PLATFORM_DOMAIN}/api/users.update_role
Cookie: <admin's accessToken cookie>
Content-Type: application/json

{ "id": "<user-uuid>", "role": "admin" }
```

The `users.update_role` RPC is gated on the actor being admin (`UserRoleHelper.isRoleLower(user.role, options.role)` check at `server/middlewares/authentication.ts:391`). Only an existing admin can promote/demote.

UI equivalent: **Settings → People → click member row → role dropdown → Admin**.

## Direct DB promotion (recovery only)

If every admin has been demoted or removed:

```sql
-- inside the postgres container, outline DB
UPDATE users
   SET role = 'admin'
 WHERE email = '<your-email>'
   AND "teamId" = (SELECT id FROM teams LIMIT 1);
```

`UserRole` is stored as a Postgres enum — the literal string `'admin'` is the only accepted value.

## E2E test fixtures

For tests that need an admin user:

- **API setup**: `POST /api/users.update_role` from an existing admin session — fastest.
- **DB setup**: direct `UPDATE users SET role='admin'` — bypasses all gating, useful for "negative" tests (non-admin tries to do X, gets denied).
- **First-user-becomes-admin**: nuke the `users` and `teams` tables before the test, then have the first SSO user land — they auto-promote. Useful for testing the cold-start path itself.

## Common gotchas

- **The first user to land on a fresh DB becomes admin.** If your e2e pipeline lets multiple test users hit Outline in parallel against an empty DB, whoever wins the race is your admin. Serialise the bootstrap.
- **`team.defaultUserRole`** is what subsequent users get. If your team's default was changed to `Viewer`, new SSO users land as viewers even if they're full members of your org's Cognito pool. Check this setting if "new SSO users can't see anything".
- **No /admin URL.** Don't waste time looking for one; admin is just `user.role === "admin"` plus the normal Outline UI.
- The fork patch in `Pressingly/outline` PR #18 fixed an `Op.iLike` impersonation vector in the ForwardAuth branch ([`outline-security.md`](../../outline-security.md)). Don't re-introduce `LIKE` matching on `email` if you edit that path.

## References

- `shared/types.ts:2-7` — `UserRole` enum
- `server/models/User.ts:156-158` — `role` column on `User`
- `server/middlewares/authentication.ts:335-365` — `isNewTeam` auto-admin path
- `server/middlewares/authentication.ts:391` — `isRoleLower` promotion gate
- `server/routes/api/users/users.ts` — `users.update_role` RPC
