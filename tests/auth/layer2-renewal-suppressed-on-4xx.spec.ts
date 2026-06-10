// Spec coverage for this file (see docs/spec-coverage.md):
// @spec session-lifecycle#layer-2-session-renewal-shall-be-guarded-against-three-regression-paths

import { test, expect } from "../../fixtures";
import {
  request,
  expect as rawExpect,
  type BrowserContext,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
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
// The spec scenario names `auth-token` and Yetti — that's Penpot — but
// the renewal middleware is a cross-app pattern, so we probe all three
// cookie-stateful apps whose session-renewal middleware owns a session
// cookie: Penpot (`auth-token`), Outline (`accessToken`), Plane
// (`session-id`). Each app gets a request that returns a clean 4xx while
// routing through the same outer middleware stack that owns cookie
// renewal — an unknown RPC command / API method / route. (Twenty and
// SurfSense are out: Twenty renews via a localStorage token pair, not a
// session cookie; SurfSense's cookie path mirrors Plane's Django stack.)
//
// Plane note: its session cookie is `session-id` (hyphenated) and is set
// only after an authenticated API call (ProxyAuthMiddleware creates the
// Django session on the first authenticated request) — a bare page load
// leaves only `_oauth2_proxy` in the jar. So Plane's probe warms the
// cookie via an explicit `/api/users/me/` hit before the assertion.

const APP_SESSION_COOKIE_NAMES: Record<string, RegExp> = {
  Penpot: /^auth-token$/i,
  Outline: /^accessToken$/i,
  PM: /^session-id$/i,
};

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// `headersArray()` preserves every Set-Cookie header as an individual
// entry, which is safer to parse than the `\n`-folded `headers()` form.
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

// Per-app probe: how to warm the session cookie into the jar and how to
// provoke a clean 4xx through the renewal-owning middleware stack.
type RenewalProbe = {
  app: keyof typeof APP_SESSION_COOKIE_NAMES;
  baseUrl: string;
  // Jar-presence regex used in the warm-up poll (pre-condition).
  presence: RegExp;
  // Extra request headers for the authenticated API context.
  extraHeaders?: Record<string, string>;
  // Optional warm step (in addition to the page load) for apps that set
  // their session cookie only after an explicit authenticated API call.
  // Uses the context's shared request jar so the cookie lands in `context`.
  warm?: (ctx: BrowserContext) => Promise<void>;
  // Issue a request that returns a 4xx while routing through the same
  // outer middleware that owns cookie renewal.
  provoke: (apiCtx: APIRequestContext) => Promise<APIResponse>;
};

const PROBES: RenewalProbe[] = [
  {
    app: "Penpot",
    baseUrl: APP_URLS.Penpot,
    presence: /auth-token=/i,
    extraHeaders: { "content-type": "application/transit+json" },
    // POST to a non-existent RPC command. Penpot's RPC dispatch returns a
    // 4xx with a structured error, exercising the same outer middleware
    // stack as a denied admin action — including session-renewal logic.
    provoke: (apiCtx) =>
      apiCtx.post(`${APP_URLS.Penpot}/api/rpc/command/this-command-does-not-exist`, {
        data: '["^ "]', // valid transit empty map; body shape isn't the point
        maxRedirects: 0,
      }),
  },
  {
    app: "Outline",
    baseUrl: APP_URLS.Outline,
    presence: /accessToken=/i,
    extraHeaders: { "content-type": "application/json" },
    // POST to an unknown API method. Outline's JSON API returns a 4xx
    // ({ ok: false }) through the same auth/session middleware that issues
    // the accessToken renewal.
    provoke: (apiCtx) =>
      apiCtx.post(`${APP_URLS.Outline}/api/this.method.does.not.exist`, {
        data: {},
        maxRedirects: 0,
      }),
  },
  {
    app: "PM",
    baseUrl: APP_URLS.PM,
    presence: /session-id=/i,
    // Plane sets `session-id` only on the first authenticated API call,
    // not on the HTML landing — warm it explicitly.
    warm: async (ctx) => {
      await ctx.request.get(`${APP_URLS.PM}/api/users/me/`).catch(() => {});
    },
    // GET an unknown API path. Plane is Django: process_response runs the
    // renewal middleware on the way out for every status, including the
    // 404 an unknown route produces — so a buggy renewal would still set
    // session-id here.
    provoke: (apiCtx) =>
      apiCtx.get(`${APP_URLS.PM}/api/this-endpoint-does-not-exist/`, {
        maxRedirects: 0,
      }),
  },
];

test.describe("Layer-2 renewal — suppressed on 4xx responses", () => {
  for (const probe of PROBES) {
    test(`${probe.app}: a 4xx response does NOT issue a fresh session cookie`, async ({
      context,
      page,
    }) => {
      test.setTimeout(60_000);

      // Warm the app so the per-app session cookie lands in the jar. The
      // renewal-owning middleware sets it on the first authenticated
      // reply (an RPC/API response or redirect), not necessarily the HTML
      // response — `domcontentloaded` can fire too early on slower CI
      // runners, so we poll until the cookie appears.
      await page.goto(probe.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      if (probe.warm) await probe.warm(context);

      await rawExpect
        .poll(
          async () => probe.presence.test(await cookieHeaderFor(context, probe.baseUrl)),
          {
            message: `Pre-condition: ${probe.app} must have issued its session cookie after login (waited up to 15s for the first authenticated reply)`,
            timeout: 15_000,
          }
        )
        .toBe(true);

      const cookieHeader = await cookieHeaderFor(context, probe.baseUrl);

      const apiCtx = await request.newContext({
        extraHTTPHeaders: { cookie: cookieHeader, ...(probe.extraHeaders ?? {}) },
      });

      try {
        const res = await probe.provoke(apiCtx);

        const status = res.status();
        expect(
          status >= 400 && status < 500,
          `Pre-condition: expected a 4xx from ${probe.app}'s unknown endpoint, got ${status}`
        ).toBe(true);

        // Load-bearing assertion: no fresh session cookie in Set-Cookie.
        const setCookies = setCookieValues(await res.headersArray());
        const pattern = APP_SESSION_COOKIE_NAMES[probe.app]!;
        const freshRenewals = setCookies.filter((sc) =>
          isFreshSessionCookie(sc, pattern)
        );

        expect(
          freshRenewals,
          `${probe.app} issued a fresh session cookie on a 4xx response — the renewal middleware's status guard is failing.\nSet-Cookie headers seen on the 4xx response:\n${setCookies.join("\n") || "(none)"}`
        ).toEqual([]);
      } finally {
        await apiCtx.dispose();
      }
    });
  }
});
