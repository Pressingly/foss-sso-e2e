// ZAP recording driver — NOT a unit test.
//
// This spec is excluded from default discovery (see playwright.config.ts
// testIgnore) and is run ONLY by .github/workflows/zap-authed-sso.yml
// with HTTP_PROXY pointed at a local ZAP daemon. Playwright drives the
// SSO chain end-to-end, ZAP records every request/response (including
// auth bounces, set-cookies, redirect chains), then the workflow asks
// ZAP to active-scan the recorded URLs and emit an HTML report.
//
// Scope is deliberately tight — the SSO chain (portal + oauth2-proxy
// + mPass IDP), NOT the 5 apps' interiors. App interiors are upstream
// OSS; findings there aren't actionable from this repo.
//
// What ZAP looks at (post-recording active scan):
//   • Reflected XSS in error pages (e.g. `?rd=` rendered into the page)
//   • Path traversal on redirect_uri-style parameters
//   • Missing/weak security headers on authenticated responses
//   • Cookie attribute drift (HttpOnly / Secure / SameSite)
//   • Open redirect / CRLF injection
//   • HTTP method tampering surfaces
//
// Many of these are also covered by hand-written specs under
// tests/security/. ZAP's value is fuzzing + payload variety, not
// novel coverage.

import { test } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import { MAIN_URL, APP_URLS, AUTH_PROXY_DOMAIN } from "../../constants";

// ZAP's MITM cert is self-signed; Playwright must ignore TLS errors
// while routing through the proxy.
test.use({ ignoreHTTPSErrors: true });

test("ZAP recording driver: exercise the SSO chain", async ({ page, context }) => {
  test.setTimeout(180_000);

  // 1. Unauthenticated portal → IDP bounce. ZAP records the unauth
  //    surface of the SSO chain.
  await page.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // 2. Full login through mPass. cognitoLogin walks the IDP method
  //    picker + form, then waits for the bounce back to a foss host.
  //    This is the highest-value recording — every oauth2-proxy / mpass
  //    state cookie and redirect lands in ZAP's history here.
  await cognitoLogin(page);

  // 3. Visit each app once. We're after the per-app SSO bounce
  //    (`/oauth2/auth` ForwardAuth dance + cookie issuance), NOT the
  //    apps' interior pages. domcontentloaded keeps the recording
  //    quick — we don't need the SPA fully hydrated.
  for (const url of [APP_URLS.Outline, APP_URLS.PM, APP_URLS.Penpot, APP_URLS.SurfSense, APP_URLS.Twenty]) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }

  // 4. Direct hits on oauth2-proxy endpoints — surfaces ZAP doesn't
  //    discover from the SPA crawl (most apps never link to these).
  for (const path of ["/oauth2/sign_in", "/oauth2/auth", "/oauth2/userinfo"]) {
    await page
      .goto(`https://${AUTH_PROXY_DOMAIN}${path}`, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => {});
  }

  // 5. Portal logout — exercises /mpass/logout and the across-apps
  //    sign_out fan-out. ZAP gets to see the logout chain for free.
  await page.goto(`${MAIN_URL}/logout`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

  // Touching context here is just to silence the unused-arg lint;
  // ZAP recording happens at the HTTP layer regardless.
  void context;
});
