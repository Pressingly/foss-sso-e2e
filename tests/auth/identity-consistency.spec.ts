// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#email-normalisation-shall-be-applied-uniformly
// @spec oauth2-proxy-gateway#gateway-shall-emit-x-auth-request-headers-on-authenticated-responses
// @spec cognito-claim-mapping#standard-claim-header-mapping

import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

// Verifies every backend's view of the logged-in user converges on the
// same email. `cognito-claim-mapping#identity-claim-shall-be-configurable-
// when-email-is-unreliable` requires `DEFAULT_EMAIL_DOMAIN` to be set
// identically on every app container — otherwise a bare-username
// Cognito subject gets synthesized differently per app and the same
// physical user shows up as two distinct identities to the stack.
//
// Live deployment ground truth (probed 2026-05-11): Cognito returns a
// bare username (`1020010000019120`), so the synthesis path IS
// exercised. Every app's `/me`-style endpoint returns
// `1020010000019120@askii.ai` — proving DEFAULT_EMAIL_DOMAIN is
// consistent across backends.
//
// Endpoint shapes differ per app (there's no uniform `/me`). The table
// below encodes each app's identity endpoint and the path to its email
// field. New apps land in the table with their own shape.
//
// Twenty is intentionally omitted: its `/rest/*` endpoints require a
// JWT Bearer (not the SSO cookie), and the SPA hides email/password
// fields by design (correct per the AUTH_TYPE=SSO product contract,
// verified by sso-mode-no-local-login.spec.ts). Twenty's identity is
// already gated by the same oauth2-proxy that feeds the other four,
// so divergence there would only be possible if Twenty's SSO controller
// transformed the email — and that's a single hot path, easily audited.

type Probe = {
  app: keyof typeof APP_URLS;
  description: string;
  fetch: (ctx: BrowserContext, baseUrl: string) => Promise<string>;
};

async function postJSON<T>(
  cookieHeader: string,
  url: string,
  body: object = {}
): Promise<T> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader, "content-type": "application/json" },
  });
  try {
    const res = await ctx.post(url, { data: body, maxRedirects: 0 });
    if (!res.ok()) {
      throw new Error(`POST ${url} → ${res.status()}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

async function getJSON<T>(cookieHeader: string, url: string): Promise<T> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader },
  });
  try {
    const res = await ctx.get(url, { maxRedirects: 0 });
    if (!res.ok()) {
      throw new Error(`GET ${url} → ${res.status()}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

const PROBES: Probe[] = [
  {
    app: "PM",
    description: "Plane GET /api/users/me/",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<{ email: string }>(ch, `${baseUrl}/api/users/me/`);
      return j.email;
    },
  },
  {
    app: "Outline",
    description: "Outline POST /api/auth.info",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await postJSON<{ data: { user: { email: string } } }>(
        ch,
        `${baseUrl}/api/auth.info`
      );
      return j.data.user.email;
    },
  },
  {
    app: "Penpot",
    description: "Penpot GET /api/rpc/command/get-profile",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<unknown>(ch, `${baseUrl}/api/rpc/command/get-profile`);
      return extractPenpotTransitField(j, "~:email");
    },
  },
  {
    app: "SurfSense",
    description: "SurfSense GET /users/me",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<{ email: string }>(ch, `${baseUrl}/users/me`);
      return j.email;
    },
  },
];

test.describe("Cross-app identity consistency", () => {
  test("every backend resolves the logged-in user to the same email", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    // Warm each app once so per-host cookies are in the jar. Penpot and
    // SurfSense in particular set their own session cookies on top of
    // the SSO cookie, and those cookies are what their /me endpoints
    // authenticate against.
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app];
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    // Ask oauth2-proxy what username it's forwarding to the backends.
    // The `user` field is the upstream Cognito identifier (typically
    // a bare username — `1020010000019120` — when the pool is
    // bare-username, or a full email if the pool pre-emails the
    // subject). Backends' synthesized emails must start with this
    // value.
    //
    // LIMITATION: oauth2-proxy is part of the same chain we're
    // verifying. If the misconfiguration is in oauth2-proxy itself
    // (or in an env var read by BOTH oauth2-proxy AND every backend),
    // the upstream value here is already wrong and the canonical
    // check below passes vacuously. The only way to close this fully
    // would be to hit Cognito's `/userInfo` directly with the access
    // token — not currently possible from a Playwright context
    // without exposing the access token at the proxy. The check
    // still catches the more likely failure mode (one backend's env
    // diverges from the others), which is what `cognito-claim-mapping`
    // calls out.
    const oauthUserCookie = await cookieHeaderFor(context, APP_URLS.PM);
    const oauthCtx = await request.newContext({
      extraHTTPHeaders: { cookie: oauthUserCookie },
    });
    let upstreamUser: string;
    try {
      const r = await oauthCtx.get(`${APP_URLS.PM}/oauth2/userinfo`);
      const j = (await r.json()) as { user: string; email?: string };
      // Penpot/SurfSense convention: when oauth2-proxy receives a bare
      // username it forwards it in `email` as-is; backends then
      // synthesize. Use `email` if present (it's the actual value
      // forwarded as X-Auth-Request-Email), else fall back to `user`.
      upstreamUser = j.email || j.user;
      expect(
        upstreamUser,
        `oauth2-proxy /oauth2/userinfo did not return a usable user field: ${JSON.stringify(j)}`
      ).toBeTruthy();
    } finally {
      await oauthCtx.dispose();
    }

    const results: { app: string; email: string }[] = [];
    const errors: { app: string; error: string }[] = [];

    for (const probe of PROBES) {
      try {
        const email = await probe.fetch(context, APP_URLS[probe.app]);
        results.push({ app: probe.app, email });
      } catch (e) {
        errors.push({ app: probe.app, error: (e as Error).message });
      }
    }

    expect(
      errors,
      `identity probe(s) failed:\n${JSON.stringify(errors, null, 2)}`
    ).toEqual([]);

    // Email-shape sanity.
    for (const r of results) {
      expect(
        r.email,
        `${r.app}: identity endpoint returned non-email value "${r.email}"`
      ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    }

    // Canonical check: every backend's email local-part must match what
    // oauth2-proxy is forwarding. Without this, the consistency check
    // below passes vacuously if all backends share a uniform fallback
    // (e.g. every container reading the same wrong env var). When
    // upstreamUser already contains an `@`, compare full strings; when
    // it's bare, compare against the local part.
    const expectedLocalPart = upstreamUser.includes("@")
      ? upstreamUser.toLowerCase()
      : `${upstreamUser.toLowerCase()}@`;
    for (const r of results) {
      const lc = r.email.toLowerCase();
      const matchesUpstream = upstreamUser.includes("@")
        ? lc === expectedLocalPart
        : lc.startsWith(expectedLocalPart);
      expect(
        matchesUpstream,
        `${r.app}: identity ${r.email} does not derive from the oauth2-proxy upstream user (${upstreamUser}). DEFAULT_EMAIL_DOMAIN synthesis may be transforming the username instead of appending to it.`
      ).toBe(true);
    }

    // Cross-backend consistency.
    const distinct = new Set(results.map((r) => r.email.toLowerCase()));
    expect(
      distinct.size,
      `backends disagree on the user's email — DEFAULT_EMAIL_DOMAIN likely diverges across containers. Per-app view:\n${JSON.stringify(results, null, 2)}`
    ).toBe(1);
  });
});
