import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_URL = process.env.FOSS_BASE_URL?.trim() || "https://foss.arbisoft.com";
const defaultSlowMo = process.env.PW_DEBUG_VISUAL === "1" ? "2000" : "0";
const parsedSlowMo = Number(process.env.PW_SLOW_MO_MS ?? defaultSlowMo);
const SLOW_MO_MS = Number.isFinite(parsedSlowMo) && parsedSlowMo >= 0 ? parsedSlowMo : 0;
const parsedWorkers = Number(process.env.PW_WORKERS);
const WORKERS = Number.isInteger(parsedWorkers) && parsedWorkers > 0
  ? parsedWorkers
  : (process.env.CI ? 2 : 2);

// Browser selection
//   default          → chromium only (fast local + CI smoke)
//   BROWSERS=all     → chromium + firefox + webkit
//   BROWSERS=firefox → just firefox (comma-separated list also accepted)
//   BROWSERS=chromium,webkit → chromium + webkit
const ALL_BROWSERS = ["chromium", "firefox", "webkit"] as const;
type BrowserName = (typeof ALL_BROWSERS)[number];

function selectedBrowsers(): BrowserName[] {
  const raw = (process.env.BROWSERS ?? "chromium").trim().toLowerCase();
  if (raw === "all") return [...ALL_BROWSERS];

  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((b): b is BrowserName =>
    (ALL_BROWSERS as readonly string[]).includes(b)
  );
  if (valid.length === 0) {
    throw new Error(
      `BROWSERS="${process.env.BROWSERS}" matched no known browser. Use "all" or any of: ${ALL_BROWSERS.join(", ")}`
    );
  }
  return valid;
}

const DEVICE_BY_BROWSER: Record<BrowserName, string> = {
  chromium: "Desktop Chrome",
  firefox:  "Desktop Firefox",
  webkit:   "Desktop Safari",
};

// Staging bug-reproducers live under tests/bugs/. They're expected to fail
// (failure = bug confirmed) so they pollute the main e2e suite's red/green
// signal. Default config skips them; the dedicated bug-tests-run.yml workflow
// sets PW_INCLUDE_STAGING=1 to pull them back in.
const INCLUDE_STAGING = process.env.PW_INCLUDE_STAGING === "1";
const STAGING_IGNORE = INCLUDE_STAGING ? [] : ["**/tests/bugs/**"];

// tests/zap/ are ZAP-driver specs — they exercise the SSO chain through
// a ZAP proxy so ZAP can record + active-scan the traffic. Always
// excluded from default discovery; the dedicated zap-authed-sso.yml
// workflow targets that file directly.
const ZAP_IGNORE = ["**/tests/zap/**"];

export default defineConfig({
  testDir: "./tests",
  testIgnore: [...STAGING_IGNORE, ...ZAP_IGNORE],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: WORKERS,
  reporter: [
    ["html", { open: "never" }],
    ["list"],
    // JSON reporter — lets CI extract a plain failure list for Slack.
    ["json", { outputFile: "test-results/report.json" }],
  ],

  use: {
    baseURL: BASE_URL,
    // Keep test runs fast by default. Enable visual pacing with PW_DEBUG_VISUAL=1.
    launchOptions: { slowMo: SLOW_MO_MS },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },

  projects: selectedBrowsers().map((name) => ({
    name,
    use: { ...devices[DEVICE_BY_BROWSER[name]] },
  })),
});
