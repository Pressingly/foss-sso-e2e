// Spec coverage for this file (see docs/spec-coverage.md):
// (no openspec requirement — generic OWASP A01 / CSRF defence on logout)
// Tracked as orthogonal coverage in spec-coverage-deferred.md.

import { test as raw, expect } from "@playwright/test";
import { APPS, MAIN_URL, AUTH_COOKIE } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// CSRF on the logout endpoint.
//
// Attack: `/oauth2/sign_out` is a GET endpoint. If hitting it with a
// cross-origin sub-resource request clears the user's SSO cookie, a
// malicious page anywhere on the public web can force-log-out any
// visitor by embedding `<img src="https://foss.${PLATFORM_DOMAIN}/oauth2/sign_out">`.
// Worst case this is combined with a re-login phishing page that
// captures the freshly-prompted credentials.
//
// Defence: the SSO cookie's `SameSite=Lax` already blocks browsers
// from attaching it to cross-origin sub-resource requests (img / iframe
// / script / fetch{credentials:include}). So even if /oauth2/sign_out
// is a GET with no CSRF token, the cookie won't reach the server and
// the logout side-effect can't fire from a third-party origin.
//
// This test pins that defence. We log in, then from a *different
// origin* (data: URL) trigger a cross-origin GET to /oauth2/sign_out,
// then verify the SSO cookie is still present and the session still
// works on a foss app. A failure here means the cookie's SameSite
// attribute was loosened (likely to None) and CSRF on logout is now
// exploitable.

raw.describe("CSRF defence on /oauth2/sign_out (SameSite cookie behaviour)", () => {
  raw("cross-origin GET to /oauth2/sign_out does NOT clear the SSO cookie", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // Phase 1: legit login.
      await cognitoLogin(page);
      const before = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(before, "Pre-condition: SSO cookie must exist after login").toBeDefined();
      const originalValue = before!.value;

      // Phase 2: navigate to a *different origin* and fire a
      // cross-origin sub-resource GET to /oauth2/sign_out. data: URLs
      // count as their own opaque origin — the foss subdomain is now
      // cross-origin relative to this page.
      //
      // Two attack shapes are exercised:
      //   • <img src=...>  — the classic CSRF-via-image attack
      //   • fetch(..., {credentials:"include"}) — the modern shape
      //     (would only succeed if SameSite were None)
      const csrfHtml = `
        <html>
          <body>
            <img src="${MAIN_URL}/oauth2/sign_out" style="display:none">
            <script>
              fetch(${JSON.stringify(`${MAIN_URL}/oauth2/sign_out`)}, {
                credentials: "include",
                mode: "no-cors",
              }).catch(() => {});
            </script>
          </body>
        </html>
      `;
      const signOutProbe = page
        .waitForRequest((r) => r.url().includes("/oauth2/sign_out"), { timeout: 8_000 })
        .catch(() => null);

      await page.goto(`data:text/html;base64,${Buffer.from(csrfHtml).toString("base64")}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // Wait until at least one probe request is observed (best-effort).
      await signOutProbe;

      // Phase 3: the SSO cookie must still be present AND its value
      // unchanged. (Browser SameSite=Lax should have suppressed the
      // cookie on both the <img> and the no-cors fetch.)
      const after = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(
        after,
        "CSRF logout: SSO cookie was cleared by a cross-origin request"
      ).toBeDefined();
      expect(
        after!.value,
        "CSRF logout: SSO cookie value changed after a cross-origin request"
      ).toBe(originalValue);

      // Phase 4: behaviourally confirm the session still works — hit
      // any protected app and make sure we don't bounce to the IDP.
      await page.goto(APPS[0]!.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      expect(
        new URL(page.url()).hostname,
        `CSRF logout: session unusable after cross-origin request — landed on ${page.url()}`
      ).toBe(new URL(APPS[0]!.url).hostname);
    } finally {
      await ctx.close();
    }
  });
});
