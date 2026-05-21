// Spec coverage for this file (see docs/spec-coverage.md):
// @spec forwardauth-traefik#bypass-paths-shall-route-via-higher-priority-routers-without-mpass-auth

import { test, expect, request } from "@playwright/test";
import { APPS, APP_URLS, isAuthWall } from "../../constants";
import { SPOOFED_HEADERS } from "../lib/spoofed-headers";

// Smoke test for the bypass + SSO-surface routers added in the 2026-05
// production rollout (foss-server-bundle#30). The PR chained
// `security-headers` and `strip-auth-headers` onto every browser-reachable
// non-secure router.
//
// What this test ACTUALLY proves: the bypass routers are reachable,
// fire on the documented paths, and don't 5xx — i.e. the router config
// itself is healthy after the rollout.
//
// What this test does NOT prove: that `strip-auth-headers` ran before
// the upstream. None of the bypass paths exercised here
// (`/favicon.ico`, `/god-mode`) currently read `X-Auth-Request-*`, so
// strip presence is unobservable from outside the stack. The actual
// strip-middleware validation lives in
// `tests/security/header-spoofing.spec.ts` ("strip middleware (authed)"),
// which targets a `*-secure` upstream that DOES read identity. We
// leave the spoofed-header values in this test as documentation: if
// a future bypass surface starts reading identity, this test grows
// teeth without further changes (just swap `/favicon.ico` for the new
// path and add an assertion on the response body).
//
// `forwardauth-traefik#header-overwrite-shall-be-enforced` covers
// "strip in front of any browser-reachable upstream" as an audit
// invariant; the live validation is in header-spoofing.spec.ts.

// Per-app bypass paths that are known to be served by a `*-bypass`
// router (not the secure catch-all). Universal: every host serves
// /favicon.ico via its static-asset bypass.
const BYPASS_TARGETS: { name: string; url: string }[] = [
  ...APPS.map((a) => ({
    name: `${a.name} /favicon.ico (static bypass)`,
    url: `${a.url}/favicon.ico`,
  })),
  // Plane admin bypass — /god-mode is the canonical example. The
  // production rollout specifically called out this surface (admin UI
  // under the same cookie scope as plane-secure, intentionally bypassing
  // ForwardAuth) as the highest-risk gap that the headers + strip-auth
  // changes closed.
  {
    name: "Plane /god-mode (admin bypass)",
    url: `${APP_URLS.PM}/god-mode`,
  },
];

test.describe("Bypass routers — reachability smoke", () => {
  for (const target of BYPASS_TARGETS) {
    test(`${target.name}: bypass path is reachable without 5xx`, async () => {
      const ctx = await request.newContext();
      try {
        const res = await ctx.get(target.url, {
          // Spoofed headers attached so this test grows teeth if the
          // bypass surface ever starts reading identity. See spec
          // header comment for the strip-validation rationale.
          headers: SPOOFED_HEADERS,
          timeout: 15_000,
          maxRedirects: 5,
        });
        const finalUrl = res.url();
        const status = res.status();

        // Bypass paths must NOT bounce to auth — that's the whole
        // point of being on a bypass router. If they do, the router
        // config regressed.
        expect(
          isAuthWall(finalUrl),
          `${target.name}: expected bypass path but request bounced to auth. final=${finalUrl}`
        ).toBe(false);

        // Upstream healthy — no 5xx. This catches a router that points
        // at a misconfigured / dead backend more than anything about
        // middleware ordering.
        expect(
          status,
          `${target.name}: bypass path returned ${status} on ${finalUrl} — upstream errored. Investigate the bypass router config.`
        ).toBeLessThan(500);

        if (target.url.endsWith("/god-mode")) {
          expect(
            status,
            `${target.name}: expected reachable admin bypass surface, got ${status} on ${finalUrl}`
          ).toBeLessThan(400);
        }
      } finally {
        await ctx.dispose();
      }
    });
  }
});
