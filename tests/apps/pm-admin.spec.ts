// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-role-shall-be-the-apps-regular-member-role-not-admin-or-guest
// (this whole file is the workspace-auto-join role assertion for Plane:
// both auto-joined SSO users land as Member, neither has Admin powers.)
//
// @spec plane-admin#workspace-settings-urls-shall-not-bypass-the-sso-chain
// @spec plane-admin#auto-joined-member-shall-reach-members-page-but-lack-add-controls

import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import {
  APP_URLS,
  IDP_REGEX,
  isAuthWall,
  escapeHostForRegex,
  PLANE_WORKSPACE_SLUG as DEFAULT_PLANE_WORKSPACE_SLUG,
} from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Plane workspace-auto-join contract (workspace-auto-join spec):
//   • Distinct from /god-mode (which is local-creds and bypasses SSO —
//     covered in pm-godmode.spec.ts).
//   • On the sandbox, the shared workspace slug is `fossarbisoft`. Every
//     SSO user is auto-joined to it with the `Member` role; the only
//     Admin is the bootstrap `system-bot` account. The workspace-auto-
//     join spec requires the auto-join role to be regular Member — NOT
//     Admin or Guest — and this file is the e2e proof for Plane.
//   • On /<slug>/settings/members:
//       - Both FOSS_USER and NORMAL_USER reach the Members table (they
//         are members).
//       - Neither sees the "Add member" button: that's an Admin-only
//         control. If a Member could see it, the auto-join role grant
//         is too broad (the spec violation we're guarding against).
//   • Slug parameterised via PLANE_ADMIN_WORKSPACE_SLUG (default
//     `fossarbisoft`).

const PLANE_WORKSPACE_SLUG = DEFAULT_PLANE_WORKSPACE_SLUG;

const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

const BASE = APP_URLS.PM;
const PM_HOST = new URL(BASE).hostname;
const MEMBERS_URL = `${BASE}/${PLANE_WORKSPACE_SLUG}/settings/members/`;
const PM_HOST_REGEX = new RegExp(`^https?://${escapeHostForRegex(PM_HOST)}`);

// ---------------------------------------------------------------------------
// (1) Cold context: the admin URL must bounce through SSO.
// ---------------------------------------------------------------------------
raw.describe("Plane — workspace-admin URL (cold context)", () => {
  raw("cold visit to /<slug>/settings/members bounces through SSO", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

      await expect
        .poll(() => isAuthWall(page.url()) || IDP_REGEX.test(page.url()), {
          message: `/${PLANE_WORKSPACE_SLUG}/settings/members must bounce through SSO. Last URL: ${page.url()}`,
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) SSO-authed as NORMAL_USER: auto-joined as Member, reaches the
//     Members page, but does NOT see the Admin-only "Add member" button.
// ---------------------------------------------------------------------------
raw.describe("Plane — NORMAL_USER auto-joined as Member (not Admin)", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  raw("NORMAL_USER reaches the Members page but cannot 'Add member'", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });
      await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

      await expect(page).toHaveURL(PM_HOST_REGEX);
      expect(
        isAuthWall(page.url()),
        `NORMAL_USER bounced to auth wall: ${page.url()}`
      ).toBe(false);

      // Member-side proof of membership: the URL stays on
      // /settings/members and the "Workspace not found" shell does NOT
      // render (which Plane would serve for a non-member). The Members
      // heading itself isn't a `role=heading` element — it's a styled
      // div with a count badge — so we go by URL + the absence of the
      // non-member error shell rather than chasing the heading.
      await expect(page).toHaveURL(/\/settings\/members\/?(\?|$)/);
      await expect(
        page.getByRole("heading", { name: /workspace not found/i }),
        "NORMAL_USER must NOT see Plane's 'Workspace not found' shell — they should be a member of the workspace"
      ).toBeHidden();

      // Admin-only control: the "Add member" button. If NORMAL_USER
      // sees it, the auto-join role grant is broader than Member —
      // the spec violation this test exists to catch.
      await expect(
        page.getByRole("button", { name: /^add member$/i }),
        "NORMAL_USER must NOT see the 'Add member' button: that's Admin-only. Visible here means the workspace-auto-join role grant escalates above Member, violating the spec."
      ).toBeHidden();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) SSO-authed as FOSS_USER: same shape — auto-joined as Member,
//     reaches the page, NOT an Admin. Uses the worker fixture identity.
//
// FOSS_USER is admin in OTHER apps (Outline role=admin, Penpot/SurfSense
// Owner of own workspace, Twenty canAccessFullAdminPanel) — but in Plane's
// sandbox they're a Member of `fossarbisoft`, same as NORMAL_USER. Only the
// bootstrap `system-bot` account holds the Admin role.
// ---------------------------------------------------------------------------
test.describe("Plane — FOSS_USER auto-joined as Member (not Admin)", () => {
  test("FOSS_USER reaches the Members page but cannot 'Add member'", async ({
    page,
  }) => {
    await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await expect(page).toHaveURL(PM_HOST_REGEX);
    expect(isAuthWall(page.url()), `FOSS_USER bounced to auth wall: ${page.url()}`).toBe(false);

    // Proof of membership: URL settled on /settings/members and Plane
    // did NOT serve the "Workspace not found" non-member shell.
    await expect(page).toHaveURL(/\/settings\/members\/?(\?|$)/);
    await expect(
      page.getByRole("heading", { name: /workspace not found/i }),
      "FOSS_USER must NOT see Plane's 'Workspace not found' shell — they should be a member of the workspace"
    ).toBeHidden();

    await expect(
      page.getByRole("button", { name: /^add member$/i }),
      "FOSS_USER must NOT see the 'Add member' button on the sandbox: in Plane they are auto-joined as Member, not Admin. If this becomes visible, either the test's deployment assumption is stale (FOSS_USER was promoted) or the workspace-auto-join role grant escalates above Member."
    ).toBeHidden();
  });
});
