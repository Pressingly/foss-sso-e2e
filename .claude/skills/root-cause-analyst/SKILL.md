---
name: root-cause-analyst
description: Investigate a bug's root cause. **Scope from the ticket FIRST** (which app or which infra layer the ticket actually mentions), then investigate only that scope. Reads code + config + logs only within the scoped area; produces a finding document. Read-only — identifies where the cause lives and where the fix should go; does NOT write a code patch. Targeted by design — refuses to grep across all 8+ repos "just in case."
allowed-tools: Bash(grep:*) Bash(rg:*) Bash(find:*) Bash(ls:*) Bash(cat:*) Bash(head:*) Bash(tail:*) Bash(docker:*) Bash(curl:*) Bash(gh:*) Bash(git:*) Read Write WebFetch
---

# Root-cause analyst

Given a bug — a Plane ticket, a captured error, a failing test — figure
out **where the bug actually lives**: which repo, which file, which env
var, which Traefik route, which IDP policy. Output a finding document.
Do **not** write a code patch. Some bugs are infra config; some are
contract gaps; some span layers. The bug-fixer plugin is what writes
tests; this skill identifies what needs to change for the fix.

## When to use

- A bug repro is confirmed and you need to know *what to change*
- A test fails in a way that spans multiple layers (frontend → API → infra)
- A reporter says "this is a known X issue" — find the actual upstream cause
- Cross-app bugs (touches SSO, multiple apps' integrations, or shared infra)
- Symptoms don't match any obvious responsible repo

## When NOT to use

- You're confident the cause is in one app's UI code — just read that
  app and propose a fix directly
- You want the **fix** (this skill only writes a finding; the fix is a
  separate task, in the right repo, by a human or the bug-fixer agent)
- The bug is too vague to investigate (no repro steps, no observable) —
  push back to the reporter first

## The 6-layer FOSS-bundle topology

A request from a user's browser to (e.g.) `pm.foss.arbisoft.com`
traverses up to 6 layers. Bugs live at any of them:

```
┌─────────────────────────────────────────────────────────────┐
│ L1 Browser                                                  │  user-visible UI; selectors, hash routing, JS errors
├─────────────────────────────────────────────────────────────┤
│ L2 Traefik (ingress + ForwardAuth)                          │  foss-server-bundle* — routing rules, middleware chain
├─────────────────────────────────────────────────────────────┤
│ L3 oauth2-proxy                                             │  foss-server-bundle* — cookie scope, session
├─────────────────────────────────────────────────────────────┤
│ L4 mPass-auth-proxy / mPass / Cognito                       │  foss-server-bundle* + IDP — claims, tokens
├─────────────────────────────────────────────────────────────┤
│ L5 App backend (Plane / Outline / Penpot / SurfSense / Twenty)│  each app's API + workers + middleware
├─────────────────────────────────────────────────────────────┤
│ L6 Data + storage (Postgres / Valkey / Rabbit / SeaweedFS) │  foss-server-bundle* — credentials, bucket policies
└─────────────────────────────────────────────────────────────┘
```

The SSO contract (`sso-rules-moneta/openspec/specs/`) cuts across L2–L4
horizontally — it's the spec for what those layers should jointly do.

## Repo map (where to look for what)

| Symptom area | Repo | Files to read |
|---|---|---|
| Login / SSO chain (contract) | `sso-rules-moneta` | `openspec/specs/*/spec.md`, `authentication.md`, `proxy-auth-contract.md`, `mpass-security.md` |
| Login / SSO chain (impl) | `foss-server-bundle` + `foss-server-bundle-devstack` | `docker-compose*.yml`, `traefik/`, `oauth2-proxy.cfg`, `mpass-auth-proxy/` |
| Per-app SSO integration | `sso-rules-moneta` | `<app>-security.md` |
| App admin UI / per-app code | `outline` / `plane` / `penpot` / `SurfSense` / `twenty` | `apps/` or top-level depending on repo |
| Plane storage / uploads | `plane` | `apps/api/plane/settings/storage.py`, `apps/api/plane/app/views/asset/v2.py` |
| File storage (S3-compatible backend) | `foss-server-bundle*` | seaweedfs container config (`s3.json`, mounts), Plane API env vars |
| Identity / Cognito claims | `sso-rules-moneta` | `openspec/specs/cognito-claim-mapping/spec.md` |
| IDP form / mPass UI | `foss-server-bundle*` | `mpass-auth-proxy/` |
| Session lifecycle | `sso-rules-moneta` | `openspec/specs/session-lifecycle/spec.md` |
| Logout flow | `sso-rules-moneta` | `openspec/specs/logout-flow/spec.md` |
| Workspace auto-join | `sso-rules-moneta` | `openspec/specs/workspace-auto-join/spec.md` |
| Test conventions / existing coverage | `foss-sso-e2e` | `CLAUDE.md`, `fixtures.ts`, `auth-helpers.ts`, `tests/auth/`, `tests/apps/<app>.spec.ts` |
| Bug-fixer agent + spec-driven plans | `foss-sso-e2e/agents/bug-fixer/` | `prompts/`, `src/bug_fixer_agent/`, `tests/bugs/specs/` (existing plans for reference) |

## Investigation methodology

**The single most important rule: scope first, investigate narrowly.**

A naive investigation greps across all 8+ repos and reads dozens of files
"just in case." That wastes time + tokens + attention. Real diagnoses
start with one question: *which 1–2 components is this bug actually
about?* Read the ticket title + description; pick the scope; investigate
ONLY that scope. If new evidence later expands the scope, expand then —
not preemptively.

### Step 0 — Scope from the ticket

Read the Plane ticket. Extract scope by keyword:

| Scope clue in the ticket | Investigate ONLY | Skip |
|---|---|---|
| Mentions a specific app: "Plane", "Outline", "Penpot", "SurfSense", "Twenty" | That app's repo + the layers it depends on (likely L5 + maybe L6 for uploads) | The other 4 apps, the SSO chain (unless symptom is auth-shaped) |
| "oauth2-proxy", "Traefik", "ForwardAuth", "auth wall", "redirect loop" | `foss-server-bundle*` Traefik / oauth2-proxy config (L2–L3); `sso-rules-moneta` openspec for the relevant module | App code (unless app-specific bypass routes are implicated) |
| "mPass", "Cognito", "QR Login", "Password Login", "IDP form" | `foss-server-bundle*` mpass-auth-proxy + IDP layer (L4); `cognito-claim-mapping` openspec | App backends (unless app reads the claim wrong) |
| "Login", "Logout", "Session", "Cookie", "Re-login" | `sso-rules-moneta/openspec/specs/session-lifecycle` + `logout-flow`; oauth2-proxy config (L3) | App-internal UI (unless app's per-app session is implicated) |
| "Upload", "Cannot upload", "Attachment", "Cover image", "Media" | The app's storage code path (L5) + foss-server-bundle's seaweedfs config (L6) | Auth chain (unless it manifests via 401/403) |
| "Two tabs", "Concurrent", "Multi-user" | L3 (cookie sharing) + L4 (IDP state); openspec session-lifecycle | App UI unless symptom is purely app-side |
| Cross-app: "all apps", "every app", "all 5 apps" | The SSO chain (L2–L4) — only shared infrastructure can affect every app simultaneously | Any single app's internals |
| Configuration / deployment hint: "doesn't work in prod", "works locally but not on sandbox" | Deployment env in `foss-server-bundle*` (env vars, secrets, Traefik labels) | Code repos (the differing artifact is usually env, not code) |

**If the ticket is genuinely vague** (no scope keywords, no observable),
DON'T expand the investigation. Stop and push back to the reporter for
clarification — same gate as bug-fixer's Mode 3.

### Step 1 — Capture the symptom precisely

Inside the chosen scope, capture:
- User-visible failure (what the user sees / doesn't see)
- HTTP / network details (status code, URL path, response body excerpt)
- Browser console errors (if known)
- Server log lines around the symptom (if reproduced locally)

### Step 2 — Pick the L1–L6 layer

Most scopes map to one or two layers (the table in §6-layer FOSS-bundle
topology above). Don't read layers outside your scope's map.

### Step 3 — Read the relevant files only

Use the **Repo map** below for the scoped area. **Open files in the
order: contract spec (if relevant) → config → code.** Most config bugs
are caught by reading config files; you only need to dive into code
when config looks correct but behavior still wrong.

### Step 4 — Check local logs (scoped containers only)

```bash
# Identify the containers in your scope:
docker ps --format 'table {{.Names}}\t{{.Image}}'

# Then tail ONLY those (don't tail all 18 containers):
docker logs -f foss-devstack-plane-api 2>&1 | grep -iE 'error|forbidden|denied|404|500'
# or whatever your scope contains (oauth2-proxy / traefik / seaweedfs / mpass-auth-proxy / app-specific)
```

### Step 5 — Cross-reference inside the scope

Within your scope, trace the request path end-to-end. For example, a
storage bug might touch:
- L5 app code (uploads handler)
- L5 app config (storage settings)
- L6 storage container env + identity file

But you DON'T need to touch L2–L4 unless evidence points there.

### Step 6 — Classify

| Class | Where it lives | Who fixes |
|---|---|---|
| **code bug** | One app repo's code | App-repo PR |
| **config bug** | Env vars, container config | `foss-server-bundle*` PR |
| **deployment bug** | Traefik routes, secrets, k8s manifests | Infra config |
| **contract gap** | The openspec doesn't define the behavior | `sso-rules-moneta` openspec proposal |
| **upstream bug** | The third-party app itself (rare; usually our fork) | Upstream PR or vendored patch |

### Step 7 — Write the finding

Use the template in the next section. Include the **scope you settled
on in Step 0** explicitly so future readers (and re-investigations)
know what you DIDN'T look at and why.

### When to expand the scope

The scope from Step 0 is a starting point, not a cage. Expand if:
- An auth-shaped symptom (401/403) appears in what you thought was an
  app-only bug → expand to L2–L4
- A bug fixed in app code reappears → check infra layer (cache, build,
  Traefik route) is also up to date
- Logs in the scoped container reference an upstream service —
  follow that thread

**Document the expansion** in the finding's "Request trace" so the
reasoning is auditable.

## Output: finding markdown

Save to `docs/root-cause-<bug-id>-YYYY-MM-DD.md`.

```markdown
# Root cause — <bug-id> / <short title>

## Scope

<What scope you settled on in Step 0 + why. e.g. "Scoped to Plane app
backend + storage (L5+L6) — ticket title says 'Plane', symptom mentions
upload. SSO chain (L2–L4) not investigated; no auth-shaped symptoms.">

## Symptom

<What the user sees. Quote error messages verbatim. URL paths. HTTP
status. Browser/server-log excerpts.>

## Request trace

<Each L1–L6 layer's role for this bug. If layer N is innocent, say so
and why; if layer N is implicated, point at the exact file/line/env.>

  L1 (browser): …
  L2 (Traefik): …
  L3 (oauth2-proxy): …
  L4 (mPass / Cognito): …
  L5 (app backend): …
  L6 (storage / data): …

## Root cause

<The single sentence "what's wrong." Cite file:line or env var.>

## Fix location

<Which repo, which file/env, what change. **Do not write the code** —
just say where it should go and why.>

  - Repo: `foss-server-bundle-devstack`
  - File: `docker-compose.yml` (the `plane-api` service env block)
  - Change: align `AWS_ACCESS_KEY_ID` to an identity in
    `seaweedfs/s3.json` that has `Write` action on `plane-uploads`

## Class

<One of: code bug | config bug | deployment bug | contract gap | upstream bug>

## Verification path

<How to confirm the fix worked, once applied. Ideally a test under
tests/bugs/ that the bug-fixer can produce — link to its plan if one
exists.>

## Related artifacts

- Plane ticket: <URL>
- Existing test (if any): `tests/bugs/bug_<short>.spec.ts`
- Existing plan (if any): `tests/bugs/specs/bug_<short>.plan.md`
- Related openspec module: `openspec/specs/<module>/spec.md`
```

## Patterns from past investigations

These are real findings — useful as templates:

- **FOSSSMBBUN-73 (Plane: cannot create project)** — `docs/root-cause-...` not written (we did it inline in the plan). Two-layer config bug: (L5) Plane's `AWS_ACCESS_KEY_ID` doesn't match an identity in SeaweedFS `s3.json` → backend can't reach bucket; (L1) presigned URL points at `seaweedfs:8333` (internal Docker hostname) which the browser can't resolve. Class: **config bug**. Fix lives in `foss-server-bundle-devstack`, not in `plane` code. See `tests/bugs/specs/bug_4961d647.plan.md` § Investigation.

- **FOSSSMBBUN-88 (multi-tab mpass_bridge race)** — symptom: second-tab login shows "Missing mpass_bridge cookie" toast. Likely root cause: mPass-side state cookie gets rotated when first tab completes; second tab's submit fails to correlate. Class candidates: **contract gap** (SSO openspec doesn't define multi-tab semantics) OR **upstream bug** (mPass / Cognito). See `tests/bugs/specs/bug_dc998ba0.plan.md`.

## Cross-references

- `agents/bug-fixer/ARCHITECTURE.md` — full pipeline architecture (this skill is the *diagnosis* counterpart to the *test generation* the bug-fixer does)
- `.claude/skills/bug-fixer/SKILL.md` — how to run the bug-fixer once root cause + fix location are known
- `skills.md` §1–§3 — what the e2e suite already covers; useful for finding existing tests that pin similar invariants
- `CLAUDE.md` — per-app gotchas (Twenty `networkidle`, Penpot hash routing, Plane god-mode local creds, mPass picker, …) — read this first to rule out known quirks before deep investigation
