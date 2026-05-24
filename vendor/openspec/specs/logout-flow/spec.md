# logout-flow — capability spec

How logout works in the FOSS bundle. There are two independently-scoped logout flows and one optional deeper teardown — they are NOT chained by default.

Source: original mPass design (PDF 2026-03-26, approved) §"Logout"; refined post-implementation to match the deployed behaviour.

## Model

Two flows are exposed in the UI; the third is operator-callable but not surfaced as a user action:

| Flow | Where it's triggered | What it clears | Where it redirects |
|---|---|---|---|
| Per-app "Logout" | "Logout" button inside each app's UI | **Nothing** — navigation only | `https://${PLATFORM_DOMAIN}` (the portal main page) |
| Portal "Logout all" | "Logout" button on the portal landing (`local.moneta.dev`) | The shared `_oauth2_proxy` cookie only (Layer 2) | `https://${PLATFORM_DOMAIN}` (back to the same landing page, now unauthenticated) |
| Cognito teardown | Operator-driven (not in the bundle UI) | The Cognito SSO session at the IdP | Wherever the operator sends them |

**This is deliberate.** Per-app "Logout" does not call any session-clear endpoint — not the app's own `/auth/sign-out/`, not `/oauth2/sign_out`, not Cognito. It is purely a "take me back to the portal" navigation. The actual sign-out happens at the portal via "Logout all", which clears the shared `_oauth2_proxy` cookie. After that, ForwardAuth gates further app access and `proxy-auth-middleware` Rule 2 reaps stale per-app sessions on next visit.

Cognito SSO survives the portal "Logout all" so the user can re-authenticate without redoing the QR scan.

## Requirements

### Requirement: per-app "Logout" SHALL be navigation-only

Every app's "Logout" UI control MUST simply navigate the browser to `https://${PLATFORM_DOMAIN}`. It MUST NOT call any session-clearing endpoint of any layer:

- MUST NOT call the app's own `/auth/sign-out/` (or equivalent).
- MUST NOT call `/oauth2/sign_out`.
- MUST NOT call any Cognito endpoint.

This is the contract. If a current implementation in any app is calling a session-clear endpoint, it is either redundant (the real sign-out is at the portal) or incorrect and should be removed.

#### Scenario: User clicks "Logout" in Plane

- **GIVEN** the user is authenticated in Plane with a valid Django `sessionid` and a valid `_oauth2_proxy` cookie
- **WHEN** the user clicks Plane's "Logout" control
- **THEN** the browser is navigated to `https://${PLATFORM_DOMAIN}` and nothing else happens
- **AND** Plane's `sessionid` cookie is unchanged
- **AND** the `_oauth2_proxy` cookie is unchanged
- **AND** the Cognito SSO session is unchanged
- **AND** the user lands on the portal main page

#### Scenario: User returns to Plane after per-app "Logout"

- **GIVEN** the user just clicked "Logout" in Plane (only a redirect happened, no cookies cleared)
- **WHEN** the user navigates back to `https://pm.${PLATFORM_DOMAIN}/`
- **THEN** the `_oauth2_proxy` cookie is still valid → ForwardAuth returns 202
- **AND** Plane's `sessionid` cookie is still present
- **AND** `proxy-auth-middleware` Rule 1 short-circuits on the matching session
- **AND** the user is back in Plane's UI as the same user, no re-prompt
- **AND** functionally nothing has changed since before they clicked "Logout"

#### Scenario: Per-app logout is the same shape in every app

- **GIVEN** any app in the bundle (Plane, Outline, Penpot, Twenty, SurfSense)
- **WHEN** the user clicks that app's "Logout" control
- **THEN** the browser navigates to `https://${PLATFORM_DOMAIN}` and nothing else happens
- **AND** the redirect target is `https://${PLATFORM_DOMAIN}` (not a per-app subdomain)
- **AND** no API call is issued by the logout action

### Requirement: per-app "Logout" SHALL NOT be relied on for security

Because per-app "Logout" does not clear any session, it MUST NOT be advertised or treated as a security boundary. UI copy, support docs, and onboarding material MUST direct users to the portal's "Logout all" control when they need to actually end their session — for example before lending the device to someone else.

The per-app button's intended UX is "take me back to the portal", not "end my session here". If the bundle wants a more aggressive per-app log-out, that requires a separate change proposal — the current contract is deliberate.

### Requirement: portal "logout all" SHALL clear only the _oauth2_proxy cookie

The portal landing's "Logout" / "Logout all" button MUST:

1. Navigate the browser to `https://auth.${PLATFORM_DOMAIN}/oauth2/sign_out` to clear the `_oauth2_proxy` cookie.
2. Honour oauth2-proxy's `rd=` redirect-back parameter pointing at `https://${PLATFORM_DOMAIN}`, so the user lands back on the portal main page after the sign-out.

The button MUST NOT call any per-app `/auth/sign-out/` endpoint. The button MUST NOT call any Cognito `/logout` endpoint.

#### Scenario: User clicks "Logout all" on the portal

