// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#unauthenticated-requests-with-a-valid-proxy-identity-shall-auto-provision-and-log-in
//   (per-app angle — sso-login.spec.ts pins this at the portal landing;
//    this file pins it via direct per-app API probes, isolating which
//    app's middleware fails to provision when the SSO chain delivers
//    valid auth headers)

import { test, expect } from "../../fixtures";
import { APP_URLS, AppName } from "../../constants";
import { APP_HEALTH_PROBES, probeApp } from "../lib/app-health-probes";

// Per-app login smoke — the canonical "this app's SSO chain is wired up"
// signal. One test per app, all using the same worker-level SSO session
// (FOSS_USER, already authenticated by `cognitoLogin` at worker scope).
//
// Behaviour pinned per app: after SSO login, the app actually recognises
// the user as authenticated — not just that the SPA shell loads. SPAs
// often serve a static landing on `/` even when the SSO chain is broken;
// the chain failure only shows up when a protected surface is hit, so
// every probe targets a per-app /me-shape endpoint (or, for Twenty
// which has no cookie-authed /me, the proxy-login terminal step).
//
// Why a dedicated smoke instead of inferring from cross-app tests: when
// one app's deployment-layer bootstrap is broken (alembic missing, SSO
// IdP row not seeded, etc.) the cascade tests (identity-consistency,
// link-coverage, …) all turn red. Triage signal gets buried. This file
// isolates the "did SSO log us in" check to one named test per app, so
// a CI failure here points directly at WHICH app is broken. The
// `appHealth` worker fixture (in fixtures.ts) consults the same probe
// map so the cascade tests can skip-with-reason when a required app is
// broken — single source of truth for "is this app healthy".

test.describe("Per-app login smoke — SSO chain reaches every app", () => {
  for (const appName of Object.keys(APP_HEALTH_PROBES) as AppName[]) {
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

      const result = await probeApp(context, appName);
      expect(
        result.healthy,
        result.healthy
          ? ""
          : `${appName}: ${result.reason}. The SSO chain did not authenticate the user against ${appName}'s backend — most likely a deployment-layer issue (missing migration, missing SSO IdP row, stale workspace seed).`,
      ).toBe(true);
    });
  }
});
