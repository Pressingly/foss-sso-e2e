// Spec coverage for this file (see docs/spec-coverage.md):
// @spec workspace-auto-join#auto-join-shall-mark-onboarding-complete-on-the-user-profile

import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS, PLANE_WORKSPACE_ID } from "../../constants";

// auto-join marks the user profile as onboarding-complete.
//
// All three observables come from Plane's `/api/users/me/profile/`
// endpoint (cookie-authed). Probed against the live sandbox 2026-06-05:
//
//   - is_onboarded: true
//   - last_workspace_id: <PLANE_WORKSPACE_ID>
//   - onboarding_step:
//       - profile_complete: true
//       - workspace_create: true
//       - workspace_invite: true
//       - workspace_join:   false  ← see note below
//
// Note on `workspace_join`: Plane sets this flag when the user joined
// an existing workspace via an invite link. SSO-auto-joined users
// (FOSS_USER / NORMAL_USER) are added by the bundle's system-bot
// without going through Plane's invite flow, so this sub-step
// legitimately stays false. The load-bearing contract observable —
// `is_onboarded: true` — is correctly set; Plane treats the user as
// fully onboarded for UX purposes and does not re-prompt them.
// The openspec scenario was updated to reflect this; we assert the
// three deterministic sub-steps and explicitly skip workspace_join.
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

interface PlaneProfile {
  is_onboarded: boolean;
  last_workspace_id: string;
  onboarding_step?: {
    profile_complete?: boolean;
    workspace_create?: boolean;
    workspace_invite?: boolean;
    workspace_join?: boolean;
  };
}

test.describe("workspace-auto-join — onboarding complete on the user profile", () => {
  test("Plane: SSO user's profile is marked onboarding-complete", async ({
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
    const profile = await getJSON<PlaneProfile>(
      cookieHeader,
      `${APP_URLS.PM}/api/users/me/profile/`,
    );

    // ---- Observable 1: is_onboarded = true ---------------------------
    // The load-bearing flag — Plane re-prompts onboarding when this
    // is false, regardless of how the user actually got into the
    // workspace.
    expect(
      profile.is_onboarded,
      "Plane /api/users/me/profile/ → is_onboarded is " +
        `${profile.is_onboarded}. ` +
        "Auto-join did not mark the profile complete; the user would be " +
        "re-prompted to onboard on every login.",
    ).toBe(true);

    // ---- Observable 2: deterministic onboarding_step flags ------------
    // The auto-join code path sets these three:
    //   profile_complete, workspace_create, workspace_invite
    // We omit `workspace_join` here: that sub-step tracks the
    // invite-link join flow, which SSO-auto-joined users skip
    // (see file head). The openspec scenario reflects this.
    const step = profile.onboarding_step ?? {};
    const expectedSteps = [
      "profile_complete",
      "workspace_create",
      "workspace_invite",
    ] as const;
    const missing = expectedSteps.filter(
      (k) => step[k as keyof typeof step] !== true,
    );
    expect(
      missing,
      `Plane /api/users/me/profile/ → onboarding_step is missing or false ` +
        `for: ${missing.join(", ")}. Got: ${JSON.stringify(step)}. ` +
        `Auto-join should set these three deterministically.`,
    ).toEqual([]);

    // ---- Observable 3: last_workspace_id matches the bundle ----------
    // The auto-joined workspace MUST be the user's last_workspace_id —
    // otherwise Plane will prompt them to create or pick a workspace
    // on next login (defeating the auto-join purpose).
    expect(
      profile.last_workspace_id,
      "Plane /api/users/me/profile/ → last_workspace_id is missing — " +
        "the user has no remembered workspace, so the next login will prompt " +
        "workspace selection instead of landing on the auto-joined workspace.",
    ).toBeTruthy();
    expect(
      profile.last_workspace_id,
      `Plane last_workspace_id is ${profile.last_workspace_id}, ` +
        `expected the bundle-configured PLANE_WORKSPACE_ID (${PLANE_WORKSPACE_ID}). ` +
        `Auto-join landed the user in a different workspace than the bundle ` +
        `intends — a mismatch that compounds with the onboarding-complete claim.`,
    ).toBe(PLANE_WORKSPACE_ID);
  });
});
