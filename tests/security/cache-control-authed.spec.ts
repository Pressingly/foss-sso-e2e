// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#authenticated-responses-shall-forbid-shared-cache-storage

import { test, expect } from "../../fixtures";
import { MAIN_URL } from "../../constants";

// Cache-Control on authenticated HTML responses.
//
// Threat: if a logged-in HTML response is cacheable by a SHARED cache
// (browser back/forward beyond the bfcache, CDN, corporate forward
// proxy, kiosk shared-browser) then user A's authenticated page can be
// served to user B on the same network — a same-browser session-bleed
// adjacent to (but distinct from) the logout-all chain problem. The
// defence is response-level `Cache-Control` directives that forbid
// shared-cache storage:
//
//   - `no-store`              — strongest; nothing is cached anywhere
//   - `private` + `no-cache`  — only the private cache (browser) may
//                                store; shared caches must NOT
//   - `private` + `max-age=0` — equivalent, less common shape
//
// We accept any of these. We REJECT bare `public`, missing header, or
// any directive that allows shared-cache storage.
//
// SCOPE: portal only — NOT the 5 apps. Same rationale as the CSP /
// COOP / CORP block in `tests/security/headers.spec.ts`:
//
//   The bundle (Traefik + oauth2-proxy + mpass-auth-proxy) owns the
//   portal HTML, so it can set the right Cache-Control on that
//   response. For the 5 apps, the bundle CANNOT set Cache-Control
//   from outside without breaking their SPA shell. Empirically the
//   apps each ship their own value:
//
//     - Outline:   `no-cache, must-revalidate`  (missing `private`)
//     - Plane:     header absent
//     - Penpot:    private-class (passes the contract)
//     - SurfSense: `s-maxage=31536000`  ⚠️ explicit 1-year shared
//                                          cache on authed HTML — a
//                                          real upstream issue
//     - Twenty:    `public, max-age=0`  (public allows shared store)
//
//   SurfSense's value in particular is concerning — tracked at
//   foss-server-bundle#84 (upstream patch or Traefik response-header
//   override). It's an upstream-owned response — the bundle can't
//   override it cleanly without regressing the SPA. Per-app
//   Cache-Control fixes belong upstream in each app's response
//   middleware. This test pins the BUNDLE'S responsibility (portal
//   HTML); the per-app state above is the audit log, not the contract.
//
// Static assets (JS chunks, fonts, images) are deliberately out of
// scope — those SHOULD be cacheable; the regression we guard is "the
// session-dependent HTML is cacheable by a shared cache".

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

test.describe("Cache-Control — portal authenticated HTML MUST NOT be shared-cacheable", () => {
  // Portal only — per-app HTML is upstream-owned (see file head).
  const TARGETS = [{ name: "Main portal", url: MAIN_URL }];

  for (const target of TARGETS) {
    // KNOWN-RED until bundle adds `Cache-Control: no-store` (or
    // `private, no-cache`) to the portal HTML response. As of
    // 2026-06-01 the bundle ships the portal landing without a
    // Cache-Control header at all — so this assertion documents the
    // contract but is dormant in CI. Tracked at
    // foss-server-bundle#83 (nginx config — same place that already
    // sets HSTS/XFO/CSP on the portal response). Remove `.fixme`
    // once that issue ships.
    test.fixme(`${target.name}: HTML response forbids shared-cache storage`, async ({
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
