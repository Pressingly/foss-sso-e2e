# CI Triage Runbook

CI is red. This is the 2-minute path to "what is this and what do I do."

For deeper conventions, see [`CLAUDE.md`](./CLAUDE.md). For the contract
under test, see [`vendor/openspec/specs/`](./vendor/openspec/specs/).

---

## Step 1 — Start with the smoke

**Look at `tests/auth/per-app-login-smoke.spec.ts` first.** It runs one
test per app (Outline, PM, Penpot, SurfSense, Twenty). If any are red,
the SSO chain isn't reaching that app's backend — almost always a
**deployment-layer issue**, not a test bug.

The smoke is the *single named signal* for each app. Many other tests
that iterate every app (cross-app probes, link-coverage, per-app
logout) **skip themselves** with a reason that points back at the
smoke. So you should see something like:

```
✘ per-app-login-smoke[SurfSense]
- email-domain-consistency           skipped: blocked by per-app login smoke — broken app(s): SurfSense (...)
- identity-consistency               skipped: ...
```

Don't triage the skipped tests. They're not the problem. Fix the smoke.

---

## Step 2 — Map the failure to a cause

| Failure pattern | Cause | What to do |
|---|---|---|
| `per-app-login-smoke[Twenty]` returned 500 "SSO workspace not provisioned" | Twenty's `core."workspaceSSOIdentityProvider"` table has no row for the workspace | File / chase a bundle issue (`foss-server-bundle/scripts/provision-admin/twenty.py`). Suite is not at fault. |
| `per-app-login-smoke[SurfSense]` returned 401 "Not authenticated" | SurfSense's alembic migrations didn't run on container start | `docker exec surfsense-backend alembic upgrade head` — and file the auto-run bug. |
| `per-app-login-smoke[<app>]` returns 2xx but no usable email | App middleware authed the request but didn't synthesise the email — likely `DEFAULT_EMAIL_DOMAIN` misconfig | Check the app container's env. See `vendor/openspec/skills/app-rules/RULES.md` for the canonical pattern. |
| `outline-admin.spec.ts /settings/<X>` failed once, passed on retry | Outline's chunk-loader 429 burst flake | Known flake. Documented in `CLAUDE.md` → Deployment gotchas → Outline. Not actionable. |
| `concurrent-first-login.spec.ts Outline: 3 parallel first-time visits resolve to ONE identity` | The race-condition test occasionally needs FOSS_USER to be a *fresh* user; if they're already provisioned in Outline, the test can flake | Re-run; if it stays red across re-runs, it's a real regression. |
| `security/headers.spec.ts` portal CSP / COOP / CORP / Server | Bundle-side; portal nginx config | Waiting on `foss-server-bundle#66`. Suite-side fix already in (`tests/security/headers.spec.ts` scoped to portal only). |
| `tests/meta/playwright-practices.spec.ts` failed | Convention violation in a spec file | Read the failure — it names the file, line, and rule. Fix the spec, not the meta. |
| `spec-coverage` check failed with `❌ Missing` rows | New openspec requirement landed in `vendor/openspec/specs/` but no test pins it | Either add a `// @spec module#slug` tag above the test that covers it, or add it to `docs/spec-coverage-deferred.md` with a category + rationale. |
| `spec-coverage` check failed with `FATAL: could not enumerate requirements` | Vendor is missing or `SPEC_DIR` env points somewhere bad | Run `bash scripts/refresh-openspec.sh` locally (needs `SSO_RULES_SRC` pointing at a `sso-rules-moneta` checkout). Commit the diff. |
| `cookie-tampering.spec.ts` failed | Real regression — the SSO cookie HMAC is no longer being validated, or the cookie attributes drifted | Treat as **high-priority**. This guards the bearer credential. Check oauth2-proxy config + Traefik bypass rules. |
| Multiple unrelated tests red with `ERR_INTERNET_DISCONNECTED` | Local/CI network blip mid-run, not a code bug | Re-run. If persistent, check the runner's network. |
| `chromium` workflow runs >15 min | Twenty's GraphQL websocket keeps a connection open; if a test forgot to close its `BrowserContext`, the worker hangs | Look for the last test that ran before the hang — that's the leaker. |

---

## Step 3 — Reading a Playwright failure

A failing test in CI has three useful lines:

1. **First line**: file, line number, test name
   ```
   ✘ 4 [chromium] › tests/apps/twenty-admin.spec.ts:171:6 › ... › admin reaches /settings/admin-panel with admin UI visible (43.5s)
   ```
2. **`Error: ...` line**: the actionable assertion message
   ```
   Error: Admin-panel signal missing. markers=0; api_status=none; landed=https://twenty.foss.arbisoft.com/auth/sso/proxy-login. ...
   ```
   Read this. Test authors in this repo put effort into making these
   messages name the cause, not just "Expected: true, Received: false".

3. **Body excerpt** (when present): the first 300–400 chars of the
   response/page body — usually contains the error JSON / 500 page text
   that names the bundle-side cause.

Skip everything else (screenshots, traces, attachment paths) unless
the assertion message isn't enough.

---

## Step 4 — When in doubt

- **Don't merge through red unless you've classified the failure.** PRs
  #19, #24, #25 all merged through `spec-coverage: FAILURE` — that was a
  known infra issue (CI token expired, fixed by vendoring in #27). If
  you're tempted to merge red, write down WHY in the PR description.
- **Per-app contract tests stay red on purpose.** `surfsense-admin`,
  `twenty-admin`, `pm-workspace-isolation`, etc. don't gate on the
  smoke — they're the loud signal that a specific app's contract is
  broken. Don't add the `appHealth` gate to them.
- **Flake quarantine: don't.** This suite documents known flakes in
  CLAUDE.md gotchas + here. Adding a `test.fixme` or `test.skip()` to
  quiet a flake is a hygiene regression — fix the flake or document it
  with a `@flaky` reason.

---

## Reference

- [`CLAUDE.md`](./CLAUDE.md) — conventions + per-app gotchas (the source of truth)
- [`docs/spec-coverage-deferred.md`](./docs/spec-coverage-deferred.md) — what's intentionally NOT covered + why
- [`docs/spec-coverage.md`](./docs/spec-coverage.md) — traceability matrix (spec ↔ test)
- [`vendor/openspec/specs/`](./vendor/openspec/specs/) — the SSO contract being tested
- [`vendor/openspec/skills/`](./vendor/openspec/skills/) — per-app admin contracts + devstack rules
- [`tests/auth/per-app-login-smoke.spec.ts`](./tests/auth/per-app-login-smoke.spec.ts) — the named signal for "is this app's SSO chain wired up"
- [`tests/lib/app-health-probes.ts`](./tests/lib/app-health-probes.ts) — probe map + `blockedAppsMessage()` helper used by gated cascade tests
- [`tests/meta/playwright-practices.spec.ts`](./tests/meta/playwright-practices.spec.ts) — the convention gate (line-pattern rules + structural checks)
