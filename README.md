# FOSS E2E — Playwright Test Suite

End-to-end tests for the FOSS platform. See **[`TESTS.md`](./TESTS.md)** for
a top-to-bottom catalog of every test in the suite. Highlights: SSO chain,
multi-app session sharing, cookie expiry bounds, session lifecycle
(logout / invalidation / replay / deletion), per-app link coverage, the
Plane god-mode admin escape hatch, Outline's admin `/settings/*` SSO-gating
+ role split, Twenty's `/settings/admin-panel` URL gate, the full
login → 5 apps → logout user journey, and the SSO-rule invariants from the
[vendored openspec](./vendor/openspec/) (header spoofing, bypass discipline,
security-header coverage on every router type, no local-login UI in SSO
mode, cross-app identity consistency, HTTP plaintext lockdown).

The suite is **environment-agnostic**. One env var (`FOSS_BASE_URL`) drives
the entire host topology. Pointing at sandbox, staging, prod, or a local
devstack is a one-line `.env` change — no code edits.

## Spec-driven

Every contract-bearing test in the suite points at a **written requirement**.
The audit is **bidirectional** and gated by CI:

- `scripts/check-spec-coverage.sh` walks requirements → tests: every
  `### Requirement:` line in [`vendor/openspec/`](./vendor/openspec/)
  must be tagged by at least one test, OR documented in
  [`docs/spec-coverage-deferred.md`](./docs/spec-coverage-deferred.md).
- The structural check in `tests/meta/playwright-practices.spec.ts`
  walks tests → requirements: every contract-bearing `*.spec.ts` must
  carry at least one `// @spec module#slug` tag pointing at a vendored
  requirement (small documented allowlist for shells / scan drivers).

Adding a test without a requirement → CI fails. Adding a requirement
without a test → CI fails. Drift requires explicit human acceptance in
both directions.

**Today: 88 requirements, 0 missing** — 52 from the SSO chain openspec,
36 from per-app admin + workspace-isolation + security-hardening skills.
Run `make audit` for live counts.

When CI is red, [`TRIAGE.md`](./TRIAGE.md) is the 2-minute "failure
pattern → cause → action" runbook.

## Apps Under Test

All hosts derive from `FOSS_BASE_URL`.

Default topology is `nested` (`FOSS_HOST_TOPOLOGY` unset):

| Component | Host pattern | Sandbox value |
|-----------|-------------|---------------|
| Main portal           | `foss.<domain>`              | `foss.arbisoft.com` |
| Outline (Docs)        | `docs.foss.<domain>`         | `docs.foss.arbisoft.com` |
| Plane (PM)            | `pm.foss.<domain>`           | `pm.foss.arbisoft.com` |
| Penpot (Design)       | `design.foss.<domain>`       | `design.foss.arbisoft.com` |
| SurfSense (Research)  | `research.foss.<domain>`     | `research.foss.arbisoft.com` |
| Twenty (CRM)          | `twenty.foss.<domain>`       | `twenty.foss.arbisoft.com` |
| ForwardAuth proxy     | `auth.foss.<domain>`         | `auth.foss.arbisoft.com` |

In `peer` topology (`FOSS_HOST_TOPOLOGY=peer`), app/auth hosts derive as
`<app>.<smb-domain>` (for example `docs.platform.askii.ai`) while
`FOSS_BASE_URL` stays `https://foss.<smb-domain>`. Cookie scope is the
SMB domain (`<smb-domain>`), so one cookie still covers all app hosts.

## Quick start

```bash
npm install
npm run install:browsers
cp .env.example .env       # then fill in FOSS_USER / FOSS_PASS
npm test
```

Required env (in `.env`):

```
FOSS_BASE_URL=https://foss.arbisoft.com
FOSS_USER=...
FOSS_PASS=...
```

Optional:
- `NORMAL_USER` / `NORMAL_PASS` — separate SSO identity ("User B" per
  sso-rules/admin.md) that has NOT been promoted to admin on any app.
  Required for the non-admin half of the role-split tests
  (`outline-admin`, `twenty-admin`); those blocks self-skip otherwise
- `PLANE_ADMIN_USER` / `PLANE_ADMIN_PASS` — enables the god-mode admin sign-in
  + wrong-password tests (otherwise those self-skip). These are local Plane
  credentials, NOT SSO — Plane's god-mode bypasses oauth2-proxy entirely.
- `TWENTY_ADMIN_USER` / `TWENTY_ADMIN_PASS` — optional override for Twenty's
  positive admin-panel test. By default that test uses `FOSS_USER` /
  `FOSS_PASS`; set this pair only when Twenty admin rights live on a different
  identity in a given deployment.

