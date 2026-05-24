# proxy-auth-middleware — capability spec

Per-app middleware that converts oauth2-proxy's `X-Auth-Request-*` headers into a native authenticated request. Applies to every app behind Traefik ForwardAuth in the FOSS bundle.

The contract assumes the trust model documented in [`../../project.md`](../../project.md). If any trust-model invariant is violated, this spec must be re-derived.

## Requirements

### Requirement: Bypass paths SHALL short-circuit before any auth processing

Configured bypass prefixes MUST be honoured at the very top of request handling. No header read, no session check, no logout, no login. Bypass paths have their own auth (god-mode local credentials, instance-admin permissions).

#### Scenario: Bypass dominates an authenticated session with mismatched proxy identity

- **GIVEN** the current Django session belongs to user A
- **AND** the request path is `/god-mode/setup/`
- **AND** the request header `X-Auth-Request-Email` asserts user B (different identity)
- **WHEN** the middleware processes the request
- **THEN** the framework `logout(request)` is NOT called
- **AND** the auto-provision/user_login flow is NOT triggered
- **AND** the request passes through to the next handler with the session intact

#### Scenario: Bypass dominates an unauthenticated request with valid proxy header

- **GIVEN** no Django session is present
- **AND** the request path is `/api/instances/config/`
- **AND** the request header `X-Auth-Request-Email` is a valid email
- **WHEN** the middleware processes the request
- **THEN** no User is created
- **AND** no `user_login` is called
- **AND** the request passes through unauthenticated (the bypass endpoint's own auth gate decides whether to 401)

### Requirement: Authenticated sessions with matching or absent proxy identity SHALL short-circuit

If `request.user.is_authenticated` is true and either the proxy header is absent OR its normalised value equals the session user's normalised email, the middleware MUST return the response unchanged. No logout, no new session, no DB write.

Header absence is NOT a logout signal — the X-Auth-Request-* headers are only set on traffic that flowed through Traefik → oauth2-proxy. Absent header means a trusted internal path (celery workers, OPTIONS preflight, direct backend hits at 127.0.0.1, Django test client, etc.).

#### Scenario: Match → no-op short-circuit

- **GIVEN** the current Django session belongs to `alice@example.com`
- **AND** the request header `X-Auth-Request-Email` is `alice@example.com`
- **WHEN** the middleware processes the request
- **THEN** `user_login` is NOT called
- **AND** the session is preserved

#### Scenario: Match is case- and whitespace-insensitive

- **GIVEN** the current session belongs to `alice@example.com`
- **AND** the request header `X-Auth-Request-Email` is `  ALICE@example.com  `
- **WHEN** the middleware processes the request
- **THEN** no flush is triggered (no `logout()` / no `clearCookie` / no re-key)
- **AND** the session passes through unchanged
- **AND** the comparison MUST apply the same normalisation (lowercase + strip) to **both** sides — the header value AND the session user's email — that the DB lookup uses

The bidirectional-normalisation requirement is the load-bearing part. Normalising only one side has the same effect as not normalising at all: every case-variant header (e.g. `ALICE@example.com` from a Cognito identity claim) falsely registers as a mismatch and kicks the cookie-authed request back to ForwardAuth on every request. Outline's `normalizeProxyEmail` + `(user.email ?? "").toLowerCase()` and Plane's `_normalise_email(proxy_email)` + `_normalise_email(request.user.email or "")` are the canonical bidirectional-normalisation patterns. A regression-guard test for this case is REQUIRED in every per-app test suite (Plane: `test_match_is_case_and_whitespace_insensitive`; Outline: `should treat case- and whitespace-variant proxy email as matching the JWT user`).

#### Scenario: Header absent → short-circuit

- **GIVEN** the current Django session belongs to `alice@example.com`
- **AND** the request has no `X-Auth-Request-Email` header
- **WHEN** the middleware processes the request
- **THEN** `user_login` is NOT called
- **AND** the framework `logout(request)` is NOT called
- **AND** the session is preserved

### Requirement: Identity mismatch SHALL flush the existing session immediately

If `request.user.is_authenticated` is true AND the proxy header asserts a non-empty identity that differs from the session user's normalised email, the middleware MUST call the framework's `logout(request)` (session flush) BEFORE attempting to resolve or authenticate the incoming user.

The flush MUST happen before any subsequent bail-out path can fire. Bail-out paths in scope today: the incoming user being marked inactive. Future bail-outs (e.g., `_resolve_user` raising on a concurrent `IntegrityError`) MUST inherit the same guarantee.

Rationale: if the flush were deferred to the implicit session rotation in `login()`, any bail-out before `login()` would leave the previous user's session intact and the request would proceed authenticated as the previous identity.

#### Scenario: A → B switch flushes A's session and logs in B

- **GIVEN** the current Django session belongs to `alice@example.com`
- **AND** `bob@example.com` is an existing active user
- **AND** the request header `X-Auth-Request-Email` is `bob@example.com`
- **WHEN** the middleware processes the request
- **THEN** the framework `logout(request)` is called exactly once
- **AND** `user_login` is called with `bob`
- **AND** the response is served as `bob`

#### Scenario: Mismatch with inactive incoming user leaves request unauthenticated

- **GIVEN** the current Django session belongs to `alice@example.com`
- **AND** `bob@example.com` exists but `is_active=False`
- **AND** the request header `X-Auth-Request-Email` is `bob@example.com`
- **WHEN** the middleware processes the request
- **THEN** the framework `logout(request)` is called
- **AND** `user_login` is NOT called
- **AND** the request proceeds as `AnonymousUser`
- **AND** alice's session does NOT survive

#### Scenario: Mismatch with unresolvable upstream identity also flushes the session

The mismatch flush MUST fire even when the upstream identity cannot be resolved to a local user record (unknown email, auto-register disabled, or a database lookup that returns nil for any other reason). The upstream header is positive proof that the identity has changed; the absence of a local profile to re-key to does NOT make it safe to keep serving the previous user.

- **GIVEN** the current session belongs to `alice@example.com` (Penpot profile-id, Plane sessionid, etc.)
- **AND** no local user record exists for `unknown@example.com`
- **AND** the auto-provision flag is OFF (the system does NOT create a new record for this email)
- **AND** the request header `X-Auth-Request-Email` is `unknown@example.com`
- **WHEN** the middleware processes the request
- **THEN** the framework's session-flush is called (the same one used in the active-mismatch and inactive-mismatch scenarios above)
- **AND** the in-flight request no longer carries alice's identity (`request.user` is anonymous, `::session/profile-id` is nil, etc.)
- **AND** **the response expires the browser's local session cookie** (so the next request cannot resurrect alice via the surviving cookie alone)
- **AND** the request proceeds as unauthenticated; downstream handlers respond per their own anonymous-request rules

The browser-cookie expiry on the response is the difference between Rule 2 here and a partial flush that only clears in-flight state. Reaping in-flight state without expiring the cookie leaks the session on the very next request: `wrap-session` (or its per-app equivalent) re-resolves alice from the surviving cookie, the middleware sees an unresolvable header again, the cycle repeats. The cookie MUST be expired via the framework's session-deletion idiom (`logout(request)` in Django, `session/delete-fn` in Penpot, `clearCookie` in Twenty, throw-401 + outer catch in Outline). Hand-rolled `Set-Cookie` for the same purpose is acceptable but discouraged — frameworks know the cookie name, attrs, and domain.

### Requirement: Unauthenticated requests with a valid proxy identity SHALL auto-provision and log in

When no session is present (or after a Rule 3 flush) and the proxy header carries a non-empty normalised identity, the middleware MUST:

1. Resolve the user via exact-match DB lookup on the normalised email.
2. If the user does not exist, create it with `set_unusable_password()`, `is_email_verified=True`, and create the associated profile row.
3. If the resolved user is inactive, pass through unauthenticated without calling `login()`.
4. Otherwise, call the framework session-establishing function (`user_login(request, user, is_app=True)` in Plane; equivalent elsewhere).

DB lookup MUST use exact equality, not pattern matching. Wildcards in the proxy header (`%`, `_`) MUST be treated as literal characters in the lookup.

#### Scenario: First-seen email creates a new active user

- **GIVEN** no user with email `newuser@example.com` exists
- **AND** the request header `X-Auth-Request-Email` is `newuser@example.com`
- **AND** no Django session is present
- **WHEN** the middleware processes the request
- **THEN** a new User is created with email `newuser@example.com`
- **AND** the User has `set_unusable_password()`
- **AND** the User has `is_email_verified=True`
- **AND** a Profile row is created for the User
- **AND** `user_login` is called with the new User

#### Scenario: Existing active user is reused, not duplicated

- **GIVEN** `existing@example.com` already exists as an active user
- **AND** the request header `X-Auth-Request-Email` is `existing@example.com`
- **AND** no Django session is present
- **WHEN** the middleware processes the request
- **THEN** no new User is created (`User.objects.count()` is unchanged)
- **AND** `user_login` is called with the existing User

#### Scenario: Inactive user does not get a session

- **GIVEN** `inactive@example.com` exists with `is_active=False`
- **AND** the request header `X-Auth-Request-Email` is `inactive@example.com`
- **AND** no Django session is present
- **WHEN** the middleware processes the request
- **THEN** `user_login` is NOT called
- **AND** the request proceeds as `AnonymousUser`

#### Scenario: SQL wildcards in the header are treated literally

- **GIVEN** a user with email `victim@example.com` exists
- **AND** the request header `X-Auth-Request-Email` is `v%@example.com`
- **AND** no Django session is present
- **WHEN** the middleware processes the request
- **THEN** the DB lookup for `v%@example.com` returns zero rows
- **AND** a new user with email `v%@example.com` is created (does not impersonate `victim`)

### Requirement: Email normalisation SHALL be applied uniformly

The same normalisation function (lowercase + strip whitespace) MUST be applied to:

1. The proxy header value before any comparison or DB lookup.
2. The session user's `email` field when computing the match comparison.
3. The persisted `User.email` column (canonical lowercase enforced at write).

This prevents case-variant or whitespace-padded headers from creating duplicate users or evading the match short-circuit.

#### Scenario: Whitespace-only header is treated as empty

- **GIVEN** the current Django session belongs to `alice@example.com`
- **AND** the request header `X-Auth-Request-Email` is `   ` (whitespace only)
- **WHEN** the middleware processes the request
- **THEN** the normalised value is empty
- **AND** the middleware short-circuits as if no header were present
- **AND** the session is preserved

#### Scenario: Mixed-case header matches a canonical-lowercase DB row

- **GIVEN** a user `alice@example.com` exists in the DB
- **AND** the request header `X-Auth-Request-Email` is `ALICE@Example.com`
- **AND** no Django session is present
- **WHEN** the middleware processes the request
- **THEN** the existing `alice@example.com` user is resolved (not a new user created)
- **AND** `user_login` is called with that User

### Requirement: Concurrent creation races SHALL fall back to read

A race between two requests for the same first-time email MAY trigger an `IntegrityError` on `get_or_create`. The middleware MUST catch this exception and re-attempt a plain `get(email=...)` lookup. If the user still does not exist, the original exception MUST be re-raised (do not silently swallow).

#### Scenario: IntegrityError on first request is recovered by the second

- **GIVEN** two concurrent requests for the same new email arrive
- **AND** the first request wins the `INSERT` race and creates the row
- **WHEN** the second request hits `get_or_create` and receives `IntegrityError`
- **THEN** the middleware retries with `User.objects.get(email=...)`
- **AND** the existing User from the first request is returned
- **AND** the second request proceeds with `user_login`

### Requirement: email-shape detection on header values SHALL avoid polynomial-backtracking regex

When the middleware decides whether a header value is already email-shaped (and therefore safe to use directly) versus a bare username that needs synthesis against `DEFAULT_EMAIL_DOMAIN`, the check MUST NOT use an unanchored or repetition-heavy regex. The standard "email-shape" pattern `^[^\s@]+@[^\s@]+\.[^\s@]+$` is polynomial-backtrack-vulnerable on adversarial input (e.g. strings starting with `!@!.` with many repetitions of `!.`). CodeQL's `js/polynomial-redos` rule flags it.

The middleware MUST use an `indexOf`-based check (or its language equivalent) that runs in O(n):

```typescript
const trimmed = headerValue.toLowerCase().trim();
const atIdx = trimmed.indexOf("@");
const dotIdx = trimmed.indexOf(".", atIdx + 1);
const isEmailShaped = atIdx > 0 && dotIdx > atIdx + 1;
```

This requirement matters because the header value is **uncontrolled input** until ForwardAuth has overwritten it. Even though the trust-model invariant says only oauth2-proxy can set the header at the edge, defense-in-depth requires the parsing code to be regex-safe in case the invariant is ever weakened (e.g. backend port accidentally exposed for debugging).

#### Scenario: Outline's CodeQL alert is closed by the indexOf rewrite

- **GIVEN** Outline's middleware previously used `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(headerValue)` to detect email-shape
- **AND** CodeQL flagged it as `js/polynomial-redos` (alert raised on PR #19)
- **WHEN** the email-shape check is rewritten to use `indexOf`-based logic
- **THEN** the same email-shape semantics are preserved (`alice@example.com` matches; `alice` does not)
- **AND** the polynomial-backtracking complexity is removed
- **AND** the CodeQL alert resolves on the next scan

Reference implementation: Outline's `normalizeProxyEmail` in `server/middlewares/authentication.ts` (post-PR #19). Plane, Penpot, and SurfSense currently use simpler `"@" in email` substring checks rather than regex and so do not exhibit the issue — but if any future implementation reaches for a regex, it MUST follow the indexOf pattern.
