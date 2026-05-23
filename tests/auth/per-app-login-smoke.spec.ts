// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#unauthenticated-requests-with-a-valid-proxy-identity-shall-auto-provision-and-log-in
//   (per-app angle — sso-login.spec.ts pins this at the portal landing;
//    this file pins it via direct per-app API probes, isolating which
//    app's middleware fails to provision when the SSO chain delivers
//    valid auth headers)

import { test, expect } from "../../fixtures";
import { BrowserContext } from "@playwright/test";
import { APP_URLS, AppName } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

// Per-app login smoke — the canonical "this app's SSO chain is wired up"
// signal. One test per app, all using the same worker-level SSO session
// (FOSS_USER, already authenticated by `cognitoLogin` at worker scope).
//
// What this pins per app: after SSO login, the app actually recognises
// the user as authenticated — not just that the SPA shell loads. Apps
// often serve a static landing on `/` even when the SSO chain is broken;
// the chain failure only shows up when a *protected* route is hit. So
// every probe targets a protected surface (per-app `/me`-style endpoint
// for the 4 cookie-authed apps; a protected SPA route for Twenty).
//
// Why a dedicated smoke instead of inferring from cross-app tests: when
// one app's deployment-level bootstrap is broken (alembic missing, SSO
// IdP row not seeded, etc.) the cascade tests (identity-consistency,
// link-coverage, …) all turn red. The triage signal gets buried. This
// file isolates the "did SSO actually log us in" check to one named
// test per app — so a CI failure here points directly at WHICH app's
// bundle bootstrap is broken without sifting through cascade failures.

type IdentityProbe = {
  // App's authed endpoint — `/me`-shaped for the 4 cookie-authed apps,
  // or the proxy-login endpoint itself for Twenty (which doesn't have
  // a cookie-authed REST `/me`).
  request: (ctx: BrowserContext, baseUrl: string) => Promise<ProbeResult>;
  // If set, parse the response body for the user's email and assert it
  // matches `<local>@<domain>` shape. Omitted for Twenty's proxy-login
  // probe, where the success signal is "no 500" — the response is
  // empty / a redirect, not an email.
  parseEmail?: (raw: string) => string;
};

type ProbeResult = { status: number; text: string };

async function apiCall(
  ctx: BrowserContext,
  url: string,
  method: "GET" | "POST" = "GET",
): Promise<ProbeResult> {
  const baseUrl = new URL(url).origin;
  const cookies = await ctx.cookies(baseUrl);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const r =
    method === "POST"
      ? await ctx.request.post(url, { headers: { cookie, "content-type": "application/json" }, data: {} })
      : await ctx.request.get(url, { headers: { cookie }, maxRedirects: 0 });
  return { status: r.status(), text: await r.text() };
}

const PROBES: Record<AppName, IdentityProbe> = {
  PM: {
    request: (ctx, baseUrl) => apiCall(ctx, `${baseUrl}/api/users/me/`),
    parseEmail: (raw) => (JSON.parse(raw) as { email: string }).email,
  },
  Outline: {
    request: (ctx, baseUrl) => apiCall(ctx, `${baseUrl}/api/auth.info`, "POST"),
    parseEmail: (raw) => (JSON.parse(raw) as { data: { user: { email: string } } }).data.user.email,
  },
  Penpot: {
    request: (ctx, baseUrl) => apiCall(ctx, `${baseUrl}/api/rpc/command/get-profile`),
    parseEmail: (raw) => extractPenpotTransitField(JSON.parse(raw), "~:email"),
  },
  SurfSense: {
    request: (ctx, baseUrl) => apiCall(ctx, `${baseUrl}/users/me`),
    parseEmail: (raw) => (JSON.parse(raw) as { email: string }).email,
  },
  // Twenty has no stable cookie-authed /me endpoint; its SPA uses
  // JWT-bearer GraphQL for currentUser. The SSO chain's terminal step
  // for Twenty is /auth/sso/proxy-login itself — when the workspace's
  // SSO IdP row is missing it returns 500; when wired up it succeeds
  // (200 or 3xx). Probing that endpoint directly skips the SPA timing
  // dance and gives a deterministic per-app SSO-chain signal.
  Twenty: {
    request: (ctx, baseUrl) => apiCall(ctx, `${baseUrl}/auth/sso/proxy-login`),
  },
};

test.describe("Per-app login smoke — SSO chain reaches every app", () => {
  for (const [appName, probe] of Object.entries(PROBES) as Array<[AppName, IdentityProbe]>) {
    test(`${appName}: SSO login authenticates the user against ${appName}'s backend`, async ({
      context,
      page,
    }) => {
      test.setTimeout(60_000);
      const baseUrl = APP_URLS[appName];

      // Warm host so per-app session cookies land in the jar before the
      // probe (some apps lazily issue their per-host session cookie on
      // the SPA's first fetch).
      await page.goto(baseUrl, { waitUntil: "commit", timeout: 30_000 });
      await expect
        .poll(() => new URL(page.url()).hostname, { timeout: 15_000 })
        .toBe(new URL(baseUrl).hostname);

      const res = await probe.request(context, baseUrl);
      expect(
        res.status,
        `${appName}: SSO-chain probe returned ${res.status}. The SSO chain did not authenticate the user against ${appName}'s backend — most likely a deployment-layer issue (missing migration, missing SSO IdP row, stale workspace seed). Body (first 300): ${res.text.slice(0, 300)}`,
      ).toBeLessThan(400);

      if (probe.parseEmail) {
        let email: string;
        try {
          email = probe.parseEmail(res.text);
        } catch (e) {
          throw new Error(
            `${appName}: identity probe returned 2xx but body shape mismatched. Error: ${(e as Error).message}. Body (first 300): ${res.text.slice(0, 300)}`,
          );
        }
        expect(
          email,
          `${appName}: identity probe returned 2xx but no usable email — bootstrap may be partially broken. Body (first 300): ${res.text.slice(0, 300)}`,
        ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      }
    });
  }
});