Outline / Penpot / SurfSense / Twenty admin tests use the worker
fixture's identity (`FOSS_USER`) by default. Plane is intentionally
different: shared-workspace role checks in `tests/apps/pm-admin.spec.ts`
pin Member-only behavior unless that identity is explicitly promoted in
the target deployment.
- `BROWSERS=all` — chromium + firefox + webkit (default: chromium only)
- `FOSS_COGNITO_DOMAIN` / `FOSS_MPASS_DOMAIN` — IDP overrides (don't derive
  from base URL)
- `FOSS_HOST_TOPOLOGY` — host derivation mode: `nested` (default) or `peer`

See `.env.example` for everything.

## Running

```bash
npm test                  # all tests, chromium
npm run test:auth         # tests/auth/        — SSO, sharing, lifecycle, identity
npm run test:apps         # tests/apps/        — per-app + god-mode
npm run test:flows        # tests/flows/       — login → 5 apps → logout
npm run test:security     # tests/security/    — headers, plaintext, spoof, bypass
npm run test:all-browsers # full suite × chromium + firefox + webkit
npm run report            # open last HTML report
```

Makefile shortcuts:

```bash
make help                          # list all targets

# Bulk runs (headless, same as CI)
make test                          # full suite, chromium
make test-auth                     # tests/auth/
make test-apps                     # tests/apps/
make test-flows                    # tests/flows/
make test-security                 # tests/security/
make test-all-browsers             # chromium + firefox + webkit
```

Running **one test locally** — these three convenience targets default
to **visible Chrome** (headed) so you can watch the browser; pass
`HEADED=0` to force headless. CI auto-detects `$CI` and runs headless
without needing the override.

| Target | Variable | When to use |
|---|---|---|
| `test-spec` | `SPEC=` (full path) | You're pasting a file path |
| `test-one` | `NAME=` (filename substring) | "Run the outline-admin tests" |
| `test-name` | `NAME=` (test name) | Paste the text after `›` from a CI failure line |

```bash
# Run a whole file (39 outline-admin tests)
make test-spec SPEC=tests/apps/outline-admin.spec.ts
make test-one  NAME=outline-admin

# Run ONE test (by name — works across the whole suite)
make test-name NAME="admin reaches /settings/integrations"

# Narrow inside a file with --grep
make test-one NAME=outline-admin GREP="/settings/integrations"

# Force headless (rare locally; default in CI)
make test-name NAME="..." HEADED=0
```

## Why some tests skip

Every `test.skip(...)` / `raw.skip(...)` in this suite is intentional —
not a TODO or broken test. Four categories:

| Reason | Where | Why |
|---|---|---|
| Missing env credentials | `tests/apps/*-admin.spec.ts`, `tests/apps/pm-godmode.spec.ts`, `tests/flows/identity-switch-after-relogin.spec.ts`, `tests/bugs/bug_dc998ba0.spec.ts` | Tests that need a second identity (`NORMAL_USER`) or local Plane creds (`PLANE_ADMIN_USER`) self-skip when unset, so the suite is portable to deployments without those identities provisioned |
| Vacuously-satisfied invariant | `tests/auth/proxy-short-circuit.spec.ts`, `tests/auth/logout-invariants.spec.ts` | The deployment doesn't expose the surface the test checks (e.g. no JS-readable session cookie to rotate) — the contract is satisfied trivially |
| App-shape opt-out | `tests/lib/link-coverage.ts` | Apps with no `<a href>` nav (button-only SPAs) skip link-crawl assertions via `requireLinks=false` |
| Browser-matrix dedup | `tests/meta/playwright-practices.spec.ts` | The static hygiene grep is browser-independent — runs once on Chromium, dedups on Firefox/WebKit |

## What's covered

The full invariant contract lives in **`skills.md`** (universal rules) and
the [vendored openspec](./vendor/openspec/specs/)
(per-module spec.md files: `forwardauth-traefik`, `oauth2-proxy-gateway`,
`proxy-auth-middleware`, `session-lifecycle`, `logout-flow`,
`cognito-claim-mapping`, `workspace-auto-join`). Highlights:

### Session + SSO
- **SSO chain** — `_oauth2_proxy` cookie shape (Secure / HttpOnly / SameSite=Lax),
  shared across all 5 subdomains, present after login, scoped to the
  platform domain.
- **Cookie expiry** — `_oauth2_proxy` and per-app session cookies must expire
  within the configured SSO TTL bound (`FOSS_MAX_SESSION_TTL_SECONDS`,
  default 92 days). Browser-session cookies (`expires=-1`) and
  CSRF / locale cookies are excluded.
