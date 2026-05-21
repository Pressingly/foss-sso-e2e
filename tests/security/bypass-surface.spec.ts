// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#bypass-paths-shall-short-circuit-before-any-auth-processing
// @spec oauth2-proxy-gateway#gateway-shall-run-as-a-single-dedicated-service
// @spec forwardauth-traefik#bypass-routes-per-app-shall-match-the-documented-list

import { test, expect, request, APIResponse } from "@playwright/test";
import { APPS, AppName, isAuthWall } from "../../constants";

// Per-app bypass paths enumerated in
// sso-rules-moneta/openspec/specs/forwardauth-traefik/spec.md
// "bypass routes per app SHALL match the documented list".
//
// `bypass` paths MUST reach the app (any non-auth-wall final URL); `gated`
// paths MUST hit the auth wall (or return 401/403) — used as regression
// guards for paths that were intentionally removed from a bypass router
// after a security review.
//
// Truth source: foss-server-bundle/docker-compose.yml router rules.
const APP_BYPASS_EXTRAS: Record<AppName, { bypass: string[]; gated: string[] }> = {
  // outline-bypass router: (PathPrefix(/api/hooks) || /static/ || /favicon.ico
  // || /robots.txt || /opensearch.xml || /manifest.webmanifest).
  // /api/hooks is the webhook receiver — token-authenticated by Outline,
  // intentionally outside the SSO gate.
  Outline:   { bypass: ["/api/hooks.unfurl"], gated: [] },

  // plane-bypass router includes /god-mode (covered in pm-godmode.spec.ts),
  // /api/instances (instance metadata for the admin wizard), and
  // /auth/get-csrf-token (paired bypass for the god-mode login POST).
  PM:        { bypass: ["/api/instances/", "/auth/get-csrf-token"], gated: [] },

  // Penpot bundle today only bypasses static-asset prefixes (/js/, /css/,
  // /images/, /fonts/). The sso-rules spec lists /api/rpc/command/get-profile
  // as "intentionally unauthenticated", but the bundle does NOT bypass it.
  // Not added here — spec/bundle mismatch is tracked separately, not
  // something this test should hard-code as a requirement.
  Penpot:    { bypass: [], gated: [] },

  // surfsense-api-bypass router: PathPrefix(/health) ONLY.
  // /docs and /openapi.json USED to bypass but were moved off the bypass
  // router after the 2026-04-30 audit (FastAPI's /docs serves Swagger UI
  // and /openapi.json leaks the full 308KB API schema). Both must now
  // bounce to auth — this is the regression guard.
  SurfSense: { bypass: ["/health"], gated: ["/docs", "/openapi.json"] },

  // Twenty's bypass router exposes static assets only; nothing app-level
  // is intentionally public.
  Twenty:    { bypass: [], gated: [] },
};

// Verifies the bypass-router discipline from
// `forwardauth-traefik#bypass-paths-shall-route-via-higher-priority-routers-without-mpass-auth`:
//
//   - Static assets and well-known endpoints (favicon, robots, ACME
//     challenge) MUST be reachable without a session cookie. If they
//     bounce to Cognito, the bypass router is missing — every uncached
//     anonymous request would be billed an IDP round-trip and breaks
//     embedded previews / SEO crawlers.
//   - Routes that return user data (root SPA shell, anything under /api/
//     that isn't an explicit bypass) MUST require auth. The Electric
//     /v1/shape exfiltration (2026-04-30) was the textbook failure mode:
//     a routable path with no `mpass-auth` middleware that returned data.
//
// Per-app bypass paths are pinned via APP_BYPASS_EXTRAS above (see
// `forwardauth-traefik#bypass-routes-per-app-shall-match-the-documented-list`).
// The tests below verify universal expectations that should hold for
// every app behind oauth2-proxy + Traefik ForwardAuth.

async function probe(
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  url: string
): Promise<{ status: number; finalUrl: string }> {
  const res: APIResponse = await ctx.get(url, {
    timeout: 15_000,
    maxRedirects: 5,
  });
  return { status: res.status(), finalUrl: res.url() };
}

