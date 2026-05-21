// Spec coverage for this file (see docs/spec-coverage.md):
// @spec oauth2-proxy-gateway#cookie-secret-shall-be-32-random-bytes-base64-encoded
// (indirect — proves the cookie's HMAC is actually checked at runtime)

import { test as raw, expect } from "@playwright/test";
import { APPS, AUTH_COOKIE, isAuthWall, IDP_REGEX } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// oauth2-proxy encrypts + HMACs the session payload before stuffing it
// into `_oauth2_proxy`. If the HMAC isn't checked at decode time, an
// attacker who can read the cookie value (XSS on a foss subdomain,
// browser-side debugger, network-tap, etc.) can edit the payload —
// flip a flag, extend the expiry, swap the email — and the proxy will
// happily honour the forged session.
//
// The contract: any modification to the cookie bytes MUST cause
// oauth2-proxy to reject the cookie and bounce the user to the IDP.
// We don't have to forge a *valid* tampered payload; flipping any
// byte breaks the HMAC and that's enough to prove the check fires.
//
// Three tamper positions exercised:
//   • Last byte (typically inside the HMAC suffix → guaranteed mismatch)
//   • First byte after the `v2.` version prefix (payload start)
//   • A middle byte (catches naive bounds-only validators)

raw.describe("Cookie tampering — modified _oauth2_proxy must be rejected", () => {
  for (const position of ["last", "middle", "after-prefix"] as const) {
    raw(`tampered cookie (${position} byte) bounces to IDP`, async ({ browser }) => {
      raw.setTimeout(120_000);
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        // Phase 1: legit login.
        await cognitoLogin(page);
        const sso = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
        expect(sso, "Pre-condition: SSO cookie must exist after login").toBeDefined();
        const original = sso!.value;
        expect(original.length, "Pre-condition: cookie value non-empty").toBeGreaterThan(20);

        // Phase 2: tamper. Flip a single character so the HMAC suffix
        // (or the encrypted payload's MAC) no longer matches the
        // payload bytes.
        const flipChar = (c: string): string =>
          c === "A" ? "B" : c === "a" ? "b" : c === "0" ? "1" : "X";
        let idx: number;
        switch (position) {
          case "last":
            idx = original.length - 1;
            break;
          case "after-prefix":
            // v2 cookies start with "v2." — skip past it. Falls back
            // to byte 5 if the prefix differs.
            idx = original.startsWith("v2.") ? 3 : 5;
            break;
          case "middle":
            idx = Math.floor(original.length / 2);
            break;
        }
        const tampered =
          original.slice(0, idx) + flipChar(original[idx]!) + original.slice(idx + 1);
        expect(
          tampered,
          "Tamper sanity: tampered value must differ from original"
        ).not.toBe(original);

        // Replace the cookie in the jar.
        await ctx.clearCookies();
        await ctx.addCookies([{ ...sso!, value: tampered }]);

        // Phase 3: hit any protected app from a FRESH page. Reusing
        // the existing `page` here would race the cookie swap above —
        // the page object can hold in-flight state from the login
        // navigation, so the first request after the swap may not
        // actually pick up the tampered value. A new page guarantees
        // the navigation reads the post-swap cookie jar.
        await page.close();
        const probe = await ctx.newPage();
        await probe.goto(APPS[0]!.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const landed = probe.url();
        const bounced = isAuthWall(landed) || IDP_REGEX.test(landed);
        expect(
          bounced,
          `Tampered cookie was accepted — landed on ${landed} instead of being bounced to IDP. The HMAC verification is not firing.`
        ).toBe(true);
      } finally {
        await ctx.close();
      }
    });
  }
});