- **Session lifecycle** — UI logout clears the cookie; logout from one app
  invalidates all; pre-logout cookies cannot be replayed; deleting the SSO
  cookie locks every app behind the IDP.
- **Layer-2 re-establish across apps** — valid SSO cookie + cleared app-local
  session/storage + reload stays on the app host (no IDP bounce).
- **Cross-app identity consistency** — every backend's `/me`-shape
  endpoint (Plane `/api/users/me/`, Outline `/api/auth.info`, Penpot
  RPC `get-profile`, SurfSense `/users/me`) resolves the same logged-in
  user to the same synthesized email. Catches `DEFAULT_EMAIL_DOMAIN`
  drift across containers.

### Per-app
- **Per-app link coverage** — every internal `<a href>` on the start page
  loads <400, stays on the app's host, doesn't bounce to the auth wall, no
  404 in title, and is clickable. Adapts to SPAs whose nav streams in /
  mutates by route (Twenty).
- **god-mode** (Plane admin) — `/god-mode/` and `/auth/get-csrf-token`
  bypass ForwardAuth; the page renders Plane's own admin form (not the SSO
  IDP); admin login works; wrong password is rejected; admin login does
  **not** issue the platform `_oauth2_proxy` cookie (separate session
  universe).
- **Outline admin** (`/settings/*`) — *inverse* invariant of god-mode:
  every admin URL sits fully behind SSO (cold context bounces through
  ForwardAuth), and Outline enforces the admin/non-admin role split
  server-side. Under a non-admin SSO user the 5 common-settings pages
  load, while the 8 admin-only pages (details, security, authentication,
  features, integrations, applications, import, export) are gated
  (Not Found, chunk-load failure, or never resolve past the SPA shell).
- **Twenty admin** (`/settings/admin-panel`) — Twenty has a real
  admin URL gated server-side by `AdminPanelGuard` checking
  `User.canAccessFullAdminPanel`. Three invariants: cold context
  bounces through SSO (no bypass), FOSS_USER (non-admin) lands on
  Twenty but the page renders no admin-panel UI markers, and (when
  `TWENTY_ADMIN_USER` is set) a pre-bootstrapped admin user sees the
  admin UI markers (Health Status / Feature Flags / Config Variables
  / AI Models). Twenty has NO first-user-auto-admin — `canAccessFull­
  AdminPanel` is only flippable via the `workspace:bootstrap-sso-admin`
  CLI command, so the admin account must be pre-bootstrapped on the
  deployment.
- **End-to-end flow** — fresh login → all 5 apps load authed; per-app
  `/oauth2/sign_out`; main portal "Log out of all apps" → all 5 apps
  bounce back to the IDP.

### Edge layer (forwardauth-traefik + oauth2-proxy-gateway)
- **HTTP plaintext lockdown** — every host on port 80 redirects to https
  or refuses the connection. No 2xx ever served over plain HTTP.
- **Security headers** on every browser-facing router — HSTS (≥180d +
  includeSubDomains), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY|SAMEORIGIN`, `Referrer-Policy`,
  `Permissions-Policy` denying camera / mic / geolocation. Covers
  `*-secure`, `*-bypass`, `oauth2-proxy-secure`, and `oauth2-apps`
  routers (headers are per-response, not host-cached — each router
  type is verified separately).
- **Header spoofing rejection** — sending `X-Auth-Request-*` headers
  without a cookie must bounce to auth or 4xx; the
  `strip-auth-headers` middleware must scrub inbound identity headers
  before the backend can trust them. Verified on both `*-secure` and
  `*-bypass` routers (defense-in-depth on bypass routers added in
  `foss-server-bundle#30`).
- **Bypass discipline** — static assets (`/favicon.ico`, `/robots.txt`)
  reachable without auth; the catch-all `/` still gated. Catches both
  over-protection of public assets and under-protection of the secure
  catch-all (Electric `/v1/shape` exfiltration pattern).
- **AUTH_TYPE=SSO gate** — local login / register / forgot-password
  UI must be hidden in SSO mode. Every app's known local-auth routes
  (Plane `/sign-in`, Outline `/auth/email`, Penpot `/#/auth/*`,
  SurfSense `/login`, Twenty `/sign-in`, etc.) must have no reachable
  `<input type="password">`.

## Test layout

