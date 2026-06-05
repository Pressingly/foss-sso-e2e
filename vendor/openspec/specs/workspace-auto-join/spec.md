# workspace-auto-join — capability spec

How each app onboards a newly-provisioned SSO user into a workspace / team / organisation on first login, so the user lands on a usable screen instead of an empty "create workspace" wizard.

Per-app workspace models, role enums, and onboarding flags vary. This spec captures the cross-app contract; the per-app implementation details live in [`workspaces.md`](../../../workspaces.md).

## Why this exists

When `proxy-auth-middleware` Rule 3 creates a new user from the proxy header, that user has no team membership and no completed onboarding. Without auto-join, the user lands on the app's "Create your first workspace" / "Get started" wizard — which is wrong for an SSO-onboarded user joining an existing organisation that already has a workspace.

The bundle's policy: when an app already has at least one workspace, a newly-provisioned SSO user MUST be joined to that workspace as a regular member, and onboarding MUST be marked complete so the user lands on the main app screen.

## Requirements

### Requirement: auto-join SHALL run on every login, not just on user creation

The auto-join logic MUST be invoked from inside `_resolve_user` (or the per-app equivalent) on **every authenticated request that resolves a user**, not gated on "is this a brand-new user?". The implementation MUST be idempotent — running it for a user who is already a member of a workspace is a cheap no-op.

Rationale: a user may be created during an early request that fails before auto-join runs (e.g. an `IntegrityError` race resolved by the get-fallback), or they may have been provisioned by an out-of-band mechanism (admin import, CLI tool) and then log in for the first time. Running auto-join on every login ensures both paths converge on a joined user.

#### Scenario: Existing member triggers no DB writes

- **GIVEN** a user who is already an active member of at least one workspace
- **WHEN** the user makes any authenticated request
- **THEN** the auto-join logic detects the existing membership and returns early
- **AND** no INSERT or UPDATE is issued against the workspace-member table
- **AND** no INSERT or UPDATE is issued against the user-profile table

### Requirement: auto-join SHALL skip when no workspace exists yet

If the app has no workspaces, the auto-join logic MUST do nothing. The user falls through to the app's normal "create your first workspace" flow. Creating a workspace implicitly here would race with an admin who is about to provision the canonical organisation workspace.

#### Scenario: First user in a brand-new install

- **GIVEN** a freshly-deployed bundle with no workspaces in the app yet
- **WHEN** the first SSO user is provisioned by `proxy-auth-middleware` Rule 3
- **THEN** the auto-join logic detects zero existing workspaces and returns
- **AND** no workspace is created automatically
- **AND** the user is routed to the app's normal "create workspace" wizard

### Requirement: auto-join target SHALL be the oldest workspace

When at least one workspace exists, the user MUST be joined to the **earliest-created** workspace (ordered by `created_at ASC`, first row). This makes the behaviour deterministic and avoids "newest workspace" surprises after an admin spins up a side workspace for testing.

#### Scenario: Multiple workspaces, auto-join lands on the oldest

- **GIVEN** the app has three workspaces: `acme` (created 2026-01-01), `staging` (2026-04-01), `test` (2026-05-01)
- **WHEN** a new SSO user is provisioned
- **THEN** the user is added as a member of `acme` (the oldest)
- **AND** the user is NOT added to `staging` or `test`

### Requirement: auto-join role SHALL be the app's regular-member role, not Admin or Guest

The role assigned MUST be the app's standard member role:

