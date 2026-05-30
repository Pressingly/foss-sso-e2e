// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-shall-not-leak-across-apps

import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import {
  APP_URLS,
  OUTLINE_TEAM_ID,
  PENPOT_TEAM_ID,
  PLANE_WORKSPACE_ID,
} from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";
import { blockedAppsMessage } from "../lib/app-health-probes";

// Per-app auto-join independence: when the same SSO user is auto-joined
// in app A and app B, each app's middleware acts independently. There
// is no shared workspace database, no cross-app sync service. The spec
// scenario:
//
//   GIVEN a user in both Plane and Outline DBs
//   AND the user is a member of `acme` in Plane
//   WHEN they log in to Outline for the first time
//   THEN Outline auto-joins them to Outline's oldest team
//   AND the user's Plane membership has no effect on what Outline does
//   AND vice-versa
//
// HISTORY: an earlier shape of this test fetched each app's primary
// workspace identifier (per-app UUID/PK) and asserted "no two apps
// share an identifier." That was structurally vacuous — four
// independent databases generating UUIDs will never collide regardless
// of whether the contract holds, so the assertion did nothing. A real
// regression that pointed Plane's middleware at Outline's workspace
// store would not have been caught: Plane would still return Plane's
// own UUID for whatever workspace it landed on.
//
// CURRENT SHAPE: positive-correlation. For the same logged-in user, we
// assert each app's primary workspace identifier MATCHES THE
// BUNDLE-CONFIGURED VALUE the suite imports from `constants.ts`
// (PLANE_WORKSPACE_ID, OUTLINE_TEAM_ID, PENPOT_TEAM_ID). These are the
// per-app IDs the bundle's auto-join provisioned this user into. A
// regression where:
//
//   - app A's middleware is misconfigured and lands the user in the
//     wrong workspace (e.g. an orphan workspace from a prior tenant),
//     OR
//   - app A's storage backend is accidentally pointed at app B's data,
//     OR
//   - app A's auto-join is silently dropped and the user ends up in
//     no workspace at all (probe throws or returns empty)
//
// is caught by the per-app equality assertion. SurfSense is omitted —
// its `/users/me` returns a per-user PK, not a workspace identifier,
// so there's no per-app-workspace value to correlate. SurfSense
// workspace membership is covered by `tests/apps/surfsense-admin.spec.ts`.

type WorkspaceProbe = {
  app: string;
  description: string;
  expected: string;
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

// Each probe returns the app's primary workspace identifier — the
// per-app UUID the app's auto-join wrote into its own DB. We assert
// that value matches the bundle-configured expected ID from
// constants.ts, proving auto-join landed the user in the bundle's
// designated workspace (not a leaked cross-app value).
const PROBES: WorkspaceProbe[] = [
  {
    app: "PM",
    description: "Plane GET /api/users/me/settings/ → workspace.last_workspace_id",
    expected: PLANE_WORKSPACE_ID,
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<{ workspace: { last_workspace_id: string } }>(
        ch,
        `${baseUrl}/api/users/me/settings/`
      );
      return j.workspace.last_workspace_id;
    },
  },
  {
    app: "Outline",
    description: "Outline POST /api/auth.info → data.team.id",
    expected: OUTLINE_TEAM_ID,
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await postJSON<{ data: { team: { id: string } } }>(
        ch,
        `${baseUrl}/api/auth.info`
      );
      return j.data.team.id;
    },
  },
  {
    app: "Penpot",
    description: "Penpot GET /api/rpc/command/get-profile → ~:default-team-id",
    expected: PENPOT_TEAM_ID,
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<unknown>(ch, `${baseUrl}/api/rpc/command/get-profile`);
      // The default-team-id field is the per-profile primary team. It
      // arrives as a Transit-tagged UUID, e.g. "~uc16a7502-...".
      return extractPenpotTransitField(j, "~:default-team-id");
    },
  },
];

test.describe("workspace-auto-join — per-app independence", () => {
  test("each app's primary workspace matches the bundle-configured value (no cross-app leak)", async ({
    context,
    page,
    appHealth,
  }) => {
    const blocked = blockedAppsMessage(appHealth, "PM", "Outline", "Penpot");
    test.skip(!!blocked, blocked ?? "");
    test.setTimeout(120_000);

    // Warm each app once so per-host cookies are in the jar — Penpot
    // doesn't issue a session cookie until the SPA has had a chance to
    // do its first authenticated call.
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app as keyof typeof APP_URLS];
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect
        .poll(() => new URL(page.url()).hostname, {
          message: `${probe.app}: warm-up navigation should settle on app host`,
          timeout: 15_000,
        })
        .toBe(new URL(baseUrl).hostname);
    }

    const mismatches: string[] = [];
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app as keyof typeof APP_URLS];
      const observed = await probe.fetch(context, baseUrl);
      expect(
        observed,
        `${probe.app}: ${probe.description} returned empty/null — auto-join may not have completed`,
      ).toBeTruthy();

      if (observed !== probe.expected) {
        mismatches.push(
          `${probe.app}: expected ${probe.expected} (from constants.ts), got ${observed} ` +
            `(via ${probe.description})`,
        );
      }
    }

    // The load-bearing assertion: each app reports the bundle-configured
    // workspace identifier. A mismatch indicates the user's auto-join
    // landed them somewhere other than the bundle's designated workspace
    // for this app — a regression in either the auto-join logic OR the
    // app's storage backend pointing.
    expect(
      mismatches,
      `Per-app workspace identifier mismatch — at least one app reported a workspace ID ` +
        `different from the bundle-configured expected value in constants.ts. ` +
        `If the bundle deliberately re-provisioned a workspace, update the matching ` +
        `*_ID / *_SLUG default in constants.ts to match.\n\n` +
        mismatches.map((m) => `  - ${m}`).join("\n"),
    ).toEqual([]);
  });
});
