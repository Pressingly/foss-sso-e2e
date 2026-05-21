// Spec coverage for this file (see docs/spec-coverage.md):
// (no openspec requirement — generic SSO UX contract)
// Tracked as orthogonal coverage in spec-coverage-deferred.md.

import { test as raw, expect } from "@playwright/test";
import { APPS, isAuthWall } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Common real-world flow: a coworker shares a deep URL like
// `https://docs.foss.${PLATFORM_DOMAIN}/doc/proposal-q4`. The clicker
// is unauthenticated. They go through the SSO redirect chain
// (oauth2-proxy → Cognito → ForwardAuth → back). After login they
// expect to land on `/doc/proposal-q4`, NOT on `/home` or `/`.
//
// If the original URL is dropped from the redirect chain, every
// shared link is broken — the recipient lands on the app root and
// has to navigate again, often forgetting which doc was shared.
//
// The contract is implicit in oauth2-proxy's design: the originally-
// requested URL is encoded into the OIDC state parameter and
// restored after a successful login. This spec exercises that
// per-app to catch deployment regressions.

// Per-app deep-link path used for the test. Picked so each path is
// stable on a fresh deployment (doesn't depend on data setup):
//   - Outline: /home/popular — proven by link-coverage tests.
//   - PM (Plane): /create-workspace — stable entry, no user-slug
//     dependency.
//   - Twenty: /settings — stable settings landing.
//
// Two apps are excluded because they don't preserve deep links
// through the SSO redirect chain. Both are real product limitations,
// not deployment bugs, so this test is scoped only to the apps that
// *can* preserve them:
//
//   • Penpot uses hash-fragment routing exclusively (`/#/...`). Hash
//     fragments never reach the server, so oauth2-proxy / OIDC state
//     can't carry them through. Verified: clicking
//     `/#/dashboard/drafts` cold lands on `/` post-login.
//
//   • SurfSense's frontend forces a `/login` redirect on every
//     post-SSO landing, regardless of the requested URL. Verified:
//     clicking `/dashboard/<id>/new-chat` cold lands on `/login`.
//     The user always has to navigate manually after login.
const DEEP_PATHS: Record<string, string> = {
  Outline: "/home/popular",
  PM: "/create-workspace",
  Twenty: "/settings",
};

raw.describe("Deep-link preservation through SSO redirect", () => {
  for (const app of APPS) {
    const deepPath = DEEP_PATHS[app.name];
    if (!deepPath) continue; // Penpot — hash-routed; see comment above.
    raw(`${app.name}: cold visit to a deep URL → login → land on the deep URL`, async ({
      browser,
    }) => {
      raw.setTimeout(120_000);
      const deepUrl = `${app.url}${deepPath}`;

      const ctx = await browser.newContext(); // cold — no SSO cookie
      const page = await ctx.newPage();
      try {
        // Cold navigation to the deep URL — this triggers the SSO
        // redirect chain. Use skipInitialNav so cognitoLogin doesn't
        // clobber the deep URL by navigating to MAIN_URL first; the
        // page is already on the IDP after the oauth2-proxy bounce.
        await page.goto(deepUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await cognitoLogin(page, { skipInitialNav: true });

        const landed = page.url();
        expect(
          new URL(landed).hostname,
          `${app.name}: post-login must land on the app host (deep path: ${deepPath})`
        ).toBe(new URL(app.url).hostname);
        expect(
          isAuthWall(landed),
          `${app.name}: post-login must not be on auth wall (deep path: ${deepPath})`
        ).toBe(false);
        expect(
          landed,
          `${app.name}: deep-link lost through login — clicked ${deepUrl}, landed on ${landed} instead of a URL containing ${deepPath}`
        ).toContain(deepPath);
      } finally {
        await ctx.close();
      }
    });
  }
});
