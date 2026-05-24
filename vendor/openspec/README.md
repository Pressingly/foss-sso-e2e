# Vendored openspec + skills from `awais786/sso-rules-moneta`

Snapshot of the SSO contract this e2e suite verifies. Vendored so the
spec-coverage audit (`scripts/check-spec-coverage.sh`) and per-app
admin tests (`tests/apps/*-admin.spec.ts`) work from a deterministic
local source — no network or token dependency at CI time.

## What's here

```
specs/                    — SSO chain contract (the `@spec` audit reads these)
  cognito-claim-mapping/spec.md
  forwardauth-traefik/spec.md
  logout-flow/spec.md
  oauth2-proxy-gateway/spec.md
  proxy-auth-middleware/spec.md
  session-lifecycle/spec.md
  workspace-auto-join/spec.md

skills/                   — devstack invariants + per-app admin contracts
  app-rules/RULES.md      — universal rules (email synthesis, header
                            handling, ReDoS guard, etc.). The source
                            of truth for `tests/auth/email-domain-consistency.spec.ts`
                            and friends.
  outline-admin/SKILL.md  — Outline `UserRole` enum semantics
  penpot-admin/SKILL.md   — Penpot team/role model
  plane-admin/SKILL.md    — Plane workspace role enum
  surfsense-admin/SKILL.md — SurfSense SearchSpace ownership
  twenty-admin/SKILL.md   — Twenty `canAccessFullAdminPanel` + workspace roles
```

The per-app `SKILL.md` files describe the contracts that the
`tests/apps/{outline,twenty,penpot,plane,surfsense}-admin.spec.ts`
suite pins. They're vendored as reference, not (yet) audited — they
don't follow the `### Requirement:` line format that the audit
script parses. If you refactor a SKILL.md to add `### Requirement:`
sections, the audit will pick it up automatically.

## Refreshing

Re-vendor from a local clone of `awais786/sso-rules-moneta`:

```bash
SSO_RULES_SRC=/path/to/sso-rules-moneta bash scripts/refresh-openspec.sh
```

The script verifies the source exists, copies `openspec/specs/` and
`skills/` into this directory, and prints a diff summary so the
update is visible in the PR.

## Pin commit

Update this line when you refresh — useful for tracing which upstream
state a given PR was tested against.

**Vendored from:** `awais786/sso-rules-moneta@main` (refresh updates this)
