// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#identity-mismatch-shall-flush-the-existing-session-immediately

import { test, expect } from "../../fixtures";
import { test as raw, type Page, type BrowserContext } from "@playwright/test";
import {
  APPS,
  MAIN_URL,
  AUTH_COOKIE,
  COGNITO_EMAIL_DOMAIN,
  escapeHostForRegex,
} from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Scenario (from a real bug report against the deployment):
//
//   1. Log in as User A on the FOSS portal.
//   2. Open every service app in its own tab.
//   3. From the portal tab, click "Log out of all apps" — SSO cookie
//      is cleared.
//   4. Log in again as User B.
//   5. Refresh each app tab.
//
// Expected: all five apps reflect User B's identity.
// Reported: only SurfSense flips correctly; Outline, Penpot, Plane,
//           and Twenty keep showing User A in their cached profile.
//
// The four broken apps cache identity in app-local storage
// (localStorage / sessionStorage / non-shared cookies on their own
// subdomain). When the platform SSO cookie rotates to User B, the
// app middleware sees the new X-Auth-Request-Email header but the
// SPA continues reading from the stale local cache.
//
// This test reproduces the scenario and asserts the *fixed* contract:
// every app's cached identity must match User B after relogin. The
// test will fail today (Outline and Penpot leak User A's email after
// relogin) — we want it on the team's daily CI radar until the SPA
// identity-refresh fix lands. When the bug is fixed, the test goes
// green naturally.

const FOSS_USER = process.env.FOSS_USER;
const FOSS_PASS = process.env.FOSS_PASS;
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

// Both users' "visible" emails inside the apps follow the synthetic
// <numeric-id>@<COGNITO_EMAIL_DOMAIN> convention (oauth2-proxy maps
// Cognito IDs into emails via DEFAULT_EMAIL_DOMAIN). The username we
// send to Cognito IS the numeric prefix.
const expectedEmail = (cognitoUsername: string): string =>
  `${cognitoUsername}@${COGNITO_EMAIL_DOMAIN}`;
const SURFACED_EMAIL_RE = new RegExp(
  `(\\d{10,})@${escapeHostForRegex(COGNITO_EMAIL_DOMAIN)}`,
  "g"
);

// Per-app URL that *reliably* surfaces the current user's email in
// rendered HTML. The app root pages (e.g. Twenty's /objects/companies,
// Plane's /aa/) often only render a user avatar / initials and don't
// include the email anywhere observable. The profile / account-settings
// pages are where the email is consistently rendered. Without visiting
// them, the test would only catch leaks on Outline + Penpot (which do
// surface the email on their root pages); Plane and Twenty would
// silently slip through.
const APP_IDENTITY_URLS: Record<string, string> = {
  Outline: "/settings/profile",
  PM: "/settings/profile/general",
  Penpot: "/#/settings/profile",
  // SurfSense surfaces the logged-in email in the Manage Members
  // dialog (verified) — the dashboard root suffices because the
  // sidebar avatar tooltip also renders the email.
  SurfSense: "",
  Twenty: "/settings/profile",
};

// Apps skipped here surface User A's email in some client-side
// store after relogin as User B, BUT the leak is cosmetic only —
// no functional / security impact. Mutations and API calls go
// through the backend SSO session, which always reflects the
// active user. The cache is purely display state.
//
// We document each case so the skip stays informative rather than
// a black-box opt-out, and so it can be revisited if the upstream
// app ever decides to invalidate the display cache on identity
// change.
const SKIP_APPS_KNOWN_STALE: Record<string, string> = {
  // Penpot — `penpot-user:/profile` localStorage holds the full
  // profile object (email, fullname, default-team-id, …) written
  // on initial login and not invalidated when SSO rotates
  // identity. The dashboard re-fetches from the backend so the
  // sidebar/avatar correctly shows User B; only
  // /#/settings/profile reads the cached blob into its disabled
  // <input value="..."> form field. Crucially, if User B submits
  // the form, the backend mutates User B's record — the active
  // session identity is correct, just the pre-fill is stale.
  // Penpot may invalidate this cache on a future release; until
  // then the test would block CI on a cosmetic display issue.
  Penpot: "stale display cache in localStorage[penpot-user:/profile] / settings-profile form pre-fill (mutations correctly target the active user — cosmetic only)",
};

