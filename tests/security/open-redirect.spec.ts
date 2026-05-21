// Spec coverage for this file (see docs/spec-coverage.md):
// (no openspec requirement — generic OWASP A01 / open-redirect protection)
// Tracked as orthogonal coverage in spec-coverage-deferred.md.

import { test as raw, expect } from "@playwright/test";
import { MAIN_URL, APPS, FOSS_HOST_REGEX } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Open-redirect protection on the SSO entry point.
//
// oauth2-proxy supports a `?rd=<url>` query parameter on /oauth2/sign_in
// that controls where the user is sent after a successful login. If
// this parameter is *not* whitelist-validated against the upstream
// domain, an attacker can craft a phishing link:
//
//     https://foss.${PLATFORM_DOMAIN}/oauth2/sign_in?rd=https://attacker.example.com
//
// → user clicks, sees a legitimate Cognito login form, enters real
//   credentials → post-login redirect goes to attacker.example.com,
//   which can then mimic an FOSS app and either harvest data or
//   re-prompt for credentials.
//
// The contract: after successful login, the landing URL must be on the
// FOSS platform host. Any attempt to redirect to a foreign host or a
// protocol-relative URL pointing off-host must be rejected (either
// silently dropped or replaced with the default landing page).
//
// Three payload variants exercised:
//   • Absolute external host         (`https://attacker.example.com`)
//   • Protocol-relative external     (`//attacker.example.com`)
//   • Backslash-prefix bypass        (`/\\attacker.example.com`) — a
//                                    common normalisation-gap exploit.

const EXTERNAL_HOST_REGEX = /attacker\.example\.com|evil\.example\.org/i;

const PAYLOADS: { name: string; rd: string }[] = [
  { name: "absolute external https URL", rd: "https://attacker.example.com" },
  { name: "protocol-relative external host", rd: "//attacker.example.com" },
  { name: "backslash-prefix normalisation bypass", rd: "/\\\\attacker.example.com" },
  { name: "double-slash + external host", rd: "///attacker.example.com" },
];

raw.describe("Open-redirect protection on /oauth2/sign_in?rd= (OWASP A01)", () => {
  for (const app of APPS) {
    for (const payload of PAYLOADS) {
      raw(`${app.name}: post-login does NOT bounce to attacker host for rd=${payload.name}`, async ({
        browser,
      }) => {
        raw.setTimeout(120_000);
        const ctx = await browser.newContext(); // cold — no SSO cookie
        const page = await ctx.newPage();
        try {
          // Cold navigation to the /oauth2/sign_in endpoint with the
          // malicious rd payload. oauth2-proxy will redirect to the
          // IDP and stash the rd into OIDC state.
          const malicious = `${app.url}/oauth2/sign_in?rd=${encodeURIComponent(payload.rd)}`;
          await page.goto(malicious, { waitUntil: "domcontentloaded", timeout: 30_000 });

          // Complete the SSO form. cognitoLogin handles the IDP form
          // fill + waits for return to a FOSS_HOST_REGEX URL.
          await cognitoLogin(page);

          // Final landing MUST be on a foss subdomain. If oauth2-proxy
          // honoured the malicious rd, the user is now on the attacker
          // host (or a path that can be controlled by it).
          const landed = page.url();
          expect(
            landed,
            `Open-redirect bypass: rd=${payload.rd} sent post-login user to ${landed}`
          ).toMatch(FOSS_HOST_REGEX);
          expect(
            landed,
            `Open-redirect bypass: rd=${payload.rd} surfaced in final URL`
          ).not.toMatch(EXTERNAL_HOST_REGEX);
        } finally {
          await ctx.close();
        }
      });
    }
  }
});
