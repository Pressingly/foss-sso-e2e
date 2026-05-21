import { test, expect } from "../../fixtures";
import { APP_URLS, isAuthWall } from "../../constants";

const BASE = APP_URLS.Penpot;
const PENPOT_HOST = new URL(BASE).hostname;

// Penpot's UI uses listitem/button click handlers (not <a href>) for nav,
// so the generic anchor-based link-coverage factory doesn't apply. Instead,
// exercise the well-known hash routes directly: each must stay on the
// Penpot host without bouncing through the auth wall, and resolve to a
// non-error page.
const HASH_ROUTES = [
  "/#/dashboard/recent",
  "/#/dashboard/projects",
  "/#/dashboard/drafts",
  "/#/settings/profile",
  "/#/settings/password",
  "/#/settings/notifications",
];

test.describe("Penpot (Design)", () => {
  test("page title carries Penpot branding", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await expect(page).toHaveTitle(/penpot/i);
  });

  test("every well-known hash route loads on Penpot host without auth wall", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const failures: { route: string; reason: string }[] = [];

    for (const route of HASH_ROUTES) {
      const url = `${BASE}${route}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      const landed = page.url();
      if (isAuthWall(landed)) {
        failures.push({ route, reason: `auth wall: ${landed}` });
        continue;
      }
      if (new URL(landed).hostname !== PENPOT_HOST) {
        failures.push({ route, reason: `left ${PENPOT_HOST}: ${landed}` });
        continue;
      }
      // Hash routes change the URL fragment, not pathname. Verify the route
      // is reflected in `landed` (browser keeps the requested hash unless
      // Penpot redirects it).
      const hash = route.split("#")[1] ?? "";
      if (hash && !landed.includes(hash.split("?")[0]!)) {
        failures.push({ route, reason: `hash route not reflected in landed URL: ${landed}` });
        continue;
      }

      const title = (await page.title()).toLowerCase();
      if (title.includes("404") || title.includes("not found")) {
        failures.push({ route, reason: `404 title: ${title}` });
      }
    }

    expect(
      failures,
      `Penpot hash-route failures:\n${JSON.stringify(failures, null, 2)}`
    ).toEqual([]);
  });
});
