// Spec coverage for this file (see docs/spec-coverage.md):
// @spec forwardauth-traefik#header-overwrite-shall-be-enforced
//
// Tightens the existing `header-spoofing.spec.ts` (B) block by spoofing
// a REAL second user's email (the FOSS_USER admin identity) from a
// NORMAL_USER session — a privilege-escalation attempt. The existing
// test uses a fake email (`attacker@evil.example`); a backend that
// rejects unknown emails passes that test trivially even if it has
// some "if inbound header matches a known active user, use that"
// logic. Using the real admin email closes that gap: the backend
// can't dismiss the spoof as "unknown identity".
//
// Self-skips if NORMAL_USER or FOSS_USER credentials are unset — both
// are needed (NORMAL_USER for the session, FOSS_USER's email as the
// spoof target).

import { test as raw, expect } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import { APP_URLS, COGNITO_EMAIL_DOMAIN } from "../../constants";
import { IDENTITY_PROBES } from "../lib/identity-probes";

const FOSS_USER = process.env.FOSS_USER;
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

// The backend `/me` endpoints return the SYNTHESIZED email (the mPass
// bareword + `@COGNITO_EMAIL_DOMAIN`), not the bare username/ID we
// pass via FOSS_USER / NORMAL_USER env vars. Synthesize both forms
// here so the comparison works regardless of which form the user
// happened to put in `.env`.
function synthesizeEmail(userOrEmail: string): string {
  return userOrEmail.includes("@")
    ? userOrEmail.toLowerCase()
    : `${userOrEmail}@${COGNITO_EMAIL_DOMAIN}`.toLowerCase();
}

raw.describe("Cross-user impersonation — spoofing the real admin identity", () => {
  raw.skip(
    !FOSS_USER || !NORMAL_USER || !NORMAL_PASS,
    "Need FOSS_USER (the spoof target) + NORMAL_USER/NORMAL_PASS (the attacker session) to run cross-user impersonation tests",
  );

  for (const appName of Object.keys(IDENTITY_PROBES) as Array<keyof typeof IDENTITY_PROBES>) {
    raw(
      `${appName}: NORMAL_USER cannot impersonate FOSS_USER via X-Auth-Request-Email spoof`,
      async ({ browser }) => {
        raw.setTimeout(120_000);

        const normalEmail = synthesizeEmail(NORMAL_USER!);
        const fossEmail = synthesizeEmail(FOSS_USER!);
        expect(
          normalEmail,
          "Pre-condition failed: NORMAL_USER and FOSS_USER resolve to the same email; this test requires two distinct identities",
        ).not.toBe(fossEmail);

        const ctx = await browser.newContext();
        try {
          // Phase 1: legit login as the lower-privileged user. From this
          // point on the browser carries a valid NORMAL_USER SSO cookie
          // + per-app session cookies.
          const page = await ctx.newPage();
          await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

          // Warm the per-app host so per-app session cookies (Outline
          // accessToken, Plane sessionid, Penpot opaque session,
          // SurfSense JWT cookie) land in the jar before we probe.
          const baseUrl = APP_URLS[appName as keyof typeof APP_URLS];
          const appPage = await ctx.newPage();
          await appPage.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

          // Phase 2: baseline identity. The /me-shape endpoint with no
          // extra headers should return the cookie-derived identity =
          // NORMAL_USER. This pins the test's pre-condition: we're
          // genuinely logged in as the lower-privileged user.
          const baseline = await IDENTITY_PROBES[appName]!(ctx, {});
          expect(
            baseline,
            `${appName}: baseline /me must return a well-formed email — pre-condition failed`,
          ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
          expect(
            baseline.toLowerCase(),
            `${appName}: baseline must report NORMAL_USER (got ${baseline}, expected ${normalEmail}). Pre-condition failed — the worker context is not authenticated as NORMAL_USER.`,
          ).toBe(normalEmail);

          // Phase 3: spoof the REAL admin's email. If the backend ever
          // resolves identity from the inbound header (instead of the
          // cookie-derived one mpass-auth-proxy injects), the response
          // would now report FOSS_USER — that's lateral privilege
          // escalation from NORMAL_USER to admin.
          const spoofed = await IDENTITY_PROBES[appName]!(ctx, {
            "X-Auth-Request-Email": fossEmail,
            "X-Auth-Request-User": FOSS_USER!,
            "X-Auth-Request-Preferred-Username": FOSS_USER!,
            "X-Forwarded-Email": fossEmail,
            "X-Forwarded-User": FOSS_USER!,
          });

          expect(
            spoofed.toLowerCase(),
            `${appName}: backend identity flipped to FOSS_USER under spoof — NORMAL_USER (${normalEmail}) could act as admin (${fossEmail}). Either strip-auth-headers is missing/misordered or the backend resolves identity from inbound headers. observed=${spoofed}`,
          ).toBe(normalEmail);

          // Defence-in-depth: explicitly assert the spoof email is
          // NOT present. Catches a backend that returns BOTH identities
          // joined (rare, but seen in append-mode header handling).
          expect(
            spoofed.toLowerCase(),
            `${appName}: backend response contained FOSS_USER's email under spoof — even if NORMAL_USER's email is also present, the contract requires the inbound header to be stripped entirely`,
          ).not.toContain(fossEmail);
        } finally {
          await ctx.close();
        }
      },
    );
  }
});