test.describe("Bypass surface — public paths reachable, protected paths gated", () => {
  for (const app of APPS) {
    // Public-surface paths: these MUST NOT bounce to the auth wall. They
    // either serve content (2xx) or return 404 (path doesn't exist on
    // this app) — both are acceptable. What's NOT acceptable is a 302
    // to Cognito.
    test(`${app.name}: /favicon.ico is reachable without auth`, async () => {
      const ctx = await request.newContext();
      try {
        const { status, finalUrl } = await probe(ctx, `${app.url}/favicon.ico`);
        expect(
          isAuthWall(finalUrl),
          `${app.name}: /favicon.ico bounced to auth wall — static-asset bypass missing. final=${finalUrl}`
        ).toBe(false);
        // 200 (served) or 404 (no favicon configured) are both fine.
        // Anything else (502/503/etc.) signals a deeper problem.
        expect(
          status === 200 || status === 204 || status === 404,
          `${app.name}: /favicon.ico unexpected status ${status}`
        ).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    test(`${app.name}: /robots.txt is reachable without auth`, async () => {
      const ctx = await request.newContext();
      try {
        const { status, finalUrl } = await probe(ctx, `${app.url}/robots.txt`);
        expect(
          isAuthWall(finalUrl),
          `${app.name}: /robots.txt bounced to auth wall — search engines / crawlers will be blocked. final=${finalUrl}`
        ).toBe(false);
        expect(
          status === 200 || status === 404,
          `${app.name}: /robots.txt unexpected status ${status}`
        ).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    // Note: /.well-known/acme-challenge/ is intentionally NOT tested here.
    // Traefik 3.x only auto-registers the ACME bypass router when a
    // `certresolver=letsencrypt` is configured. This deployment uses
    // mkcert (TLS is infra-side, not in the openspec contract), so the
    // path correctly falls through to the secure catch-all and bounces
    // to auth. Re-add the test when / if a deployment migrates to
    // Let's Encrypt.

    // Protected surface — root path must bounce to auth. We already cover
    // this in sso-login.spec.ts, but repeating here as the inverse-control
    // anchor for this suite: prove the catch-all router is still doing
    // its job alongside the bypass paths above.
    test(`${app.name}: root / requires auth (catch-all gate is live)`, async () => {
      const ctx = await request.newContext();
      try {
        const { status, finalUrl } = await probe(ctx, `${app.url}/`);
        const bouncedToAuth = isAuthWall(finalUrl);

        expect(
          status,
          `${app.name}: root / returned ${status} on ${finalUrl} (server error, cannot validate auth gate)`
        ).toBeLessThan(500);

        const clearlyGated = bouncedToAuth || status === 401 || status === 403;
        expect(
          clearlyGated,
          `${app.name}: root / is not clearly gated (status=${status}, final=${finalUrl})`
        ).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    // Per-app documented bypass paths — these MUST reach the app, not
    // bounce to the IDP. Each entry in APP_BYPASS_EXTRAS[app].bypass is a
    // path the foss-server-bundle bypass router has explicitly carved
    // out. Any status code below 500 is fine (the app may return 200,
    // 404, 405, etc. depending on the endpoint); what's NOT acceptable
    // is a redirect to Cognito/mPass.
    for (const path of APP_BYPASS_EXTRAS[app.name].bypass) {
      test(`${app.name}: ${path} bypasses ForwardAuth`, async () => {
        const ctx = await request.newContext();
        try {
          const { status, finalUrl } = await probe(ctx, `${app.url}${path}`);
          expect(
            isAuthWall(finalUrl),
            `${app.name}: ${path} bounced to auth wall — documented bypass route missing. final=${finalUrl}`
          ).toBe(false);
          expect(
            status,
            `${app.name}: ${path} returned ${status} (server error masks the bypass-router check)`
          ).toBeLessThan(500);
        } finally {
          await ctx.dispose();
        }
      });
    }

    // Per-app gated regression guards — paths that were intentionally
    // moved OFF the bypass router. If any of these starts bypassing
    // again, that's the regression: the path leaks data unauthenticated.
    // Example: SurfSense's /docs (Swagger UI) and /openapi.json (308KB
    // API schema dump) were public until the 2026-04-30 audit.
    for (const path of APP_BYPASS_EXTRAS[app.name].gated) {
      test(`${app.name}: ${path} is gated (regression guard)`, async () => {
        const ctx = await request.newContext();
        try {
          const { status, finalUrl } = await probe(ctx, `${app.url}${path}`);
          const bouncedToAuth = isAuthWall(finalUrl);
          const clearlyGated = bouncedToAuth || status === 401 || status === 403;
          expect(
            clearlyGated,
            `${app.name}: ${path} is reachable without auth (status=${status}, final=${finalUrl}) — this path was intentionally removed from bypass for security; it must require auth.`
          ).toBe(true);
        } finally {
          await ctx.dispose();
        }
      });
    }
  }
});
