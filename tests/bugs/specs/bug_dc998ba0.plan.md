# FOSSSMBBUN-88 — concurrent multi-tab login (graceful failure)

## Status

**Fix shipped** in [Pressingly/foss-server-bundle#61](https://github.com/Pressingly/foss-server-bundle/pull/61). The cookie race **at the wire** is NOT atomically prevented — per the spec constraint *"do NOT introduce per-state cookie keys"*, `mpass_bridge` stays a single per-browser slot, and concurrent `/authorize` requests will race for it. The ship is a **graceful UX wrapper**: `/mpass-callback` redirects to the portal with `?login_error=expired_flow` instead of the stark `400 Missing mpass_bridge cookie` page. Portal JS reads the flag, shows a toast, and strips the param via `history.replaceState`.

Race semantics: whichever tab's callback runs **second** finds the bridge state already consumed (atomic `GETDEL` in Redis) and gets the graceful redirect. The first-to-callback succeeds normally.

A layered mutex (server-side 409 on `/authorize` + client-side JS gate + back-nav cleanup + double-click override) was prototyped on the same branch and dropped as scope creep — it didn't atomically prevent the race either (the underlying `mpass_bridge` slot is still shared), it only moved the failure between tabs. PR #57 (mutex) was closed in favour of PR #61 (graceful redirect).

## Fix mechanism

| Layer | Where | Behaviour |
|---|---|---|
| **Callback wrapper** | `mpass-auth-proxy/main.py` `/mpass-callback` | `try/except` around the bridge-state lookup. On missing cookie or expired/consumed state, returns `302 → <portal>/?login_error=expired_flow` instead of `400 Missing mpass_bridge cookie`. |
| **Bridge cookie cleanup** | same handler, on every exit path | `_clear_bridge_cookie()` on success and failure — keeps the slot clean for the next attempt. |
| **Portal toast** | `foss-server-bundle/landing/index.html.example` `consumeAuthFlags()` | Reads `?login_error=expired_flow` from `location.search` on load, shows a 4 s toast, then `history.replaceState`'s the param out of the URL. |
| **Portal URL derivation** | `_derive_portal_url()` / `PORTAL_URL` env | Strips the auth host prefix so the redirect target is the user-visible portal, not the bridge subdomain. |

## Application Overview

This bug sits at the **mPass / bridge layer** of the SSO chain (`mpass-auth-proxy` between oauth2-proxy and the moneta-auth IDP). `mpass_bridge` is a per-browser cookie keying a one-shot Redis state entry (`bridge_state:<state>`). Two tabs sharing cookies → second tab's `/authorize` overwrites the first's `mpass_bridge`; the first tab's `/mpass-callback` atomically consumes the (now-shared) Redis entry; the second tab's `/mpass-callback` arrives with nothing to look up.

The reporter filed against Plane, but the failing surface is the shared SSO entry, so the test enters at the portal (`MAIN_URL`) — every app bounces through the same IDP form.

## Test Scenarios

### 1. Second tab's callback → graceful portal redirect

**Seed:** none (test owns its `BrowserContext` — multi-tab semantics require a shared cookie jar with two pages, which neither the worker `context` fixture nor `freshLogin(browser)` set up directly).

#### 1.1. second-tab-callback-redirects-to-portal-with-login_error-toast

**File:** `tests/bugs/bug_dc998ba0.spec.ts`

**Skips when** `NORMAL_USER` / `NORMAL_PASS` are unset — the repro uses a distinct identity in tab 2 to match the reporter's two-users-two-tabs flow.

**Steps:**
  1. Open a fresh `BrowserContext` and open page1 (tab 1). `goto(MAIN_URL)`, click the Login CTA, `waitForURL(IDP_REGEX)`.
  2. Open page2 (tab 2) in the **same** context. Attach a `page.on("response", …)` listener that captures every `/mpass-callback` response's `status` + `Location` header — **before** navigating, so a fast redirect isn't missed.
  3. `goto(MAIN_URL)` on page2, click Login, `waitForURL(IDP_REGEX)`. Both tabs are now on the IDP picker; the per-browser `mpass_bridge` cookie has been written by tab 1's `/authorize`, then overwritten by tab 2's.
  4. Submit tab 1 via `cognitoLogin(page1, { skipInitialNav: true })`. Tab 1's callback consumes the shared bridge state and clears the cookie.
  5. Submit tab 2 via `cognitoLogin(page2, { user: NORMAL_USER, pass: NORMAL_PASS, skipInitialNav: true })`. `cognitoLogin`'s `waitForURL(FOSS_HOST_REGEX)` is satisfied by the portal redirect (the portal IS a foss host), so no throw. Wrap defensively in `try/catch` so any unexpected throw becomes captured diagnostic info, not a stack trace masking the real assertion.

**Assertions (in order of importance):**
  - Tab 2's captured `/mpass-callback` responses must include a **302 whose `Location` matches `/login_error=expired_flow/`**. Server-side signal — wire-level proof Option B fired.
  - Tab 2's body must NOT match `/mpass[_\s-]?bridge/i` (regression guard against the original `Missing mpass_bridge cookie` observable).
  - Tab 2's final URL must match `FOSS_HOST_REGEX` (the portal). Backstops the case where the 302 is captured but navigation didn't complete.

## Why the response listener, not the toast text

The toast renders briefly (4 s opacity-out per the landing JS), and `history.replaceState` strips the `?login_error=expired_flow` param from the URL almost immediately. Asserting on either would be timing-fragile. The `page.on("response", …)` listener captures the wire-level redirect once, deterministically, before any of those races matter.

## What we do NOT test

- **The race outcome for tab 1.** Tab 1 always succeeds because its callback runs first; the test asserts only the second-tab failure mode. The first-tab happy path is exercised across the rest of the auth suite.
- **The lock cookie / JS gate / 5-second override / back-nav cleanup.** Those were prototyped on PR #57 and dropped before merge. If someone re-adds them in future, this test still passes (the graceful redirect path is unchanged); a separate test would be needed for the new behaviour.

## Resolution of original open questions

1. **Entry point** — confirmed: portal (`MAIN_URL`) is correct. The graceful redirect target IS the portal.
2. **Error surface** — the new observable is a portal toast (`?login_error=expired_flow` query → JS toast → `history.replaceState`). The old `Missing mpass_bridge cookie` 400 page is unreachable.
3. **Expected post-bug identity** — tab 2 lands unauthenticated on the portal; no session is established for it. Tab 1 is fully logged in.
4. **Tab semantics** — confirmed: single `BrowserContext` + two `newPage()` is the correct model (cookies shared, which is what makes the race observable).
