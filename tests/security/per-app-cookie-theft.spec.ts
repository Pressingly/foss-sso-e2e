// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#per-app-session-cookies-shall-not-be-standalone-bearer-credentials
// @spec security-hardening#per-app-session-cookies-shall-be-hardened-at-issue-time
//
// Two complementary describe blocks:
//
//   (A) "Per-app session cookies are NOT standalone bearer credentials" —
//       even if an attacker lifts a per-app cookie (Outline accessToken,
//       Plane sessionid, Penpot opaque, etc.), it's insufficient on its
//       own because the ForwardAuth chain in front of every app router
//       refuses requests without a valid `_oauth2_proxy` cookie. The
//       request gets bounced to the IDP before the per-app middleware
//       even sees it. This is the bundle's defense-in-depth model.
//
//   (B) "Per-app session cookies are issued with hardening attributes" —
//       even though (A) shows the cookies aren't standalone credentials,
//       attribute hygiene (HttpOnly / Secure / host-scoped Domain)
//       prevents the XSS-lift / network-capture / sibling-subdomain-
//       leak mechanisms in the first place.

import { test, expect } from "../../fixtures";
import { request, type BrowserContext } from "@playwright/test";
import { APP_URLS, AUTH_COOKIE, COOKIE_DOMAIN } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

// Per-app session-cookie name patterns for theft checks in this spec.
const APP_SESSION_COOKIE_PATTERNS: RegExp[] = [
  /^sessionid$/i, // Django (Plane, SurfSense)
  /^accessToken$/i, // Outline
  /^auth[-_]token$/i, // Penpot
  /^session(_id|-id)?$/i, // generic
  /^connect\.sid$/i, // Express
];

const NON_APP_COOKIE_NAMES = new Set([
  AUTH_COOKIE, // the SSO layer — covered by cookie-attributes.spec.ts
  `${AUTH_COOKIE}_csrf`,
]);

function isAppSessionCookie(name: string): boolean {
  if (NON_APP_COOKIE_NAMES.has(name)) return false;
  return APP_SESSION_COOKIE_PATTERNS.some((p) => p.test(name));
}

const APP_NAME_TO_URL: Record<string, string> = {
  PM: APP_URLS.PM,
  Outline: APP_URLS.Outline,
  Penpot: APP_URLS.Penpot,
  SurfSense: APP_URLS.SurfSense,
  Twenty: APP_URLS.Twenty,
};

// Apps known to authenticate via a per-app session COOKIE, so a theft /
// attribute check is meaningful and a session cookie MUST be present.
// Twenty is intentionally excluded: it authenticates via a localStorage
// token pair, not a session cookie, so "no session cookie found" is
// correct-by-design for Twenty only. For every app in this set, finding
// zero session cookies is a silent coverage hole — the cookie was renamed
// out of APP_SESSION_COOKIE_PATTERNS, or auth changed — so we fail loud
// instead of skipping as "vacuously safe".
const KNOWN_STATEFUL_APPS = new Set(["PM", "Outline", "Penpot", "SurfSense"]);