- **GIVEN** the user is authenticated and has an `_oauth2_proxy` cookie scoped to `.${PLATFORM_DOMAIN}`
- **AND** the user has active app-native sessions in Plane and Outline
- **WHEN** the user clicks the portal's "Logout all" control
- **THEN** the browser navigates to `https://auth.${PLATFORM_DOMAIN}/oauth2/sign_out?rd=https://${PLATFORM_DOMAIN}`
- **AND** oauth2-proxy clears the `_oauth2_proxy` cookie via `Set-Cookie: _oauth2_proxy=; Max-Age=0; Domain=.${PLATFORM_DOMAIN}`
- **AND** the user lands back on `https://${PLATFORM_DOMAIN}`
- **AND** Plane's `sessionid` cookie is still present in the browser (Layer 1 not touched)
- **AND** Outline's `accessToken` cookie is still present (Layer 1 not touched)
- **AND** the Cognito SSO session is still active at the IdP

### Requirement: stale app-native sessions SHALL be reaped on next request, not eagerly

When the user revisits an app after a portal "logout all", their app-native session cookie is still present in the browser but the `_oauth2_proxy` cookie is gone. The bundle relies on two layers to recover correctly:

1. **ForwardAuth (Traefik → oauth2-proxy)** returns 401 because there is no `_oauth2_proxy` cookie. The request never reaches the app. Traefik redirects to `/oauth2/sign_in`, which then redirects to mPass.
2. **After re-auth**, the user gets a new `_oauth2_proxy` cookie with whatever identity they now hold. The request reaches the app. `proxy-auth-middleware` Rule 2 compares the upstream identity against the surviving app-native session — match → keep, mismatch → flush + re-auth.

This is the load-bearing reason the portal "logout all" can skip the per-app cleanup: ForwardAuth gates app access, and the middleware reaps stale sessions defensively when the user returns.

#### Scenario: User returns to Plane after portal "logout all"

- **GIVEN** the user just clicked "Logout all" on the portal — `_oauth2_proxy` cleared, Plane's `sessionid` still present
- **WHEN** the user navigates to `https://pm.${PLATFORM_DOMAIN}/`
- **THEN** Traefik calls oauth2-proxy ForwardAuth
- **AND** oauth2-proxy sees no `_oauth2_proxy` cookie and returns 401
- **AND** Traefik redirects the browser to `/oauth2/sign_in`
- **AND** the user re-authenticates via mPass (Cognito SSO is still alive, so no QR rescan needed)
- **AND** a fresh `_oauth2_proxy` cookie is set
- **AND** Plane's `proxy-auth-middleware` compares the new upstream identity against the surviving `sessionid` user
- **AND** if they match, the session is reused; if they differ, Rule 2 flushes and re-auths

### Requirement: Cognito SSO teardown is operator-callable but not surfaced as a user action

The bundle MUST NOT chain Cognito's `/logout` endpoint from any user-facing button. If a Cognito-side sign-out is needed (e.g. forced sign-out after a security incident), the operator triggers it via:

- The AWS Cognito console for a single user, OR
- `https://<cognito-domain>/logout?client_id=…&logout_uri=…` if scripting, with `logout_uri` registered in the Cognito app client's "Allowed sign-out URLs".

This requirement is partly an instruction to NOT add a "Sign out of mPass" button to any app's UI. Doing so would break the SSO experience for the rest of the bundle (every other app would force a fresh mPass login on next visit, with no benefit).

#### Scenario: Bundle UI has no Cognito-logout button

- **WHEN** any UI in the bundle is audited for logout controls
- **THEN** no button or link navigates to `https://<cognito-domain>/logout` directly
- **AND** the only operator-callable Cognito logout is via the AWS console or scripted action

### Requirement: logout SHALL be observable and idempotent

Calling either logout flow when no session exists MUST NOT error. Each layer's clear operation is independently idempotent (clearing an already-empty cookie is a no-op).

#### Scenario: Per-app logout called twice

- **GIVEN** the user has just completed a per-app logout (session cleared, redirected to portal)
- **WHEN** the user accidentally hits the logout link again
- **THEN** the app's `/auth/sign-out/` accepts the call without error
- **AND** the user lands on the portal as expected

#### Scenario: Portal "logout all" called twice

- **GIVEN** the user has just completed a portal "logout all" (`_oauth2_proxy` cleared)
- **WHEN** the user accidentally hits the portal "Logout all" button again
- **THEN** oauth2-proxy's `/oauth2/sign_out` accepts the call without error
- **AND** the user lands back on the portal as expected

### Requirement: Cognito allowlist SHALL include the portal main page

Even though the bundle's default flows don't redirect to Cognito's `/logout`, the operator-callable path still needs Cognito's allowed-sign-out-URL list to contain `https://${PLATFORM_DOMAIN}`. This is required for the Cognito teardown path to work when the operator invokes it.

#### Scenario: Cognito app client allowlist contains the portal

- **GIVEN** the Cognito app client `${OIDC_CLIENT_ID}`
- **WHEN** an operator queries the app-client config
- **THEN** the "Allowed sign-out URLs" list contains `https://${PLATFORM_DOMAIN}`