```
tests/
├── auth/
│   ├── sso-login.spec.ts                  # cookie shape, persistence
│   ├── session-sharing.spec.ts            # cross-subdomain scope + expiry bounds
│   ├── session-lifecycle.spec.ts          # logout, replay, cookie deletion
│   ├── email-domain-consistency.spec.ts   # DEFAULT_EMAIL_DOMAIN parity check
│   ├── identity-consistency.spec.ts       # every backend resolves the same email
│   └── workspace-auto-join-independence.spec.ts # app-local workspace state isolation
├── apps/
│   ├── outline.spec.ts                    # branding + link coverage
│   ├── penpot.spec.ts                     # branding + hash-route nav coverage
│   ├── outline-admin.spec.ts              # /settings/* SSO-gating + non-admin role split
│   ├── pm.spec.ts                         # link coverage
│   ├── pm-godmode.spec.ts                 # admin escape-hatch invariants
│   ├── surfsense.spec.ts                  # link coverage
│   ├── twenty.spec.ts                     # link coverage (SPA, route-mutating nav)
│   └── twenty-admin.spec.ts               # /settings/admin-panel URL gate
├── flows/
│   └── login-logout-flow.spec.ts          # full e2e journey
├── security/
│   ├── headers.spec.ts                    # canonical headers on *-secure, *-bypass,
│   │                                      # oauth2-proxy-secure, oauth2-apps
│   ├── http-no-plaintext.spec.ts          # no 2xx over plain HTTP on any host
│   ├── header-spoofing.spec.ts            # X-Auth-Request-* spoof must be rejected
│   ├── strip-on-bypass.spec.ts            # strip-auth-headers chained on bypass routers
│   ├── bypass-surface.spec.ts             # static assets bypass, catch-all gated
│   └── sso-mode-no-local-login.spec.ts    # no password input on local-auth routes
└── lib/
    └── link-coverage.ts                   # registerLinkCoverage() factory
```

`constants.ts` — single source of truth, derives every host from
`FOSS_BASE_URL`.
`skills.md` — local invariant contract (what every app must satisfy).
[vendored openspec](./vendor/openspec/) — canonical edge-layer +
per-app rules organised by capability spec; the `tests/security/` and
`identity-consistency` tests verify these on the live deployment.

## Auth architecture

Login is performed once per worker via the configured IDP (Cognito or
mPass). The resulting cookies + storage are shared across tests in the
same worker — no repeated logins.

Session lifecycle and god-mode tests are exempt: they spawn fresh
contexts and manage their own login/logout so global state changes
don't contaminate the shared session.

## Pointing at production

```bash
# .env
FOSS_BASE_URL=https://foss.example.com
FOSS_USER=prod-user@example.com
FOSS_PASS=prod-password
# only if prod uses a different mPass IDP host:
# FOSS_MPASS_DOMAIN=moneta-auth.pressingly.net
```

App URLs, ForwardAuth host, and cookie domain all auto-derive from
`FOSS_BASE_URL`.

## CI (GitHub Actions)

Two workflows. Each runs the full chromium suite and uploads the HTML
report as an artifact every run; failure traces and videos as a second
artifact only on failure.

| Workflow | File | Triggers | Secrets prefix |
|----------|------|----------|----------------|
| `E2E — Sandbox`    | `.github/workflows/e2e-sandbox.yml` | every 12h (`00:00` + `12:00` UTC), push to `main`, PR, manual | `SANDBOX_*` |
| `E2E — Production` | `.github/workflows/e2e-prod.yml`    | manual only — gated on `production` Environment | `PROD_*` |

> **Note**: scheduled (cron) runs only fire from the default branch, so
> the 12-hour cadence starts after this branch lands on `main`.

### Sandbox setup (one-time)

**Repo → Settings → Secrets and variables → Actions → Secrets**:

| Name | Required | Purpose |
|------|----------|---------|
| `SANDBOX_FOSS_USER` | ✅ | SSO username (User A — pre-promoted admin per sso-rules/admin.md) |
| `SANDBOX_FOSS_PASS` | ✅ | SSO password |
| `SANDBOX_NORMAL_USER` | optional | User B SSO username — enables non-admin role-split tests |
| `SANDBOX_NORMAL_PASS` | optional | same |
| `SANDBOX_PLANE_ADMIN_USER` | optional | enables god-mode admin tests (local Plane creds, not SSO) |
| `SANDBOX_PLANE_ADMIN_PASS` | optional | same |
| `SLACK_WEBHOOK_URL` | optional | enables Slack failure notifications (with the list of failed tests) |

**Variables tab** (optional):

| Name | Purpose |
|------|---------|
| `SANDBOX_FOSS_BASE_URL` | override sandbox URL (default `https://foss.arbisoft.com`) |

