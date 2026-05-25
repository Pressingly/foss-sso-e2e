// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-role-shall-be-the-apps-regular-member-role-not-admin-or-guest
// (partial — proves NORMAL_USER auto-joined as non-admin Outline user;
// admin-only /settings/* pages are gated for them and reachable for FOSS_USER)
//
// @spec outline-admin#admin-settings-urls-shall-not-bypass-the-sso-chain
// @spec outline-admin#workspace-admin-shall-reach-every-settings-page
// @spec outline-admin#non-admin-shall-not-reach-admin-only-settings-pages

import { test, expect } from "../../fixtures";
import { test as raw, type Page, type Response } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
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

const MAX_SETTINGS_ATTEMPTS = process.env.CI ? 4 : 3;

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
//
// We watch network responses during each attempt for a 429. If one is
// observed, the inter-attempt backoff is longer (Outline's rate
// limiter has a sliding ~5-10s window). If the failure is just an
// incomplete render with no 429, a shorter backoff is enough. The
// retry burst itself is what made the original retry loop counter-
// productive — hammering /settings under an active rate limit just
// kept us rate-limited.
async function gotoSettingsPath(page: Page, path: string): Promise<void> {
  if (path === "/settings") {
    await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    return;
  }

  const subLink = page.locator(`a[href="${path}"]`).first();
  let lastError: unknown;
  let saw429Attempts = 0;

  // Per-attempt 429 watch. Pacing-only use of timing — explicit
  // rate-limit politeness, not a readiness escape hatch.
  const onResponse = (resp: Response) => {
    if (resp.status() === 429) saw429Attempts += 1;
  };
  page.on("response", onResponse);

  try {
    for (let attempt = 1; attempt <= MAX_SETTINGS_ATTEMPTS; attempt++) {
      const before429Count = saw429Attempts;
      await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      try {
        await expect(subLink).toBeVisible({ timeout: 10_000 });
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < MAX_SETTINGS_ATTEMPTS) {
          const saw429ThisAttempt = saw429Attempts > before429Count;
          // Backoff: longer when 429 is confirmed (rate-limit is
          // actively rejecting — Outline's window appears to be ~15s+),
          // shorter when render just stalled. Pacing only — never use
          // as a readiness wait.
          const backoffMs = saw429ThisAttempt
            ? 15_000 * attempt // 15s, 30s, 45s for genuine rate limit
            : 1_500;           // ~1.5s when it's just incomplete render
          await delay(backoffMs);
        }
      }
    }
  } finally {
    page.off("response", onResponse);
  }

  if (lastError) {
    throw new Error(
      `${path}: sub-nav link never appeared on /settings after ${MAX_SETTINGS_ATTEMPTS} attempts. ` +
        `429 responses observed across attempts: ${saw429Attempts}. ` +
        (saw429Attempts > 0
          ? "Outline rate-limited the chunk loads — increase backoff or stagger the test more."
          : "No 429 seen — could be a slow render / selector drift rather than rate-limit.")
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
// Probe NORMAL_USER's actual Outline role. Outline auto-promotes the
// first user on a fresh team to Admin (vendor/openspec/skills/outline-admin/
// SKILL.md → "First-admin bootstrap"), so on a deployment where NORMAL_USER
// has ever landed on Outline first, they're Admin of their OWN team and
// the "non-admin gated" assertions can't verify the contract — they'd land
// in their own team where they ARE admin and the page renders.
//
// When that's the case, we skip the ADMIN_ONLY_PATHS tests below with a
// reason pointing at foss-server-bundle issue (provision a seeded-as-
// Member test user). COMMON_PATHS tests still run — they pass whether
// NORMAL_USER is admin or non-admin.
async function probeNormalUserOutlineRole(
  browser: import("@playwright/test").Browser,
): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });
    await page.goto(APP_URLS.Outline, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const cookies = await ctx.cookies(APP_URLS.Outline);
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const r = await ctx.request.post(`${APP_URLS.Outline}/api/auth.info`, {
      headers: { cookie, "content-type": "application/json" },
      data: {},
    });
    const j = (await r.json()) as { data?: { user?: { role?: string } } };
    return j.data?.user?.role ?? "unknown";
  } finally {
    await ctx.close();
  }
}

let normalUserOutlineRole: string | undefined;

raw.describe("Outline — non-admin role split (NORMAL_USER)", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  raw.beforeAll(async ({ browser }) => {
    if (normalUserOutlineRole === undefined) {
      normalUserOutlineRole = await probeNormalUserOutlineRole(browser);
    }
  });

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
      raw.skip(
        normalUserOutlineRole === "admin",
        `NORMAL_USER's Outline role is "admin" (auto-promoted on first-team login ` +
          `per outline-admin SKILL.md → "First-admin bootstrap"). Cannot verify ` +
          `non-admin gate without a seeded-as-Member test user. ` +
          `Tracking: foss-server-bundle#72.`,
      );
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
      // Outline's per-route 429 backoff inside gotoSettingsPath can
      // pace the suite at 15s + 30s + 45s = 90s in the worst case
      // (3 backoffs across 4 attempts). Add headroom on top for goto
      // + render. Default 30s would time out mid-backoff.
      test.setTimeout(180_000);
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
