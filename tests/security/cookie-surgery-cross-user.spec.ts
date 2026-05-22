// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#identity-mismatch-shall-flush-the-existing-session-immediately
//
// Cookie-surgery variant of cross-user impersonation: the existing
// `tests/flows/identity-switch-after-relogin.spec.ts` proves the
// identity-mismatch-flush invariant via the natural flow
// (logout → relogin as a different user). This file proves the SAME
// invariant via the harder threat vector — an attacker who somehow
// obtained User A's `_oauth2_proxy` cookie value (XSS on a foss
// subdomain, network capture, browser-debugger lift) injecting it
// into User B's already-authenticated browser session.
//
// What the test pins:
//   • The SSO cookie is the bearer credential — when it's swapped,
//     subsequent app requests are authenticated as the new identity.
//   • The per-app middleware detects the (new SSO identity) vs.
//     (old per-app session identity) mismatch and flushes the
//     local session before serving the request. Per
//     `proxy-auth-middleware#identity-mismatch-shall-flush-…`,
//     the response identity must reflect the SWAPPED-IN cookie,
//     not the stale per-app session.
//
// Self-skips if FOSS_USER or NORMAL_USER is unset — both identities
// are required (one for the cookie source, one for the victim
// session being attacked).

import { test as raw, expect, request, BrowserContext } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import { APP_URLS, AUTH_COOKIE, COGNITO_EMAIL_DOMAIN } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

const FOSS_USER = process.env.FOSS_USER;
const FOSS_PASS = process.env.FOSS_PASS;
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

function synthesizeEmail(userOrEmail: string): string {
  return userOrEmail.includes("@")
    ? userOrEmail.toLowerCase()
    : `${userOrEmail}@${COGNITO_EMAIL_DOMAIN}`.toLowerCase();
}

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Per-app /me-shape identity probes — same set as
// header-spoofing.spec.ts / cross-user-impersonation.spec.ts. Twenty
// has no stable cookie-authed /me endpoint that returns the proxy-
// derived email in a single request, so it's excluded (same exclusion
// pattern as the other two files).
type IdentityProbe = (ctx: BrowserContext) => Promise<string>;
const IDENTITY_PROBES: Record<string, IdentityProbe> = {
  PM: async (ctx) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.PM);
    const c = await request.newContext({ extraHTTPHeaders: { cookie } });
    try {
      const r = await c.get(`${APP_URLS.PM}/api/users/me/`);
      const j = (await r.json()) as { email?: string };
      return j.email ?? "";
    } finally {
      await c.dispose();
    }
  },
  Outline: async (ctx) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.Outline);
    const c = await request.newContext({
      extraHTTPHeaders: { cookie, "content-type": "application/json" },
    });
    try {
      const r = await c.post(`${APP_URLS.Outline}/api/auth.info`, { data: {} });
      const j = (await r.json()) as { data?: { user?: { email?: string } } };
      return j?.data?.user?.email ?? "";
    } finally {
      await c.dispose();
    }
  },
  SurfSense: async (ctx) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.SurfSense);
    const c = await request.newContext({ extraHTTPHeaders: { cookie } });
    try {
      const r = await c.get(`${APP_URLS.SurfSense}/users/me`);
      const j = (await r.json()) as { email?: string };
      return j.email ?? "";
    } finally {
      await c.dispose();
    }
  },
  Penpot: async (ctx) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.Penpot);
    const c = await request.newContext({ extraHTTPHeaders: { cookie } });
    try {
      const r = await c.get(`${APP_URLS.Penpot}/api/rpc/command/get-profile`);
      return extractPenpotTransitField(await r.json(), "~:email");
    } finally {
      await c.dispose();
    }
  },
};

