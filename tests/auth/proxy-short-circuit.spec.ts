// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#authenticated-sessions-with-matching-or-absent-proxy-identity-shall-short-circuit

import { test, expect } from "../../fixtures";
import { APPS, AUTH_COOKIE } from "../../constants";

// When the SSO session is alive and the X-Auth-Request-Email header
// matches (or is absent on internal traffic), the per-app middleware
// MUST return the response unchanged — no `logout(request) +
// user_login`, no session rotation, no DB write.
//
// Why it matters: if this regresses, *every* authenticated request to
// the app re-creates the session. Symptoms users see:
//   • Intermittent session loss (form state wiped mid-edit).
//   • Slow page loads (extra session-table writes per request).
//   • Cookie value rotates on each request — breaks tab-restore.
//
// Observable signal: the app's local session cookie value must stay
// stable across multiple authenticated navigations on the same host.
// A working short-circuit keeps the same sessionid / accessToken /
// session bytes across N requests; a broken one rotates them.

// Heuristics for "this is the app's session cookie". Mirrors the
// pattern in tests/auth/session-sharing.spec.ts. Excluded: cookies that
// are *always* expected to vary (CSRF tokens) or are platform-wide
// (_oauth2_proxy is the SSO layer, not the app's local session).
const APP_SESSION_COOKIE_PATTERNS: RegExp[] = [
  /^sessionid$/i, // Django (Plane, SurfSense)
  /^accessToken$/i, // Outline
  /^session(_id|-id)?$/i, // generic
  /^connect\.sid$/i, // Express
];

const SSO_COOKIE_NAMES = new Set([AUTH_COOKIE]);

function isAppSessionCookie(name: string): boolean {
  if (SSO_COOKIE_NAMES.has(name)) return false;
  return APP_SESSION_COOKIE_PATTERNS.some((p) => p.test(name));
}

test.describe("proxy-auth-middleware short-circuit (session cookie stable across requests)", () => {
  for (const app of APPS) {
    test(`${app.name}: 3 authenticated navigations do NOT rotate the local session cookie`, async ({
      context,
      page,
    }) => {
      test.setTimeout(120_000);

      // First visit: prime + capture cookies.
      await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const after1 = (await context.cookies(app.url)).filter((c) =>
        isAppSessionCookie(c.name)
      );

      // Some apps don't surface a JS-readable session cookie at all
      // (auth is purely header-driven each request). For those, this
      // requirement is vacuously satisfied — log it and skip.
      if (after1.length === 0) {
        test.skip(
          true,
          `${app.name}: no JS-readable app-local session cookie (auth is header-driven). Short-circuit requirement is vacuously satisfied — nothing to rotate.`
        );
      }

      // Second visit: same host, different path. If short-circuit is
      // broken, this triggers a fresh logout/user_login cycle and the
      // session cookie value changes.
      await page.goto(`${app.url}/?_=spec-probe-2`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const after2 = (await context.cookies(app.url)).filter((c) =>
        isAppSessionCookie(c.name)
      );

      // Third visit: a final navigation to confirm stability isn't an
      // accident on the second request.
      await page.goto(`${app.url}/?_=spec-probe-3`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const after3 = (await context.cookies(app.url)).filter((c) =>
        isAppSessionCookie(c.name)
      );

      // Build a name → [values across 3 visits] map. The short-circuit
      // requirement says each cookie's value must be the same on all
      // three visits.
      const seen = new Map<string, string[]>();
      const push = (cookies: typeof after1) => {
        for (const c of cookies) {
          if (!seen.has(c.name)) seen.set(c.name, []);
          seen.get(c.name)!.push(c.value);
        }
      };
      push(after1);
      push(after2);
      push(after3);

      const rotated: string[] = [];
      for (const [name, values] of seen) {
        const distinct = new Set(values);
        if (distinct.size > 1) {
          rotated.push(
            `${name}: ${[...distinct].length} distinct values across 3 visits`
          );
        }
      }

      expect(
        rotated,
        `${app.name}: app-local session cookie rotated across 3 authenticated navigations — proxy-auth-middleware likely fires logout()+user_login() on every request instead of short-circuiting:\n${rotated.join("\n")}`
      ).toEqual([]);
    });
  }
});
