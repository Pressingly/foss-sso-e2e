# Logout-All Contract Evolution

**Status:** Analysis / pre-decision

**Context:** Two foss-server-bundle PRs propose changes to the global
"Logout all apps" behavior. The current vendored openspec contract
explicitly says per-app cookies survive logout (lazy reap on next
request). Both PRs invert that contract. This doc lays out what the
new contract should look like, compares the two PRs against it, and
recommends a path.

This is a **non-binding analysis** — it doesn't change `vendor/openspec/`
or any tests. When the chosen PR ships and the upstream openspec
(`awais786/sso-rules-moneta`) updates, we vendor the result and
rewrite the affected tests.

---

## Current contract (today, vendored)

From `vendor/openspec/specs/logout-flow/spec.md`:

| Slug | Statement |
|---|---|
| `portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie` | Portal Logout-All clears ONLY `_oauth2_proxy`. Per-app session cookies survive. |
| `stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly` | ForwardAuth handles cleanup lazily on next app request. |
| `per-app-logout-shall-be-navigation-only` | In-app Logout buttons just navigate to portal. No session clearing. |
| `logout-shall-be-observable-and-idempotent` | All logout layers are idempotent. |
| `cognito-sso-teardown-is-operator-callable-but-not-surfaced-as-a-user-action` | Cognito `/logout` is operator-only. |
| `cognito-allowlist-shall-include-the-portal-main-page` | Cognito sign-out URL list contains portal. |
| `per-app-logout-shall-not-be-relied-on-for-security` | UI copy directs users to portal Logout-All for real security. |

**The load-bearing decision** the current contract makes: "lazy reaping
is fine because ForwardAuth gates every request." The new contract
flips this: "lazy reaping leaves a same-browser session-bleed window;
eagerly clear all app cookies during Logout-All."

---

## Proposed new contract (chain-logout)

Three requirements change. Two new ones added.

### Inverted

| Slug | Old | New |
|---|---|---|
| `portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie` | Per-app cookies survive | **Per-app cookies MUST be cleared via chain** |
| `stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly` | Lazy reap | **Removed — eager clear is now the contract** |

### Unchanged

| Slug | Notes |
|---|---|
| `per-app-logout-shall-be-navigation-only` | Still applies — the in-app Logout button is separate from the new `/portal-logout` endpoint. The button stays nav-only; the endpoint is portal-call-only. |
| `logout-shall-be-observable-and-idempotent` | The chain MUST be idempotent at every step. |
| `cognito-sso-teardown-is-operator-callable-but-not-surfaced-as-a-user-action` | The chain ENDS at oauth2/cognito teardown — still operator-style at the IdP layer. |
| `cognito-allowlist-shall-include-the-portal-main-page` | Unchanged. |
| `per-app-logout-shall-not-be-relied-on-for-security` | The in-app button is still UX-only. |

### New requirements

```markdown
### Requirement: portal Logout-All SHALL chain through every app's session-clear endpoint

When the portal's Logout-All button is clicked, the browser MUST visit
every protected app's `/portal-logout` (or app-equivalent) endpoint
once, in sequence, before completing the SSO 3-layer chain. Each visit
serves to clear that app's own session cookies via `Set-Cookie:
<name>=; Max-Age=0` from the app's own origin — cross-origin
`Set-Cookie` from the portal is impossible, so the chain is
architecturally necessary.

The chain order is deterministic and ends at the SSO 3-layer
(oauth2-proxy → Cognito → portal).
```

```markdown
### Requirement: each app SHALL expose a portal-logout endpoint that honours ?next=

Every protected app MUST expose an endpoint (default
`/portal-logout`) that:

- Sets every app-owned session cookie to `Max-Age=0` via response
  `Set-Cookie` headers
- Reads a `?next=<url>` query parameter and validates the target
  against an allowlist of platform hosts (regex match against the
  `${PLATFORM_DOMAIN}` family) — open-redirect to an off-platform
  host MUST be refused
- Returns `302 Location: <next>` on success; the chain proceeds to
  the next app

For SurfSense (which holds a JWT in `localStorage`), the endpoint MAY
return a small HTML page that runs `localStorage.removeItem(...)`
before `window.location.href = <next>` — server-side cookie clear
alone is not sufficient.
```

