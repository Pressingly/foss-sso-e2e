// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-role-shall-be-the-apps-regular-member-role-not-admin-or-guest
// (partial — proves NORMAL_USER auto-joined to Twenty without
// canAccessFullAdminPanel; admin panel renders zero markers)

import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import { APP_URLS, IDP_REGEX, isAuthWall } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

const BASE = APP_URLS.Twenty;
const TWENTY_HOST = new URL(BASE).hostname;
const ADMIN_URL = `${BASE}/settings/admin-panel`;

// Identity model (sso-rules/admin.md): FOSS_USER (User A) is the
// pre-bootstrapped admin with canAccessFullAdminPanel=true on Twenty;
// NORMAL_USER (User B) is the non-admin baseline. Worker fixture uses
// FOSS_USER, so admin-side tests use `test`; non-admin uses an explicit
// cognitoLogin into a fresh context with NORMAL_USER.
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;
const TWENTY_ADMIN_USER = process.env.TWENTY_ADMIN_USER ?? process.env.FOSS_USER;
const TWENTY_ADMIN_PASS = process.env.TWENTY_ADMIN_PASS ?? process.env.FOSS_PASS;

// Twenty is the only app in the bundle with a real `/admin` URL distinct
// from workspace-level admin. Two separate concepts live behind the same
// URL space:
//   • Global admin — `User.canAccessFullAdminPanel === true`, checked
//     server-side by AdminPanelGuard. Mounted at /settings/admin-panel
//     and the /admin-panel-graphql-api endpoint.
//   • Workspace admin — `WorkspaceMember.role = "Admin"` (UUID
//     20202020-02c2-43f2-b94d-cab1f2b532eb). Unrelated to admin-panel.
//
// There is no first-user-auto-admin and no UI/API path to flip
// `canAccessFullAdminPanel` — bootstrap requires the
// `workspace:bootstrap-sso-admin --email <email>` CLI command (the
// bundle's provision-twenty.sh wires this). So this spec is read-side
// only: it verifies the gate, not promotion. Promotion is exercised
// implicitly — if the bootstrap command works, TWENTY_ADMIN_USER
// reaches the panel; if it didn't, they get the same non-admin signal
// FOSS_USER does, and the admin-side test fails loudly.
//
// Twenty's SPA keeps a GraphQL-subscriptions websocket open, so the
// page never reaches `networkidle` (see tests/apps/twenty.spec.ts and
// link-coverage.ts for the same issue). Use `commit` + an explicit
// render wait.

async function waitForAdminPanelSurface(page: import("@playwright/test").Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      return text.length > 0;
    }, null, { timeout: 10_000 })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// (A) Cold context: /settings/admin-panel must bounce through SSO.
// ---------------------------------------------------------------------------

