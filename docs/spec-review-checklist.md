# Spec & Test Shape Review Checklist

A human checklist for PRs that touch `vendor/openspec/specs/`,
`vendor/openspec/skills/`, or any `@spec`-tagged test under `tests/`.

## Why this exists

The automated gates (`scripts/check-spec-coverage.sh` +
`tests/meta/playwright-practices.spec.ts`) enforce **presence** in both
directions: every requirement has a tag pointing at it, every
contract-bearing test has a tag pointing at a requirement. That's
load-bearing — without it the suite drifts.

What the gates **cannot** enforce is **shape correctness**: whether the
test's assertion actually fails when the contract is broken. Four
distinct shape failures have shipped through the gate in this repo:

| File | Shape bug |
|---|---|
| `tests/auth/workspace-auto-join-independence.spec.ts` (before reframe) | Asserted "no UUID collision across 4 independent DBs" — structurally impossible to fail. Test passed for the wrong reason. |
| `tests/security/jwt-algorithm-confusion.spec.ts` (before fix) | `expect(status).toBeGreaterThanOrEqual(200)` — every HTTP status is ≥ 200. Tautology. |
| `tests/flows/login-logout-flow.spec.ts` (before fix) | `@spec` tag pointed at `per-app-logout-shall-be-navigation-only`, but the file's tests are about Logout-All + `/oauth2/sign_out`. Wrong contract claimed as covered. |
| `tests/security/cookie-bomb-dos.spec.ts` (a CoPilot autofix iteration) | Required HTTP 4xx specifically, but the bundle's fail-closed shape is 302-to-IDP. The assertion was tighter than the contract — 6/7 entry points failed CI while behaving correctly. |

Each of these passed the automated gate. None would have shipped if
the human author had walked the checklist below.

## When to use this checklist

- Adding or editing a `### Requirement:` block in
  `vendor/openspec/specs/` or `vendor/openspec/skills/`.
- Adding a new spec file with an `@spec` tag.
- Adding or changing an assertion in a spec file that already carries
  an `@spec` tag.
- Reviewing such a PR (reviewer should walk the checklist out loud in
  the PR comments — silent approval is how shape bugs slip through).

Not needed for: typo fixes, comment-only changes, test name renames
that don't change behaviour, `tests/bugs/` / `tests/zap/` /
`tests/meta/` (out of contract scope by directory rule).

## The checklist

### Part A — for each requirement added or edited

```
- [ ] Strong-verb headline. The headline uses SHALL (or MUST) and
      describes a property the system has, not a feature it ships.
      Anti-pattern: "the system should handle expired sessions
      gracefully."

- [ ] Observable from outside the system. Someone with no source
      access could check whether the requirement holds right now,
      from the outputs of the system alone (HTTP responses, cookies
      set, page rendered, header values, etc.). If you'd need DB
      introspection or log inspection, either narrow the observable
      or document the deferral.

- [ ] No implementation coupling. The requirement does not name a
      specific function, file, class, or library version. Behaviour
      survives a refactor; implementation does not. (Bad: "MUST be
      invoked from inside `_resolve_user`." Better: "MUST be
      invoked on every authenticated request that resolves a user.")

- [ ] At least one Gherkin Scenario. GIVEN/WHEN/THEN is mandatory
      under the requirement, even for skill files. The scenario is
      the test author's blueprint — if you can't write the scenario,
      the requirement is too vague.

- [ ] Failure mode is named. The scenario's THEN clauses describe
      the OBSERVABLE that breaks when the contract breaks. Not "the
      system handles it correctly" but "the URL does not bounce to
      the IDP host" or "no INSERT is issued against table X".
```

### Part B — for each test added or with a new/changed assertion

```
- [ ] @spec tag points at a requirement this test actually
      exercises. Open the spec file. Read the requirement. Read
      your test. Does the test's WHEN map to the requirement's WHEN?
      Does its THEN cover at least one of the requirement's THENs?
      If not, the tag is wrong.

- [ ] Counterfactual exists. State out loud: "if the contract were
      violated, the assertion would observe X." If you can't fill
      in X, the assertion is decorative.

- [ ] Assertion can fail. Not "the file loads" or "no exception
      thrown" or "status >= 200" — those are tautologies. A real
      assertion has at least one input (real or imagined) that
      makes it return red.

- [ ] Range assertions enumerate the acceptable set. If you assert
      `status < 500` (or `>= 400` or any inequality), the comment
      above the assertion lists which OTHER status values are
      ALSO acceptable and why. Tightening a range is one of the
      easiest ways to make a test fail on correct behaviour (see
      the cookie-bomb case above).

- [ ] Per-app generalisation handled. If the contract applies to
      every app, the test is parameterised over APPS (or pinned to
      one canonical app with a documented reason, e.g. "Plane is
      the canonical surface because it has the cleanest REST API
      for membership"). One-off Outline-specific tests with a
      universal-shaped requirement are a smell.

- [ ] Precondition is not the contract. If the contract is "X
      happens when Y," then arranging Y in the test must NOT also
      arrange X. Otherwise the test passes regardless of whether
      the contract holds. (Bad: "set the cookie, then assert the
      cookie is set." Good: "delete the cookie, perform an action
      the contract says should re-create it, then assert it's
      back.")
```

