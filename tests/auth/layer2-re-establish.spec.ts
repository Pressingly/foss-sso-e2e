// Spec coverage for this file (see docs/spec-coverage.md):
// @spec session-lifecycle#layer-2-expiry-while-layer-1-is-valid-shall-re-establish-session-from-headers

import { test, expect, type Response } from "@playwright/test";
import { APPS, AUTH_COOKIE, IDP_REGEX, isAuthWall } from "../../constants";
import { freshLogin } from "../lib/common-flows";

// Layer-2 expiry is the most-hit edge case in a long-running browser
// tab: each app's local session cookie (Django sessionid, Outline's
// accessToken, etc.) expires before the platform-wide `_oauth2_proxy`
// SSO cookie. The contract says: when the SSO cookie is still valid
// but the app's local session is gone, the next request MUST silently
// re-establish the local session from the `X-Auth-Request-*` headers
// — no IDP bounce, no login form, no lost state.
//
// We can't fast-forward time to expire Layer-2 cookies, but we can
// reproduce the same browser-side state instantly by clearing every
// non-SSO cookie + localStorage + sessionStorage, then reload. This spec
// applies that pattern across every app in the bundle.

test.describe("Layer-2 expiry → silent re-establish (cleared app session, valid SSO)", () => {
  for (const app of APPS) {
    test(`${app.name}: clear app-local session, SSO intact → page still loads`, async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const { context, page } = await freshLogin(browser);

      try {
        // Land on the app with a fully populated session.
        await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        expect(
          page.url().startsWith(app.url),
          `Pre-condition: must be on ${app.name} after login, got ${page.url()}`
        ).toBe(true);

        // Capture and isolate the SSO cookie. Everything else (the app's
        // own session cookies, CSRF, locale, JWT etc.) gets dropped to
        // simulate Layer-2 having expired locally.
        const allCookies = await context.cookies();
        const ssoCookie = allCookies.find((c) => c.name === AUTH_COOKIE);
        expect(ssoCookie, "SSO cookie must exist after login").toBeDefined();

        await context.clearCookies();
        await context.addCookies([ssoCookie!]);

        // Belt-and-braces: clear web storage too. Apps that gate auth on
        // a localStorage token (Twenty's tokenPair, Penpot profile) must
        // re-establish from the SSO header path, not from local cache.
        //
        // The outer .catch swallows "Execution context was destroyed" —
        // Twenty's SPA polls auth state and may navigate away after we
        // drop the cookies but before this evaluate runs. The subsequent
        // reload() is what we care about; storage that didn't get
        // cleared here will be cleared by the reload's fresh page load.
        await page
          .evaluate(() => {
            try {
              window.localStorage.clear();
              window.sessionStorage.clear();
            } catch {
              // Cross-origin frames may throw; safe to ignore.
            }
          })
          .catch(() => {
            /* SPA navigated mid-evaluate; storage will get cleared on reload anyway */
          });

        // Anti-vacuous: an app could "re-establish" by silently re-running
        // the FULL SSO bounce (a Cognito/IDP round-trip), which also lands
        // back on-host and would pass the host + not-auth-wall checks
        // identically. The contract is re-establishment FROM HEADERS — no
        // IDP bounce. Record any IDP-host hit during the reload so we can
        // tell header re-establishment apart from a hidden re-login. With
        // Layer-1 (`_oauth2_proxy`) intact, oauth2-proxy validates the
        // cookie and injects `X-Auth-Request-*` without ever touching the
        // IDP, so a clean re-establishment yields zero IDP hits.
        const idpHits: string[] = [];
        const onResponse = (r: Response) => {
          if (IDP_REGEX.test(r.url())) idpHits.push(r.url());
        };
        page.on("response", onResponse);

        // Reload — this is the moment the spec requirement fires. The
        // app's middleware must re-establish the local session from
        // `X-Auth-Request-*` headers; no IDP bounce.
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        } finally {
          page.off("response", onResponse);
        }

        const landed = page.url();
        expect(new URL(landed).hostname).toBe(new URL(app.url).hostname);
        expect(
          isAuthWall(landed),
          `${app.name} bounced to auth wall after Layer-2 clear — local session was not re-established from headers. Landed: ${landed}`
        ).toBe(false);
        expect(
          idpHits,
          `${app.name} re-established by bouncing through the IDP (${idpHits[0] ?? ""}) instead of silently from X-Auth-Request-* headers — Layer-2 expiry must not trigger a fresh IDP login while Layer-1 is valid.`
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
