import { Page, Response } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect } from "../../fixtures";
import { isAuthWall } from "../../constants";

// L1 — first path segment after redirect must NOT be one of these.
const RESERVED_PATH_SEGMENTS = new Set([
  "auth", "login", "signin", "sign-in", "sign_in", "signup", "sign-up",
  "logout", "sign_out", "signout", "oauth2", "onboarding",
  "create-workspace", "invitations", "god-mode", "accounts", "api",
  "static", "_next",
]);

// L8 — paths matching this regex are dropped from the discovery set.
const LOGOUT_PATH_RE = /\/(logout|sign_out|signout)/i;

export type WaitStrategy = "load" | "domcontentloaded" | "commit";

export async function resolveStartUrl(
  page: Page,
  baseUrl: string,
  waitUntil: WaitStrategy = "domcontentloaded",
): Promise<string> {
  const expectedHost = new URL(baseUrl).hostname;
  await page.goto(baseUrl, { waitUntil, timeout: 30000 });

  const u = new URL(page.url());
  if (u.hostname !== expectedHost) {
    throw new Error(`Expected ${expectedHost}, landed on ${page.url()}`);
  }
  const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  if (first && RESERVED_PATH_SEGMENTS.has(first)) {
    throw new Error(
      `Start URL on reserved path "${first}" — user may have no default workspace: ${page.url()}`
    );
  }
  return page.url();
}

/**
 * Wait for the page to actually render anchor-based nav before discovery
 * runs. SurfSense (Next.js + SSE/zero-cache) frequently has `networkidle`
 * resolve while the page still shows a "Loading" status — hydration plants
 * the dashboard anchors a few hundred ms later. On slower CI runners this
 * race causes 0-link failures even though the page is healthy.
 *
 * Twenty's SPA streams sidebar anchors in batches: the first `<a>` attaches
 * within ~200ms (a table row link) while the main nav arrives ~1–2s later.
 * Returning at the first attach yields a partial set, so we additionally
 * wait for the anchor count to stop growing for ~1s.
 *
 * `requireLinks=false` apps (Penpot canvas-SPA) skip the wait so the
 * discovery runs immediately and self-skips downstream tests.
 */
export async function waitForAnchors(
  page: Page,
  opts: { requireLinks?: boolean; timeout?: number } = {}
): Promise<void> {
  if (opts.requireLinks === false) return;
  const overallTimeout = opts.timeout ?? 30_000;
  await page
    .locator("a[href]")
    .first()
    .waitFor({ state: "attached", timeout: overallTimeout })
    .catch(() => {});

  let lastCount = -1;
  let stableTicks = 0;
  await expect
    .poll(
      async () => {
        const count = await page.locator("a[href]").count();
        if (count === lastCount) {
          stableTicks += 1;
        } else {
          stableTicks = 0;
          lastCount = count;
        }
        return stableTicks;
      },
      {
        message: "anchor count should stop growing before link discovery",
        timeout: 5_000,
        intervals: [250],
      }
    )
    .toBeGreaterThanOrEqual(4)
    .catch(() => {});
}

export async function collectInternalHrefs(page: Page, host: string): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (anchors) =>
    anchors.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hrefs) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    if (url.hostname !== host) continue;
    if (LOGOUT_PATH_RE.test(url.pathname)) continue;
    // Hash semantics:
    //   "#"        → empty fragment (no destination)
    //   "#skip-nav" / "#main" / "#top" → in-page accessibility / fragment
    //                anchors. Hidden until focused; not real destinations.
    //   "#/foo"    → SPA hash route (Penpot et al). Keep.
    if (url.hash && !url.hash.startsWith("#/")) continue;

    // Hash matters for SPA routes — include in dedupe key so #/foo and
    // #/bar are treated as distinct destinations.
    const key = url.origin + url.pathname + url.search + url.hash;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export interface LinkCoverageOptions {
  appName: string;
  baseUrl: string;
  /** Register the click-coverage test (L7). Slow — one full reload per link. */
  includeClickTest?: boolean;
  /**
   * Apps that render their UI via canvas/SPA without `<a href>` (e.g. Penpot)
   * should set this to false. L1 still runs; L2–L7 self-skip with a clear
   * message when no anchors are discovered.
   */
  requireLinks?: boolean;
  /**
   * Override the URL used for link discovery. Some apps (e.g. Penpot) land
   * on a dashboard whose primary nav uses listitem/button click handlers
   * rather than `<a href>`, but expose anchor-based nav on a deeper page
   * (Penpot: `/#/settings/profile`). Defaults to `baseUrl`.
   */
  discoveryUrl?: string;
  /**
   * Page-load strategy. Use `"commit"` for SPAs that abort load during
   * client-side redirects. Avoid `networkidle`; persistent websockets and
   * polling make it a poor readiness signal for these apps.
   */
  waitUntil?: WaitStrategy;
}

