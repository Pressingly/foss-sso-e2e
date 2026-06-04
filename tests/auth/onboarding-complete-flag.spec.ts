// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-shall-mark-onboarding-complete-on-the-user-profile

import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS, PLANE_WORKSPACE_ID } from "../../constants";

// auto-join marks the user profile as onboarding-complete.
//
// The openspec scenario lists Plane-specific contract fields:
//
//   - is_onboarded = True
//   - last_workspace_id = <the joined workspace's id>
//   - onboarding_step = { profile_complete: True, workspace_create: True,
//                         workspace_invite: True, workspace_join: True }
//
// All four observables come from Plane's `/api/users/me/` and
// `/api/users/me/settings/` endpoints — same cookie-auth path the
// rest of this suite uses against Plane.
//
// Scoped to Plane because the openspec scenario explicitly pins
// Plane's fields. Per-app extensions (Penpot `is-onboarded`, Outline
// team-membership flags, etc.) follow the same shape and can be added
// as those apps' contracts crystallise.

async function cookieHeaderFor(
  ctx: BrowserContext,
  baseUrl: string,
): Promise<string> {
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
      throw new Error(
        `GET ${url} → ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

interface PlaneMe {
  is_onboarded: boolean;
  onboarding_step?: {
    profile_complete?: boolean;
    workspace_create?: boolean;
    workspace_invite?: boolean;
    workspace_join?: boolean;
  };
}

interface PlaneSettings {
  workspace: {
    last_workspace_id: string;
  };
}

test.describe("workspace-auto-join — onboarding complete on the user profile", () => {
  test("Plane: SSO user's profile has all four onboarding-complete signals", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);

    // Warm Plane so per-host cookies land in the jar — Plane's
    // `sessionid` is set on first authenticated load.
    await page.goto(APP_URLS.PM, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect
      .poll(() => new URL(page.url()).hostname, {
        message: "Pre-condition: Plane warm-up must settle on Plane host",
        timeout: 15_000,
      })
      .toBe(new URL(APP_URLS.PM).hostname);

    const cookieHeader = await cookieHeaderFor(context, APP_URLS.PM);

    // ---- Observable 1: is_onboarded = true ---------------------------
    const me = await getJSON<PlaneMe>(cookieHeader, `${APP_URLS.PM}/api/users/me/`);
    expect(
      me.is_onboarded,
      "Plane /api/users/me/ → is_onboarded is false. " +
        "Auto-join did not mark the profile complete; the user would be " +
        "re-prompted to onboard on every login.",
    ).toBe(true);

    // ---- Observable 2: each onboarding_step flag is true -------------
    const step = me.onboarding_step ?? {};
    const expectedSteps = [
      "profile_complete",
      "workspace_create",
      "workspace_invite",
      "workspace_join",
    ] as const;
    const missing = expectedSteps.filter(
      (k) => step[k as keyof typeof step] !== true,
    );
    expect(
      missing,
      `Plane /api/users/me/ → onboarding_step is missing or false for: ${missing.join(", ")}. ` +
        `Got: ${JSON.stringify(step)}. ` +
        `Auto-join should mark all four steps complete.`,
    ).toEqual([]);

    // ---- Observable 3: last_workspace_id is set ----------------------
    // The auto-joined workspace MUST be the user's last_workspace_id —
    // otherwise Plane will prompt them to create or pick a workspace
    // on next login (defeating the auto-join purpose).
    const settings = await getJSON<PlaneSettings>(
      cookieHeader,
      `${APP_URLS.PM}/api/users/me/settings/`,
    );
    expect(
      settings.workspace?.last_workspace_id,
      "Plane /api/users/me/settings/ → workspace.last_workspace_id is missing — " +
        "the user has no remembered workspace, so the next login will prompt " +
        "workspace selection instead of landing on the auto-joined workspace.",
    ).toBeTruthy();
    expect(
      settings.workspace.last_workspace_id,
      `Plane last_workspace_id is ${settings.workspace.last_workspace_id}, ` +
        `expected the bundle-configured PLANE_WORKSPACE_ID (${PLANE_WORKSPACE_ID}). ` +
        `Auto-join landed the user in a different workspace than the bundle ` +
        `intends — a mismatch that compounds with the onboarding-complete claim.`,
    ).toBe(PLANE_WORKSPACE_ID);
  });
});
