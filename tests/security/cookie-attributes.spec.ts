// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#sso-cookie-shall-be-issued-with-defense-in-depth-attributes

import { test as raw, expect } from "@playwright/test";
import { AUTH_COOKIE, COOKIE_DOMAIN } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// oauth2-proxy hands the browser one SSO cookie. The cookie's *value*
// is HMAC-protected (tests/security/cookie-tampering.spec.ts proves
// the HMAC is checked at runtime), but the cookie *attributes* control
// the blast radius if anything else slips:
//
//   • HttpOnly=false → JavaScript on ANY foss subdomain can read the
//     cookie. One XSS on docs.foss.* leaks the SSO token directly.
//   • Secure=false → the cookie rides over plaintext HTTP requests.
//     Any network observer captures the SSO token in cleartext.
//   • SameSite=None (or unset) → cross-site requests to foss hosts
//     carry the cookie, expanding the CSRF surface beyond logout
//     (which csrf-logout.spec.ts only verifies on /oauth2/sign_out).
//   • Domain wider than the platform parent → cookie leaks to
//     unrelated subdomains under the same registrable suffix.
//
// Each of these is independent: the suite needs ALL FOUR right.

raw.describe("_oauth2_proxy cookie attributes (defense-in-depth)", () => {
  raw("issued with HttpOnly + Secure + SameSite + scoped to platform parent", async ({
    browser,
  }) => {
    raw.setTimeout(60_000);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await cognitoLogin(page);

      const sso = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(
        sso,
        `Pre-condition: ${AUTH_COOKIE} cookie must exist after successful login`,
      ).toBeDefined();

      expect(
        sso!.httpOnly,
        "HttpOnly must be true — JavaScript on any foss subdomain must NOT be able to read the SSO cookie. An XSS bug anywhere in the bundle would otherwise become full SSO theft.",
      ).toBe(true);

      expect(
        sso!.secure,
        "Secure must be true — the SSO cookie must never travel over plaintext HTTP. A network observer would otherwise capture the session token.",
      ).toBe(true);

      expect(
        ["Lax", "Strict"].includes(sso!.sameSite ?? ""),
        `SameSite must be Lax or Strict (was ${JSON.stringify(sso!.sameSite)}). 'None' or unset expands the CSRF surface beyond /oauth2/sign_out — any cross-site form POST to a foss host would carry the SSO cookie.`,
      ).toBe(true);

      // Playwright may return the cookie Domain with or without a
      // leading dot depending on browser normalisation. Strip and
      // compare against the expected platform parent — any wider
      // value (e.g. ".arbisoft.com" when COOKIE_DOMAIN is
      // "foss.arbisoft.com") would leak the cookie to unrelated
      // subdomains.
      const domain = (sso!.domain ?? "").replace(/^\./, "");
      expect(
        domain,
        `Cookie Domain (${JSON.stringify(sso!.domain)}) must be exactly the platform parent (${COOKIE_DOMAIN}). A wider domain would leak the SSO cookie to unrelated subdomains of the registrable suffix.`,
      ).toBe(COOKIE_DOMAIN);

      // Path should be the document root so the cookie is sent on
      // every path under the foss hosts (anything narrower would
      // break the SSO chain on first sub-path navigation).
      expect(
        sso!.path,
        `Cookie Path must be "/" so the SSO cookie reaches every protected route. Got: ${JSON.stringify(sso!.path)}`,
      ).toBe("/");
    } finally {
      await ctx.close();
    }
  });
});
