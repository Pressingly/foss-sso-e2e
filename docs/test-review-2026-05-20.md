# Test-suite review — 2026-05-20

Scope: 41 `.spec.ts` files under `tests/` (excluding `tests/bugs/`).
Mode: mechanical-only pass (`test-reviewer` skill's 7 grep checks).
Token cost: 0 LLM tokens — pure `grep`.

## Summary

| Severity | Count | Notes |
|---|---|---|
| ❌ Critical | **0** | No non-negotiable violations |
| ⚠️ Important | **0** | After scoping check 6 + applying the sso-login defensive wraps in this PR |
| 💡 Nit | **2** | One ambiguous literal, one defensive-wait class to revisit |

Suite is in very good shape. No tests need rewriting; only minor refinements.

## Findings

### 💡 Nit-1 — `tests/auth/proxy-short-circuit.spec.ts:34` — literal `_oauth2_proxy`

```ts
const SSO_COOKIE_NAMES = new Set(["_oauth2_proxy"]);
```

The test is *about* the proxy's cookie-name handling; the literal is
the system-under-test, not a host-config drift. Probably intentional.

**Suggested fix:** if leaving as-is, add the file to the skill's
"allowed exceptions" filter alongside `cookie-tampering.spec.ts` and
`session-fixation.spec.ts`, so future runs don't re-flag.

### 💡 Nit-2 — `networkidle` defensive waits in `tests/auth/`

Eight remaining occurrences, all already defensive (timeout +
`.catch(() => {})`):

- `tests/auth/email-domain-consistency.spec.ts:135`
- `tests/auth/concurrent-first-login.spec.ts:72`
- `tests/auth/logout-invariants.spec.ts:269`
- `tests/auth/session-sharing.spec.ts:56, 74` (`waitUntil: "networkidle"` on `goto`)
- `tests/auth/workspace-auto-join-independence.spec.ts:150`
- `tests/auth/session-lifecycle.spec.ts:101` (`waitUntil: "networkidle"` on `goto`)

All have either explicit timeouts (≤30s) or `.catch(() => {})`
guards, so they can't hang the test. They're not actively dangerous;
they're just guess-and-hope settle waits that a locator-state wait
(`await expect(<known authenticated element>).toBeVisible()`) would
replace more precisely.

**Suggested fix:** opportunistic — replace each with a locator-state
wait when the surrounding code is being modified for unrelated
reasons. No batch cleanup needed.

## What was fixed in this PR

1. **Skill `check 6` scoped to `tests/auth/`.** Previous version
   over-flagged 16 orthogonal-coverage files (per `skills.md` §2).
   The fix scopes the missing-`@spec` check to where the openspec
   contract actually lives — agreeing with `scripts/check-spec-coverage.sh`.
2. **`sso-login.spec.ts` bare `waitForLoadState("networkidle")` × 5**
   (lines 39, 78, 107, 111, 114) → each replaced with the suite's
   defensive pattern (`{ timeout: 15_000 }).catch(() => {})`).
   The previous form had **no timeout AND no catch**, making it the
   only place in `tests/auth/` where a never-settling session check
   could deadlock the test. Now matches the defensive pattern used
   elsewhere in the auth suite.

## What was confirmed clean

- ✅ No hardcoded `foss.arbisoft.com` outside `constants.ts`
- ✅ No hardcoded `_oauth2_proxy` outside the allowed list (only the
  one intentional Nit-1 above)
- ✅ No `waitForTimeout(` usage anywhere
- ✅ No POM-style `class FooPage {}` constructs
- ✅ No `testData.json` / `data/` imports
- ✅ All 11 `tests/auth/` files carry `@spec` tags pinning openspec
  requirements
- ✅ Twenty-specific `networkidle` usage is on auth-wall pages only
  (where it works), with inline comments explaining why

## Tooling notes

- The `scripts/check-spec-coverage.sh` audit (run with `SPEC_DIR=…`
  against `sso-rules-moneta@origin/main`) shows **26 ✅ / 25 ⚠️ /
  0 ❌ / 51 total**. `skills.md` line 22 reflects this.
- The `test-reviewer` skill's 6 semantic checks (auth-landed pattern,
  shared-helper usage, assertion-message quality, locator vs sleep
  waits, single-responsibility, cookie-mocking shortcuts) were not
  run in this pass. They would catch nuanced issues that grep misses,
  but cost ~30× more LLM tokens. Run them when there's reason to
  suspect specific drift in those dimensions.
