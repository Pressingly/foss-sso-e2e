// Spec coverage for this file (see docs/spec-coverage.md):
// @spec logout-flow#portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie
// @spec logout-flow#stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly

import { test, expect } from "../../fixtures";
import { BrowserContext } from "@playwright/test";
import { APPS, AUTH_COOKIE, IDP_HOSTS, IDP_REGEX, MAIN_URL, isAuthWall } from "../../constants";
import { freshLogin } from "../lib/common-flows";
import { blockedAppsMessage } from "../lib/app-health-probes";

// oauth2-proxy exposes /oauth2/sign_out on every protected subdomain.
// Hitting it with `rd=` redirects to the main portal after clearing the cookie.
function signOutUrl(appUrl: string): string {
  return `${appUrl}/oauth2/sign_out?rd=${encodeURIComponent(MAIN_URL + "/")}`;
}

async function getSsoCookie(context: BrowserContext) {
  const cookies = await context.cookies();
  return cookies.find((c) => c.name === AUTH_COOKIE);
}

// ---------------------------------------------------------------------------
// Full flow: login once → open all 4 apps → confirm SSO authed across each
// ---------------------------------------------------------------------------

test.describe.serial("E2E Flow — Login + Visit All Apps + Per-App Logout", () => {
  test("login once, then every app loads authenticated without re-auth", async ({
    browser,
    appHealth,
  }) => {
    // Cross-app iteration — when one app's bundle bootstrap is broken
    // (Twenty IdP row missing, SurfSense alembic stale, etc.) this
    // test fails on the broken app's goto. The per-app login smoke
    // catches that case with a named signal; this test skips with
    // the same reason, matching the block-on-smoke pattern applied to
    // the 4 cross-app probes in #28.
    const blocked = blockedAppsMessage(
      appHealth,
      "PM",
      "Outline",
      "Penpot",
      "SurfSense",
      "Twenty",
    );
    test.skip(!!blocked, blocked ?? "");
    test.setTimeout(180_000); // many apps × goto + login can exceed 30s default
    const { context, page } = await freshLogin(browser);

    try {
      const cookie = await getSsoCookie(context);
      expect(cookie, "SSO cookie must be set after login").toBeDefined();

      for (const app of APPS) {
        // `domcontentloaded` — Twenty's client-side redirect aborts `load`.
        const res = await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        expect(res?.status(), `${app.name} HTTP status`).toBeLessThan(400);
        expect(
          isAuthWall(page.url()),
          `${app.name} must NOT bounce to auth wall — got ${page.url()}`
        ).toBe(false);
        expect(
          new URL(page.url()).hostname,
          `${app.name} should stay on its own host`
        ).toBe(new URL(app.url).hostname);
      }
    } finally {
      await context.close();
    }
  });

  test('main portal "Log out of all apps" button kills SSO and every app falls back to the IDP', async ({ browser }) => {
    const { context, page } = await freshLogin(browser);

    try {
      // Sanity: SSO cookie present before logout
      const cookieBefore = await getSsoCookie(context);
      expect(cookieBefore, "SSO cookie must exist pre-logout").toBeDefined();
      expect(cookieBefore!.value).not.toBe("");

      // Land on main portal and click the global Logout All control
      await page.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      const LOGOUT_ALL_RE = /log\s*out\s*(of\s*)?all(\s*apps)?|sign\s*out\s*(of\s*)?all(\s*apps)?/i;
      const logoutAll = page
        .getByRole("button", { name: LOGOUT_ALL_RE })
        .or(page.getByRole("link", { name: LOGOUT_ALL_RE }))
        .first();

      await expect(
        logoutAll,
        "main portal must expose a 'Logout All' control"
      ).toBeVisible({ timeout: 10000 });

      await logoutAll.click({ timeout: 10000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});

      // SSO cookie must be cleared
      const cookieAfter = await getSsoCookie(context);
      const cleared = !cookieAfter || cookieAfter.value === "";
      expect(cleared, `Logout All must clear ${AUTH_COOKIE}`).toBe(true);

      // Every app, when revisited unauthenticated, must bounce off-host to the IDP chain
      // (oauth2-proxy → Cognito or mPass).
      for (const app of APPS) {
        // `domcontentloaded` is fine here — we only need the redirect chain
        // to settle, no client-side rendering needs to be observed.
        await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForURL(IDP_REGEX, { timeout: 20000 }).catch(() => {});

        const landed = page.url();
        expect(
          isAuthWall(landed),
          `${app.name} must hit auth wall (oauth2-proxy or IDP) after logout-all, landed on ${landed}`
        ).toBe(true);
        expect(
          IDP_HOSTS.some((h) => landed.includes(h)),
          `${app.name} should reach an IDP host (${IDP_HOSTS.join(" or ")}), landed on ${landed}`
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  // /oauth2/sign_out endpoint behaviour. Run on one canonical app — the
  // endpoint is provided by oauth2-proxy and is identical on every subdomain,
  // so iterating all 4 was duplicate coverage. The "Log out of all apps"
  // button test above already verifies global propagation across all apps.
  test("/oauth2/sign_out endpoint clears SSO cookie and redirects", async ({ browser }) => {
    const app = APPS[0]!;
    const { context, page } = await freshLogin(browser);

    try {
      await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      expect(isAuthWall(page.url()), `${app.name} must be authed before logout`).toBe(false);

      await page.goto(signOutUrl(app.url), { waitUntil: "domcontentloaded", timeout: 30000 });

      const finalUrl = page.url();
      expect(
        finalUrl.startsWith(MAIN_URL) || isAuthWall(finalUrl),
        `Sign-out should land on main portal or auth wall, got ${finalUrl}`
      ).toBe(true);

      const cookie = await getSsoCookie(context);
      expect(!cookie || cookie.value === "", `${AUTH_COOKIE} must be cleared`).toBe(true);
    } finally {
      await context.close();
    }
  });
});
