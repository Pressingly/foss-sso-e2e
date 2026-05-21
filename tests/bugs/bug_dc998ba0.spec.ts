// spec: /Users/apple/Documents/devstack/foss-sso-e2e/tests/bugs/specs/bug_dc998ba0.plan.md
// @spec session-lifecycle#only-one-oauth-login-flow-shall-be-in-progress-per-browser-at-a-time
// seed: none — owns its own BrowserContext. Multi-tab semantics need a
//       single context with two pages (shared cookie jar is what makes
//       the race observable); neither the worker `context` fixture nor
//       `freshLogin(browser)` provide that directly.

import { test, expect } from "@playwright/test";
import {
  MAIN_URL,
  IDP_REGEX,
  FOSS_HOST_REGEX,
} from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// FOSSSMBBUN-88 — concurrent multi-tab login race.
//
// Original symptom (the buggy observable): when two tabs go through
// login concurrently, the second tab's submit lands on a stark
// "Missing mpass_bridge cookie" 400 page. Root cause: `mpass_bridge`
// is a single per-browser cookie slot; the second tab's `/authorize`
// overwrites the first tab's value, the first tab's callback then
// `GETDEL`s the (now-shared) Redis bridge state, and the second tab's
// callback arrives with the cookie cleared and no state to look up.
//
// Ship-side resolution (Pressingly/foss-server-bundle#61): the race
// at the wire is NOT atomically prevented — per the spec constraint
// "no per-state cookie keys", mpass_bridge stays a single slot.
// Instead, `mpass-auth-proxy` `/mpass-callback` now redirects to the
// portal with `?login_error=expired_flow` when no bridge cookie /
// state is available; the portal JS reads the flag and shows a toast,
// then strips the query param via `history.replaceState`. The losing
// tab lands on the portal, not on a 400 page.
//
// This test asserts that wrapper: the second tab's `/mpass-callback`
// returns 302 → portal with `login_error=expired_flow`, the page
// body does NOT contain "mpass_bridge", and the final URL is on a
// foss host.
//
// Staging — once promoted, this moves into tests/auth/ and may gain
// a `@spec session-lifecycle#graceful-callback-failure` tag (if that
// requirement lands in the openspec).

const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

test.describe("FOSSSMBBUN-88 — multi-tab login graceful failure", () => {
  test("second tab's callback redirects to portal with login_error toast (not 'Missing mpass_bridge cookie')", async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    test.skip(
      !NORMAL_USER || !NORMAL_PASS,
      "NORMAL_USER / NORMAL_PASS unset — this repro uses a distinct identity in tab 2 (matches the reporter's flow).",
    );

    const context = await browser.newContext();

    // Capture every `/mpass-callback` response on tab 2 (status +
    // Location header). This is the deterministic, server-side signal
    // that the graceful redirect fired — independent of whether the
    // toast renders or how fast `history.replaceState` cleans the URL.
    const tab2Callbacks: { url: string; status: number; location: string }[] = [];

    try {
      // 1. Open tab 1, click Login, wait for the IDP picker.
      const page1 = await context.newPage();
      await page1.goto(MAIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (!IDP_REGEX.test(page1.url())) {
        await page1
          .getByRole("button", { name: /(log\s*in|sign\s*in)/i })
          .or(page1.getByRole("link", { name: /(log\s*in|sign\s*in)/i }))
          .first()
          .click({ timeout: 10_000 })
          .catch(() => {});
      }
      await page1.waitForURL(IDP_REGEX, { timeout: 45_000 });

      // 2. Open tab 2 in the SAME context (cookies shared = "multi tabs"),
      //    attach the response listener BEFORE navigating so we don't
      //    miss the callback if it lands quickly.
      const page2 = await context.newPage();
      page2.on("response", (res) => {
        if (!res.url().includes("/mpass-callback")) return;
        tab2Callbacks.push({
          url: res.url(),
          status: res.status(),
          location: res.headers()["location"] ?? "",
        });
      });
      await page2.goto(MAIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (!IDP_REGEX.test(page2.url())) {
        await page2
          .getByRole("button", { name: /(log\s*in|sign\s*in)/i })
          .or(page2.getByRole("link", { name: /(log\s*in|sign\s*in)/i }))
          .first()
          .click({ timeout: 10_000 })
          .catch(() => {});
      }
      await page2.waitForURL(IDP_REGEX, { timeout: 45_000 });

      // 3. Submit tab 1 (FOSS_USER). This callback runs FIRST, consumes
      //    the shared bridge_state, clears the mpass_bridge cookie.
      await cognitoLogin(page1, { skipInitialNav: true });
      expect(
        FOSS_HOST_REGEX.test(page1.url()),
        `tab 1 should have returned to a foss host after submitting login, got ${page1.url()}`,
      ).toBe(true);

      // 4. Submit tab 2 (NORMAL_USER). Its callback finds the cookie
      //    cleared / state consumed → 302 → portal/?login_error=expired_flow.
      //    cognitoLogin's waitForURL(FOSS_HOST_REGEX) is satisfied by
      //    that redirect (the portal IS a foss host), so no throw.
      let loginThrew: Error | null = null;
      try {
        await cognitoLogin(page2, {
          user: NORMAL_USER,
          pass: NORMAL_PASS,
          skipInitialNav: true,
        });
      } catch (e) {
        loginThrew = e instanceof Error ? e : new Error(String(e));
      }

      const tab2Url = page2.url();
      const tab2Body =
        (await page2.locator("body").innerText().catch(() => "")) ?? "";

      // 5. Primary assertion — server-side: tab 2's `/mpass-callback`
      //    returned 302 with `login_error=expired_flow` in the Location
      //    header. Wire-level proof that Option B fired.
      const gracefulRedirect = tab2Callbacks.find(
        (r) => r.status === 302 && /login_error=expired_flow/.test(r.location),
      );
      expect(
        gracefulRedirect,
        `tab 2's /mpass-callback should return 302 to portal with login_error=expired_flow. Captured callbacks: ${JSON.stringify(tab2Callbacks)}. tab2 URL: ${tab2Url}. cognitoLogin threw: ${loginThrew?.message ?? "<no>"}`,
      ).toBeDefined();

      // 6. Regression guard against the original bug observable:
      //    the page must NOT show "Missing mpass_bridge cookie".
      const mpassBridgeMentioned = /mpass[_\s-]?bridge/i.test(tab2Body);
      expect(
        mpassBridgeMentioned,
        `tab 2 should not show 'Missing mpass_bridge cookie' (the original bug's user-visible observable). Body excerpt: ${tab2Body.slice(0, 300)}`,
      ).toBe(false);

      // 7. Tab 2 lands on a foss host (the portal). Backstops the case
      //    where the redirect Location is captured but the navigation
      //    doesn't complete — the user should physically be on a foss
      //    host at this point.
      expect(
        FOSS_HOST_REGEX.test(tab2Url),
        `tab 2 should land on a foss host (portal) after the graceful redirect. Got ${tab2Url}.`,
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
