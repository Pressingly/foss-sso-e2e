// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#oidc-state-parameter-shall-be-integrity-protected

import { test, expect, request } from "@playwright/test";
import { APPS, MAIN_URL, isAuthWall } from "../../constants";

// OIDC state parameter integrity.
//
// In a correct OIDC flow:
//   1. The user hits /oauth2/sign_in?rd=<deep>
//   2. oauth2-proxy generates a state value, stores it server-side
//      (or signed in a cookie), and redirects to the IDP with
//      ?state=<value>
//   3. The IDP redirects back to /oauth2/callback?code=...&state=<same>
//   4. oauth2-proxy validates that `state` matches what it issued
//   5. If matched, completes the login. Otherwise, 400/403.
//
// The state parameter is the OIDC equivalent of a CSRF token. If
// it's missing, predictable, or unvalidated, an attacker can trick
// a victim into completing a login flow that the attacker started —
// the victim ends up authenticated as the attacker's identity (or
// vice-versa, depending on the attack shape).
//
// What this spec exercises:
//   • /oauth2/callback with a missing `state` parameter MUST be
//     rejected.
//   • /oauth2/callback with an obviously-invalid `state` value MUST
//     be rejected.
//   • /oauth2/callback with a `state` that doesn't match an issued
//     bridge MUST be rejected.
//
// What it canNOT exercise from a black-box probe:
//   • Whether the state is cryptographically random (would need to
//     observe many issued state values + entropy analysis).
//   • Whether the same state value can be replayed across two
//     concurrent flows (would need a controlled-race harness).

const INVALID_STATES = [
  "",                                    // empty
  "x",                                   // too short
  "a".repeat(8),                         // all same char
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",   // 32 chars but trivially guessable
  "not-a-real-state-value-from-anyone", // wrong shape
];

test.describe("OIDC state parameter integrity", () => {
  for (const app of APPS) {
    for (const state of INVALID_STATES) {
      const stateDisplay = state === "" ? "<empty>" : state.slice(0, 20);
      test(`${app.name}: /oauth2/callback with invalid state '${stateDisplay}' is rejected`, async () => {
        const ctx = await request.newContext();
        try {
          // Build a callback URL with a forged state. We don't need
          // a valid `code` — if state validation fires first (as it
          // should), the response shape is the same whether or not
          // the code would be redeemable.
          const stateParam = state === "" ? "" : `state=${encodeURIComponent(state)}`;
          const callbackUrl = `${app.url}/oauth2/callback?code=forged${
            stateParam ? "&" + stateParam : ""
          }`;
          const res = await ctx.fetch(callbackUrl, {
            method: "GET",
            maxRedirects: 0,
            timeout: 15_000,
          });
          const status = res.status();
          const location = res.headers()["location"] ?? "";

          // Acceptable rejections:
          //   • 4xx — explicit rejection (400 bad request, 401/403, etc.)
          //   • 5xx — ugly rejection (the callback handler crashed
          //     trying to validate; the request never granted access).
          //     Observed in practice: oauth2-proxy returns 500 on
          //     forged-state callbacks rather than a clean 4xx.
          //   • 302 to /oauth2/sign_in (start over)
          //   • 302 to the IDP (start over from oauth2-proxy's POV)
          //   • 302 to the main portal with NO session cookie set
          //
          // NOT acceptable:
          //   • 2xx with a body that suggests a successful login
          //   • 302 to a deep app URL (means it accepted the forged
          //     state and is sending us into the authenticated UX)
          const rejected =
            (status >= 400 && status < 600) ||
            (status >= 300 &&
              status < 400 &&
              (location.includes("/oauth2/sign_in") ||
                isAuthWall(location.startsWith("http") ? location : new URL(location, app.url).toString()) ||
                location === MAIN_URL ||
                location === `${MAIN_URL}/`));

          expect(
            rejected,
            `${app.name}: /oauth2/callback accepted forged state '${stateDisplay}' — status=${status}, location=${location}. State validation appears to be missing or bypassable; an attacker could complete a CSRF-on-login flow.`
          ).toBe(true);

          // Belt-and-braces: even if the response is "acceptable" by
          // status code, make sure no SSO cookie got set in the
          // response. oauth2-proxy must NEVER issue _oauth2_proxy
          // from a callback with bad state.
          const setCookies = (await res.headersArray())
            .filter((h) => h.name.toLowerCase() === "set-cookie")
            .map((h) => h.value);
          const issuedSso = setCookies.find(
            (c) => /_oauth2_proxy=/i.test(c) && !/Max-Age\s*=\s*0/i.test(c)
          );
          expect(
            issuedSso,
            `${app.name}: /oauth2/callback with forged state set an _oauth2_proxy cookie: ${issuedSso}`
          ).toBeUndefined();
        } finally {
          await ctx.dispose();
        }
      });
    }
  }
});
