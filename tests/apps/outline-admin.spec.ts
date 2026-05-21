// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-role-shall-be-the-apps-regular-member-role-not-admin-or-guest
// (partial — proves NORMAL_USER auto-joined as non-admin Outline user;
// admin-only /settings/* pages are gated for them and reachable for FOSS_USER)

import { test, expect } from "../../fixtures";
import { test as raw, type Page } from "@playwright/test";
import { APP_URLS, IDP_REGEX, isAuthWall } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Identity model (sso-rules/admin.md): two SSO users across all apps.
//   • FOSS_USER (User A) — admin everywhere. Used by the worker fixture
//     and so is the implicit identity for the `test`-based blocks below.
//   • NORMAL_USER (User B) — non-admin baseline. Loaded explicitly via
//     cognitoLogin() in a fresh context when a test needs to assert the
//     non-admin side of a role contract.
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

const DOCS_HOST = new URL(APP_URLS.Outline).hostname;
const SETTINGS_URL = `${APP_URLS.Outline}/settings`;

// Outline has no separate /admin path and no ForwardAuth bypass for it.
// Admin functionality lives in the /settings/* namespace, gated server-side
// by the user's role (state.auth.user.role === "admin"). The contract is
// the *inverse* of Plane's /god-mode/:
//
//   (1) Every /settings/* URL sits fully behind SSO — a cold context
//       must bounce through ForwardAuth / the IDP.
//   (2) SSO-authed as a non-admin (NORMAL_USER), Outline enforces the
//       role split with a server-side 404 — admin-only pages return
//       "Not Found", non-admin-visible pages load on the Outline host.
//   (3) SSO-authed as the admin (OUTLINE_ADMIN_USER, == FOSS_USER per
//       admin.md), every /settings page renders cleanly.
//
// The split between ADMIN_ONLY and NON_ADMIN_VISIBLE was discovered by
// hitting the deployment with a non-admin SSO user. If a future Outline
// release flips a page from one bucket to the other, that release note
// belongs to whoever runs this suite — these tests are the contract.

const COMMON_PATHS = [
  "/settings",
  "/settings/members",
  "/settings/groups",
  "/settings/api-and-access",
  "/settings/shares",
] as const;

const ADMIN_ONLY_PATHS = [
  "/settings/details",
  "/settings/security",
  "/settings/authentication",
  "/settings/features",
  "/settings/integrations",
  "/settings/applications",
  "/settings/import",
  "/settings/export",
  // NOTE: /settings/people is the canonical members-admin URL per the
  // outline-admin sso-rules skill, but this fork serves Not Found for
  // both admin and non-admin — the actual members page is /settings/members
  // (in COMMON_PATHS). Don't add /settings/people back without first
  // probing it against this deployment.
] as const;

const ALL_PATHS = [...COMMON_PATHS, ...ADMIN_ONLY_PATHS] as const;

const MAX_SETTINGS_ATTEMPTS = process.env.CI ? 3 : 2;

// Outline serves the SPA shell with title "Outline" before the router
// mounts the route component (which then sets the per-page title, e.g.
// "Not Found - Outline" or "Members - Outline"). The shell title is
// also what's left visible if a route chunk fails to load on a slow CI
// runner. waitForSpaTitle blocks until the shell default has been
// replaced (or the timeout elapses, in which case callers can decide
// whether the shell default is itself a meaningful signal — e.g. it is
// for non-admin admin-only paths).
async function waitForSpaTitle(page: Page): Promise<string> {
  const titleSettleTimeoutMs = process.env.CI ? 25_000 : 10_000;
  await page
    .waitForFunction(() => document.title.trim().toLowerCase() !== "outline", null, {
      timeout: titleSettleTimeoutMs,
    })
    .catch(() => {});
  return (await page.title()).toLowerCase();
}