// Throttle: real humans read each page before clicking the next link.
// Bursting through dozens of `goto`s in seconds trips per-user rate
// limits on app servers (Outline returns HTTP 429 to /search, /drafts,
// etc. when this suite runs at full speed). 500ms between visits keeps
// us well under a typical 60-120 req/min cap. On 429, back off harder
// and retry once — mirrors a human waiting and re-trying after a
// transient error.
const PAUSE_BETWEEN_LINKS_MS = 500;
const RATE_LIMIT_BACKOFF_MS = 5_000;

// Visit one internal link and report any failure (HTTP 4xx/5xx, auth-wall
// bounce, host hop, or 404 title). Returns null on success.
async function checkLink(
  page: Page,
  href: string,
  host: string,
  waitUntil: WaitStrategy
): Promise<{ url: string; reason: string } | null> {
  const tryGoto = async (): Promise<{ url: string; reason: string } | Response | null> => {
    try {
      return await page.goto(href, { waitUntil, timeout: 30000 });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { url: href, reason: `goto threw: ${message}` };
    }
  };

  let res = await tryGoto();
  if (res && "reason" in res) return res;
  if (!res) return null;

  // 429 recovery: pause and re-request once before treating as a hard
  // failure.
  if (res.status() === 429) {
    await delay(RATE_LIMIT_BACKOFF_MS);
    const retried = await tryGoto();
    if (retried && "reason" in retried) {
      return { url: href, reason: `goto threw after 429 backoff: ${retried.reason}` };
    }
    if (!retried) return null;
    res = retried;
  }

  const status = res.status();
  if (status >= 400) return { url: href, reason: `HTTP ${status}` };

  const landed = page.url();
  if (isAuthWall(landed)) return { url: href, reason: `bounced to auth wall: ${landed}` };
  if (new URL(landed).hostname !== host) {
    return { url: href, reason: `left ${host}, landed on ${landed}` };
  }
  const title = (await page.title()).toLowerCase();
  if (title.includes("404") || title.includes("not found")) {
    return { url: href, reason: `404 title: ${title}` };
  }
  return null;
}

// Some apps (notably SurfSense) ship a product tour that overlays the page and
// intercepts pointer events. Best-effort dismissal before discovery / clicks.
async function dismissTour(page: import("@playwright/test").Page): Promise<void> {
  const close = page
    .locator('button[aria-label*="close" i][aria-label*="tour" i]')
    .or(page.locator('button[aria-label*="dismiss" i]'))
    .or(page.getByRole("button", { name: /skip|close|got it|dismiss/i }))
    .first();
  if (await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 2000, force: true }).catch(() => {});
    await close.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
  }
}

