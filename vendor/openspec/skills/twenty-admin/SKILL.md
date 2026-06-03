---
name: twenty-admin
description: Use when accessing or managing Twenty's admin panel, bootstrapping the first admin via the `workspace:bootstrap-sso-admin` CLI, or wiring admin-related tests for Twenty in a foss-server-bundle-devstack. Twenty has BOTH a global admin (`canAccessFullAdminPanel`) AND a workspace-level Admin role — these are distinct.
---

# twenty-admin — global admin panel + workspace role

Twenty is the only app in the bundle with a **global server-level admin** distinct from workspace membership. Two separate concepts:

| Layer | Field / role | Scope | UI |
|---|---|---|---|
| **Global admin** | `User.canAccessFullAdminPanel = true` | Whole Twenty instance — feature flags, system health, AI models, config variables | `/settings/admin-panel` |
| **Workspace admin** | `WorkspaceMember.role = "Admin"` (UUID `20202020-02c2-43f2-b94d-cab1f2b532eb`) | One workspace — members, settings within it | `/settings/members`, `/settings/general` |

Most "admin" requests refer to layer 1. Layer 2 is the normal Plane-style workspace owner role; nothing special.

## URL — global admin panel

```
https://twenty.${PLATFORM_DOMAIN}/settings/admin-panel
```

Routes are real Twenty pages, not a separate app. Backend gate: `AdminPanelGuard` (`packages/twenty-server/src/engine/guards/admin-panel-guard.ts:13`) checks `request.user.canAccessFullAdminPanel === true` on every admin GraphQL mutation/query. UI hides the menu link for non-admins.

GraphQL endpoint used by admin pages: `/admin-panel-graphql-api` (separate from the main `/graphql` — see `packages/twenty-server/src/engine/api/graphql/admin-panel.module-factory.ts`).

## First-admin bootstrap — TWO separate steps required

**Critical correction (verified against running source 2026-05-14):** the `workspace:bootstrap-sso-admin` CLI does **NOT** set `canAccessFullAdminPanel`. Reading `bootstrap-sso-admin.command.ts:102-115`, the only writes the command performs are:

1. `findOrCreateUser(email)` — creates the `core.user` row if missing
2. `userWorkspaceService.addUserToWorkspaceOrEnsureRole(user, workspace, adminRole.id)` — assigns the workspace `Admin` role (the standard role with universalIdentifier `20202020-02c2-43f2-b94d-cab1f2b532eb`)

Nowhere does it touch `canAccessFullAdminPanel`. So the CLI alone gets you workspace Admin (CRM data + workspace settings + role management at `/settings/roles`), but it does NOT unlock the instance Admin Panel at `/settings/admin-panel`. That requires a separate DB UPDATE.

### Step 1 — workspace Admin role (CLI)

The bundle's compose file uses service name `twenty` (NOT `twenty-server`). Service name varies by deployment shape — confirm with `docker compose ps | grep twenty`. For the FOSS bundle:

```bash
docker compose exec -T twenty yarn command:prod workspace:bootstrap-sso-admin --email <email>
```

Idempotent. Output looks like:

```
[Nest] LOG [BootstrapSsoAdminCommand] Existing user "<email>" promoted to Admin in workspace "<workspace-subdomain>".
```