raw.describe("Cookie surgery — stolen SSO cookie used against another user's session", () => {
  raw.skip(
    !FOSS_USER || !FOSS_PASS || !NORMAL_USER || !NORMAL_PASS,
    "Need FOSS_USER + NORMAL_USER (and their passwords) — one for the cookie source, one for the victim session",
  );

  raw("FOSS_USER cookie planted in NORMAL_USER's context → all apps see FOSS_USER (identity-mismatch flush)", async ({
    browser,
  }) => {
    raw.setTimeout(240_000);

    const fossEmail = synthesizeEmail(FOSS_USER!);
    const normalEmail = synthesizeEmail(NORMAL_USER!);

    // ── Phase 1: log in as FOSS_USER in a SEPARATE context, capture
    //    just the _oauth2_proxy cookie value, then close. The
    //    attacker walks away with that one string.
    const sourceCtx = await browser.newContext();
    let stolenCookie: { name: string; value: string; domain: string; path: string };
    try {
      const sourcePage = await sourceCtx.newPage();
      await cognitoLogin(sourcePage, { user: FOSS_USER!, pass: FOSS_PASS! });
      const all = await sourceCtx.cookies();
      const sso = all.find((c) => c.name === AUTH_COOKIE);
      expect(
        sso,
        `Pre-condition: FOSS_USER's ${AUTH_COOKIE} cookie must exist after login`,
      ).toBeDefined();
      stolenCookie = {
        name: sso!.name,
        value: sso!.value,
        domain: sso!.domain,
        path: sso!.path,
      };
    } finally {
      await sourceCtx.close();
    }

    // ── Phase 2: NEW context, log in as NORMAL_USER. The browser now
    //    holds NORMAL_USER's _oauth2_proxy + the per-app session
    //    cookies for each app (Outline accessToken, Plane sessionid,
    //    Penpot opaque, SurfSense JWT).
    const victimCtx = await browser.newContext();
    try {
      const victimPage = await victimCtx.newPage();
      await cognitoLogin(victimPage, { user: NORMAL_USER!, pass: NORMAL_PASS! });

      // Warm each app so per-app session cookies land.
      for (const url of Object.values(APP_URLS)) {
        const p = await victimCtx.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await p.close();
      }

      // Baseline: every app probe should report NORMAL_USER right now.
      for (const appName of Object.keys(IDENTITY_PROBES) as Array<keyof typeof IDENTITY_PROBES>) {
        const observed = await IDENTITY_PROBES[appName]!(victimCtx);
        expect(
          observed.toLowerCase(),
          `${appName}: baseline must report NORMAL_USER (got ${observed}) — pre-condition failed; the victim context isn't authenticated as NORMAL_USER`,
        ).toBe(normalEmail);
      }

      // ── Phase 3: cookie surgery. Replace ONLY the SSO cookie with
      //    the stolen FOSS_USER value; keep every per-app session
      //    cookie (Outline accessToken, Plane sessionid, etc.)
      //    intact. This is the exact shape an attacker would mount
      //    after lifting the cookie via XSS / network capture.
      await victimCtx.clearCookies({ name: AUTH_COOKIE });
      await victimCtx.addCookies([
        {
          name: stolenCookie.name,
          value: stolenCookie.value,
          domain: stolenCookie.domain,
          path: stolenCookie.path,
        },
      ]);

      // ── Phase 4: probe each app. The proxy-auth-middleware MUST
      //    detect the mismatch (proxy header now says FOSS_USER, local
      //    session is NORMAL_USER's) and flush before serving — so
      //    the response identity must be FOSS_USER, NOT NORMAL_USER.
      for (const appName of Object.keys(IDENTITY_PROBES) as Array<keyof typeof IDENTITY_PROBES>) {
        const observed = await IDENTITY_PROBES[appName]!(victimCtx);
        expect(
          observed.toLowerCase(),
          `${appName}: stolen FOSS_USER cookie should make the response identity FOSS_USER (per identity-mismatch flush). Got ${observed}. If this still reports NORMAL_USER (${normalEmail}), the mismatch-flush invariant has regressed: the stale per-app session is leaking the previous user's identity.`,
        ).toBe(fossEmail);
        expect(
          observed.toLowerCase(),
          `${appName}: response identity must not remain NORMAL_USER after the SSO cookie was swapped`,
        ).not.toBe(normalEmail);
      }
    } finally {
      await victimCtx.close();
    }
  });
});
