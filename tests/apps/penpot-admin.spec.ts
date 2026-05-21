// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-role-shall-be-the-apps-regular-member-role-not-admin-or-guest
// (partial — proves NORMAL_USER auto-joined to Penpot's shared team
// as Editor (non-Owner): "Invite people" / role combobox absent)

import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import {
  APP_URLS,
  IDP_REGEX,
  isAuthWall,
  escapeHostForRegex,
  PENPOT_TEAM_ID,
} from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Penpot admin contract (sso-rules/admin.md):
//   • FOSS_USER (User A) is the Owner of a shared Penpot team in the
//     sandbox. NORMAL_USER (User B) is in that same team as Editor.
//   • Penpot's owner-only controls live at /#/dashboard/invitations and
//     /#/dashboard/members on that team's URL. The clearest signal is
//     the "Invite people" link on the Invitations tab — Owner sees it,
//     Editor doesn't.
//   • Bootstrap is data-side: the team must exist with FOSS_USER as
//     Owner and NORMAL_USER as a non-owner member, and the team's id
//     must be in PENPOT_TEAM_ID. The default falls back to the sandbox
//     team id so the suite is runnable out of the box on that
//     deployment; other deployments override via env.

const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

const BASE = APP_URLS.Penpot;
const PENPOT_HOST = new URL(BASE).hostname;
const INVITATIONS_URL = `${BASE}/#/dashboard/invitations?team-id=${PENPOT_TEAM_ID}`;
const MEMBERS_URL = `${BASE}/#/dashboard/members?team-id=${PENPOT_TEAM_ID}`;

// (1) Cold context: the admin URLs must bounce through SSO.
raw.describe("Penpot — admin URLs (cold context)", () => {
  for (const [label, url] of [
    ["/dashboard/invitations", INVITATIONS_URL],
    ["/dashboard/members", MEMBERS_URL],
  ] as const) {
    raw(`cold visit to ${label} bounces through SSO (no bypass)`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext(); // no storageState → no SSO cookie
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

        await expect
          .poll(() => isAuthWall(page.url()) || IDP_REGEX.test(page.url()), {
            message: `${label} must bounce through SSO. Last URL: ${page.url()}`,
            timeout: 15_000,
          })
          .toBe(true);
      } finally {
        await ctx.close();
      }
    });
  }
});

// (2) SSO-authed as NORMAL_USER (Editor): the page renders on the
//     Penpot host but the "Invite people" owner-only link is absent.
raw.describe("Penpot — non-admin (Editor) is gated", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  raw("non-admin lands on /dashboard/invitations but cannot Invite", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

      await page.goto(INVITATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Page must load on the Penpot host (not bounce away).
      await expect(page).toHaveURL(new RegExp(`^https?://${escapeHostForRegex(PENPOT_HOST)}`));
      expect(
        isAuthWall(page.url()),
        `Non-admin bounced to auth wall on /dashboard/invitations: ${page.url()}`
      ).toBe(false);

      await expect(
        page.getByText(/invite people/i),
        "Non-admin Editor must not see the 'Invite people' control"
      ).toBeHidden({ timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) SSO-authed as FOSS_USER (Owner): the owner-only controls render.
//     Uses the worker fixture (which logs in as FOSS_USER).
// ---------------------------------------------------------------------------
test.describe("Penpot — admin (FOSS_USER, Owner) reaches owner-only controls", () => {
  test("Owner sees 'Invite people' on /dashboard/invitations", async ({ page }) => {
    await page.goto(INVITATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await expect(page).toHaveURL(new RegExp(`^https?://${escapeHostForRegex(PENPOT_HOST)}`));
    expect(isAuthWall(page.url()), `Admin bounced to auth wall: ${page.url()}`).toBe(false);

    await expect(
      page.getByText(/invite people/i),
      "Owner must see the 'Invite people' control on the Invitations tab"
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Owner sees a role combobox on /dashboard/members (manage other members)", async ({
    page,
  }) => {
    await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await expect(page).toHaveURL(new RegExp(`^https?://${escapeHostForRegex(PENPOT_HOST)}`));
    expect(isAuthWall(page.url()), `Admin bounced to auth wall: ${page.url()}`).toBe(false);

    // The Owner row has a static "Owner" badge (own role isn't editable);
    // the other rows expose a role-selector combobox. Editor-only views
    // render the role as static text instead. Either combobox count > 0
    // *or* the Owner badge alone may be enough — we check for the
    // combobox specifically because it's the owner-only action.
    await expect(
      page.getByRole("combobox").first(),
      "Owner must see at least one role combobox to manage other members"
    ).toBeVisible({ timeout: 15_000 });
  });
});