- Plane: `Member` (role value `15`)
- Outline: `member` (Outline's standard team role)
- Penpot: standard team-member role
- Twenty: workspace member (non-admin)
- SurfSense: standard space-member role (where applicable; SurfSense's tenancy model is documented in `workspaces.md`)

Auto-join MUST NOT promote the user to Admin and MUST NOT downgrade them to Guest / Viewer. Admins are bootstrapped separately (CLI command, manual admin action, or the explicit god-mode flow); guests are only assigned by an admin invitation flow.

#### Scenario: Member role, not Admin

- **GIVEN** a new SSO user is being provisioned
- **WHEN** the auto-join writes the membership row
- **THEN** the role on the new membership row is the app's regular Member role
- **AND** the role is NOT Admin, Owner, Guest, or Viewer

### Requirement: auto-join SHALL mark onboarding complete on the user profile

After joining a user to the oldest workspace, the per-app user-profile row MUST be updated to reflect a completed onboarding state. The exact fields differ by app; for Plane the contract is:

- `is_onboarded = True` — the load-bearing flag; Plane re-prompts onboarding when this is `False` regardless of the per-step sub-state.
- `last_workspace_id = <the joined workspace's id>` — set so the user lands directly in their workspace on next login.
- `onboarding_step.profile_complete = True`, `workspace_create = True`, `workspace_invite = True` — the three deterministic sub-step flags the auto-join code path sets.

The `onboarding_step.workspace_join` sub-flag tracks Plane's invite-link join flow (a user clicking an invitation URL). Auto-join provisions the user directly through the bundle's system-bot path, NOT through the invite UI, so `workspace_join` legitimately stays `False` on SSO-auto-joined users. The contract is satisfied by `is_onboarded = True` (the load-bearing flag) plus the three deterministic sub-step flags.

The update MUST only fire when the profile is not yet onboarded — this avoids a write on every authenticated request for already-onboarded users.

#### Scenario: New SSO user gets onboarding-complete flags after auto-join

- **GIVEN** a freshly-created user with `is_onboarded=False`
- **WHEN** auto-join runs and joins them to the oldest workspace
- **THEN** the user's profile row is updated to `is_onboarded=True`
- **AND** `last_workspace_id` is set to the joined workspace's id
- **AND** `onboarding_step.profile_complete = True`
- **AND** `onboarding_step.workspace_create = True`
- **AND** `onboarding_step.workspace_invite = True`
- **AND** `onboarding_step.workspace_join` remains `False` (the user didn't go through an invite link — see requirement text above)

#### Scenario: Already-onboarded user is not re-written

- **GIVEN** an existing user with `is_onboarded=True`
- **WHEN** the user makes any authenticated request
- **AND** auto-join runs
- **THEN** no UPDATE is issued against the profile row (the `WHERE is_onboarded=False` filter excludes them)

### Requirement: per-app workspace model SHALL be documented in workspaces.md

The cross-app concept of "workspace" varies in name and shape:

- Plane: `Workspace` ↔ `WorkspaceMember`
- Outline: `Team` ↔ team-membership records
- Penpot: `Team` (with profile↔team rows)
- Twenty: `Workspace` ↔ workspace-member with role
- SurfSense: per-space membership (see workspaces.md)

The implementation in each app's middleware MUST resolve to the correct per-app type. The mapping table — including each app's role enum and onboarding-flag layout — MUST be kept current in [`workspaces.md`](../../../workspaces.md). This spec deliberately stays cross-app; the reference doc carries the per-app detail.

### Requirement: auto-join SHALL NOT leak across apps

A user joining workspace X in Plane MUST NOT cause them to be auto-joined to anything in Outline, Penpot, Twenty, or SurfSense. Each app's auto-join runs independently against its own DB.

This is by construction — each app has its own user table and its own middleware — but the requirement is stated to prevent a future "cross-app membership-sync service" from being designed without re-evaluating the auto-join model.

#### Scenario: Per-app auto-join is independent

- **GIVEN** a user who exists in both Plane and Outline DBs (same email, separately provisioned by each app's middleware)
- **AND** the user is a member of the `acme` workspace in Plane
- **WHEN** the user logs in to Outline for the first time
- **THEN** Outline's auto-join joins them to Outline's oldest team (whatever that is)
- **AND** the user's Plane membership has no effect on what Outline does
- **AND** the user's Outline membership has no effect on what Plane does
