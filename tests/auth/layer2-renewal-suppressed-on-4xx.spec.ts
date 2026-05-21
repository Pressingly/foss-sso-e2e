// Spec coverage for this file (see docs/spec-coverage.md):
// @spec session-lifecycle#layer-2-session-renewal-shall-be-guarded-against-three-regression-paths

import { test, expect } from "../../fixtures";
import { request, BrowserContext, expect as rawExpect } from "@playwright/test";
import { APP_URLS } from "../../constants";

// `session-lifecycle/spec.md` §"Layer-2 session renewal SHALL be guarded
// against three regression paths" requires that an app's session-renewal
// middleware MUST NOT issue a fresh session cookie on a non-success
// response. The canonical bug class (Penpot/Yetti, listed in the spec):
//
//   - Inner middleware returns 403 on a denied admin action.
//   - Outer renewal middleware ignores the qualified status and
//     re-issues `auth-token=…` on the response anyway.
//   - The rejected user's session is silently extended past its TTL.
//
// We can't engineer "stale cookie past renewal threshold" without
// fast-forwarding time, but we CAN pin the weaker invariant that
// catches the missing-status-guard AND missing-renewal-due-guard
// regressions together: on any 4xx, no fresh session cookie is issued.
//
// We probe Penpot specifically because:
//   1. The spec scenario names `auth-token` and Yetti — that's Penpot.
//   2. Penpot's RPC layer is auth-aware: every `/api/rpc/command/*`
//      POST routes through the same outer middleware stack that owns
//      cookie renewal.
//   3. POSTing an invalid command (or an unknown one) returns a clean
//      4xx that exercises the renewal path without needing per-tenant
//      knowledge of admin roles or workspace ownership.
//
// Extending to other apps (Outline `accessToken`, Plane `sessionid`)
// is the next step if a regression appears in those — same pattern,
// different per-app cookie name.

const APP_SESSION_COOKIE_NAMES: Record<string, RegExp> = {
  Penpot: /^auth-token$/i,
};

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// `multi()` returns every Set-Cookie header from the response. Playwright
// folds them into a `\n`-separated string on `headers()['set-cookie']`,
// but `headersArray()` preserves them as individual entries which is
// safer to parse.
function setCookieValues(
  headersArray: { name: string; value: string }[]
): string[] {
  return headersArray
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
}

// A "fresh cookie" is a Set-Cookie that issues a non-empty value (so it
// would extend the session). An expiring/clearing Set-Cookie (Max-Age=0
// or value="") is fine — that's the Rule 3 cookie-expiry path on a
// mismatch, NOT a renewal.
function isFreshSessionCookie(setCookie: string, namePattern: RegExp): boolean {
  // Set-Cookie format: name=value; attr1; attr2; ...
  const eq = setCookie.indexOf("=");
  if (eq < 0) return false;
  const name = setCookie.slice(0, eq).trim();
  const rest = setCookie.slice(eq + 1);
  const valueEnd = rest.indexOf(";");
  const value = (valueEnd < 0 ? rest : rest.slice(0, valueEnd)).trim();
  if (!namePattern.test(name)) return false;
  if (value === "" || value === '""') return false;
  // Max-Age=0 or Expires in the past indicates a clearing Set-Cookie,
  // not a renewal. We only flag it as "fresh" if it isn't a clearing.
  if (/Max-Age\s*=\s*0(\s*;|$)/i.test(setCookie)) return false;
  return true;
}

test.describe("Layer-2 renewal — suppressed on 4xx responses", () => {
  test("Penpot: a 4xx RPC response does NOT issue a fresh auth-token cookie", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);

    // Warm Penpot so the auth-token cookie is in the jar. Penpot's
    // proxy-auth-middleware sets `auth-token` on its first authenticated
    // RPC reply (e.g. the SPA's get-profile fetch on first load), not on
    // the HTML response — `domcontentloaded` fires too early on slower
    // CI runners, so we poll until the cookie appears.
    await page.goto(APP_URLS.Penpot, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await rawExpect
      .poll(
        async () => {
          const header = await cookieHeaderFor(context, APP_URLS.Penpot);
          return /auth-token=/i.test(header);
        },
        {
          message:
            "Pre-condition: Penpot must have issued an auth-token cookie after login (waited up to 15s for the SPA's first authenticated RPC reply)",
          timeout: 15_000,
        }
      )
      .toBe(true);

    const cookieHeader = await cookieHeaderFor(context, APP_URLS.Penpot);

    const apiCtx = await request.newContext({
      extraHTTPHeaders: {
        cookie: cookieHeader,
        "content-type": "application/transit+json",
      },
    });

    try {
      // POST to a non-existent RPC command. Penpot's RPC dispatch returns
      // a 4xx with a structured error, exercising the same outer
      // middleware stack as a denied admin action — including any
      // session-renewal logic.
      const url = `${APP_URLS.Penpot}/api/rpc/command/this-command-does-not-exist`;
      const res = await apiCtx.post(url, {
        data: '["^ "]', // valid transit empty map; body shape isn't the point
        maxRedirects: 0,
      });

      const status = res.status();
      expect(
        status >= 400 && status < 500,
        `Pre-condition: expected a 4xx from unknown RPC command, got ${status}`
      ).toBe(true);

      // Now the load-bearing assertion: no fresh auth-token in Set-Cookie.
      const setCookies = setCookieValues(await res.headersArray());
      const pattern = APP_SESSION_COOKIE_NAMES.Penpot!;
      const freshRenewals = setCookies.filter((sc) =>
        isFreshSessionCookie(sc, pattern)
      );

      expect(
        freshRenewals,
        `Penpot issued a fresh auth-token cookie on a 4xx response — the renewal middleware's status guard is failing.\nSet-Cookie headers seen on the 4xx response:\n${setCookies.join("\n") || "(none)"}`
      ).toEqual([]);
    } finally {
      await apiCtx.dispose();
    }
  });
});