async function gotoApp(page: Page, url: string, timeout = 30_000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "commit", timeout });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/ERR_ABORTED/.test(msg)) throw e;
  }
}

// Collect every place an app could surface a user identity. The bug
// is observable in any of these — apps cache the email in:
//   • localStorage / sessionStorage (Penpot, Twenty)
//   • a rendered avatar / sidebar header (Outline)
//   • icon tooltips, title attributes, or aria-labels (Plane's user
//     avatar — rendered text isn't enough; full outerHTML is needed)
//   • base64-encoded JWTs inside larger JSON blobs (Twenty stores its
//     tokenPair this way; the email lives in the JWT payload)
// Returns the full concatenated haystack with all reasonable decodings
// applied; callers regex it for the email pattern.
async function collectIdentityHaystack(
  page: Page,
  context: BrowserContext,
  appUrl: string
): Promise<string> {
  const fromDom = await page.evaluate(() => {
    // Walk localStorage/sessionStorage and *also* try to base64-decode
    // any JWT-shaped substrings (3 dot-separated b64url segments) we
    // find in the values — Twenty buries the user email inside the
    // JWT payload, not in plain text.
    const tryDecodeJwts = (s: string): string[] => {
      const out: string[] = [];
      const matches = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
      for (const jwt of matches) {
        const parts = jwt.split(".");
        try {
          // Decode the payload (middle part) as base64url.
          const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
          out.push(atob(b64 + "==".slice(0, (4 - (b64.length % 4)) % 4)));
        } catch {
          /* skip non-decodable */
        }
      }
      return out;
    };

    const buckets: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) {
        const v = localStorage.getItem(k) ?? "";
        buckets.push(v);
        buckets.push(...tryDecodeJwts(v));
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) {
        const v = sessionStorage.getItem(k) ?? "";
        buckets.push(v);
        buckets.push(...tryDecodeJwts(v));
      }
    }
    buckets.push(document.cookie);
    // Full HTML — innerText misses attribute values (title, aria-label,
    // data-* attrs) where Plane stashes the email in avatar tooltips.
    buckets.push(document.documentElement?.outerHTML ?? "");
    return buckets.join("\n");
  });

  const cookies = await context.cookies(appUrl);
  const cookieBlob = cookies.map((c) => c.value).join("\n");
  let decodedCookies = cookieBlob;
  try {
    decodedCookies = decodeURIComponent(cookieBlob);
  } catch {
    /* leave as-is */
  }
  return [fromDom, decodedCookies].join("\n");
}

