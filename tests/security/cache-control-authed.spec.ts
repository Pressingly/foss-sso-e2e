// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#authenticated-responses-shall-forbid-shared-cache-storage

import { test, expect } from "../../fixtures";
import { APPS, MAIN_URL } from "../../constants";

// Cache-Control on authenticated HTML responses.
//
// Threat: if a logged-in app's HTML response is cacheable by a SHARED
// cache (browser back/forward beyond the bfcache, CDN, corporate
// forward proxy, kiosk shared-browser) then user A's authenticated page
// can be served to user B on the same network — a same-browser
// session-bleed adjacent to (but distinct from) the logout-all chain
// problem. The defence is response-level `Cache-Control` directives
// that forbid shared-cache storage:
//
//   - `no-store`              — strongest; nothing is cached anywhere
//   - `private` + `no-cache`  — only the private cache (browser) may
//                                store; shared caches must NOT
//   - `private` + `max-age=0` — equivalent, less common shape
//
// We accept any of these. We REJECT bare `public`, missing header, or
// any directive that allows shared-cache storage.
//
// Scope: the SSO chain end-points (portal, oauth2-proxy entry) and the
// HTML landing of each of the 5 apps when authenticated. Static assets
// (JS chunks, fonts, images) are deliberately out of scope — those
// SHOULD be cacheable; the regression we guard is "the HTML carrying
// session-dependent content is cacheable by a shared cache".
//
// Why not just HSTS-class: HSTS protects in-flight; this protects
// at-rest in shared caches. The two are orthogonal.

interface CacheVerdict {
  ok: boolean;
  reason: string;
}

function evaluateCacheControl(raw: string | undefined): CacheVerdict {
  if (raw === undefined) {
    return {
      ok: false,
      reason:
        "Cache-Control header missing. Authenticated HTML MUST set Cache-Control " +
        "to prevent shared-cache storage of session-dependent content.",
    };
  }
  const value = raw.toLowerCase();
  const directives = value.split(",").map((d) => d.trim());

  // Strong: `no-store` alone is sufficient.
  if (directives.includes("no-store")) {
    return { ok: true, reason: `no-store present in "${value}"` };
  }

  // Accept `private` ONLY when paired with `no-cache` or `max-age=0`.
  // `private` alone allows the browser cache to serve the page on
  // back/forward; that's fine for browser cache, but `private` does
  // NOT prevent the page from being revalidated — `no-cache` /
  // `max-age=0` is what forces revalidation. Pinning the stricter
  // pair is the defensible default.
  const hasPrivate = directives.includes("private");
  const hasNoCache = directives.includes("no-cache");
  const hasMaxAgeZero = directives.some((d) => /^max-age\s*=\s*0$/.test(d));
  if (hasPrivate && (hasNoCache || hasMaxAgeZero)) {
    return { ok: true, reason: `private + no-cache/max-age=0 in "${value}"` };
  }

  // Anything else (public, bare s-maxage>0, max-age>0 without private,
  // immutable, etc.) allows shared-cache storage of authenticated
  // content. Reject.
  return {
    ok: false,
    reason:
      `Cache-Control: "${value}" allows shared-cache storage of authenticated ` +
      `content. Acceptable: "no-store" OR "private, no-cache" OR "private, max-age=0".`,
  };
}

test.describe("Cache-Control — authenticated HTML responses MUST NOT be shared-cacheable", () => {
  const TARGETS = [
    { name: "Main portal", url: MAIN_URL },
    ...APPS.map((a) => ({ name: a.name, url: a.url })),
  ];

  for (const target of TARGETS) {
    test(`${target.name}: HTML response forbids shared-cache storage`, async ({
      page,
    }) => {
      test.setTimeout(60_000);

      // We need the FINAL response (the authed HTML), not the 302 to
      // the IDP / oauth2-proxy redirect chain. Drive the navigation
      // through the page (which is authed via the worker fixture) and
      // capture the response object for the navigated URL.
      const responsePromise = page.waitForResponse(
        (r) =>
          r.url() === target.url ||
          r.url().startsWith(`${target.url}/`) ||
          r.url() === `${target.url}/`,
        { timeout: 30_000 },
      );
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const response = await responsePromise.catch(() => null);

      // Some apps (Penpot hash routes, Twenty SPA shell) settle on a
      // different final URL than the requested origin root. In that
      // case grab whatever HTML response landed via the page's own
      // tracking. Fallback: refetch with the page's cookies through a
      // request context.
      let cacheControl: string | undefined;
      if (response) {
        cacheControl = response.headers()["cache-control"]?.toLowerCase();
      }

      if (cacheControl === undefined) {
        // Fallback: use the browser context's cookies to refetch the
        // origin and read the header. This still exercises the
        // authenticated response path.
        const ctx = await page.context().request;
        const refetch = await ctx.get(target.url, {
          maxRedirects: 5,
          timeout: 15_000,
        });
        cacheControl = refetch.headers()["cache-control"]?.toLowerCase();
      }

      const verdict = evaluateCacheControl(cacheControl);
      expect(
        verdict.ok,
        `${target.name} (${target.url}) — ${verdict.reason}\n` +
          `Background: an authenticated HTML response stored in a shared cache (corporate ` +
          `proxy, kiosk, browser back-forward) can be served to a different user on the ` +
          `same network. Forbid with "Cache-Control: no-store" (preferred) or "private, no-cache".`,
      ).toBe(true);
    });
  }
});