## Worked examples

The four shape bugs from the table at the top, walked through the
checklist as the author/reviewer would have. Each one is something
the checklist would have caught.

### 1. workspace-auto-join-independence — vacuous assertion

**Before reframe:** "no two apps report the same workspace
identifier (4 UUIDs probed)."

Checklist Part B failures:

- **Counterfactual exists**: "If the contract were violated, the
  assertion would observe X." But what would X be? Four independent
  DBs generating random UUIDs cannot produce a collision regardless
  of whether the contract holds. **X is empty.** Decorative test.
- **Assertion can fail**: There is no realistic input that makes
  this assertion return red. Tautology, just slower.

The fix was to reshape to a positive correlation: each app's
primary workspace ID must equal the bundle-configured value in
`constants.ts`. A regression where app A's storage gets pointed at
app B's workspace store would produce a mismatch the assertion
catches.

### 2. jwt-algorithm-confusion — `toBeGreaterThanOrEqual(200)`

```ts
expect(status).toBeGreaterThanOrEqual(200);  // every status is ≥ 200
```

Checklist Part B failures:

- **Counterfactual exists**: Name a status the JWT validator could
  return that would fail this assertion. None exists. Tautology.
- **Assertion can fail**: No.

Fix: `expect(status < 200 || status >= 300).toBe(true)` — rejects
any 2xx (real "token accepted" surface).

### 3. login-logout-flow — wrong `@spec` tag

The file's three tests:
1. "login once, every app loads authed"
2. "portal Logout-All kills SSO"
3. "/oauth2/sign_out clears cookie"

The tag claimed `logout-flow#per-app-logout-shall-be-navigation-only`.

Checklist Part B failures:

- **@spec tag points at a requirement this test actually exercises**:
  No. The per-app navigation-only contract is about in-app Logout
  buttons being navigation-only (covered by `logout-invariants.spec.ts`
  sub-test 3). None of the three tests in `login-logout-flow.spec.ts`
  click an in-app Logout button.

A 30-second tag-vs-test re-read at PR time catches this.

Fix: re-tag to the two requirements the file's tests actually pin
(`portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie` and
`stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly`).

### 4. cookie-bomb-dos — over-tight `>= 400` requirement

```ts
expect(status).toBeGreaterThanOrEqual(400);
expect(status).toBeLessThan(500);
```

The file's contract (in the comment block above): "the chain must
fail closed without a parser crash." That's 5xx-forbidden — the
fail-closed shape says nothing about WHICH non-5xx response is
acceptable.

Checklist Part B failures:

- **Range assertions enumerate the acceptable set**: The `>= 400`
  half says "no 2xx, no 3xx allowed." But the contract is
  fail-closed, and a 302 redirect to the IDP for an unauthenticated
  visit IS fail-closed for SSO. The acceptable set is broader than
  the assertion permits. CI failed on correct bundle behaviour.

Fix: keep `expect(status).toBeLessThan(500)` only. Expand the
inline comment to enumerate the four acceptable response shapes
(4xx, 3xx-to-IDP, 2xx-when-next-to-valid-cookie, connection-close).

## Smell tests

If you're in a hurry, three quick questions catch most shape bugs:

1. **"Could this assertion be true even if the contract were violated?"**
   If yes, the shape is wrong.

2. **"What status / value / shape would make this assertion fail?"**
   If you can't name one, the assertion is decorative.

3. **"Does the test's first line of action set up the same state the
   contract says should be produced?"**
   If yes, you've baked the contract into the precondition. Rewrite
   so the precondition NEGATES the contract's outcome, then the
   trigger restores it.

If any answer is bad, the shape isn't right yet. Write the
checklist's full Part B for that test before merging.

## How this integrates with the rest

- **The audit (`make audit`) keeps running every PR.** It still
  enforces presence — the load-bearing baseline. This checklist is
  the layer above: shape, not presence.
- **No tooling change.** This is a human discipline document. The
  enforcement is "reviewer must walk the checklist in the PR
  comments before approving any PR that touches specs or
  `@spec`-tagged tests."
- **CLAUDE.md links here.** Any Claude session editing specs or
  spec-tagged tests should consult this file as part of the work.
- **When a shape bug ships and gets caught after merge** (it will
  happen — humans are fallible), add a new row to the worked-examples
  section above. The examples are the curriculum.