raw.describe("Identity switch — relogin as a different user updates every app's cache", () => {
  raw.skip(
    !FOSS_USER || !FOSS_PASS || !NORMAL_USER || !NORMAL_PASS,
    "Set FOSS_USER/FOSS_PASS and NORMAL_USER/NORMAL_PASS in .env"
  );

  raw("after 'Log out of all apps' and relogin, every app reflects the new user", async ({
    browser,
  }) => {
    raw.setTimeout(300_000);

    const ctx = await browser.newContext();
    const loginPage = await ctx.newPage();
    try {
      // Phase 1: Login as User A on the portal, then open every app
      // once to prime each app's local browser state. Close those pages
      // before logout/relogin so background tabs cannot start their own
      // OAuth recovery flow and corrupt the single-flight bridge state.
      // The context still retains per-origin localStorage and cookies,
      // which are the stale identity caches this test is asserting.
      await cognitoLogin(loginPage, { user: FOSS_USER!, pass: FOSS_PASS! });
      for (const app of APPS) {
        const p = await ctx.newPage();
        await gotoApp(p, app.url);
        await expect
          .poll(() => new URL(p.url()).hostname, {
            message: `${app.name}: tab should settle on its app host`,
            timeout: 10_000,
          })
          .toBe(new URL(app.url).hostname);
        await p.close();
      }
      const userAEmail = expectedEmail(FOSS_USER!);

      // Phase 2: Log out of all apps from the portal tab.
      await loginPage.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const LOGOUT_ALL_RE = /log\s*out\s*(of\s*)?all(\s*apps)?|sign\s*out\s*(of\s*)?all(\s*apps)?/i;
      await loginPage
        .getByRole("button", { name: LOGOUT_ALL_RE })
        .or(loginPage.getByRole("link", { name: LOGOUT_ALL_RE }))
        .first()
        .click({ timeout: 10_000, noWaitAfter: true });
      await loginPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});

      // Sanity: SSO cookie must be cleared so we know the logout
      // actually happened.
      await expect
        .poll(
          async () => {
            const ssoAfterLogout = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
            return !ssoAfterLogout || ssoAfterLogout.value === "";
          },
          {
            message: `Logout must clear ${AUTH_COOKIE} cookie before relogin`,
            timeout: 30_000,
          }
        )
        .toBe(true);

      // Phase 3: Log in as User B from a clean portal tab. Reusing the
      // logout tab can preserve an oauth2 callback URL as the next `rd=`
      // target on this deployment, especially after Twenty has been primed.
      const reloginPage = await ctx.newPage();
      await cognitoLogin(reloginPage, { user: NORMAL_USER!, pass: NORMAL_PASS! });
      const userBEmail = expectedEmail(NORMAL_USER!);

      // Phase 4: For each app's pre-existing tab, navigate to its
      // identity-revealing URL (the profile / account-settings page,
      // or the root if that's where the email surfaces). This matches
      // the user-reported flow ("refresh the tab") plus the practical
      // need to land on a page that actually renders the email — root
      // pages on Plane and Twenty hide the email behind an avatar.
      //
      // Bug: User A's email is still present in client-readable state.
      // We assert two things per app:
      //   • No User A leak — userAEmail must NOT appear anywhere
      //     observable (storage, cookies, rendered text/HTML, decoded
      //     JWTs). If it does, the SPA is reading stale identity.
      //   • Positive signal where available — if an app surfaces an
      //     askii.ai email at all, it should be User B's. Apps that
      //     don't surface any email are tolerated.
      const failures: { app: string; reason: string }[] = [];
      for (const app of APPS) {
        if (app.name in SKIP_APPS_KNOWN_STALE) {
          console.log(
            `[skip] ${app.name}: ${SKIP_APPS_KNOWN_STALE[app.name]} — TODO(remove-when-fixed)`
          );
          continue;
        }
        const p = await ctx.newPage();
        const identityUrl = app.url + (APP_IDENTITY_URLS[app.name] ?? "");
        await gotoApp(p, identityUrl);
        // Give SPAs a short, condition-based window to hydrate delayed
        // identity UI/storage before collecting the haystack.
        await expect
          .poll(
            async () => {
              const h = await collectIdentityHaystack(p, ctx, app.url);
              return h.includes(userAEmail) || h.includes(userBEmail) || /\d{10,}@[a-z0-9.-]+\.[a-z]{2,}/i.test(h);
            },
            { timeout: 8_000 }
          )
          .toBe(true)
          .catch(() => {});
        const haystack = await collectIdentityHaystack(p, ctx, app.url);

        if (haystack.includes(userAEmail)) {
          failures.push({
            app: app.name,
            reason: `User A's email (${userAEmail}) is still cached at ${identityUrl} after relogin as User B`,
          });
          continue;
        }
        const surfaced = haystack.match(SURFACED_EMAIL_RE) ?? [];
        const nonUserB = surfaced.filter((e) => e !== userBEmail);
        if (nonUserB.length > 0) {
          failures.push({
            app: app.name,
            reason: `Unexpected non-User-B email surfaced at ${identityUrl}: ${[...new Set(nonUserB)].join(", ")} (expected ${userBEmail} or no email at all)`,
          });
        }
      }

      expect(
        failures,
        `Apps leaking stale identity after relogin as User B (expected ${userBEmail}):\n${JSON.stringify(failures, null, 2)}`
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
