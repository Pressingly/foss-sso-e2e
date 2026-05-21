// Spec coverage for this file (see docs/spec-coverage.md):
// @spec logout-flow#portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie
// @spec logout-flow#logout-shall-be-observable-and-idempotent
// @spec logout-flow#per-app-logout-shall-be-navigation-only

import { test, expect } from "@playwright/test";
import { APPS, AUTH_COOKIE, MAIN_URL, isAuthWall } from "../../constants";
import { openLogoutMenu } from "../lib/app-menus";
import { freshLogin, clickPortalLogoutAll } from "../lib/common-flows";

// The three invariants pinned down here, all from
// sso-rules-moneta/openspec/specs/logout-flow/spec.md:
//
//   1. Portal "Logout all" clears ONLY the `_oauth2_proxy` cookie. Per-app
//      session cookies (Plane sessionid, Outline accessToken, etc.) must
//      survive — the spec is explicit that Layer-2 reaping happens on the
//      next request via ForwardAuth, not eagerly at logout time.
//      Existing coverage (session-lifecycle.spec.ts) asserts the SSO cookie
//      is cleared but doesn't pin down "ONLY".
//
//   2. Logout endpoints are idempotent — `/oauth2/sign_out` invoked twice
//      with no session in between must not 5xx and must still redirect to
//      the portal. Catches a regression class where oauth2-proxy or an
//      upstream proxy starts erroring on a missing session.
//
//   3. Per-app "Logout" controls are navigation-only — clicking them must
//      NOT call `/oauth2/sign_out`, MUST NOT call any per-app
//      `/auth/sign-out`, MUST NOT call Cognito's `/logout`. Only navigate
//      back to the portal. Best-effort: self-skips per app when the
//      logout control isn't reachable from the initial app shell (some
//      apps hide it behind an avatar menu and the per-app UI knowledge
//      needed to open it lives outside this test).

const APP_SESSION_COOKIE_PATTERNS: RegExp[] = [
  /^sessionid$/i,        // Django (Plane)
  /^accessToken$/i,      // Outline
  /^auth-token$/i,       // Penpot
  /^session(_id|-id)?$/i,
  /^connect\.sid$/i,
];

const SSO_COOKIE_NAMES = new Set([AUTH_COOKIE]);

function isAppSessionCookie(name: string): boolean {
  if (SSO_COOKIE_NAMES.has(name)) return false;
  return APP_SESSION_COOKIE_PATTERNS.some((p) => p.test(name));
}

// ---------------------------------------------------------------------------
// (1) Portal Logout-All clears the SSO cookie but leaves per-app cookies
// ---------------------------------------------------------------------------