(Or "Admin user X newly provisioned" if the user didn't exist yet.)

### Step 2 — instance admin flag (DB UPDATE — no CLI exists)

```bash
docker compose exec -T postgres psql -U postgres -d twenty -c \
  "UPDATE core.\"user\" SET \"canAccessFullAdminPanel\" = true WHERE email = '<email>' RETURNING email, \"canAccessFullAdminPanel\";"
```

Then **the user must sign out and sign back in** — Twenty bakes `canAccessFullAdminPanel` into the JWT at sign-in time. The current session still has the old value cached in its access token. Without a fresh sign-in, the sidebar won't show the Admin Panel link and `/settings/admin-panel` will hit the `AdminPanelGuard` rejection.

### Side effect of step-2 omission

If you run only the CLI (step 1) and skip the DB UPDATE (step 2):
- ✅ User can read/write CRM data
- ✅ User can access `/settings/roles`, `/settings/ai`, `/settings/general`, etc. (workspace settings)
- ❌ User CANNOT access `/settings/admin-panel` (no Admin Panel link in sidebar; direct URL hits the guard)

### Bundle integration

The bundle's `provision-twenty.sh:37-40` runs the workspace-Admin step automatically (using service name `twenty`, not `twenty-server`):

```bash
docker exec foss-devstack-twenty yarn command:prod \
  workspace:bootstrap-sso-admin --email "${ADMIN_EMAIL}"
```

Important caveats for SSO deployments:

1. **`ADMIN_EMAIL` ≠ SSO email when Cognito sends numeric IDs.** The provisioner runs the CLI with `ADMIN_EMAIL` (e.g. `admin@example.com`), but actual SSO logins arrive as `<numeric-cognito-id>@askii.ai` (synthesised by the proxy-auth middleware). The CLI creates a `core.user` row for `ADMIN_EMAIL` but no SSO session ever resolves to that row — it's a phantom. To fix: re-run the CLI with the synthesised SSO email after the user has logged in once.

2. **The CLI does not unlock the Admin Panel.** Even after a successful CLI run, `canAccessFullAdminPanel` is still `false` and `/settings/admin-panel` is unreachable. You must run the Step 2 DB UPDATE separately.

3. **Sign-out is required to refresh JWT.** After the DB UPDATE, the user's existing JWT still has the old permission. Sign out and back in to get a fresh token.

## Promoting another user to global admin

There is **no GraphQL mutation** to flip `canAccessFullAdminPanel` from the UI. The CLI command is the only path:

```bash
docker compose exec twenty-server \
  node dist/src/database/commands/bootstrap-sso-admin.command.js \
  --email second-admin@example.com
```

Idempotent — running it again for an existing admin is a no-op.

## Promoting another user to workspace Admin

This *is* in the UI: `/settings/members` → member row → role dropdown → Admin. Backed by the `updateRole` mutation on the `WorkspaceMember` object via the standard `/graphql` endpoint. Gated on the actor being Admin or Owner of the workspace.

For role lookup, the Admin role's universal identifier is `20202020-02c2-43f2-b94d-cab1f2b532eb` (`packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant.ts:2`). The `Role` entity carries capability flags (`canUpdateAllSettings`, `canAccessAllTools`, `canReadAllObjectRecords`, etc.) rather than a fixed name enum — see `packages/twenty-server/src/engine/metadata-modules/role/role.entity.ts` (entity class at line 22; capability columns 27-46).

## Direct DB promotion (recovery only)

```sql
-- inside the postgres container, twenty core DB
UPDATE "core"."user" SET "canAccessFullAdminPanel" = true WHERE email = '<email>';
```

For workspace Admin role:

```sql
UPDATE "core"."workspaceMember"
   SET "roleId" = '20202020-02c2-43f2-b94d-cab1f2b532eb'
 WHERE "userId"      = (SELECT id FROM "core"."user" WHERE email = '<email>')
   AND "workspaceId" = '<workspace-uuid>';
```

## E2E test fixtures

- **Global admin path**: bootstrap via CLI (`workspace:bootstrap-sso-admin --email <test-admin>`) during test setup; assert against `/settings/admin-panel`. Don't try to flip `canAccessFullAdminPanel` from the UI — it isn't exposed.
- **Workspace admin path**: standard CRM flow — owner invites, role dropdown promotes.
- **Negative tests**: DB-seed `canAccessFullAdminPanel = false`, hit an admin GraphQL operation (e.g. `getSystemHealthStatus`), expect `AdminPanelGuard` to reject.

## Common gotchas

- **Two admin layers — do not conflate them.** `canAccessFullAdminPanel` is the instance-level flag, `WorkspaceMember.role = "Admin"` is workspace-scoped. They can be set independently. Bootstrap-sso-admin sets both; manual promotion in the UI only sets the workspace one.
- **No first-user-auto-admin.** Unlike Outline/Penpot/SurfSense, Twenty does not auto-promote anyone. You MUST run the bootstrap command or no one has admin.
- **Bootstrap is by email, not by Cognito sub.** For SSO deployments where oauth2-proxy synthesises emails from numeric IDs (e.g. `1020010000005439@askii.ai`), pass the synthesised email to `--email` — it must match what `ProxyAuthMiddleware` would create.
- **`/admin-panel-graphql-api`** is a separate endpoint. Don't issue admin operations against the main `/graphql` — the resolvers aren't there.

## Requirements

The following requirements pin the per-app admin contract for Twenty.
Each is verified by a test in `tests/apps/twenty-admin.spec.ts`, linked
via a `// @spec twenty-admin#<requirement-slug>` tag.

### Requirement: /settings/admin-panel SHALL NOT bypass the SSO chain

A cold context (no SSO cookie) hitting `/settings/admin-panel` MUST
be redirected to the IDP / auth wall. Twenty's admin URLs are not
in the ForwardAuth bypass list — there is no path that admits the
request without a valid `_oauth2_proxy` cookie.

#### Scenario: Cold visit to /settings/admin-panel bounces to auth

- **GIVEN** a fresh browser context with no `_oauth2_proxy` cookie
- **WHEN** the context navigates to
  `https://twenty.${PLATFORM_DOMAIN}/settings/admin-panel`
- **THEN** the response chain ends at an `isAuthWall` host
- **AND** the Twenty SPA shell does NOT progress past the auth bounce

### Requirement: non-admin SHALL NOT see admin-panel UI

An SSO-authenticated user with `User.canAccessFullAdminPanel = false`
visiting `/settings/admin-panel` MUST NOT see any admin-panel UI
markers (Health Status, Feature Flags, Config Variables, AI Models,
Admin Panel headings). The user remains on Twenty's host (not bounced
to the IDP) but the AdminPanelGuard either redirects them or refuses
to render the admin surface.