### Production setup (one-time)

**Repo → Settings → Environments → New environment → `production`**:

1. Enable **Required reviewers** so prod runs pause for human approval.
2. Add the secrets below as **Environment secrets** (not repo secrets —
   Environment secrets only release when an approver clicks):

| Name | Required | Purpose |
|------|----------|---------|
| `PROD_FOSS_USER` | ✅ | SSO username (User A — pre-promoted admin) |
| `PROD_FOSS_PASS` | ✅ | SSO password |
| `PROD_NORMAL_USER` | optional | User B SSO username — enables non-admin role-split tests |
| `PROD_NORMAL_PASS` | optional | same |
| `PROD_PLANE_ADMIN_USER` | optional | god-mode admin user (local Plane creds, not SSO) |
| `PROD_PLANE_ADMIN_PASS` | optional | god-mode admin pass |

**Variables (repo or environment)**:

| Name | Required | Purpose |
|------|----------|---------|
| `PROD_FOSS_BASE_URL` | ✅ | prod main portal URL |
| `PROD_FOSS_MPASS_DOMAIN` | optional | prod mPass host if non-sandbox |
| `PROD_FOSS_COGNITO_DOMAIN` | optional | prod Cognito host if non-default |

### Running on GitHub

- **Sandbox**: runs automatically (cron / push / PR), or *Actions →
  E2E — Sandbox → Run workflow* to trigger ad-hoc.
- **Production**: *Actions → E2E — Production → Run workflow*. Optional
  `base_url` input overrides `PROD_FOSS_BASE_URL` for that single run.
  Pauses for reviewer approval if the `production` environment requires
  it.
- Daily prod smoke: uncomment the `schedule:` block in
  `.github/workflows/e2e-prod.yml`.

### Slack notifications

The sandbox workflow posts a **failure-only** plain-text report to
Slack — listing each failed test by file + title — when any run (12h
cron, push, PR, manual) fails. Successful runs stay quiet.

Sample message:

```
E2E Sandbox failed — 2 test(s)
Branch: main @ a1b2c3d
https://github.com/your-org/your-repo/actions/runs/123456789

tests/auth/session-sharing.spec.ts: auth/session cookies on every app...
tests/apps/outline.spec.ts: clicking each visible link navigates within host
```

To enable:

1. Slack workspace → **Apps → Incoming Webhooks → New webhook** for the
   target channel; copy the URL.
2. Repo Settings → Secrets and variables → Actions → Secrets → add
   `SLACK_WEBHOOK_URL` with the webhook URL.

The notification step no-ops with a log message if the secret is unset,
so existing setups don't break.

### Slack command trigger (run tests from Slack)

This repo now supports a Slack-driven run workflow:

- Workflow: `.github/workflows/e2e-slack-command.yml`
- Trigger: `workflow_dispatch` (manual or API)
- Input command format: `e2e <target>`

Supported targets:

- `all`
- `outline`, `penpot`, `surfsense`, `twenty`, `pm` (or `plane`)

Examples:

- `e2e all`
- `e2e outline`
- `e2e penpot`
- `e2e surfsense`
- `e2e twenty`
- `e2e pm`
- `e2e plane`

#### How to wire Slack

Your existing `SLACK_WEBHOOK_URL` can still post results. For triggering,
configure Slack to call GitHub's workflow-dispatch API.

Workflow-dispatch request shape:

```json
{
  "ref": "main",
  "inputs": {
    "command": "e2e penpot",
    "slack_user_id": "U123456",
    "slack_channel_id": "C123456"
  }
}
```

API endpoint:

- `POST /repos/<owner>/<repo>/actions/workflows/e2e-slack-command.yml/dispatches`

Required auth:

- GitHub token with permission to dispatch workflows for the repo.

Optional guardrails (repo variables):

- `SLACK_ALLOWED_USER_IDS` (comma-separated Slack user IDs)
- `SLACK_ALLOWED_CHANNEL_IDS` (comma-separated Slack channel IDs)

If allowlists are set, non-matching Slack users/channels are rejected.

### Local CI mode

```bash
CI=true npm test
```

CI mode: 2 workers, 1 retry, HTML report saved but not opened.
Screenshots, videos, and traces written to `test-results/` on failure.

## Session TTL note

`tests/auth/session-sharing.spec.ts` uses a deployment-configurable upper bound via
`FOSS_MAX_SESSION_TTL_SECONDS` (default: 92 days) so environments with intentional
multi-month cookie TTLs can be validated without hardcoding a 30-day ceiling.
