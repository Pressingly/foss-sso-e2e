# Test-suite review — 2026-05-22

Scope: `tests/` (excluding `tests/bugs/`) — **44 files reviewed**, **306 expanded tests** (83 `test()` declarations × parameterization).

## Bottom line

The suite is in **good shape**. One Important finding worth fixing in a hygiene PR; no Critical findings. The 306-test count is justified — it expands from 83 distinct `test()` declarations, each parameterized for per-app + per-payload precision. Removing the multipliers would lose the "which exact attack vector / which exact app" failure-localisation signal.

## Critical

(none)

## Important

- **`tests/auth/proxy-short-circuit.spec.ts:34`** — hardcoded `_oauth2_proxy` literal
  - **Why:** Convention (Mechanical check 2 from this skill): import `AUTH_COOKIE` from `constants.ts` rather than hardcoding the cookie name. The only files allowed to use the literal are `cookie-tampering` and `session-fixation` (which assert tampering signals).
  - **Fix:** Replace `const SSO_COOKIE_NAMES = new Set(["_oauth2_proxy"]);` with `const SSO_COOKIE_NAMES = new Set([AUTH_COOKIE]);` and add `AUTH_COOKIE` to the existing `constants.ts` import.

## Nit

(none)

## Findings discarded (false positives worth recording so future runs skip them)

- **S2 (login choreography duplication):** 5 grep hits, all legitimate.
  - `tests/security/sso-mode-no-local-login.spec.ts` looks for password inputs to assert they DON'T exist (the test's whole point).
  - `tests/auth/session-lifecycle.spec.ts` checks if a password input is visible (re-auth detection signal).
  - `tests/apps/pm-godmode.spec.ts` uses local creds at `/god-mode/` — explicitly NOT SSO, per CLAUDE.md.
- **S4 (sleep / `delay()` / `node:timers/promises`):** all 30+ hits are `test.setTimeout(...)` or `raw.setTimeout(...)` — Playwright's per-test timeout setter, not a sleep call. Grep pattern needs to be narrower (`page.waitForTimeout` is the actual ban, already covered by Mechanical check 3).
- **S6 (cookie surgery):** all hits are in tests where cookie state IS the system-under-test:
  - `cookie-tampering.spec.ts` + `session-fixation.spec.ts` — explicitly listed as allowed in CLAUDE.md.
  - `layer2-re-establish.spec.ts` — tests session re-establishment when Layer 1 cookies/storage are cleared. The cookie surgery is the setup, not a shortcut around the contract.
  - `session-lifecycle.spec.ts` — tests session lifecycle by clearing/restoring `AUTH_COOKIE`. Same reasoning.
- **S3 (bare `toBe(true|false)`):** 27 files flagged by raw count, but all sampled cases use the `expect(value, "descriptive message").toBe(...)` form — the message arg is on the line above. The skill's grep matches the closing parens only and gives a noisy signal. Skip this check on future runs, or rewrite the grep to detect missing-message-arg directly (e.g. AST-based, since `expect(X).toBe(Y)` vs `expect(X, "msg").toBe(Y)` is hard to distinguish with regex).

## On the "do we have too many tests?" question

| Concern | Reality |
|---|---|
| Raw count | 306 tests across 44 files |
| Source count | 83 `test()` declarations |
| Expansion ratio | 3.7× average, driven by **per-app loops** (×5) and **per-payload loops** (×4 for redirects, ×5 for OIDC state values) |

### Highest-multiplier files

| File | Tests | Pattern |
|---|---|---|
| `apps/outline-admin.spec.ts` | 39 | 13 Outline settings paths × 3 contracts (cold-bounce / non-admin role / admin role) |
| `security/headers.spec.ts` | 27 | Targets × `HEADER_RULES` + the new HTML-hardening block |
| `security/oidc-state-integrity.spec.ts` | 25 | 5 apps × 5 invalid-state payloads |
| `security/bypass-surface.spec.ts` | 21 | Bypass paths × apps × statuses |
| `security/open-redirect.spec.ts` | 20 | 5 apps × 4 evasion payloads |
| `security/open-redirect-crlf.spec.ts` | 20 | 5 apps × 4 CRLF payloads |
| `security/http-method-tampering.spec.ts` | 20 | 5 apps × 4 methods |

Each line in this table is "one test per attack vector × per app." Collapsing them (e.g. one test that loops internally and aggregates failures) would hide which specific app/payload combination failed — the most useful signal during a security regression.

### Specs to leave alone (high count is justified)

All of them.

### Specs to consider trimming (none currently)

- A reasonable rule-of-thumb threshold is `tests-per-file > 40` for non-security specs. The only file approaching that is `outline-admin.spec.ts` at 39, but its three contracts × 13 paths shape is intentional and reviewed (see the file's leading comment about Outline's chunk-loader 429 flake handling).

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| Important | 1 |
| Nit | 0 |

**Action items:**

1. Open a hygiene PR for the single Important finding (`proxy-short-circuit.spec.ts:34` — use `AUTH_COOKIE` import).

That's it. No further action needed; the suite size and shape are correct.

## Cross-references

- `CLAUDE.md` — suite conventions (the rulebook this review measured against)
- `skills.md` §1 / §2 — invariant-based test organisation
- `scripts/check-spec-coverage.sh` — separate audit for `@spec` coverage (last run: 27 ✅ / 25 ⚠️ / 0 ❌ / 52 total)
- `.claude/skills/test-reviewer/SKILL.md` — the skill that produced this report
