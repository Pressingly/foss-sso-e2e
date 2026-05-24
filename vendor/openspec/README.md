# Vendored openspec + skills

In-tree snapshot of the SSO contract this e2e suite verifies. Vendored
so the spec-coverage audit (`scripts/check-spec-coverage.sh`) and
per-app admin tests (`tests/apps/*-admin.spec.ts`) work from a
deterministic local source — no network or token dependency at CI
time.

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

## Updating

Edits land as normal PR diffs against the files in this directory.
The audit picks up new `### Requirement:` lines automatically; remove
or rename a requirement and a test's `@spec` tag will point at
nothing — that's a CI failure pointing at the gap.
