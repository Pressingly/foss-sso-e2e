// Spec coverage for this file (see docs/spec-coverage.md):
// @spec forwardauth-traefik#bypass-routes-per-app-shall-match-the-documented-list
// @spec proxy-auth-middleware#bypass-paths-shall-short-circuit-before-any-auth-processing
// (Plane's /god-mode and /auth/get-csrf-token are the per-app bypass
// routes asserted by the documented-list requirement; the local-creds
// login behaviour proves the proxy-auth-middleware short-circuit
// requirement at the per-app layer.)

import { test, expect } from "../../fixtures";
import { test as raw, type Page, type Locator } from "@playwright/test";
import {
  APP_URLS,
  AUTH_COOKIE,
  AUTH_PROXY_DOMAIN,
  IDP_HOSTS,
  isAuthWall,
  escapeHostForRegex,
} from "../../constants";

const GODMODE_URL = `${APP_URLS.PM}/god-mode/`;
const CSRF_URL    = `${APP_URLS.PM}/auth/get-csrf-token/`;
const PM_HOST     = new URL(APP_URLS.PM).hostname;
const PM_HOST_REGEX = new RegExp(`^https?://${escapeHostForRegex(PM_HOST)}`);

const ADMIN_USER = process.env.PLANE_ADMIN_USER;
const ADMIN_PASS = process.env.PLANE_ADMIN_PASS;

// god-mode is the Plane admin console. It exposes its own admin login that
// is independent of the SSO IDP — admins authenticate against Plane directly.
//
// Two angles are tested:
//   (1) Cold-context: hitting /god-mode/ without any SSO cookie must NOT
//       redirect through oauth2-proxy / ForwardAuth → IDP. This is the strict
//       bypass invariant.
//   (2) SSO-authed (matches a normal browser session): /god-mode/ renders
//       Plane's own email + password form, and an admin can sign in to reach
//       the admin console.

function emailLocator(page: Page): Locator {
  return page
    .locator('input[type="email"], input[name="email"], input[name="username"]')
    .first();
}

function passwordLocator(page: Page): Locator {
  return page.locator('input[type="password"]').first();
}

function submitButton(page: Page): Locator {
  return page.getByRole("button", { name: /sign in|log in|login|submit/i }).first();
}