```markdown
### Requirement: portal-logout endpoint SHALL refuse off-platform redirects

The `?next=` value MUST be matched against a server-side allowlist
(e.g., `^https://([a-z]+\.)?${PLATFORM_DOMAIN}/`). Non-matching
values MUST be replaced with the portal URL or refused with a 400.

This is the classic open-redirect surface — without the allowlist,
an attacker could craft a Logout-All link that ends on a
phishing host.
```

```markdown
### Requirement: post-logout app re-entry SHALL require fresh Cognito authentication

After a successful Logout-All, opening any app subdomain in the same
browser session MUST bounce through the IDP / Cognito login. No
silent SSO from stale state.

This is the load-bearing security claim — it prevents
same-browser session-bleed. Combined with the per-app cookie clear,
no residual state can re-hydrate the previous user's session.
```

```markdown
### Requirement: re-login after Logout-All SHALL start clean

When user B logs into the same browser after user A's Logout-All:

- User B's session in each app MUST be tied to user B's identity
  (no inherited cookies / tokens / localStorage from user A)
- API calls as user B MUST NOT return user A's data
- This SHALL hold even if user A's app-side session TTL has not
  yet expired server-side (the cookie that referenced it is gone)
```

---

## PR comparison

| Concern | foss-server-bundle PR #81 (DB purge + iframe) | foss-server-bundle-devstack PR #53 (chain redirect) |
|---|---|---|
| **Mechanism** | New `/mpass/purge-sessions` endpoint + new `foss-session-clear` static service + iframe fan-out + DB writes to 4 apps' Postgres/Redis | Portal builds a nested `?next=` URL; browser does 302 chain through each app's `/portal-logout` endpoint |
| **Bundle owns app DB schemas?** | Yes — Plane `django_session`, Penpot Redis DB 5, SurfSense + Twenty `refresh_tokens` | **No** |
| **Schema-drift maintenance** | Permanent — every app upgrade needs schema-compat verification | **None** |
| **Silent failure modes** | DELETE matches 0 rows = no error, returns 204, stale sessions survive | **None** — failed 302 is visible in the browser bar |
| **localStorage cleared (SurfSense)?** | Yes (via iframe JS) | Yes (via the endpoint returning JS-bearing HTML) |
| **Cookies cleared?** | Yes (iframe Set-Cookie via app endpoint) | Yes (302's response Set-Cookie from app origin) |
| **Server-side refresh tokens revoked?** | Yes (DB DELETE) | No — but the SSO chain at the end of the redirect chain invalidates the token-issuance path |
| **New fork patches required** | 0 (existing app endpoints + bundle DB access) | 4 (one `/portal-logout` per app: Outline, Penpot, SurfSense, Twenty — Plane reuses existing `/auth/sign-out/`) |
| **End-to-end time** | ~1-2s (parallel iframes with 3s cap) | ~3-5s (sequential 302s) |
| **Timing-sensitivity** | 3s iframe cap can race a slow app — silent token-bleed if any iframe times out | None — 302 either completes or the chain visibly breaks |
| **URL bar UX** | Clean (iframes hidden) | Each step is briefly visible — auditable, possibly ugly |
| **Lines of bundle code** | ~300+ (new service + new endpoint + iframe orchestration) | ~30 in landing/index.html.example |
| **Coverage of new spec requirements** | See table below | See table below |

### Per-requirement coverage

| New requirement | PR #81 | devstack #53 |
|---|---|---|
| Chain through every app's session-clear endpoint | ❌ (parallel iframes, not chain) | ✅ |
| Each app exposes `/portal-logout` honouring `?next=` | ❌ (uses existing endpoints + bundle DB) | ✅ (requires fork patches) |
| Endpoint validates `?next=` against platform allowlist | ❌ (no endpoint in plan) | ⚠️ (must be added per fork — not in current #53) |
| Post-logout app re-entry requires fresh Cognito | ✅ | ✅ |
| Re-login starts clean (no session bleed) | ✅ (eager DB delete) | ✅ (per-app cookie clear from each origin) |

---

## Recommendation

**Adopt the chain-redirect approach (devstack PR #53) over the DB-purge approach (PR #81).**

Reasoning:

1. **Same security property, less surface area.** Both prevent same-browser session-bleed. #53 does so without owning app DB schemas.
2. **Failure modes are observable.** #53's 302 either completes or breaks visibly. #81's DB writes can silently DELETE 0 rows.
3. **One-time cost vs. ongoing burden.** #53's fork patches are 4 small one-time PRs (~30 lines each). #81's schema-coupling is permanent and grows with every app upgrade.
4. **Smaller bundle code.** ~30 lines vs ~300+.

### One thing #53 needs before it ships

The `?next=` parameter is currently NOT validated in the planned `/portal-logout` endpoints. The 4 fork patches MUST include an allowlist check against `^https://([a-z]+\.)?${PLATFORM_DOMAIN}/` (or equivalent). Without it, the chain is an open-redirect vector.

