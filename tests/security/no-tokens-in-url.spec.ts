// Spec coverage for this file (see docs/spec-coverage.md):
// (no openspec requirement — generic OWASP A09 / sensitive-data-exposure)
// Tracked as orthogonal coverage in spec-coverage-deferred.md.

import { test as raw, expect } from "@playwright/test";
import { APPS, FOSS_HOST_REGEX } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// OWASP A09: never put bearer tokens, IDs, or codes in the URL.
//
// During an OIDC flow, the URL legitimately holds short-lived state /
// authorisation-code values *while bouncing through* the IDP host.
// Once the user lands back on a foss subdomain, the URL bar must be
// clean — no `access_token`, `id_token`, `token`, `code`,
// `authorization_code` parameter, no JWT-shaped fragment.
//
// Why this matters:
//   • Tokens in URLs leak to: browser history, server access logs,
//     reverse-proxy logs, the Referer header on outbound clicks,
//     analytics / Sentry payloads, screenshot tools.
//   • A leaked id_token is a full credential — JWT replay until expiry.
//
// We don't observe just the final URL; the SPA may rewrite it on
// load. We observe every URL the page settled on after the SSO
// callback by polling page.url() during the redirect chain. The
// final settle URL is what counts, plus we sweep the document for
// any visible token-shaped substring (covers cases where the JWT
// has been stashed into a query param by the SPA's own router).

// Each app's URL might *briefly* hold a code during the OIDC dance
// (legitimate, server-decided). But the final settle URL — and any
// post-load URL changes triggered by the SPA — must be clean.
const TOKEN_PARAM_NAMES = [
  "access_token",
  "id_token",
  "token",
  "refresh_token",
  // `code` is part of the legitimate OAuth callback; it's expected to
  // appear briefly on /oauth2/callback?code=... and then disappear.
  // We only flag it if it persists past the final settle.
  "code",
  "authorization_code",
];

// JWT shape: three base64url-encoded segments separated by dots,
// starting with `eyJ` (JSON `{` base64-encoded).
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

function findLeaks(url: string): string[] {
  const out: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return out; // malformed URL is its own problem; this test doesn't claim it.
  }
  for (const name of TOKEN_PARAM_NAMES) {
    if (parsed.searchParams.has(name)) {
      out.push(`query param "${name}" present`);
    }
  }
  if (JWT_RE.test(parsed.search)) {
    out.push("JWT-shaped value in query string");
  }
  if (JWT_RE.test(parsed.hash)) {
    out.push("JWT-shaped value in URL fragment");
  }
  return out;
}

raw.describe("No tokens in URL bar after SSO completes (OWASP A09)", () => {
  for (const app of APPS) {
    raw(`${app.name}: post-login URL has no access_token / id_token / JWT in path, query, or hash`, async ({
      browser,
    }) => {
      raw.setTimeout(120_000);
      const ctx = await browser.newContext(); // cold
      const page = await ctx.newPage();
      try {
        // Visit the app cold so the full SSO chain fires for *this*
        // app's host — different apps land at different post-login
        // URLs and any one of them could leak.
        await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await cognitoLogin(page, { skipInitialNav: true });

        // Give client-side redirects a bounded, URL-based chance to settle.
        await expect
          .poll(() => page.url(), {
            message: `${app.name}: post-login URL should remain on a FOSS host`,
            timeout: 15_000,
          })
          .toMatch(FOSS_HOST_REGEX);

        const settled = page.url();
        expect(
          settled,
          `${app.name}: post-login URL is not on a foss host: ${settled}`
        ).toMatch(FOSS_HOST_REGEX);

        const leaks = findLeaks(settled);
        expect(
          leaks,
          `${app.name}: token leak in URL after login — ${settled}\nLeaks: ${leaks.join(", ")}`
        ).toEqual([]);
      } finally {
        await ctx.close();
      }
    });
  }
});
