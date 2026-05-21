// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-role-shall-be-the-apps-regular-member-role-not-admin-or-guest
// (partial — proves NORMAL_USER auto-joined to SurfSense's shared
// SearchSpace as non-Owner: role-change controls render as static
// text for them, as interactive buttons for FOSS_USER)

import { test, expect } from "../../fixtures";
import { test as raw, type Page } from "@playwright/test";
import { APP_URLS, IDP_REGEX, isAuthWall } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// SurfSense admin contract (foss-server-bundle admin.md):
//   • Admin scope is per-SearchSpace: `search_space_memberships.is_owner = true`.
//     There is no instance admin and no admin URL — admin surfaces live
//     entirely in modal dialogs reached via the SearchSpace-name dropdown.
//   • The SPA renders the "Manage members" modal IDENTICALLY for Owner
//     and non-owner: same heading, same "Invite members" button, same
//     member rows. Gating is API-side AND a single visible UI detail:
//     the role label in each *other* member's row is a clickable
//     "<role>" button (role-change action) for the Owner, but plain
//     static text for Editor/Viewer.
//   • So the contract assertion is on that role-change button — it must
//     be present for FOSS_USER (Owner) and absent for NORMAL_USER
//     (Editor) when both look at the same shared SearchSpace.
//   • SearchSpace id is integer in SurfSense. Default below is the
//     sandbox SearchSpace where FOSS_USER is Owner and NORMAL_USER is
//     Editor. Override via SURFSENSE_SEARCH_SPACE_ID.

const SURFSENSE_SEARCH_SPACE_ID = process.env.SURFSENSE_SEARCH_SPACE_ID ?? "7";

const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

const BASE = APP_URLS.SurfSense;
const SS_HOST = new URL(BASE).hostname;
const DASHBOARD_URL = `${BASE}/dashboard/${SURFSENSE_SEARCH_SPACE_ID}/new-chat`;

// "Manage members" lives behind two clicks from the dashboard. Wrapping
// the navigation lets both the admin-positive and non-admin-gated tests
// share the same path.
async function openManageMembersModal(page: Page): Promise<void> {
  // Pre-warm: hit BASE first so SurfSense's auth middleware can
  // initialize the session before we go after a deep route. Going
  // straight to /dashboard/<id>/new-chat sometimes resolves to the
  // marketing page on first request to the SurfSense host.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // SurfSense auto-redirects authed users from / to /dashboard/<id>/...
  await page.waitForURL(/\/dashboard\/\d+/, { timeout: 20_000 });

  // SurfSense ships a product tour on first load that overlays the page
  // and intercepts pointer events. Dismiss it before clicking through.
  const closeTour = page.getByRole("button", { name: /close tour/i }).first();
  if (await closeTour.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeTour.click({ timeout: 5_000 }).catch(() => {});
  }

  // SearchSpace dropdown: opens a menu with "Manage members" + "Search
  // Space settings". The button label is the SearchSpace name; default
  // is "My Search Space". An "Add search space" button also exists at
  // the top of the sidebar — use an exact-name regex to disambiguate.
  await page
    .getByRole("button", { name: /^my search space$/i })
    .first()
    .click({ timeout: 10_000 });
  await page.getByRole("menuitem", { name: /manage members/i }).click({ timeout: 10_000 });
  await expect(page.getByRole("dialog", { name: /manage members/i })).toBeVisible({
    timeout: 15_000,
  });
}

// (1) Cold context: the SurfSense dashboard sits fully behind SSO.
raw.describe("SurfSense — dashboard URL (cold context)", () => {
  raw("cold visit to /dashboard/<id>/new-chat bounces through SSO", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

      await expect
        .poll(() => isAuthWall(page.url()) || IDP_REGEX.test(page.url()), {
          message: `/dashboard/${SURFSENSE_SEARCH_SPACE_ID}/new-chat must bounce through SSO. Last URL: ${page.url()}`,
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

// (2) SSO-authed as NORMAL_USER (Editor): can open Manage Members,
//     but the role-change button on other members' rows is absent
//     (renders as plain text for non-owners).
raw.describe("SurfSense — non-admin (Editor) is gated", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  raw("non-admin can open Manage Members but has no role-change buttons", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });
      await openManageMembersModal(page);

      const dialog = page.getByRole("dialog", { name: /manage members/i });
      // SurfSense's role labels are Owner / Editor / Viewer. The Owner
      // sees these as <button> elements on rows *other than their own*;
      // a non-owner sees the same labels as plain text. We assert the
      // absence of any role-change button inside the dialog.
      await expect(
        dialog.getByRole("button", { name: /^(owner|editor|viewer|admin)$/i }),
        "Non-admin Editor must not see any role-change button in the Manage Members modal"
      ).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) SSO-authed as FOSS_USER (Owner): the role-change button on other
//     members' rows is present and clickable.
// ---------------------------------------------------------------------------
test.describe("SurfSense — admin (FOSS_USER, Owner) reaches owner-only controls", () => {
  test("Owner sees a role-change button on the Editor's row in Manage Members", async ({
    page,
  }) => {
    await openManageMembersModal(page);

    const dialog = page.getByRole("dialog", { name: /manage members/i });
    // The Owner's own row has a plain "Owner" cell (own role isn't
    // editable). Other members' rows expose a clickable
    // <button name="<role>"> for role-change. With 2 members in the
    // sandbox SearchSpace, the count of role buttons should be 1
    // (the non-owner row). On larger SearchSpaces, > 0 is enough.
    await expect(
      dialog.getByRole("button", { name: /^(owner|editor|viewer|admin)$/i }),
      "Owner must see at least one role-change button (other members' role labels are clickable)"
    ).not.toHaveCount(0);
  });
});
