import { BrowserContext } from "@playwright/test";
import { APP_URLS, AppName } from "../../constants";
import { extractPenpotTransitField } from "./penpot-transit";

// Per-app SSO-chain health probes. Each app's probe hits a protected
// endpoint with the SSO cookie jar and reports whether the chain
// actually authenticated the user against that app's backend.
//
// Two consumers:
//   1. `tests/auth/per-app-login-smoke.spec.ts` — runs one test per
//      app; failures here are the loud signal for "this app's
//      deployment-layer bootstrap is broken" (missing migration,
//      missing SSO IdP row, stale workspace seed).
//   2. The `appHealth` worker fixture in `fixtures.ts` — probes all
//      apps once per worker. Cross-app cascade tests
//      (identity-consistency, link-coverage, …) read its result via
//      `blockedAppsMessage()` and `test.skip` themselves with a clear
//      reason when a required app is broken. That keeps a single
//      bundle issue from cascading into 20 red tests.
//
// Probes are AUTHED-state checks, not connectivity checks. A SPA root
// loading happily is NOT evidence of SSO success — apps often serve a
// static landing on `/` even when the chain is broken. Every probe
// targets a protected surface (per-app `/me`-shape for the 4
// cookie-authed apps; the proxy-login terminal step for Twenty).

type ProbeRequest = (ctx: BrowserContext) => Promise<{ status: number; text: string }>;

type AppHealthProbe = {
  request: ProbeRequest;
  // If set, parse the response body for the user's email and validate
  // it matches `<local>@<domain>` shape. Omitted for Twenty's
  // proxy-login probe — its success signal is "no 500", not an email
  // (the response is a redirect or empty).
  parseEmail?: (raw: string) => string;
};

export type AppHealthResult =
  | { healthy: true; email?: string }
  | { healthy: false; reason: string };

export type AppHealthMap = Record<AppName, AppHealthResult>;

async function apiCall(
  ctx: BrowserContext,
  url: string,
  method: "GET" | "POST" = "GET",
): Promise<{ status: number; text: string }> {
  const origin = new URL(url).origin;
  const cookies = await ctx.cookies(origin);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const r =
    method === "POST"
      ? await ctx.request.post(url, { headers: { cookie, "content-type": "application/json" }, data: {} })
      : await ctx.request.get(url, { headers: { cookie }, maxRedirects: 0 });
  return { status: r.status(), text: await r.text() };
}

export const APP_HEALTH_PROBES: Record<AppName, AppHealthProbe> = {
  PM: {
    request: (ctx) => apiCall(ctx, `${APP_URLS.PM}/api/users/me/`),
    parseEmail: (raw) => (JSON.parse(raw) as { email: string }).email,
  },
  Outline: {
    request: (ctx) => apiCall(ctx, `${APP_URLS.Outline}/api/auth.info`, "POST"),
    parseEmail: (raw) => (JSON.parse(raw) as { data: { user: { email: string } } }).data.user.email,
  },
  Penpot: {
    request: (ctx) => apiCall(ctx, `${APP_URLS.Penpot}/api/rpc/command/get-profile`),
    parseEmail: (raw) => extractPenpotTransitField(JSON.parse(raw), "~:email"),
  },
  SurfSense: {
    request: (ctx) => apiCall(ctx, `${APP_URLS.SurfSense}/users/me`),
    parseEmail: (raw) => (JSON.parse(raw) as { email: string }).email,
  },
  Twenty: {
    // Twenty has no stable cookie-authed /me endpoint; its SPA uses
    // JWT-bearer GraphQL for currentUser. /auth/sso/proxy-login is the
    // SSO chain's terminal step — 500 when the workspace's IdP row is
    // missing, 2xx/3xx when wired up. Probing it directly skips the
    // SPA timing dance.
    request: (ctx) => apiCall(ctx, `${APP_URLS.Twenty}/auth/sso/proxy-login`),
  },
};

// Probe a single app. Returns either {healthy:true, email?} or
// {healthy:false, reason:<short string>}. The reason is rendered in
// `blockedAppsMessage()` and embedded in skip reasons / smoke failure
// messages — keep it short and grep-able.
export async function probeApp(ctx: BrowserContext, app: AppName): Promise<AppHealthResult> {
  const probe = APP_HEALTH_PROBES[app];
  let res: { status: number; text: string };
  try {
    res = await probe.request(ctx);
  } catch (e) {
    return {
      healthy: false,
      reason: `probe threw: ${(e as Error).message}`,
    };
  }
  if (res.status >= 400) {
    return {
      healthy: false,
      reason: `probe returned ${res.status} (body: ${res.text.slice(0, 120).replace(/\s+/g, " ").trim()})`,
    };
  }
  if (probe.parseEmail) {
    let email: string;
    try {
      email = probe.parseEmail(res.text);
    } catch (e) {
      return {
        healthy: false,
        reason: `probe 2xx but body shape mismatch: ${(e as Error).message}`,
      };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        healthy: false,
        reason: `probe 2xx but no usable email: ${email}`,
      };
    }
    return { healthy: true, email };
  }
  return { healthy: true };
}

// Probe every app in parallel. Used by the `appHealth` worker fixture
// so all cascade tests can see the same snapshot.
export async function probeAllApps(ctx: BrowserContext): Promise<AppHealthMap> {
  const apps = Object.keys(APP_HEALTH_PROBES) as AppName[];
  const results = await Promise.all(apps.map((a) => probeApp(ctx, a).then((r) => [a, r] as const)));
  return Object.fromEntries(results) as AppHealthMap;
}

// Given a health snapshot and a list of apps the calling test
// depends on, return a skip-reason string when one or more are
// unhealthy. Null when everything's fine.
//
// Pattern in a cascade test:
//
//   test("...", async ({ appHealth }) => {
//     const blocked = blockedAppsMessage(appHealth, "PM", "Outline", "Penpot", "SurfSense");
//     test.skip(!!blocked, blocked ?? "");
//     ...
//   });
//
// The skip reason names the broken app(s) and quotes the probe failure
// so triage points straight at the bundle issue, not at this test.
export function blockedAppsMessage(
  health: AppHealthMap,
  ...requiredApps: AppName[]
): string | null {
  const broken = requiredApps.filter((a) => !health[a].healthy);
  if (broken.length === 0) return null;
  const details = broken
    .map((a) => `${a} (${(health[a] as { healthy: false; reason: string }).reason})`)
    .join("; ");
  return `blocked by per-app login smoke — broken app(s): ${details}. See tests/auth/per-app-login-smoke.spec.ts for the canonical signal.`;
}