// Per-app /me probes used in (A) to confirm that with the SSO cookie
// the per-app cookies DO work — pre-condition for the test. Twenty
// excluded (no stable cookie-authed /me endpoint).
type IdentityProbe = (ctx: BrowserContext) => Promise<{ email: string; ok: boolean; status: number }>;
const PROBES: Record<string, IdentityProbe> = {
  PM: async (ctx) => {
    const cookies = await ctx.cookies(APP_URLS.PM);
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const c = await request.newContext({ extraHTTPHeaders: { cookie: header } });
    try {
      const r = await c.get(`${APP_URLS.PM}/api/users/me/`);
      const status = r.status();
      const body = await r.text();
      let email = "";
      try {
        email = (JSON.parse(body) as { email?: string }).email ?? "";
      } catch {
        /* non-JSON — leave email empty */
      }
      return { email, ok: r.ok(), status };
    } finally {
      await c.dispose();
    }
  },
  Outline: async (ctx) => {
    const cookies = await ctx.cookies(APP_URLS.Outline);
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const c = await request.newContext({
      extraHTTPHeaders: { cookie: header, "content-type": "application/json" },
    });
    try {
      const r = await c.post(`${APP_URLS.Outline}/api/auth.info`, { data: {} });
      const status = r.status();
      const body = await r.text();
      let email = "";
      try {
        email = (JSON.parse(body) as { data?: { user?: { email?: string } } })?.data?.user?.email ?? "";
      } catch {
        /* non-JSON — leave email empty */
      }
      return { email, ok: r.ok(), status };
    } finally {
      await c.dispose();
    }
  },
  SurfSense: async (ctx) => {
    const cookies = await ctx.cookies(APP_URLS.SurfSense);
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const c = await request.newContext({ extraHTTPHeaders: { cookie: header } });
    try {
      const r = await c.get(`${APP_URLS.SurfSense}/users/me`);
      const status = r.status();
      const body = await r.text();
      let email = "";
      try {
        email = (JSON.parse(body) as { email?: string }).email ?? "";
      } catch {
        /* non-JSON */
      }
      return { email, ok: r.ok(), status };
    } finally {
      await c.dispose();
    }
  },
  Penpot: async (ctx) => {
    const cookies = await ctx.cookies(APP_URLS.Penpot);
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const c = await request.newContext({ extraHTTPHeaders: { cookie: header } });
    try {
      const r = await c.get(`${APP_URLS.Penpot}/api/rpc/command/get-profile`);
      const status = r.status();
      let email = "";
      try {
        email = extractPenpotTransitField(await r.json(), "~:email");
      } catch {
        /* non-JSON */
      }
      return { email, ok: r.ok(), status };
    } finally {
      await c.dispose();
    }
  },
};

