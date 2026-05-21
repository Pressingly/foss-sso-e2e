// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-shall-not-leak-across-apps

import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

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
// The behavioural signal we can observe from e2e: for the same logged-in
// user, each app's `/me`-style endpoint reports its OWN workspace
// identifier — a per-app UUID/slug that lives in that app's own DB.
// If two apps reported the same identifier, that would prove a shared
// backend (which would violate the independence invariant). Different
// identifiers prove the auto-join made distinct DB writes per app.
//
// Twenty is omitted (same reason as identity-consistency.spec.ts):
// its workspace data is behind a JWT-bearer endpoint, not the SSO
// cookie. The 4 cookie-authed apps below are enough to prove the
// no-shared-DB property — if any future regression introduces a
// cross-app workspace sync, this 4-app probe will catch it.

type WorkspaceProbe = {
  app: string;
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

// Each probe returns the app's primary workspace/team identifier — the
// per-app UUID or slug that the app's auto-join wrote into its own DB.
// We don't normalise across apps: Outline uses team UUIDs, Plane uses
// workspace slugs, Penpot uses team UUIDs, SurfSense uses search_space
// UUIDs. The shape differences are the point — they prove each app
// has its own workspace store.
const PROBES: WorkspaceProbe[] = [
  {
    app: "PM",
    description: "Plane GET /api/users/me/settings/ → workspace.last_workspace_id",
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
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<unknown>(ch, `${baseUrl}/api/rpc/command/get-profile`);
      // The default-team-id field is the per-profile primary team. It
      // arrives as a Transit-tagged UUID, e.g. "~uc16a7502-...".
      return extractPenpotTransitField(j, "~:default-team-id");
    },
  },
  {
    app: "SurfSense",
    description: "SurfSense GET /users/me → id (user record, not workspace, but per-app)",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      // SurfSense's workspace model is per-SearchSpace. The /users/me
      // endpoint returns the user id, not a workspace; use that as the
      // per-app identifier — if cross-app sync somehow assigned the same
      // user PK across apps, this would coincidentally match another
      // app's UUID (extremely unlikely with separate per-app DBs).
      const j = await getJSON<{ id: string }>(ch, `${baseUrl}/users/me`);
      return j.id;
    },
  },
];

test.describe("workspace-auto-join — per-app independence", () => {
  test("each app surfaces its own workspace identifier; none are shared across apps", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    // Warm each app once so per-host cookies are in the jar — Penpot and
    // SurfSense don't issue session cookies until the SPA has had a
    // chance to do its first authenticated call.
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

    const observed: { app: string; identifier: string }[] = [];
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app as keyof typeof APP_URLS];
      const identifier = await probe.fetch(context, baseUrl);
      expect(
        identifier,
        `${probe.app}: ${probe.description} returned empty/null — auto-join may not have completed (the property "auto-join SHALL run on every login" is the prerequisite for this independence check)`
      ).toBeTruthy();
      observed.push({ app: probe.app, identifier });
    }

    // The load-bearing assertion: no two apps report the same
    // identifier. If they did, that would prove a shared backend
    // (workspace-sync service, shared DB, etc.) which violates the
    // "auto-join SHALL NOT leak across apps" invariant.
    const byIdentifier = new Map<string, string[]>();
    for (const { app, identifier } of observed) {
      if (!byIdentifier.has(identifier)) byIdentifier.set(identifier, []);
      byIdentifier.get(identifier)!.push(app);
    }
    const collisions = [...byIdentifier.entries()]
      .filter(([, apps]) => apps.length > 1)
      .map(([id, apps]) => `${apps.join(" + ")} share identifier ${id}`);

    expect(
      collisions,
      `Cross-app workspace identifier collision detected — at least two apps report the same per-app identifier, which would only be possible with a shared workspace backend. Observed:\n${observed
        .map((o) => `  ${o.app}: ${o.identifier}`)
        .join("\n")}\nCollisions:\n${collisions.join("\n")}`
    ).toEqual([]);
  });
});
