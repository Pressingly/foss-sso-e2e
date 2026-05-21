// Spec coverage for this file (see docs/spec-coverage.md):
// @spec cognito-claim-mapping#identity-claim-shall-be-configurable-when-email-is-unreliable

import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

// Cross-app email-domain consistency.
//
// The `cognito-claim-mapping` spec requires that when the Cognito
// `sub` claim is a bare username (no `@`), every app's middleware
// synthesises an email by appending the same `DEFAULT_EMAIL_DOMAIN`.
// If two apps disagree on the domain (say, Plane is configured with
// `@askii.ai` and Outline with `@moneta.dev`), the same physical
// user shows up as two distinct identities to the stack — silent
// data partitioning.
//
// `tests/auth/identity-consistency.spec.ts` already asserts that
// every backend resolves the SAME EMAIL for the logged-in user, so
// in the happy path this check is redundant. The reason it lives in
// its own spec is the failure-mode SHAPE: identity-consistency fails
// loudly with "Plane says A, Outline says B" — useful but reads as
// an identity bug. This spec fails with "Plane uses domain X,
// Outline uses domain Y" — directly pointing the operator at the
// env-var divergence to fix.
//
// Twenty is omitted (same reason as identity-consistency): its
// /rest/* endpoints require a JWT bearer rather than the SSO cookie.

type EmailProbe = {
  app: keyof typeof APP_URLS;
  description: string;
  fetch: (ctx: BrowserContext, baseUrl: string) => Promise<string>;
};

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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

const PROBES: EmailProbe[] = [
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

function emailDomain(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "(no @ — bare username)";
  return email.slice(at + 1).toLowerCase().trim();
}

test.describe("cognito-claim-mapping — DEFAULT_EMAIL_DOMAIN consistent across apps", () => {
  test("every cookie-authed app synthesises the same email domain", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    // Warm each app once so per-host cookies land before probes.
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app];
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect
        .poll(() => new URL(page.url()).hostname, {
          message: `${probe.app}: warm-up navigation should settle on app host`,
          timeout: 15_000,
        })
        .toBe(new URL(baseUrl).hostname);
    }

    const observed: { app: string; email: string; domain: string }[] = [];
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app];
      const email = await probe.fetch(context, baseUrl);
      observed.push({ app: probe.app, email, domain: emailDomain(email) });
    }

    const distinctDomains = new Set(observed.map((o) => o.domain));
    expect(
      [...distinctDomains],
      `Cross-app DEFAULT_EMAIL_DOMAIN divergence — at least two apps synthesise different email suffixes for the same user. This is the signature of a per-app env-var misconfiguration (likely a copy-paste of docker-compose.yml that forgot to update one app's DEFAULT_EMAIL_DOMAIN).\nObserved:\n${observed
        .map((o) => `  ${o.app}: ${o.email} (domain: ${o.domain})`)
        .join("\n")}`
    ).toHaveLength(1);
  });
});
