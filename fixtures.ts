import { test as base, BrowserContext, Browser } from "@playwright/test";
import { cognitoLogin } from "./auth-helpers";

type WorkerFixtures = {
  workerStorageState: string;
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
