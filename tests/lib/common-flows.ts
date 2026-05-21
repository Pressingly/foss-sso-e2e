import { Browser, BrowserContext, Page, expect } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import { MAIN_URL } from "../../constants";

// Shared end-to-end helpers used by multiple spec files. Each helper
// here was originally redefined per-spec with subtle variations (see
// the git blame on this file for the consolidation). Re-using the
// canonical versions keeps the SSO choreography identical across
// tests so a future change to login or portal-logout shape only has
// to land in one place.

/**
 * Create a fresh BrowserContext + Page and complete an SSO login
 * via cognitoLogin(). Returns the context and page; the caller is
 * responsible for `await context.close()` in a finally block.
 *
 * This is the canonical replacement for the per-file `freshLogin` /
 * `loginFreshContext` patterns that proliferated across the suite.
 */
export async function freshLogin(
  browser: Browser
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await cognitoLogin(page);
  return { context, page };
}

/**
 * Navigate the given page to the main portal, find the "Log out of
 * all apps" button or link, and click it. Returns after the
 * post-click navigation has had a chance to settle.
 *
 * Replaces the per-file `clickPortalLogoutAll` / `performLogout`
 * variations. The selector intentionally accepts both "Log out" and
 * "Sign out" wording and both button/link element types — the
 * portal's exact markup has changed across releases.
 */
export async function clickPortalLogoutAll(page: Page): Promise<void> {
  await page.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const LOGOUT_ALL_RE =
    /log\s*out\s*(of\s*)?all(\s*apps)?|sign\s*out\s*(of\s*)?all(\s*apps)?|log\s*out|sign\s*out/i;
  const logoutControl = page
    .getByRole("button", { name: LOGOUT_ALL_RE })
    .or(page.getByRole("link", { name: LOGOUT_ALL_RE }))
    .first();

  await expect(
    logoutControl,
    "main portal must expose a 'Logout' / 'Logout all' control"
  ).toBeVisible({ timeout: 10_000 });
  await logoutControl.click({ timeout: 10_000 });

  // Logout flows may redirect through oauth2-proxy or back to the portal.
  // Wait only for the document transition; callers assert cookies/URL state.
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
}
