// Spec coverage for this file (see docs/spec-coverage-deferred.md):
// (no @spec tag — per-app workspace-membership authorization is an
//  app-functionality concern, not part of the SSO contract published
//  in `awais786/sso-rules-moneta/openspec/specs/`. Lives under
//  tests/apps/ alongside the other per-app contract files;
//  documented under "Coverage outside the openspec contract scope"
//  in docs/spec-coverage-deferred.md.)
//
// Pins the **asymmetric workspace surface** model:
//
//   • FOSS_USER ("User A")  — multi-workspace surface. Lives in the
//                              shared `fossarbisoft` SMB workspace
//                              AND in `FOSS_USER_PRIVATE_WORKSPACE_SLUG`
//                              (default `aa`) where they are Admin.
//   • NORMAL_USER ("User B") — SMB-workspace-only surface. Lives in
//                              `fossarbisoft` only.
//
// The contract: NORMAL_USER's UI and API access to FOSS_USER's
// private workspace MUST be refused (workspace authorization is at
// both layers — not just UI, the API enforces it too).
//
// Why an SSO suite cares: this is the load-bearing test for "valid
// SSO session ≠ free pass to every authenticated route." Without it,
// a workspace-membership check regression in Plane (e.g., view-level
// `is_authenticated` swapped for a stricter check that gets reverted)
// would let NORMAL_USER read `aa`'s projects via the API.
//
// Self-skips when NORMAL_USER credentials are unset.

import { test as raw, expect } from "@playwright/test";
import { request } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import {
  APP_URLS,
  FOSS_USER_PRIVATE_WORKSPACE_SLUG,
  PLANE_WORKSPACE_SLUG,
} from "../../constants";

const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

raw.describe("Plane — workspace membership isolation (NORMAL_USER cannot reach FOSS_USER's private workspace)", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER / NORMAL_PASS in .env to run the workspace-isolation contract",
  );

  raw("UI: NORMAL_USER navigating to FOSS_USER's private workspace lands on 'Workspace not found'", async ({ browser }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

      // Pre-condition sanity: NORMAL_USER reaches their SMB workspace fine —
      // proves the session is valid and they're authenticated against Plane.
      await page.goto(`${APP_URLS.PM}/${PLANE_WORKSPACE_SLUG}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", { name: /workspace not found/i }),
        `Pre-condition failed: NORMAL_USER cannot reach their own ${PLANE_WORKSPACE_SLUG} workspace — the rest of the test isn't meaningful`,
      ).toBeHidden({ timeout: 15_000 });

      // The actual contract: NORMAL_USER navigates to FOSS_USER's private
      // workspace. Expected behaviour is Plane's "Workspace not found"
      // shell (NOT a redirect to the IDP — they're authenticated, just
      // not authorised for this workspace).
      await page.goto(`${APP_URLS.PM}/${FOSS_USER_PRIVATE_WORKSPACE_SLUG}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      await expect(
        page.getByRole("heading", { name: /workspace not found/i }),
        `NORMAL_USER reached ${FOSS_USER_PRIVATE_WORKSPACE_SLUG} without being a member — workspace-membership check is bypassed. URL: ${page.url()}`,
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });

  raw("API: NORMAL_USER's request to FOSS_USER's private-workspace API is refused", async ({ browser }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

      // Warm Plane host so per-app session cookies land.
      const probe = await ctx.newPage();
      await probe.goto(APP_URLS.PM, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await probe.close();

      const cookies = await ctx.cookies(APP_URLS.PM);
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const apiCtx = await request.newContext({
        extraHTTPHeaders: { cookie: cookieHeader },
      });
      try {
        // Pre-condition: NORMAL_USER's own workspace's members endpoint
        // returns 200 — confirms the session is valid + authed against
        // Plane's API layer.
        const ownMembers = await apiCtx.get(
          `${APP_URLS.PM}/api/workspaces/${PLANE_WORKSPACE_SLUG}/members/`,
        );
        expect(
          ownMembers.status(),
          `Pre-condition failed: NORMAL_USER's GET /api/workspaces/${PLANE_WORKSPACE_SLUG}/members/ returned ${ownMembers.status()}. Expected 200 (they're a member of their own workspace).`,
        ).toBe(200);

        // The actual contract: same endpoint shape on FOSS_USER's
        // private workspace MUST be refused. Plane typically returns
        // 403 (Forbidden) for cross-workspace API access, but 404
        // (Not Found, leak-resistant) is also a valid contract. Anything
        // 2xx is a regression.
        const otherMembers = await apiCtx.get(
          `${APP_URLS.PM}/api/workspaces/${FOSS_USER_PRIVATE_WORKSPACE_SLUG}/members/`,
        );
        const status = otherMembers.status();
        expect(
          status >= 400 && status < 500,
          `NORMAL_USER's GET /api/workspaces/${FOSS_USER_PRIVATE_WORKSPACE_SLUG}/members/ returned ${status} — expected 4xx (forbidden or not-found). 2xx means the workspace-membership check at Plane's API layer is bypassed: a non-member can read another workspace's data.`,
        ).toBe(true);
      } finally {
        await apiCtx.dispose();
      }
    } finally {
      await ctx.close();
    }
  });
});
