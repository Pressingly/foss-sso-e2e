// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#http-method-tampering-shall-not-bypass-auth

import { test, expect, request } from "@playwright/test";
import { APPS, isAuthWall } from "../../constants";

// HTTP method tampering: send PUT / DELETE / PATCH / TRACE to routes
// that expect GET. A correctly-configured stack must NOT serve a 2xx
// for these — either:
//   - ForwardAuth gates the request and returns 401/redirect (the
//     auth check runs irrespective of method)
//   - the app's router returns 405 Method Not Allowed
//   - the app returns 404 because the verb-path pair isn't routed
//
// What we're hunting:
//   1. A misconfigured backend that silently accepts PUT/PATCH where
//      GET was intended and triggers unguarded state changes.
//   2. A bypass router (Plane /god-mode/*, /api/instances/*) that
//      reaches the upstream without method-method validation.
//   3. TRACE that echoes back request headers (cross-site tracing —
//      OWASP A05 surface).

const FORBIDDEN_METHODS = ["PUT", "DELETE", "PATCH", "TRACE"] as const;

test.describe("HTTP method tampering — non-GET on root must not 2xx", () => {
  for (const app of APPS) {
    for (const method of FORBIDDEN_METHODS) {
      test(`${app.name}: ${method} / does not return 2xx`, async () => {
        const ctx = await request.newContext();
        try {
          const res = await ctx.fetch(`${app.url}/`, {
            method,
            maxRedirects: 0,
            timeout: 15_000,
            // Don't follow redirects — if the auth gate redirects,
            // that's a valid response shape (not a bypass).
          });
          const status = res.status();

          // 2xx on a tampered method against the root means either
          // the backend served content (bug), or an upstream gate
          // misbehaved (also bug). Anything else — 3xx redirect to
          // auth, 4xx method-not-allowed / not-authenticated, 5xx
          // upstream-died — is at worst inert, never a security
          // regression we'd silently miss.
          expect(
            status < 200 || status >= 300,
            `${app.name} ${method} /: returned 2xx (${status}) — verb tampering reached an unguarded handler`
          ).toBe(true);

          // Treat backend 5xx as test failures: a broken upstream masks
          // the security signal and should not silently green this suite.
          expect(
            status,
            `${app.name} ${method} /: returned ${status} (server error) — cannot validate method-tampering behaviour on a failing backend`
          ).toBeLessThan(500);

          // Belt-and-braces: even if the response is 3xx, make sure
          // the redirect target isn't into the app (i.e. it's the
          // auth chain, not a deep app URL that the verb shouldn't
          // have reached).
          if (status >= 300 && status < 400) {
            const location = res.headers()["location"] ?? "";
            if (location && !location.startsWith("/")) {
              const target = new URL(location, app.url).toString();
              const intoAuth = isAuthWall(target);
              const stayedOnApp =
                new URL(target).hostname === new URL(app.url).hostname;
              expect(
                intoAuth || !stayedOnApp,
                `${app.name} ${method} / redirected to ${target} — should be auth-bound, not into the app`
              ).toBe(true);
            }
          }
        } finally {
          await ctx.dispose();
        }
      });
    }
  }
});