### What about server-side refresh tokens?

PR #81 explicitly purges these from app DBs. PR #53 does not. The argument for not needing it:

- Refresh tokens in app DBs are USELESS without the matching client-side state (cookie / Authorization header)
- Client-side state is gone after the chain
- For a refresh token to be usable, an attacker would need to exfiltrate it from the database — out of scope of "same-browser session-bleed"

If exfiltration is a concern: add Cognito `GlobalSignOut` as a one-line API call from `mpass-auth-proxy` — revokes refresh tokens at the IDP, no schema coupling.

---

## Suite changes when devstack #53 merges + forks ship

1. **Update vendor openspec** (after `awais786/sso-rules-moneta` is updated):
   - Remove `portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie`
   - Remove `stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly`
   - Add the 5 new requirements listed above

2. **Update existing tests:**
   - `tests/auth/logout-invariants.spec.ts` — invert the "cookies survive" assertion to "cookies cleared"
   - Move `@spec` tags to the new slugs

3. **Add new tests:**
   - `tests/auth/logout-chain.spec.ts` (new file):
     - "portal Logout-All visits every app's /portal-logout in sequence"
     - "after chain, every app session cookie is absent"
     - "/portal-logout refuses off-platform ?next= targets"
     - "post-logout app re-entry bounces through Cognito (no silent SSO)"
     - "re-login as a different user shows no inherited cookies/data" (the load-bearing security test)

4. **No bundle test required** for `/mpass/purge-sessions` (it doesn't exist in #53).

---

## Action items

- [ ] Comment on bundle PR #81 with this comparison; recommend closure in favour of #53
- [ ] Comment on devstack PR #53 with the `?next=` allowlist requirement
- [ ] File tracking issue here for the suite-side changes (gated on #53 + forks shipping)
- [ ] When the chain ships: re-vendor openspec + rewrite tests per "Suite changes" above

---

## What this doc is and is not

- ✅ A pre-decision analysis to align on architecture
- ✅ A reference for what the new spec text would look like
- ✅ A comparison the dev team can use to choose between approaches
- ❌ NOT a change to `vendor/openspec/specs/logout-flow/spec.md` (that file is unchanged)
- ❌ NOT a change to any test (the audit still passes — 84 covered, 0 missing)

If the team picks an approach the upstream openspec maintainer commits to, this doc gets superseded by the vendored spec update + the suite changes listed above.
