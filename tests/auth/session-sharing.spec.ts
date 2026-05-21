// Spec coverage for this file (see docs/spec-coverage.md):
// @spec oauth2-proxy-gateway#cookie-domain-shall-be-the-platform-parent-domain
// @spec session-lifecycle#the-system-shall-maintain-two-distinct-session-layers

import { test, expect } from "../../fixtures";
import {
  APPS,
  AUTH_COOKIE,
  COGNITO_DOMAIN,
  AUTH_PROXY_DOMAIN,
  COOKIE_DOMAIN,
  COOKIE_DOMAIN_REGEX,
} from "../../constants";

// Reasonable session-cookie expiry window. Lower bound: a freshly-issued
// cookie should have at least 5 minutes left (otherwise the session will
// expire mid-test). Upper bound is deployment-configurable because some
// environments intentionally run multi-month SSO TTLs.
//
// MAX has a small grace window built in: the server issues the cookie a
// few hundred ms before our test reads it, and some apps round up to the
// next second / minute. Without slack, a "92 days exactly" deployment
// TTL reports as 92.0 days remaining and trips the strict `> 92 days`
// rejection. 1 hour is comfortably above any rounding noise but still
// well under any meaningful contract violation.
const MIN_REMAINING_SECONDS = 5 * 60;
const MAX_REMAINING_GRACE_SECONDS = 60 * 60;
const parsedMaxTtl = Number(process.env.FOSS_MAX_SESSION_TTL_SECONDS);
const MAX_REMAINING_SECONDS = Number.isFinite(parsedMaxTtl) && parsedMaxTtl > 0
  ? parsedMaxTtl
  : 92 * 24 * 60 * 60 + MAX_REMAINING_GRACE_SECONDS;