// ---------------------------------------------------------------------------
// (A) Per-app session cookies WITHOUT the SSO cookie do NOT authenticate.
//     The ForwardAuth chain bounces the request before the app's own
//     middleware sees it.
// ---------------------------------------------------------------------------
test.describe("Per-app session cookies alone are NOT standalone credentials", () => {
  for (const appName of Object.keys(PROBES) as Array<keyof typeof PROBES>) {
    test(`${appName}: stolen per-app cookies WITHOUT _oauth2_proxy do NOT authenticate`, async ({
      context,
      page,
      browser,
    }) => {
      test.setTimeout(120_000);

      const baseUrl = APP_NAME_TO_URL[appName]!;
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Pre-condition: with the WHOLE cookie jar (SSO + per-app),
      // the probe succeeds and returns the worker user's email.
      const baseline = await PROBES[appName]!(context);
      expect(
        baseline.email,
        `${appName}: baseline /me with full cookie jar must return a well-formed email (status=${baseline.status}). Pre-condition failed.`,
      ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

      // Capture per-app cookies ONLY (no _oauth2_proxy).
      const all = await context.cookies(baseUrl);
      const sessionCookies = all.filter((c) => isAppSessionCookie(c.name));
      if (sessionCookies.length === 0) {
        if (KNOWN_STATEFUL_APPS.has(String(appName))) {
          expect(
            sessionCookies.length,
            `${appName}: expected at least one per-app session cookie to steal but found none on ${baseUrl}. Cookie names: ${all.map((c) => c.name).join(", ")}. ${appName} is known cookie-stateful — zero matches means its session cookie was renamed out of APP_SESSION_COOKIE_PATTERNS (a silent coverage hole), not that there is nothing to steal.`,
          ).toBeGreaterThan(0);
        }
        test.skip(
          true,
          `${appName}: no app session cookies on ${baseUrl}. Cookie names: ${all.map((c) => c.name).join(", ")}. App may use header-only auth (vacuously safe — nothing to steal).`,
        );
      }

      // Attacker's empty context — only the lifted per-app cookies,
      // NO _oauth2_proxy.
      const attackerCtx = await browser.newContext();
      try {
        await attackerCtx.addCookies(
          sessionCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
          })),
        );

        const stolen = await PROBES[appName]!(attackerCtx);

        // Contract: the request must NOT return the victim's email.
        // Accepted shapes: 4xx (rejected outright), 302 to IDP, empty
        // body, or any non-email response. The bundle's ForwardAuth
        // chain should bounce the request before the per-app
        // middleware even processes it.
        expect(
          stolen.email.toLowerCase(),
          `${appName}: per-app cookie ALONE returned the victim's email (status=${stolen.status}). This means the per-app middleware is honouring the local session WITHOUT a valid _oauth2_proxy cookie — the ForwardAuth gate is being bypassed.`,
        ).not.toBe(baseline.email.toLowerCase());
      } finally {
        await attackerCtx.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (B) Per-app session cookies are issued with HttpOnly + Secure +
//     correctly-scoped Domain. Defenses that prevent the lift mechanism
//     in (A) from happening in the first place.
// ---------------------------------------------------------------------------
test.describe("Per-app session cookie attributes (defenses against theft)", () => {
  for (const appName of Object.keys(APP_NAME_TO_URL) as Array<keyof typeof APP_NAME_TO_URL>) {
    test(`${appName}: per-app session cookies are HttpOnly + Secure + app/parent-domain scoped`, async ({
      context,
      page,
    }) => {
      test.setTimeout(60_000);

      const baseUrl = APP_NAME_TO_URL[appName]!;
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      const all = await context.cookies(baseUrl);
      const sessionCookies = all.filter((c) => isAppSessionCookie(c.name));
      if (sessionCookies.length === 0) {
        if (KNOWN_STATEFUL_APPS.has(String(appName))) {
          expect(
            sessionCookies.length,
            `${appName}: expected at least one per-app session cookie to inspect but found none on ${baseUrl}. Cookie names: ${all.map((c) => c.name).join(", ")}. ${appName} is known cookie-stateful — zero matches means its session cookie was renamed out of APP_SESSION_COOKIE_PATTERNS, silently hiding the hardening-attribute check.`,
          ).toBeGreaterThan(0);
        }
        test.skip(
          true,
          `${appName}: no app session cookies matched APP_SESSION_COOKIE_PATTERNS on ${baseUrl}. Cookie names: ${all.map((c) => c.name).join(", ")}. If header-only auth, vacuously safe.`,
        );
      }

      const failures: string[] = [];
      const expectedHost = new URL(baseUrl).hostname.toLowerCase();
      for (const cookie of sessionCookies) {
        if (!cookie.httpOnly) {
          failures.push(
            `${cookie.name}: HttpOnly=false — JavaScript on this host can read the cookie. An XSS would lift it.`,
          );
        }
        if (!cookie.secure) {
          failures.push(
            `${cookie.name}: Secure=false — cookie can ride over plaintext HTTP. Network observer can capture it.`,
          );
        }
        const cookieDomain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
        // Per-app session cookies should be either host-scoped (the
        // exact app host) or platform-parent-scoped. Wider = leak to
        // unrelated subdomains.
        const acceptableScopes = [expectedHost, COOKIE_DOMAIN.toLowerCase()];
        if (!acceptableScopes.includes(cookieDomain)) {
          failures.push(
            `${cookie.name}: Domain=${JSON.stringify(cookie.domain)} — should be exactly the app host (${expectedHost}) or platform parent (${COOKIE_DOMAIN}). Wider leaks the cookie to unrelated subdomains.`,
          );
        }
      }

      expect(
        failures,
        `${appName} per-app session-cookie attribute violations on ${baseUrl}:\n${failures.join("\n")}`,
      ).toEqual([]);
    });
  }
});
