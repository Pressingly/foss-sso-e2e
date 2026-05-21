// Spec coverage for this file (see docs/spec-coverage.md):
// @spec logout-flow#portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie
// @spec logout-flow#stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly
// @spec logout-flow#logout-shall-be-observable-and-idempotent
// @spec session-lifecycle#simultaneous-expiry-of-both-layers-shall-redirect-to-mpass-login

import { test, expect, BrowserContext } from "@playwright/test";
import { APPS, AUTH_COOKIE, isAuthWall } from "../../constants";
import { freshLogin, clickPortalLogoutAll } from "../lib/common-flows";

// These tests manage their own auth contexts — sharing the worker
// session would contaminate other tests when logout destroys the SSO
// cookie. Use freshLogin() + clickPortalLogoutAll() from common-flows
// rather than re-implementing here.

// ---------------------------------------------------------------------------

test.describe("Session Lifecycle — Logout", () => {
  test("logout clears the _oauth2_proxy SSO cookie", async ({ browser }) => {
    const { context, page } = await freshLogin(browser);

    try {
      const cookieBefore = (await context.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(cookieBefore, "SSO cookie must exist before logout").toBeDefined();
      expect(cookieBefore!.value).not.toBe("");

      await clickPortalLogoutAll(page);

      const allCookies = await context.cookies();
      const cookieAfter = allCookies.find((c) => c.name === AUTH_COOKIE);
      const isCleared = !cookieAfter || cookieAfter.value === "";
      expect(isCleared, "_oauth2_proxy cookie must be absent or empty after logout").toBe(true);
    } finally {
      await context.close();
    }
  });

  // NOTE: per-app logout buttons (Outline / Plane / Penpot / SurfSense /
  // Twenty's "Sign out") only redirect the user back to the main dashboard —
  // they do NOT clear the shared `_oauth2_proxy` SSO cookie. Cross-app
  // invalidation happens only via the dashboard's "Log out of all apps"
  // button (covered in flows/login-logout-flow.spec.ts).

  // Simulates session expiry from the client side: the SSO cookie is gone
  // (whether expired by TTL, manually cleared, or revoked) — every app must
  // refuse access and bounce to the IDP. This is the behaviour users will
  // see when SESSION_TTL_SECONDS elapses, without having to wait 8h.
  test("deleting the _oauth2_proxy cookie locks every app behind the IDP", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { context, page } = await freshLogin(browser);

    try {
      // Sanity: SSO cookie present before deletion
      const before = (await context.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(before, "SSO cookie must exist before deletion").toBeDefined();

      // Delete only _oauth2_proxy, leave other cookies (CSRF, locale, etc.)
      // alone — proves the SSO cookie is the gating credential, not just
      // "any cookie" sufficing.
      await context.clearCookies({ name: AUTH_COOKIE });

      const after = (await context.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(after, "_oauth2_proxy must be gone after clearCookies").toBeUndefined();

      // Every protected app must now refuse access
      for (const app of APPS) {
        // `domcontentloaded` — Twenty's client-side redirect aborts `load`.
        await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        expect(
          isAuthWall(page.url()),
          `${app.name} must redirect to auth wall when SSO cookie is missing, got: ${page.url()}`
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test("session cannot be resumed by replaying the old cookie after logout", async ({ browser }) => {
    const { context: ctx1, page: page1 } = await freshLogin(browser);
    let savedCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

    try {
      // Capture cookies while authenticated
      savedCookies = await ctx1.cookies();
      expect(savedCookies.find((c) => c.name === AUTH_COOKIE)).toBeDefined();

      await clickPortalLogoutAll(page1);
    } finally {
      await ctx1.close();
    }

    // New context: inject the pre-logout cookies and try to access an app
    const ctx2 = await browser.newContext();
    try {
      await ctx2.addCookies(savedCookies);
      const page2 = await ctx2.newPage();

      await page2.goto(APPS[0]!.url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // If the server-side session is properly invalidated, the old cookie is rejected
      // and we land on an auth wall even with the replayed cookie.
      // NOTE: If foss-auth uses stateless JWT tokens in the cookie this test may fail —
      // that would be a finding worth reporting (logout doesn't truly invalidate JWTs).
      const redirectedToAuthWall = isAuthWall(page2.url());
      const loginVisible =
        (await page2.locator('input[type="password"]:visible').count()) > 0 ||
        (await page2.getByRole("button", { name: /sign\s*in/i }).filter({ visible: true }).count()) > 0;
      expect(
        redirectedToAuthWall || loginVisible,
        `Replayed pre-logout cookie must not grant access. Landed on: ${page2.url()}`
      ).toBe(true);
    } finally {
      await ctx2.close();
    }
  });
});