// Cookies that actually carry identity / session bearer state. Other
// persistent cookies (CSRF tokens, locale, "last signed in" UX hints) are
// conventionally long-lived and are not part of the SSO TTL contract.
const AUTH_COOKIE_PATTERNS: RegExp[] = [
  /^_oauth2_proxy/i,
  /session(id|_id|-id)?$/i,
  /^access[_-]?token$/i,
  /^auth[_-]?token$/i,
  /^id[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^jwt$/i,
  /^JSESSIONID$/,
  /^PHPSESSID$/,
];

function isAuthCookie(name: string): boolean {
  return AUTH_COOKIE_PATTERNS.some((p) => p.test(name));
}

test.describe("SSO Session Sharing", () => {
  test("_oauth2_proxy cookie is shared across all FOSS subdomains", async ({ context, page }) => {
    // Warm one app so the cookie is in the jar, then assert one cookie covers
    // every app's host (it's scoped to .${COOKIE_DOMAIN} — same cookie everywhere).
    await page.goto(APPS[0]!.url, { waitUntil: "domcontentloaded", timeout: 30000 });

    for (const app of APPS) {
      const cookies = await context.cookies(app.url);
      const c = cookies.find((c) => c.name === AUTH_COOKIE);
      expect(c, `${app.name} missing ${AUTH_COOKIE}`).toBeDefined();
      expect(c!.value, `${app.name} has empty cookie`).not.toBe("");
      expect(
        c!.domain,
        `${app.name} cookie not on .${COOKIE_DOMAIN}`
      ).toMatch(COOKIE_DOMAIN_REGEX);
    }
  });

  test("_oauth2_proxy cookie has a valid future expiry within session bounds", async ({
    context,
    page,
  }) => {
    await page.goto(APPS[0]!.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const cookies = await context.cookies(APPS[0]!.url);
    const c = cookies.find((c) => c.name === AUTH_COOKIE);
    expect(c).toBeDefined();

    // Playwright returns expires=-1 for browser-session cookies (cleared on
    // browser close). The SSO cookie must be persistent across browser
    // restarts within its TTL — anything else breaks tab-restore + multi-day
    // device usage.
    expect(c!.expires, "SSO cookie must not be a browser-session cookie").toBeGreaterThan(0);

    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = c!.expires - nowSec;
    expect(
      remaining,
      `SSO cookie already expired (expires=${c!.expires}, now=${nowSec})`
    ).toBeGreaterThan(0);
    expect(
      remaining,
      `SSO cookie expires in <${MIN_REMAINING_SECONDS}s (${remaining}s) — TTL too short or skewed`
    ).toBeGreaterThan(MIN_REMAINING_SECONDS);
    expect(
      remaining,
      `SSO cookie expires in >${MAX_REMAINING_SECONDS}s (${remaining}s, ${(remaining / 86400).toFixed(1)} days) — likely misconfigured TTL`
    ).toBeLessThan(MAX_REMAINING_SECONDS);
  });

  test("auth/session cookies on every app have valid future expiry within session bounds", async ({
    context,
    page,
  }) => {
    test.setTimeout(180_000);
    const nowSec = Math.floor(Date.now() / 1000);
    const failures: string[] = [];

    for (const app of APPS) {
      // `commit` + ERR_ABORTED tolerance — Twenty's SPA aborts the
      // top-level navigation when its auth-redirect fires mid-flight.
      // By the time the abort lands, response headers (and Set-Cookie)
      // have already arrived, so the cookie jar is correct.
      try {
        await page.goto(app.url, { waitUntil: "commit", timeout: 60000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/ERR_ABORTED/.test(msg)) throw e;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      const cookies = await context.cookies(app.url);

      for (const c of cookies) {
        if (!isAuthCookie(c.name)) continue;
        // expires=-1 → browser-session cookie. CSRF and similar throwaway
        // cookies use this; pattern filter already excludes them, but be
        // safe.
        if (c.expires <= 0) continue;

        if (c.expires <= nowSec) {
          failures.push(
            `${app.name}: auth cookie ${c.name} (domain=${c.domain}) is already expired (expires=${c.expires})`
          );
          continue;
        }
        const remaining = c.expires - nowSec;
        if (remaining > MAX_REMAINING_SECONDS) {
          failures.push(
            `${app.name}: auth cookie ${c.name} (domain=${c.domain}) expires in ${(remaining / 86400).toFixed(1)} days — > ${MAX_REMAINING_SECONDS / 86400} day SSO TTL limit`
          );
        }
      }
    }

    expect(failures, `Auth cookie expiry violations:\n${failures.join("\n")}`).toEqual([]);
  });

  test("round-trip across all apps requires no re-authentication", async ({ page }) => {
    test.setTimeout(180_000);
    for (const app of APPS) {
      // Twenty's SPA does a client-side redirect after first paint
      // that can abort the top-level navigation and even bounce us
      // back to the previous app's host. We tolerate ERR_ABORTED and
      // retry up to 3 times until the page settles on the target
      // host — this exercises exactly the "no re-auth needed" path
      // we want to assert.
      const targetHost = new URL(app.url).hostname;
      const targetHostRe = new RegExp(`^https?://${targetHost.replace(/\./g, "\\.")}`);
      let attempt = 0;
      const maxAttempts = 3;
      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          await page.goto(app.url, { waitUntil: "commit", timeout: 60000 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/ERR_ABORTED/.test(msg)) throw e;
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        if (new URL(page.url()).hostname === targetHost) break;
        // Stuck on a different host (Twenty's SPA bounced us somewhere
        // else). Give the client-side redirect a brief chance to settle,
        // then retry.
        await page.waitForURL(targetHostRe, { timeout: 1_500 }).catch(() => {});
      }
      const landed = page.url();
      console.log(`${app.name} → ${landed} (attempt ${attempt}/${maxAttempts})`);

      expect(landed).not.toContain(COGNITO_DOMAIN);
      expect(landed).not.toContain(AUTH_PROXY_DOMAIN);
      expect(
        new URL(landed).hostname,
        `${app.name}: after ${maxAttempts} navigation attempts the page is still on ${new URL(landed).hostname}, not ${targetHost} (Twenty SPA may be bouncing back to the previous app's host — investigate the SPA's first-paint redirect chain)`
      ).toBe(targetHost);
    }

    // Round-trip back to first app — still authed
    await page.goto(APPS[0]!.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    expect(new URL(page.url()).hostname).toBe(new URL(APPS[0]!.url).hostname);
  });
});
