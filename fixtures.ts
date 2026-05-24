import { test as base, BrowserContext, Browser } from "@playwright/test";
import { cognitoLogin } from "./auth-helpers";
import { APP_URLS } from "./constants";
import { AppHealthMap, probeAllApps } from "./tests/lib/app-health-probes";

type WorkerFixtures = {
  workerStorageState: string;
  // Per-app SSO-chain health snapshot, probed once per worker after
  // the worker login completes. Cross-app cascade tests
  // (identity-consistency, link-coverage, logout-invariants, …) read
  // this and `test.skip` with a reason if a required app is broken,
  // so a single bundle issue doesn't cascade into 20 red tests. The
  // per-app smoke spec is the LOUD signal; the gate this fixture
  // enables is the NOISE-REDUCTION layer on top.
  appHealth: AppHealthMap;
};

type TestFixtures = {
  context: BrowserContext;
  browser: Browser;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Login once per worker — result lives in memory as JSON string
  workerStorageState: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await cognitoLogin(page);
      const state = await context.storageState(); // in-memory object, never written to disk
      await context.close();
      await use(JSON.stringify(state));
    },
    { scope: "worker", timeout: 120_000 },
  ],

  // Worker-scope: probe every app's SSO chain once and cache the
  // result so cascade tests can read it without re-probing. The
  // probe context is created fresh from worker storage state and
  // closed immediately — it never leaks into test contexts.
  //
  // Important: this fixture warms each app's host (so per-host
  // session cookies land in the jar) BEFORE probing. Some apps
  // lazily issue their per-host session cookie on first SPA fetch,
  // and probing /me with only the SSO cookie would 401.
  //
  // The warm-up is intentionally duplicated in cascade tests too —
  // each test's `context` is a separate BrowserContext also seeded
  // from workerStorageState, and per-host cookies issued in THIS
  // fixture's context don't carry over. Sharing context across the
  // fixture + tests would break Playwright's per-test isolation, so
  // accept the ~5s of duplicated `goto`s per worker as the price of
  // correctness.
  appHealth: [
    async ({ browser, workerStorageState }, use) => {
      const ctx = await browser.newContext({ storageState: JSON.parse(workerStorageState) });
      try {
        for (const url of Object.values(APP_URLS)) {
          const p = await ctx.newPage();
          await p.goto(url, { waitUntil: "commit", timeout: 30_000 }).catch(() => {});
          await p.close();
        }
        const health = await probeAllApps(ctx);
        await use(health);
      } finally {
        await ctx.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],

  // Each test gets a fresh context pre-loaded with the worker's auth state
  context: async ({ browser, workerStorageState }, use) => {
    const context = await browser.newContext({
      storageState: JSON.parse(workerStorageState),
    });
    await use(context);
    await context.close();
  },
});

export { expect } from "@playwright/test";