test.describe("Plane (PM) — god-mode bypasses ForwardAuth", () => {
  // --- (1) Strict bypass invariant: cold context, no SSO cookie ---
  raw("cold visit to /god-mode/ does NOT redirect through ForwardAuth/IDP", async ({
    browser,
  }) => {
    const ctx = await browser.newContext(); // no storageState → no SSO cookie
    const page = await ctx.newPage();
    try {
      await page.goto(GODMODE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Must stay on the Plane host — not bounce through ForwardAuth, the
      // IDP, or any auth wall. One toHaveURL covers the host invariant;
      // the negative checks below cover the bypass intent.
      await expect(page).toHaveURL(PM_HOST_REGEX);
      const landed = page.url();
      expect(
        landed.includes(AUTH_PROXY_DOMAIN),
        `god-mode bounced through ForwardAuth (${AUTH_PROXY_DOMAIN}) — bypass router missing. Landed: ${landed}`
      ).toBe(false);
      expect(
        IDP_HOSTS.some((h) => landed.includes(h)),
        `god-mode bounced to IDP (${IDP_HOSTS.join("/")}) — bypass router missing. Landed: ${landed}`
      ).toBe(false);
      expect(
        isAuthWall(landed),
        `god-mode hit auth wall — bypass not in place. Landed: ${landed}`
      ).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  // --- (2) Authed visit: matches "direct load in your browser" ---
  test("god-mode renders Plane's own admin login form", async ({ page }) => {
    await page.goto(GODMODE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    await expect(page).toHaveURL(/\/god-mode/);
    await expect(page).toHaveURL(PM_HOST_REGEX);

    await expect(
      emailLocator(page),
      "god-mode must expose a direct email input (Plane admin form, not SSO IDP)"
    ).toBeVisible({ timeout: 10000 });
    await expect(
      passwordLocator(page),
      "god-mode must expose a direct password input (Plane admin form, not SSO IDP)"
    ).toBeVisible({ timeout: 10000 });
  });

  test("admin can sign in via god-mode and reach the admin console", async ({ page }) => {
    test.skip(
      !ADMIN_USER || !ADMIN_PASS,
      "Set PLANE_ADMIN_USER and PLANE_ADMIN_PASS in .env to run this test"
    );

    await page.goto(GODMODE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const emailInput = emailLocator(page);
    await expect(emailInput).toBeVisible({ timeout: 10000 });
    await emailInput.fill(ADMIN_USER!);
    await passwordLocator(page).fill(ADMIN_PASS!);
    await submitButton(page).click({ timeout: 10000 });

    // The form disappears on successful login — a stronger signal than a
    // URL check, since /god-mode itself is the post-login destination.
    await expect(
      passwordLocator(page),
      "Admin login form should disappear after successful sign-in"
    ).not.toBeVisible({ timeout: 15000 });

    // Plane POSTs to /api/instances/admins/sign-in/ and the SPA only
    // routes back to /god-mode once the backend's 200 response lands.
    // When Plane is slow (e.g. cold app or transient gateway timeout)
    // the URL can sit on the API endpoint for several seconds before
    // the SPA navigates. Allow up to 20s for the URL to settle.
    await expect(page).toHaveURL(/\/god-mode/, { timeout: 20_000 });
    await expect(page).toHaveURL(PM_HOST_REGEX);
    expect(isAuthWall(page.url()), `Admin must not bounce to SSO chain: ${page.url()}`).toBe(false);
  });

  // --- (3) Negative: wrong creds rejected ---
  test("god-mode rejects an incorrect password", async ({ browser }) => {
    test.skip(!ADMIN_USER, "Set PLANE_ADMIN_USER in .env to run this test");
    test.setTimeout(60_000);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(GODMODE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      const emailInput = emailLocator(page);
      await expect(emailInput).toBeVisible({ timeout: 10000 });
      await emailInput.fill(ADMIN_USER!);
      await passwordLocator(page).fill("definitely-not-the-real-password-" + Date.now());
      await submitButton(page).click({ timeout: 10000 });

      // Wrong creds → form must stay rendered, URL must stay on /god-mode.
      await expect(
        passwordLocator(page),
        "Password field must remain visible after wrong-password attempt"
      ).toBeVisible({ timeout: 10000 });
      await expect(page).toHaveURL(/\/god-mode/);
    } finally {
      await ctx.close();
    }
  });

  // --- (4) /auth/get-csrf-token bypass — needed before the login POST ---
  raw("/auth/get-csrf-token bypasses ForwardAuth (cold context)", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const res = await page.goto(CSRF_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      await expect(page).toHaveURL(PM_HOST_REGEX);
      expect(
        isAuthWall(page.url()),
        `/auth/get-csrf-token bounced to auth wall: ${page.url()}`
      ).toBe(false);
      // Endpoint returns 200 with JSON {csrf_token: ...}. Pin it exactly:
      // accepting any < 400 would let a 3xx redirect INTO the auth chain
      // pass as a clean bypass (the very thing this test guards against).
      expect(res?.status(), "CSRF endpoint should return 200 (JSON {csrf_token})").toBe(200);
    } finally {
      await ctx.close();
    }
  });

  // --- (5) Independence: admin sign-in does NOT touch the SSO cookie ---
  test("god-mode admin login does not affect the SSO _oauth2_proxy cookie", async ({
    browser,
  }) => {
    test.skip(
      !ADMIN_USER || !ADMIN_PASS,
      "Set PLANE_ADMIN_USER and PLANE_ADMIN_PASS in .env to run this test"
    );

    // Fresh context so we don't pollute the worker session.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(GODMODE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      const cookiesBefore = await ctx.cookies();
      const ssoBefore = cookiesBefore.find((c) => c.name === AUTH_COOKIE);
      // Cold context — there shouldn't be one. Document the assumption.
      expect(ssoBefore, "Fresh context must have no SSO cookie pre-login").toBeUndefined();

      const emailInput = emailLocator(page);
      await expect(emailInput).toBeVisible({ timeout: 10000 });
      await emailInput.fill(ADMIN_USER!);
      await passwordLocator(page).fill(ADMIN_PASS!);
      await submitButton(page).click({ timeout: 10000 });

      // Wait for the form to clear — confirms login completed before we
      // sample cookies (otherwise a race could read pre-login state).
      await expect(passwordLocator(page)).not.toBeVisible({ timeout: 15000 });

      // After admin login: still no SSO cookie. god-mode is its own session
      // universe — it doesn't (and must not) issue the platform-wide
      // _oauth2_proxy cookie.
      const cookiesAfter = await ctx.cookies();
      const ssoAfter = cookiesAfter.find((c) => c.name === AUTH_COOKIE);
      expect(
        ssoAfter,
        `god-mode login must not issue the SSO cookie. Found: ${JSON.stringify(ssoAfter)}`
      ).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