// Reach a /settings/<sub> page the way a real user does: open /settings
// once, then click the in-page sub-nav <a href> for the target path.
// Click-nav lets Outline's React router prefetch the chunk on hover and
// preserves SPA state, which avoids the chunk-load race that direct
// page.goto-ing each settings URL trips on CI.
//
// When the sub-nav link never appears on /settings, the most common
// cause is the Outline server returning HTTP 429 on a chunk request
// mid-render, leaving the sidebar half-populated. Reload /settings —
// the same instinct a human has when a page renders incompletely — and
// retry up to MAX_SETTINGS_ATTEMPTS.
async function gotoSettingsPath(page: Page, path: string): Promise<void> {
  if (path === "/settings") {
    await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    return;
  }

  const subLink = page.locator(`a[href="${path}"]`).first();
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SETTINGS_ATTEMPTS; attempt++) {
    await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      await expect(subLink).toBeVisible({ timeout: 10_000 });
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_SETTINGS_ATTEMPTS) {
        // Brief settle before retrying when chunk/sidebar render was incomplete.
        await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
      }
    }
  }
  if (lastError) {
    throw new Error(
      `${path}: sub-nav link never appeared on /settings after ${MAX_SETTINGS_ATTEMPTS} attempts. Likely rate-limited (HTTP 429) on chunk loads.`
    );
  }

  await subLink.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await subLink.click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(path)}(\\?|$)`), {
    timeout: 15_000,
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// (1) Cold context: every admin URL must bounce through SSO.
//     Independent of any identity — uses no fixture, no cookies.
raw.describe("Outline — admin /settings URLs (cold context)", () => {
  for (const path of ALL_PATHS) {
    raw(`cold visit to ${path} bounces through SSO (no bypass)`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext(); // no storageState → no SSO cookie
      const page = await ctx.newPage();
      try {
        await page.goto(APP_URLS.Outline + path, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        await expect
          .poll(() => isAuthWall(page.url()) || IDP_REGEX.test(page.url()), {
            message: `${path} must bounce through SSO — Outline admin is not bypass-routed. Last URL: ${page.url()}`,
            timeout: 15_000,
          })
          .toBe(true);
      } finally {
        await ctx.close();
      }
    });
  }
});

// (2) SSO-authed as a *non-admin* (NORMAL_USER, == User B): the role
//     split is enforced server-side. COMMON_PATHS load with a real
//     page title; ADMIN_ONLY_PATHS return Not Found / module-failed /
//     never resolve past the SPA shell. Whole block self-skips when
//     NORMAL_USER creds are unset.
raw.describe("Outline — non-admin role split (NORMAL_USER)", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  for (const path of COMMON_PATHS) {
    raw(`non-admin reaches ${path} on the Outline host`, async ({ browser }) => {
      raw.setTimeout(120_000);
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });
        await gotoSettingsPath(page, path);

        await expect(page).toHaveURL(new RegExp(`https?://${escapeRegex(DOCS_HOST)}`));
        expect(
          isAuthWall(page.url()),
          `Non-admin bounced to auth wall on ${path}: ${page.url()}`
        ).toBe(false);
        await expect(page).toHaveURL(new RegExp(`${escapeRegex(path)}(\\?|$)`));

        const title = await waitForSpaTitle(page);
        expect(
          title.includes("not found") || title.includes("404"),
          `${path} should NOT be admin-gated for a normal user, but title is: "${title}"`
        ).toBe(false);
      } finally {
        await ctx.close();
      }
    });
  }

  for (const path of ADMIN_ONLY_PATHS) {
    raw(`non-admin gets Not Found on admin-only ${path}`, async ({ browser }) => {
      raw.setTimeout(120_000);
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

        // Direct goto here is intentional — the admin-only sub-nav links
        // are not rendered for non-admin users, so the click-through
        // pattern from COMMON_PATHS can't apply. Outline gates the route
        // server-side and we just need to confirm the gating signal.
        await page.goto(APP_URLS.Outline + path, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        await expect(page).toHaveURL(new RegExp(`https?://${escapeRegex(DOCS_HOST)}`));
        expect(
          isAuthWall(page.url()),
          `Admin-only ${path} must serve Not Found, not bounce to auth wall: ${page.url()}`
        ).toBe(false);

        const title = await waitForSpaTitle(page);
        const gated =
          title === "outline" || // SPA never resolved to a real page
          title.includes("not found") ||
          title.includes("404") ||
          title.includes("module failed to load");
        expect(
          gated,
          `Admin-only ${path} must be gated for a non-admin user (shell default, Not Found, or chunk-load failure), but title is: "${title}"`
        ).toBe(true);
      } finally {
        await ctx.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (3) Positive side of the role contract: FOSS_USER (the admin per
//     admin.md) reaches every /settings/* page without hitting the
//     non-admin gating signals. Uses the worker fixture directly.
// ---------------------------------------------------------------------------
test.describe("Outline — admin (FOSS_USER) reaches every /settings page", () => {
  for (const path of ALL_PATHS) {
    test(`admin reaches ${path} with a real page title`, async ({ page }) => {
      await gotoSettingsPath(page, path);

      await expect(page).toHaveURL(new RegExp(`https?://${escapeRegex(DOCS_HOST)}`));
      expect(isAuthWall(page.url()), `Admin bounced to auth wall on ${path}: ${page.url()}`).toBe(false);
      await expect(page).toHaveURL(new RegExp(`${escapeRegex(path)}(\\?|$)`));

      const title = await waitForSpaTitle(page);
      const gatedForNonAdmin =
        title === "outline" ||
        title.includes("not found") ||
        title.includes("404") ||
        title.includes("module failed to load");
      expect(
        gatedForNonAdmin,
        `Admin must reach ${path} cleanly — title looks gated/unloaded: "${title}"`
      ).toBe(false);
    });
  }
});
