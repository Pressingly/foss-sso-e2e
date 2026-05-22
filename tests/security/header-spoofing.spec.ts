// Spec coverage for this file (see docs/spec-coverage.md):
// @spec forwardauth-traefik#a-single-mpass-auth-middleware-shall-be-defined-on-the-oauth2-proxy-service
// @spec forwardauth-traefik#every-protected-app-router-shall-apply-mpass-auth
// @spec forwardauth-traefik#header-overwrite-shall-be-enforced

import { test, expect } from "../../fixtures";
import { request } from "@playwright/test";
import { APPS, APP_URLS, isAuthWall } from "../../constants";
import { IDENTITY_PROBES } from "../lib/identity-probes";
import { SPOOFED_HEADERS } from "../lib/spoofed-headers";

// Two tests, addressing two distinct failure modes:
//
//   (A) "auth-gate present"  — unauthenticated request with spoofed
//       `X-Auth-Request-*` headers must NOT be granted access. This
//       proves `mpass-auth` is in front of `/`, but does NOT exercise
//       the strip middleware (the request is rejected before any
//       backend sees it). Kept as a sanity guard against a regression
//       where mpass-auth is accidentally removed from a router.
//
//   (B) "strip-auth-headers is wired" — authenticated request with a
//       spoofed `X-Auth-Request-Email` for a DIFFERENT user. The
//       request reaches the backend (so the full chain runs); we
//       assert the returned identity is the cookie-derived one.
//
//       LIMITATIONS — this is a partial check, not iron-clad proof:
//
//       1. Traefik's ForwardAuth often REPLACES inbound headers
//          listed in `authResponseHeaders` with oauth2-proxy's value
//          rather than appending. If your stack replaces, the
//          attacker's value gets overwritten by mpass-auth even if
//          strip is removed — the test passes on a misconfiguration
//          it claims to catch.
//       2. If Traefik appends (creating duplicate headers), backend
//          behavior diverges: Django/Express/FastAPI/Node all handle
//          duplicate `X-Auth-Request-Email` differently (first wins,
//          last wins, comma-joined, error). The test only catches
//          the "first wins" backends.
//
//       What this test DOES reliably catch:
//          - mpass-auth accidentally removed from the router (the
//            inbound header would be the ONLY one present →
//            attacker identity returned)
//          - Backend that explicitly prefers inbound headers over
//            ForwardAuth-injected ones (rare but exists in misconfig)
//
//       What it does NOT catch: a missing `strip-auth-headers` on
//       stacks where Traefik replaces. forwardauth-traefik#header-
//       overwrite-shall-be-enforced keeps that as an audit invariant;
//       the live test here is a partial backstop.

test.describe("Header spoofing", () => {
  // (A) — auth gate sanity. Cheap and runs without login. Catches a
  // missing mpass-auth on the secure router.
  test.describe("auth gate (unauth'd)", () => {
    for (const app of APPS) {
      test(`${app.name}: spoofed X-Auth-Request-* without cookie does not grant access`, async () => {
        const ctx = await request.newContext();
        try {
          const r = await ctx.get(`${app.url}/`, {
            headers: SPOOFED_HEADERS,
            timeout: 20_000,
            maxRedirects: 5,
          });
          const finalUrl = r.url();
          const status = r.status();
          expect(
            status,
            `${app.name}: unauth spoof probe returned ${status} on ${finalUrl} (server error, cannot validate auth gate)`
          ).toBeLessThan(500);
          const ok = isAuthWall(finalUrl) || status === 401 || status === 403;
          expect(
            ok,
            `${app.name}: unauth'd request reached ${finalUrl} with status ${status} — mpass-auth is not in front of / on this router.`
          ).toBe(true);
        } finally {
          await ctx.dispose();
        }
      });
    }
  });

  // (B) — strip middleware validation. Sends a spoofed
  // X-Auth-Request-Email for a DIFFERENT user, with the legitimate
  // session cookie attached. If strip is in place, the backend sees
  // only mpass-auth's added header (the real user); if strip is
  // missing or misordered, the backend sees the attacker's value too
  // and at least one identity probe returns it.
  test.describe("strip middleware (authed)", () => {
    for (const appName of Object.keys(IDENTITY_PROBES) as Array<keyof typeof IDENTITY_PROBES>) {
      test(`${appName}: spoofed X-Auth-Request-Email does not flip backend identity (partial)`, async ({
        context,
        page,
      }) => {
        // Warm the host so per-app cookies (Outline/SurfSense session
        // cookies, Plane Django session, Penpot opaque session) land
        // in the jar before the probe.
        const baseUrl = APP_URLS[appName as keyof typeof APP_URLS];
        await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

        const legitimate = await IDENTITY_PROBES[appName]!(context, {});
        expect(
          legitimate,
          `${appName}: baseline /me probe must return an email`
        ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
        expect(
          legitimate.toLowerCase(),
          `${appName}: baseline identity unexpectedly matches spoofed attacker header (${SPOOFED_HEADERS["X-Auth-Request-Email"]}); pick a different spoof identity to keep this check meaningful`
        ).not.toBe(String(SPOOFED_HEADERS["X-Auth-Request-Email"]).toLowerCase());

        const observed = await IDENTITY_PROBES[appName]!(context, SPOOFED_HEADERS);

        // PARTIAL check — see file-header LIMITATIONS comment. A pass
        // here means the spoof didn't reach the backend (or did and
        // the backend ignored it). A divergence means the backend's
        // view of identity changed under spoof: one of {strip
        // ordering, backend header preference, Traefik append-mode
        // duplicate handling} is broken — diagnosis requires looking
        // at the chain directly, NOT inferring from the symptom.
        expect(
          observed,
          `${appName}: backend identity diverged under spoof. legitimate=${legitimate} observed=${observed} attacker_value=${SPOOFED_HEADERS["X-Auth-Request-Email"]}. Possible causes: missing strip-auth-headers, strip ordered after mpass-auth, backend that prefers inbound over ForwardAuth-injected headers, or Traefik append-mode duplicate-header tiebreak picking the inbound. See file-head LIMITATIONS.`
        ).toBe(legitimate);
      });
    }
  });
});