#### Scenario: Non-admin lands on Twenty's host but no admin markers render

- **GIVEN** an SSO-authenticated user (`NORMAL_USER`) with
  `User.canAccessFullAdminPanel = false`
- **WHEN** the user navigates to `/settings/admin-panel`
- **THEN** the page settles on the Twenty host (no IDP bounce)
- **AND** the count of admin-marker locators visible on the page is
  zero — for the markers Health Status, Feature Flags, Config
  Variables, AI Models, Admin Panel
- **AND** non-admin paths on the same host (e.g. `/settings/profile`)
  continue to render normally for the same user

### Requirement: instance admin SHALL reach /settings/admin-panel

A user with `User.canAccessFullAdminPanel = true` and a valid SSO
session MUST reach `/settings/admin-panel` with the admin UI
rendered. Either at least one admin marker (Health Status, Feature
Flags, etc.) is visible OR the `/admin-panel-graphql-api` endpoint
returned a 2xx/3xx response during the page load — both are
acceptable signals that AdminPanelGuard admitted the request.

#### Scenario: Admin reaches /settings/admin-panel and the guard admits

- **GIVEN** an SSO-authenticated user (`FOSS_USER`) with
  `User.canAccessFullAdminPanel = true`
- **WHEN** the user navigates to `/settings/admin-panel`
- **THEN** AT LEAST ONE of the following is true:
  - At least one admin-panel marker locator (Health Status, Feature
    Flags, Config Variables, AI Models, or an Admin Panel heading)
    is visible on the page, OR
  - The `/admin-panel-graphql-api` endpoint returned a non-error
    response (2xx or 3xx) during the page load
- **AND** the page does NOT bounce off-host or render an
  AdminPanelGuard-refused fallback

## References

- `packages/twenty-server/src/database/commands/bootstrap-sso-admin.command.ts:32` — `workspace:bootstrap-sso-admin` CLI command name; `addUserToWorkspaceOrEnsureRole` call at line 105
- `packages/twenty-server/src/engine/guards/admin-panel-guard.ts:6,13` — `AdminPanelGuard` class + `canAccessFullAdminPanel === true` check
- `packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.resolver.ts` — admin GraphQL surface (`@UseGuards(AdminPanelGuard)` repeated at lines 148, 170, 176, 182, …)
- `packages/twenty-server/src/engine/api/graphql/admin-panel.module-factory.ts` — `/admin-panel-graphql-api` route binding
- `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant.ts:2` — Admin role universal identifier
- `packages/twenty-server/src/engine/metadata-modules/role/role.entity.ts:22-46` — `RoleEntity` class + capability flag columns
- Bundle: `foss-server-bundle-devstack/provision/provision-twenty.sh:37-40` — bootstrap invocation (gated on `ADMIN_EMAIL` being set and not the placeholder)
