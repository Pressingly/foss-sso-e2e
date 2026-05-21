// Spec coverage for this file (see docs/spec-coverage.md):
// (no openspec requirement — generic OWASP session-fixation defence)
// Tracked as orthogonal coverage in spec-coverage-deferred.md.

import { test as raw, expect } from "@playwright/test";
import { APPS, AUTH_COOKIE, COOKIE_DOMAIN, isAuthWall, IDP_REGEX } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Session-fixation defence on the SSO cookie.
//
// Attack: an attacker controls a subdomain (or finds an XSS on any
// foss.* subdomain) that lets them set a `_oauth2_proxy` cookie with
// a value the attacker chose. The attacker then sends the victim a
// link to log in. If oauth2-proxy *reuses* the pre-set cookie value
// after successful auth, the attacker's pre-pinned session is now
// the victim's authenticated session — the attacker can use the
// known cookie value to impersonate.
//
// The contract: after a successful login, the `_oauth2_proxy` cookie
// value MUST differ from whatever value was in the jar pre-login.
// oauth2-proxy generates a fresh session identifier on every login;
// reusing a pre-set value is the classic session-fixation flaw.

raw.describe("Session-fixation defence on _oauth2_proxy (OWASP A07)", () => {
  raw("pre-set _oauth2_proxy cookie is rotated on successful login", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext(); // cold — fresh jar
    const page = await ctx.newPage();
    try {
      // Plant a deterministic value the attacker "knows". Any
      // string is fine — the point is that this exact byte
      // sequence must NOT survive into the post-login cookie.
      const ATTACKER_PINNED = `attacker-pinned-fixation-value-${Date.now()}`;
      await ctx.addCookies([
        {
          name: AUTH_COOKIE,
          value: ATTACKER_PINNED,
          domain: `.${COOKIE_DOMAIN}`,
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ]);

      // Sanity: the cookie really is in the jar pre-login.
      const before = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(before, "pre-login cookie must be planted").toBeDefined();
      expect(before!.value).toBe(ATTACKER_PINNED);

      // First proof the pinned cookie is actually being rejected, NOT
      // just overwritten by the subsequent login. Without this step,
      // a passing test would also be consistent with "oauth2-proxy
      // happily accepted the planted cookie, then login replaced it
      // anyway" — that's not a session-fixation defence, that's just
      // login flow.
      //
      // Hit any protected app on a fresh page. With the planted but
      // HMAC-invalid cookie in the jar, oauth2-proxy must reject it
      // and bounce to the IDP (or an auth wall on the foss host).
      const rejectionProbe = await ctx.newPage();
      try {
        await rejectionProbe.goto(APPS[0]!.url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        const landed = rejectionProbe.url();
        const bounced = isAuthWall(landed) || IDP_REGEX.test(landed);
        expect(
          bounced,
          `Planted cookie was honoured: landed on ${landed} without auth bounce. oauth2-proxy is not validating the cookie — the post-login value diff below would be coincidental, not a fixation defence.`
        ).toBe(true);
      } finally {
        await rejectionProbe.close();
      }

      // Now go through the full SSO flow as a normal user on the
      // original page. The pinned cookie has already been proven
      // rejected above; cognitoLogin completes the IDP password form
      // and oauth2-proxy issues a fresh session.
      await cognitoLogin(page);

      // Post-login: the cookie must exist AND its value must NOT
      // equal the attacker's planted value.
      const after = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(after, "post-login cookie must exist").toBeDefined();
      expect(after!.value, "post-login cookie must be non-empty").not.toBe("");
      expect(
        after!.value,
        `Session fixation: post-login cookie value equals the pre-planted attacker value (${ATTACKER_PINNED}). The attacker can impersonate the just-logged-in user.`
      ).not.toBe(ATTACKER_PINNED);
    } finally {
      await ctx.close();
    }
  });
});