raw.describe("Twenty — admin-panel URL gate (cold context)", () => {
  raw("cold visit to /settings/admin-panel bounces through SSO", async ({
    browser,
  }) => {
    raw.setTimeout(60_000);
    const ctx = await browser.newContext(); // no SSO cookie
    const page = await ctx.newPage();
    try {
      await page.goto(ADMIN_URL, { waitUntil: "commit", timeout: 30_000 });
      await page.waitForURL(IDP_REGEX, { timeout: 15_000 }).catch(() => {});

      const landed = page.url();
      const bouncedToSSO = isAuthWall(landed) || IDP_REGEX.test(landed);
      expect(
        bouncedToSSO,
        `/settings/admin-panel must bounce through SSO — Twenty admin is not bypass-routed. Landed: ${landed}`
      ).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (B) SSO-authed as FOSS_USER (non-admin): the admin panel must be gated.
//
// The exact gating signal depends on Twenty's SPA implementation —
// it could redirect, render an access-denied component, or simply not
// render the admin UI. To make the contract robust to either:
//   • The page must stay on the Twenty host (not bounce to IDP).
//   • The visible content must NOT include admin-panel-specific UI.
// We pick a couple of strings that the admin-panel.resolver.ts surface
// implies are present on the admin page: "Health Status", "Feature
// Flags", "Config Variables", "AI Models". If even ONE renders for a
// non-admin, AdminPanelGuard has been bypassed.
// ---------------------------------------------------------------------------

const ADMIN_UI_MARKERS = [
  /health[\s-]*status/i,
  /feature[\s-]*flags?/i,
  /config[\s-]*variables?/i,
  /ai[\s-]*models?/i,
  /admin[\s-]*panel/i,
];

async function readVisibleText(page: import("@playwright/test").Page): Promise<string> {
  // page.content() includes attributes / hidden nodes; innerText gives
  // user-visible text only, which is what we want for a "would a real
  // admin see this" assertion.
  return await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

async function countAdminMarkers(page: import("@playwright/test").Page): Promise<number> {
  const visible = await readVisibleText(page);
  return ADMIN_UI_MARKERS.filter((rx) => rx.test(visible)).length;
}

raw.describe("Twenty — admin-panel gated for non-admin SSO user", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin gate"
  );

  raw("non-admin lands on Twenty but admin-panel content is not rendered", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

      await page.goto(ADMIN_URL, { waitUntil: "commit", timeout: 30_000 });
      await waitForAdminPanelSurface(page);

      const landed = page.url();
      expect(new URL(landed).hostname).toBe(TWENTY_HOST);
      expect(
        isAuthWall(landed),
        `Non-admin must not bounce to auth wall on /settings/admin-panel: ${landed}`
      ).toBe(false);

      const visible = await readVisibleText(page);
      const matched = ADMIN_UI_MARKERS.filter((rx) => rx.test(visible));
      expect(
        matched,
        `AdminPanelGuard appears bypassed for NORMAL_USER — admin UI markers visible: ${matched
          .map((r) => r.source)
          .join(", ")}\nFirst 400 chars of visible text: ${visible.slice(0, 400)}`
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (C) SSO-authed as TWENTY_ADMIN_USER: the admin panel must render.
// This intentionally uses explicit admin credentials instead of the
// worker fixture account so CI can run against environments where
// FOSS_USER is not a Twenty full-admin.
// ---------------------------------------------------------------------------

raw.describe("Twenty — admin-panel reachable for TWENTY_ADMIN_USER", () => {
  raw.skip(
    !TWENTY_ADMIN_USER || !TWENTY_ADMIN_PASS,
    "Set FOSS_USER/FOSS_PASS (or TWENTY_ADMIN_USER/TWENTY_ADMIN_PASS override) to run the Twenty admin positive test"
  );

  raw("admin reaches /settings/admin-panel with admin UI visible", async ({ browser }) => {
    raw.setTimeout(90_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await cognitoLogin(page, { user: TWENTY_ADMIN_USER!, pass: TWENTY_ADMIN_PASS! });

      // Pre-warm: navigate to Twenty home first so the SPA fetches
      // currentUser/workspace BEFORE we hit a guarded route. Otherwise the
      // route guard races the auth-hydration query, treats the session as
      // unknown, and bounces through /welcome → /objects/companies. Real
      // users don't trip this because human latency lets the SPA settle.
      await page.goto(BASE, { waitUntil: "commit", timeout: 30_000 });
      await page
        .locator('[data-testid="nav-workspace-trigger"], nav, [role="navigation"]')
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});

      const adminApiResponsePromise = page
        .waitForResponse(
          (r) =>
            r.url().includes("/admin-panel-graphql-api") &&
            ["GET", "POST"].includes(r.request().method()),
          { timeout: process.env.CI ? 30_000 : 15_000 }
        )
        .catch(() => null);

      await page.goto(ADMIN_URL, { waitUntil: "commit", timeout: 30_000 });
      await waitForAdminPanelSurface(page);

      const landed = page.url();
      expect(new URL(landed).hostname).toBe(TWENTY_HOST);
      expect(
        landed,
        `Expected to remain on /settings/admin-panel, but landed on: ${landed}. This usually means the user is not granted canAccessFullAdminPanel.`
      ).toContain("/settings/admin-panel");
      expect(
        isAuthWall(landed),
        `Admin bounced to auth wall on /settings/admin-panel: ${landed}`
      ).toBe(false);

      // Catch late SPA redirects: non-admin users can briefly land on the
      // route and then get pushed back to app home.
      await expect
        .poll(() => page.url(), {
          timeout: process.env.CI ? 20_000 : 10_000,
          message:
            "Twenty redirected away from /settings/admin-panel after initial load. " +
            "The SSO user is likely authenticated but missing canAccessFullAdminPanel.",
        })
        .toContain("/settings/admin-panel");


      const adminApiResponse = await adminApiResponsePromise;
      const markerCount = await countAdminMarkers(page);
      const visible = await readVisibleText(page);
      const apiLooksAdmin = !!adminApiResponse && adminApiResponse.status() < 400;
      const markerLooksAdmin = markerCount > 0;
      expect(
        markerLooksAdmin || apiLooksAdmin,
        `Admin-panel signal missing. markers=${markerCount}; api_status=${adminApiResponse?.status() ?? "none"}; landed=${page.url()}. None of these UI markers matched: ${ADMIN_UI_MARKERS.map(
          (r) => r.source
        ).join(", ")}\nFirst 400 chars of visible text: ${visible.slice(0, 400)}`
      ).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
