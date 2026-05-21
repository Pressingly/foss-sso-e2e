/**
 * FOSS Platform Discovery Script
 * Automates AWS Cognito SSO login, then maps all apps/links/routes.
 *
 * Usage:
 *   FOSS_USER=you@example.com FOSS_PASS=secret npm run discover
 */

import { chromium, Browser, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://foss.arbisoft.com";
const OUTPUT_FILE = path.join(__dirname, "discovery-report.json");
const STORAGE_STATE_FILE = path.join(__dirname, "storageState.json");

const FOSS_USER = process.env.FOSS_USER ?? "";
const FOSS_PASS = process.env.FOSS_PASS ?? "";

interface DiscoveryReport {
  baseUrl: string;
  timestamp: string;
  ssoLoginUrl: string | null;
  ssoProvider: string | null;
  apps: AppInfo[];
  protectedRoutes: RouteCheck[];
  cookies: CookieInfo[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  allLinks: string[];
}

interface AppInfo {
  name: string;
  url: string;
  title: string;
  isAuthenticated: boolean;
  navLinks: string[];
  adminLinks: string[];
}

interface RouteCheck {
  url: string;
  status: number | null;
  redirectedTo: string | null;
  blocked: boolean;
}

interface CookieInfo {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | undefined;
}

async function extractLinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith("http"))
  );
}

async function extractNavLinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("nav a[href], header a[href], .navbar a[href], .nav a[href]")
    )
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith("http"))
  );
}

async function detectAdminLinks(links: string[]): Promise<string[]> {
  const patterns = [/admin/i, /dashboard/i, /manage/i, /staff/i, /superuser/i, /godmode/i];
  return links.filter((l) => patterns.some((p) => p.test(l)));
}

async function checkIsAuthenticated(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body.innerText.toLowerCase());
  const url = page.url();
  const hasLogin = text.includes("sign in") || text.includes("log in") || text.includes("login");
  const hasUser =
    text.includes("logout") ||
    text.includes("sign out") ||
    text.includes("profile") ||
    text.includes("account") ||
    text.includes("dashboard");
  const isLoginPage =
    url.includes("login") || url.includes("signin") || url.includes("accounts/login");
  return !isLoginPage && hasUser && !hasLogin;
}

async function checkRoute(browser: Browser, url: string): Promise<RouteCheck> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let status: number | null = null;
  let redirectedTo: string | null = null;
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    status = res?.status() ?? null;
    const finalUrl = page.url();
    if (finalUrl !== url) redirectedTo = finalUrl;
  } catch {
    // unreachable / timeout
  } finally {
    await ctx.close();
  }
  const blocked =
    status === 403 || status === 401 || (redirectedTo?.includes("login") ?? false);
  return { url, status, redirectedTo, blocked };
}

// ---------------------------------------------------------------------------
// Cognito SSO login
// ---------------------------------------------------------------------------
async function cognitoLogin(page: Page): Promise<void> {
  if (!FOSS_USER || !FOSS_PASS) {
    throw new Error(
      "Set FOSS_USER and FOSS_PASS env vars.\n" +
        "  FOSS_USER=you@example.com FOSS_PASS=secret npm run discover"
    );
  }

  console.log("Navigating to FOSS platform...");
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Wait for Cognito redirect
  await page.waitForURL(/amazoncognito\.com/, { timeout: 15000 });
  console.log(`Cognito page: ${page.url()}`);

  // Step 1: username
  await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 10000 });
  await page.fill('input[name="username"], input[type="text"]', FOSS_USER);
  await page.click('button[type="submit"], input[type="submit"], button:has-text("Next"), button:has-text("Sign in")');

  // Step 2: password (may appear on same or next page)
  await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 10000 });
  await page.fill('input[name="password"], input[type="password"]', FOSS_PASS);
  await page.click('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Login")');

  // Wait for redirect back to FOSS
  await page.waitForURL(/foss\.arbisoft\.com/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  console.log(`Login complete. Now at: ${page.url()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  const report: DiscoveryReport = {
    baseUrl: BASE_URL,
    timestamp: new Date().toISOString(),
    ssoLoginUrl: null,
    ssoProvider: "AWS Cognito",
    apps: [],
    protectedRoutes: [],
    cookies: [],
    localStorage: {},
    sessionStorage: {},
    allLinks: [],
  };

  console.log("\n=== FOSS Platform Discovery ===\n");

  await cognitoLogin(page);

  // Capture post-login links
  const postLoginLinks = await extractLinks(page);
  report.allLinks = [...new Set(postLoginLinks)];
  report.ssoLoginUrl = page.url();
  console.log(`Links found: ${report.allLinks.length}`);

  // Cookies
  const cookies = await context.cookies();
  report.cookies = cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  }));
  console.log(`Cookies: ${report.cookies.map((c) => c.name).join(", ")}`);

  // Storage
  report.localStorage = await page.evaluate(() => {
    const s: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      s[k] = localStorage.getItem(k) ?? "";
    }
    return s;
  });
  report.sessionStorage = await page.evaluate(() => {
    const s: Record<string, string> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      s[k] = sessionStorage.getItem(k) ?? "";
    }
    return s;
  });

  // Save storageState
  await context.storageState({ path: STORAGE_STATE_FILE });
  console.log(`storageState saved → ${STORAGE_STATE_FILE}`);

  // Detect app origins from links
  const appDomains = new Set<string>();
  report.allLinks.forEach((link) => {
    try {
      const u = new URL(link);
      if (u.hostname.includes("arbisoft") || u.hostname.includes("foss")) {
        appDomains.add(u.origin);
      }
    } catch {}
  });
  console.log(`\nDetected app origins: ${[...appDomains].join(", ") || "(only base domain found)"}`);

  // Visit each app
  for (const appOrigin of appDomains) {
    console.log(`\nVisiting: ${appOrigin}`);
    try {
      await page.goto(appOrigin, { waitUntil: "networkidle", timeout: 20000 });
      const appLinks = await extractLinks(page);
      const navLinks = await extractNavLinks(page);
      const all = [...new Set([...appLinks, ...navLinks])];
      const adminLinks = await detectAdminLinks(all);
      const isAuth = await checkIsAuthenticated(page);
      const title = await page.title();
      report.apps.push({ name: title || appOrigin, url: appOrigin, title, isAuthenticated: isAuth, navLinks: navLinks.slice(0, 30), adminLinks });
      console.log(`  Title: ${title}`);
      console.log(`  Authenticated: ${isAuth}`);
      console.log(`  Admin links: ${adminLinks.join(", ") || "none"}`);
    } catch (e) {
      console.log(`  Failed: ${e}`);
    }
  }

  // Check protected routes (unauthenticated)
  const protectedPaths = [
    "/admin", "/admin/", "/staff", "/dashboard", "/api/users",
    "/api/admin", "/manage", "/settings", "/superuser",
  ];
  console.log("\nChecking protected routes (fresh unauthenticated context)...");
  for (const p of protectedPaths) {
    const result = await checkRoute(browser, `${BASE_URL}${p}`);
    if (result.status !== null) {
      report.protectedRoutes.push(result);
      console.log(
        `  ${BASE_URL}${p} → ${result.status}` +
          (result.redirectedTo ? ` → ${result.redirectedTo}` : "")
      );
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nReport → ${OUTPUT_FILE}`);
  console.log(`Apps: ${report.apps.length} | Links: ${report.allLinks.length} | Blocked: ${report.protectedRoutes.filter((r) => r.blocked).length}`);
  console.log("=== Done ===");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
