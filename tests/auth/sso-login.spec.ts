// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#unauthenticated-requests-with-a-valid-proxy-identity-shall-auto-provision-and-log-in
// @spec oauth2-proxy-gateway#cookie-domain-shall-be-the-platform-parent-domain
// @spec session-lifecycle#the-system-shall-maintain-two-distinct-session-layers

import { test, expect } from "../../fixtures";
import { BrowserContext, Page } from "@playwright/test";
import {
  APP_URLS,
  MAIN_URL,
  AUTH_COOKIE,
  COOKIE_DOMAIN,
  COOKIE_DOMAIN_REGEX,
  isAuthWall,
} from "../../constants";

const SESSION_LS_KEY = "foss_cognito_alive_ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOauthCookie(context: BrowserContext) {
  const cookies = await context.cookies(MAIN_URL);
  return cookies.find((c) => c.name === AUTH_COOKIE);
}

async function isOnAuthWall(page: Page): Promise<boolean> {
  return isAuthWall(page.url());
}

// ---------------------------------------------------------------------------
// Tests — storageState already injected via playwright.config.ts
// ---------------------------------------------------------------------------

test.describe("SSO Login Flow", () => {
  test("authenticated session lands on FOSS platform, not Cognito", async ({ page, context }) => {
    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });

    expect(await isOnAuthWall(page)).toBe(false);
    expect(page.url()).toContain(COOKIE_DOMAIN);

    // Anti-vacuous-pass: a misconfigured proxy that sets cookies but
    // rejects every subsequent request with 401 would still pass the URL
    // check above. Probe Plane's /me endpoint to prove the session is
    // genuinely accepted by at least one backend, not just visually
    // routed away from Cognito.
    const res = await context.request.get(`${APP_URLS.PM}/api/users/me/`);
    expect(
      res.status(),
      `/api/users/me/ rejected the SSO-derived session (status ${res.status()}). Landing URL alone is not sufficient: the proxy may set cookies but reject backend requests when ProxyAuthMiddleware is misconfigured or its env vars diverge from oauth2-proxy.`
    ).toBe(200);
    const body = (await res.json()) as { email?: string };
    expect(body.email, "Plane /me must return an email for the authenticated user").toMatch(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    );
  });

  test(`_oauth2_proxy cookie present on .${COOKIE_DOMAIN} after login`, async ({ context }) => {
    const cookie = await getOauthCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie!.domain).toMatch(COOKIE_DOMAIN_REGEX);
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
  });

  test("_oauth2_proxy cookie has SameSite=Lax (allows cross-subdomain sharing)", async ({
    context,
  }) => {
    const cookie = await getOauthCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie!.sameSite).toBe("Lax");
  });

  test("session localStorage key set after login", async ({ page }) => {
    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });

    const val = await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), SESSION_LS_KEY), {
        message: `${SESSION_LS_KEY} should be written after authenticated portal load`,
        timeout: 15_000,
      })
      .not.toBeNull()
      .then(() => page.evaluate((key) => localStorage.getItem(key), SESSION_LS_KEY));
    expect(val).not.toBeNull();

    const ts = parseInt(val!, 10);
    expect(ts).toBeGreaterThan(0);
    // timestamp should be recent (within last 24h)
    expect(Date.now() - ts).toBeLessThan(24 * 60 * 60 * 1000);
  });

});

// ---------------------------------------------------------------------------
// Session persistence across navigation
// ---------------------------------------------------------------------------

test.describe("Session Persistence", () => {
  test("session survives reload + revisit (cookie unchanged, no re-auth)", async ({
    page,
    context,
  }) => {
    const cookieBefore = await getOauthCookie(context);
    expect(cookieBefore, "SSO cookie must exist before navigation").toBeDefined();

    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });
    const firstUrl = page.url();

    await page.reload({ waitUntil: "domcontentloaded" });

    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });

    // Cookie value unchanged — no silent re-auth handshake
    const cookieAfter = await getOauthCookie(context);
    expect(cookieAfter).toBeDefined();
    expect(cookieAfter!.value).toBe(cookieBefore!.value);

    // No bounce to Cognito, lands on the same URL
    expect(await isOnAuthWall(page)).toBe(false);
    expect(page.url()).toBe(firstUrl);
  });
});