export function registerLinkCoverage({
  appName,
  baseUrl,
  includeClickTest = true,
  requireLinks = true,
  discoveryUrl,
  waitUntil = "domcontentloaded",
}: LinkCoverageOptions): void {
  const HOST = new URL(baseUrl).hostname;
  const startUrl = discoveryUrl ?? baseUrl;
  // Iterating across many links pushes well past Playwright's 30s default.
  const SUITE_TIMEOUT = 180_000;

  test.describe(`${appName} — Link Coverage`, () => {
    // L1 + L2
    test("start page exposes at least one internal link", async ({ page }) => {
      test.setTimeout(SUITE_TIMEOUT);
      const start = await resolveStartUrl(page, startUrl, waitUntil);
      await dismissTour(page);
      await waitForAnchors(page, { requireLinks });
      const links = await collectInternalHrefs(page, HOST);
      console.log(`[${appName}] start=${start}`);
      console.log(`[${appName}] discovered ${links.length} links`);

      if (!requireLinks && links.length === 0) {
        console.log(
          `[${appName}] no anchors found — app uses canvas/SPA navigation; downstream link tests will self-skip.`
        );
        test.skip(true, `${appName}: no <a href> nav (requireLinks=false)`);
      }
      expect(
        links.length,
        `${appName}: expected internal links from ${start}`
      ).toBeGreaterThan(0);
    });

    // L3 + L4 + L5 + L6
    test("every internal link loads without auth wall or error", async ({ page }) => {
      test.setTimeout(SUITE_TIMEOUT);

      // Keep a small gap between L1 and this test to reduce bursty re-requests.
      await delay(process.env.CI ? 1200 : 600);

      await resolveStartUrl(page, startUrl, waitUntil);
      await dismissTour(page);
      await waitForAnchors(page, { requireLinks });
      const links = await collectInternalHrefs(page, HOST);

      if (!requireLinks && links.length === 0) {
        test.skip(true, `${appName}: no <a href> nav (requireLinks=false)`);
      }
      expect(links.length).toBeGreaterThan(0);

      const failures: { url: string; reason: string }[] = [];
      for (let i = 0; i < links.length; i++) {
        if (i > 0) await delay(PAUSE_BETWEEN_LINKS_MS);
        const fail = await checkLink(page, links[i]!, HOST, waitUntil);
        if (fail) failures.push(fail);
      }

      expect(
        failures,
        `${appName} broken links:\n${JSON.stringify(failures, null, 2)}`
      ).toEqual([]);
    });

    // L7
    if (includeClickTest) {
      test("clicking each visible link navigates within host", async ({ page }) => {
        test.setTimeout(SUITE_TIMEOUT);
        const start = await resolveStartUrl(page, startUrl, waitUntil);
        await dismissTour(page);
        await waitForAnchors(page, { requireLinks });
        const links = await collectInternalHrefs(page, HOST);

        if (!requireLinks && links.length === 0) {
          test.skip(true, `${appName}: no <a href> nav (requireLinks=false)`);
        }
        expect(links.length).toBeGreaterThan(0);

        const failures: { href: string; reason: string }[] = [];
        let clicked = 0;
        for (const href of links) {
          await page.goto(start, { waitUntil, timeout: 30000 });
          await dismissTour(page);
          await waitForAnchors(page, { requireLinks });

          // SPAs whose sidebar mutates by route (e.g. Twenty: Settings
          // sidebar only renders under /settings/*) won't re-render every
          // discovery-time anchor after the reset goto. Re-collect the
          // current page's anchors and skip any href that isn't present —
          // the link is real, just not reachable from this view. L3
          // already proved the href loads via direct `goto`.
          const present = new Set(await collectInternalHrefs(page, HOST));
          if (!present.has(href)) continue;

          const u = new URL(href);
          // Match the href as written in the DOM. SPAs with hash routing
          // (e.g. Penpot) write `href="#/dashboard/..."`; conventional apps
          // write `href="/foo?bar"`. Try the most-specific form first, fall
          // back to less-specific.
          const candidates = [
            `${u.pathname}${u.search}${u.hash}`,
            u.hash || `${u.pathname}${u.search}`,
            u.href,
          ].filter((v, i, a) => v && a.indexOf(v) === i);
          // Exclude target="_blank" — opens a new tab, doesn't navigate the
          // current page, so URL assertions below would be a false negative.
          const selector = candidates
            .map((v) => `a[href="${v.replace(/"/g, '\\"')}"]:not([target="_blank"])`)
            .join(", ");
          const link = page.locator(selector).first();
          if (!(await link.isVisible().catch(() => false))) continue;
          await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});

          await Promise.all([
            page
              .waitForLoadState(waitUntil === "commit" ? "domcontentloaded" : waitUntil, {
                timeout: 30000,
              })
              .catch(() => {}),
            // force: bypass tour overlays / animated chrome that intercept pointer events
            link.click({ timeout: 10000, force: true }).catch((e) => {
              failures.push({ href, reason: `click threw: ${e.message}` });
            }),
          ]);

          const landed = page.url();
          if (isAuthWall(landed)) {
            failures.push({ href, reason: `bounced to auth wall: ${landed}` });
          } else if (new URL(landed).hostname !== HOST) {
            failures.push({ href, reason: `left ${HOST}: ${landed}` });
          }
          clicked++;
        }

        expect(
          failures,
          `${appName} click failures:\n${JSON.stringify(failures, null, 2)}`
        ).toEqual([]);
        // Ensure the test wasn't a no-op: at least one discovered link
        // must have remained present on reset and been click-tested.
        expect(
          clicked,
          `${appName}: no discovered links were present on reset — L7 ran zero clicks`
        ).toBeGreaterThan(0);
      });
    }
  });
}
