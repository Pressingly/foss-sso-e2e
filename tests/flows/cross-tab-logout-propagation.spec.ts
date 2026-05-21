// Spec coverage for this file (see docs/spec-coverage.md):
// @spec logout-flow#portal-logout-all-shall-clear-only-the-oauth2-proxy-cookie
// @spec logout-flow#stale-app-native-sessions-shall-be-reaped-on-next-request-not-eagerly

import { test as raw, expect } from "@playwright/test";
import { APPS, MAIN_URL, AUTH_COOKIE, isAuthWall, IDP_REGEX } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Real-world flow:
//   1. User opens an app tab (Outline, say) and is signed in.
//   2. In *another* tab they hit "Log out of all apps" on the portal.
//   3. They click back to the Outline tab and do anything — link click,
//      reload, save a doc.
//
// Contract: the Outline tab MUST NOT remain authenticated. The
// platform logout cleared the shared SSO cookie, so the next request
// flowing through ForwardAuth gets no `_oauth2_proxy` cookie and
// oauth2-proxy bounces it to the IDP. The app may have an in-memory
// SPA state that *thinks* the user is still logged in, but the very
// next page navigation must detect the SSO loss and redirect to login.
//
// We model this with two pages on a single browser context (shared
// cookie jar — mirrors a real browser with multiple tabs of the same
// session). Tab A is the portal tab where logout fires; Tab B is the
// app tab that should detect the logout on its next navigation.

const LOGOUT_ALL_RE = /log\s*out\s*(of\s*)?all(\s*apps)?|sign\s*out\s*(of\s*)?all(\s*apps)?/i;

raw.describe("Cross-tab logout — apps detect SSO loss on next navigation", () => {
  for (const app of APPS) {
    raw(`${app.name}: tab navigation after portal Logout-All bounces to IDP`, async ({
      browser,
    }) => {
      raw.setTimeout(120_000);

      const ctx = await browser.newContext();
      // Tab A — portal. Will do the logout.
      const portalTab = await ctx.newPage();
      // Tab B — the app. Should stay authenticated until logout fires
      // in tab A, then detect SSO loss on its next navigation.
      const appTab = await ctx.newPage();

      try {
        // Phase 1: log in via portal tab, then warm the app tab.
        await cognitoLogin(portalTab);
        await appTab.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        expect(
          new URL(appTab.url()).hostname,
          `${app.name}: pre-condition — app tab must be on its host post-login`
        ).toBe(new URL(app.url).hostname);
        expect(
          isAuthWall(appTab.url()),
          `${app.name}: pre-condition — app tab must NOT be on auth wall post-login`
        ).toBe(false);

        // Phase 2: in portal tab, click "Log out of all apps".
        await portalTab.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await portalTab
          .getByRole("button", { name: LOGOUT_ALL_RE })
          .or(portalTab.getByRole("link", { name: LOGOUT_ALL_RE }))
          .first()
          .click({ timeout: 10_000 });
        await portalTab.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});

        // Sanity: the SSO cookie is gone for the whole context (both
        // tabs share the jar).
        const sso = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
        const cleared = !sso || sso.value === "";
        expect(cleared, `${app.name}: portal Logout-All must clear ${AUTH_COOKIE}`).toBe(true);

        // Phase 3: navigate the still-open app tab. With no SSO
        // cookie, oauth2-proxy must bounce this to the IDP (or to an
        // auth wall on the foss.* domain).
        try {
          await appTab.goto(app.url, { waitUntil: "commit", timeout: 30_000 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/ERR_ABORTED/.test(msg)) throw e;
        }
        await appTab.waitForURL(IDP_REGEX, { timeout: 15_000 }).catch(() => {});

        const landed = appTab.url();
        const bouncedToAuth = isAuthWall(landed) || IDP_REGEX.test(landed);
        expect(
          bouncedToAuth,
          `${app.name}: after portal Logout-All, the still-open app tab must bounce to SSO on next navigation. Landed: ${landed}`
        ).toBe(true);
      } finally {
        await ctx.close();
      }
    });
  }
});
