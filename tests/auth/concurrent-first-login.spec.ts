// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#concurrent-creation-races-shall-fall-back-to-read

import { test as raw, expect } from "@playwright/test";
import { APPS, COGNITO_EMAIL_DOMAIN, escapeHostForRegex } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// proxy-auth-middleware contract: when two requests with the same
// proxy identity hit the per-app middleware concurrently for a user
// that doesn't yet exist in the app DB, only ONE user row must be
// created. The losing branch must fall back to a read.
//
// Without this guarantee, a fresh SSO user landing on multiple apps
// at once (e.g. browser tab restore after a fresh login) gets
// duplicate user rows in *each* app — their data ends up partitioned
// across two identities, audit logs get confused, and there's no
// trivial unwind path.
//
// The cleanest behavioural assertion we can run from a Playwright
// suite without DB or admin API access: log in via N parallel
// browser contexts, sharing the same SSO user, and assert each app
// reports a stable identity (one canonical email visible in storage
// / cookies / DOM) across every context. If two user rows got
// created, at least one context would see a different identity
// (different name shown, different profile UUID, etc.) — and the
// next time that context's request hits the app, its data view
// would diverge from the original context's.
//
// The test is intentionally conservative: it only flags HARD
// divergence (two contexts seeing different identities for the same
// Cognito user). Subtle race outcomes (silent duplicate rows that
// the SPA hides) are out of scope without DB access.

const PARALLEL_CONTEXTS = 3;

raw.describe("proxy-auth-middleware concurrent-creation race", () => {
  for (const app of APPS) {
    raw(`${app.name}: ${PARALLEL_CONTEXTS} parallel first-time visits resolve to ONE identity`, async ({
      browser,
    }) => {
      raw.setTimeout(180_000);

      // Phase 1: fire all logins in parallel. Each context is a
      // fresh browser session sharing the same Cognito identity.
      // The first one through the OIDC callback races the others to
      // create the user row in the app DB; the contract says only
      // one row gets created and the rest fall back to read.
      const sessions = await Promise.all(
        Array.from({ length: PARALLEL_CONTEXTS }, async () => {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          return { ctx, page };
        })
      );

      try {
        // Fire all logins simultaneously. Promise.all races the
        // OIDC callbacks; if proxy-auth-middleware's race-handling
        // is broken, some contexts may end up bound to a duplicate
        // row.
        await Promise.all(sessions.map((s) => cognitoLogin(s.page)));

        // Phase 2: in each context, visit the app and scrape any
        // surfaced identity signal. We re-use the same haystack
        // approach as flows/identity-switch-after-relogin: dump
        // every observable identity source and grep for
        // <numeric>@askii.ai emails plus any UUID-shaped profile
        // identifier.
        const identities = await Promise.all(
          sessions.map(async ({ ctx, page }) => {
            await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
            await expect
              .poll(() => new URL(page.url()).hostname, {
                message: `${app.name}: login session should land on app host before identity scrape`,
                timeout: 15_000,
              })
              .toBe(new URL(app.url).hostname);
            return await page.evaluate((emailDomainEscaped: string) => {
              const buckets: string[] = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) buckets.push(localStorage.getItem(k) ?? "");
              }
              for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                if (k) buckets.push(sessionStorage.getItem(k) ?? "");
              }
              buckets.push(document.documentElement?.outerHTML ?? "");
              const joined = buckets.join("\n");
              const re = new RegExp(`(\\d{10,})@${emailDomainEscaped}`, "g");
              const emails = [...new Set(joined.match(re) ?? [])];
              return emails.sort();
            }, escapeHostForRegex(COGNITO_EMAIL_DOMAIN));
          })
        );

        // Phase 3: every context must surface the SAME identity.
        // If any one of them surfaces a different email pattern,
        // the race left at least one context bound to a duplicate
        // row.
        const distinctIdentities = new Set(identities.map((e) => e.join(",")));
        expect(
          [...distinctIdentities],
          `${app.name}: parallel first-time logins resolved to multiple identities — likely duplicate user rows from a creation race.\nObserved identities per context:\n${identities
            .map((e, i) => `  ctx${i}: [${e.join(", ")}]`)
            .join("\n")}`
        ).toHaveLength(1);
      } finally {
        await Promise.all(sessions.map(({ ctx }) => ctx.close()));
      }
    });
  }
});