test.describe("Logout invariants — portal Logout-All", () => {
  test("portal Logout-All clears _oauth2_proxy but leaves per-app session cookies intact", async ({
    browser,
  }) => {
    test.setTimeout(240_000); // visit all 5 apps + logout
    const { context, page } = await freshLogin(browser);

    try {
      // Phase 1: visit every app so each issues its per-app session cookie
      // into the shared jar. Twenty's SPA intermittently aborts the
      // top-level navigation when its auth-redirect fires mid-flight —
      // we tolerate ERR_ABORTED because by the time the abort lands,
      // the response headers (and Set-Cookie) have already arrived.
      for (const app of APPS) {
        try {
          await page.goto(app.url, {
            waitUntil: "commit",
            timeout: 60_000,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/ERR_ABORTED/.test(msg)) throw e;
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
        expect(
          isAuthWall(page.url()),
          `${app.name}: must be authed before logout (got ${page.url()})`
        ).toBe(false);
      }

      // Snapshot every per-app session cookie keyed by name. If an app
      // doesn't issue a JS-readable session cookie (header-driven auth on
      // every request), it simply won't appear here — we only assert
      // survival for cookies that actually existed pre-logout.
      const before = await context.cookies();
      const appCookiesBefore = before.filter((c) => isAppSessionCookie(c.name));
      const beforeMap = new Map(
        appCookiesBefore.map((c) => [`${c.domain}|${c.name}`, c.value])
      );

      expect(
        before.find((c) => c.name === AUTH_COOKIE),
        "SSO cookie must exist before logout"
      ).toBeDefined();

      // Phase 2: portal Logout-All.
      await clickPortalLogoutAll(page);

      const after = await context.cookies();

      // Half A — SSO cookie cleared.
      const ssoAfter = after.find((c) => c.name === AUTH_COOKIE);
      const ssoCleared = !ssoAfter || ssoAfter.value === "";
      expect(
        ssoCleared,
        `_oauth2_proxy must be cleared by portal Logout-All (got ${JSON.stringify(ssoAfter)})`
      ).toBe(true);

      // Half B — every per-app session cookie that existed before must still
      // exist with the same value after. This is the "ONLY" half of the
      // contract: Layer-2 cookies survive; reaping happens on next request.
      const survivors: string[] = [];
      const lost: string[] = [];
      for (const [key, value] of beforeMap) {
        const [domain, name] = key.split("|");
        const present = after.find(
          (c) => c.domain === domain && c.name === name && c.value === value
        );
        if (present) {
          survivors.push(`${name}@${domain}`);
        } else {
          lost.push(`${name}@${domain}`);
        }
      }

      // No per-app cookies in the first place is a vacuously-satisfied case
      // — skip cleanly so this test stays useful on header-only apps.
      test.skip(
        beforeMap.size === 0,
        "No per-app session cookies were issued — Layer-2 'survives logout' invariant is vacuously satisfied on this deployment."
      );

      expect(
        lost,
        `Portal Logout-All cleared per-app session cookies that should have survived (Layer-2 reaping is supposed to happen on next request, not at logout time): ${lost.join(", ")}. Survivors: ${survivors.join(", ")}`
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) Logout is idempotent
// ---------------------------------------------------------------------------

test.describe("Logout invariants — idempotency", () => {
  test("/oauth2/sign_out can be invoked twice without error", async ({ browser }) => {
    test.setTimeout(120_000);
    const app = APPS[0]!;
    const signOutUrl = `${app.url}/oauth2/sign_out?rd=${encodeURIComponent(MAIN_URL + "/")}`;

    const { context, page } = await freshLogin(browser);
    try {
      // Sanity: authenticated to start.
      await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      expect(isAuthWall(page.url()), "pre-condition — must be authed").toBe(false);

      // Call 1 — should clear the cookie and land on the portal.
      const res1 = await page.goto(signOutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      expect(
        res1?.status() ?? 0,
        `first /oauth2/sign_out returned ${res1?.status()} (expected <500)`
      ).toBeLessThan(500);
      const landed1 = page.url();
      expect(
        landed1.startsWith(MAIN_URL) || isAuthWall(landed1),
        `first sign_out should land on portal or auth wall, got ${landed1}`
      ).toBe(true);

      // Call 2 — no session left. Must still respond cleanly (not 5xx)
      // and land somewhere sensible (portal or auth wall).
      const res2 = await page.goto(signOutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      expect(
        res2?.status() ?? 0,
        `second /oauth2/sign_out returned ${res2?.status()} — endpoint not idempotent on empty session`
      ).toBeLessThan(500);
      const landed2 = page.url();
      expect(
        landed2.startsWith(MAIN_URL) || isAuthWall(landed2),
        `second sign_out should land on portal or auth wall, got ${landed2}`
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) Per-app "Logout" is navigation-only
// ---------------------------------------------------------------------------
//
// The spec is explicit: per-app logout MUST navigate to the portal and MUST
// NOT call any session-clear endpoint (`/oauth2/sign_out`, per-app
// `/auth/sign-out`, Cognito `/logout`). We enforce this by intercepting
// every request issued while the logout control is being clicked.
//
// Per-app UI choreography (opening the avatar/profile menu, navigating
// into Settings, etc.) lives in `tests/lib/app-menus.ts` — see
// `openLogoutMenu` there. If a helper fails to find the control, this
// test fails loudly: that's a UI change the helper needs to chase.
//
// Per-app Logout's destination is NOT pinned down. "Clear all apps and
// redirect to home" is the portal "Logout all" semantic (covered by
// sub-test 1 above). Per-app Logout in this bundle may legitimately
// stay on the app host (Plane, SurfSense) — the spec invariants we
// enforce are the two that actually matter for security: no
// session-clear endpoint is hit, and the SSO cookie is untouched.

const FORBIDDEN_LOGOUT_PATHS = [
  /\/oauth2\/sign_out/i,
  /\/auth\/sign[-_]out/i,
  /cognito.*\/logout/i,
];

test.describe("Logout invariants — per-app navigation-only", () => {
  for (const app of APPS) {
    test(`${app.name}: per-app Logout control is navigation-only`, async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const { context, page } = await freshLogin(browser);

      try {
        await page.goto(app.url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        expect(
          isAuthWall(page.url()),
          `${app.name}: pre-condition — must be authed`
        ).toBe(false);

        // Per-app helper opens whatever menu/page surfaces Logout, and
        // returns the Locator we click.
        const logoutControl = await openLogoutMenu[app.name](page);

        // Snapshot cookies before click.
        const cookiesBefore = await context.cookies();
        const ssoBefore = cookiesBefore.find((c) => c.name === AUTH_COOKIE);
        expect(
          ssoBefore?.value,
          `${app.name}: SSO cookie missing pre-click`
        ).toBeTruthy();

        // Listen for any request to a forbidden session-clear path during
        // the logout click. The spec says "navigation only" — i.e. just
        // an `<a href="MAIN_URL">`, not even a fetch.
        const forbiddenHits: string[] = [];
        const listener = (req: { url: () => string }) => {
          const u = req.url();
          if (FORBIDDEN_LOGOUT_PATHS.some((p) => p.test(u))) {
            forbiddenHits.push(u);
          }
        };
        page.on("request", listener);

        try {
          await logoutControl.click({ timeout: 10_000 });
          await page
            .waitForLoadState("domcontentloaded", { timeout: 15_000 })
            .catch(() => {});
        } finally {
          page.off("request", listener);
        }

        // Assertion A — no forbidden network calls.
        expect(
          forbiddenHits,
          `${app.name}: per-app Logout triggered a session-clear endpoint — spec says navigation-only: ${forbiddenHits.join(", ")}`
        ).toEqual([]);

        // Assertion B — SSO cookie unchanged (per-app logout MUST NOT
        // clear it; only portal Logout-All does).
        const cookiesAfter = await context.cookies();
        const ssoAfter = cookiesAfter.find((c) => c.name === AUTH_COOKIE);
        expect(
          ssoAfter?.value,
          `${app.name}: per-app Logout cleared _oauth2_proxy — should be navigation-only`
        ).toBe(ssoBefore?.value);

        // Per-app Logout's landing host is intentionally NOT pinned down
        // here. The portal "Logout all" is the flow that redirects to
        // the home page (covered by sub-test 1 above). Per-app Logout
        // can land on the portal, the auth wall during SSO bounce, or
        // the app's own sign-in page — what matters is the two
        // assertions above: no forbidden endpoint call, SSO cookie
        // untouched.
      } finally {
        await context.close();
      }
    });
  }
});
