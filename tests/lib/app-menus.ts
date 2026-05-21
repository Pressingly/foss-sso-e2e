// Per-app menu helpers — encapsulates the per-app UI choreography
// needed to reach controls that live behind dropdowns/avatars/popovers.
//
// Today this file only exposes `openLogoutMenu`. Add more helpers here
// when other tests need similar per-app menu navigation.
//
// Selectors picked for stability:
//   - Penpot uses clean `data-testid` attributes and they're load-bearing.
//   - Outline / SurfSense / Plane use Radix / Headless-UI auto-generated
//     IDs (e.g. `radix-3`, `headlessui-menu-button-:r6:`) that rotate
//     between renders — so we target structural / accessible-name
//     locators instead.
//   - Twenty surfaces Logout inside /settings/profile (not in a popover);
//     the helper navigates there first.

import { Locator, Page, expect } from "@playwright/test";
import { AppName } from "../../constants";

// Each helper opens whatever menu/page contains the Logout control and
// returns a Locator the caller can click. The caller is responsible for
// the assertions around the click (network listener, cookie diff, etc).
export const openLogoutMenu: Record<AppName, (page: Page) => Promise<Locator>> = {
  // Outline — the workspace switcher at top-left of the sidebar opens a
  // popover containing "Log out". The trigger is a Radix button with
  // an auto-generated ID; we filter by visible inner text (which is
  // workspace-avatar-initial + workspace name, e.g. "OOutline").
  // getByRole({ name: }) was unreliable here — the computed accessible
  // name didn't expose "Outline". hasText reads inner text directly.
  Outline: async (page) => {
    await page
      .locator("button")
      .filter({ hasText: /outline/i })
      .first()
      .click({ timeout: 10_000 });
    const logout = page.getByText(/^log\s*out$/i).last();
    await logout.waitFor({ state: "visible", timeout: 5_000 });
    return logout;
  },

  // Plane — top-right user-menu trigger is the rightmost icon-sized
  // button in the topbar. Plane's SPA renders this avatar with a
  // notification badge ("1" for the numeric Cognito sub user); it's
  // ~32px square. There are non-icon items in the same area
  // ("Star us on GitHub", search box) but the width filter excludes
  // them. We don't rely on `headlessui-menu-button-` ID prefix because
  // Plane upgrades Headless UI versions periodically.
  PM: async (page) => {
    // Collect ALL icon-sized buttons in the topbar (y<80, 20<=w<=50),
    // sorted right-to-left. The user-menu avatar is the rightmost in
    // most Plane layouts, but the topbar also has notification /
    // GitHub-star / help icons of similar shape — if the rightmost
    // opens an unrelated menu we try the next-rightmost, and so on.
    const findTopbarIconButtons = async (): Promise<Locator[]> => {
      const allButtons = await page.locator("button").all();
      const candidates: { locator: Locator; x: number }[] = [];
      for (const b of allButtons) {
        const box = await b.boundingBox().catch(() => null);
        if (!box) continue;
        if (box.y > 80) continue;
        if (box.width > 50 || box.width < 20) continue;
        candidates.push({ locator: b, x: box.x });
      }
      candidates.sort((a, b) => b.x - a.x); // rightmost first
      return candidates.map((c) => c.locator);
    };

    let triggers: Locator[] = [];
    await expect
      .poll(
        async () => {
          triggers = await findTopbarIconButtons();
          return triggers.length > 0;
        },
        {
          message: "Plane: no icon-sized button at top-right of header — SPA may not have hydrated",
          timeout: 15_000,
        }
      )
      .toBe(true);

    // Try each candidate trigger: click, wait briefly, check if "Sign
    // out" appeared. If not, press Escape (close any popover) and try
    // the next. Stops at the first that reveals Sign out.
    const logout = page
      .getByRole("button", { name: /sign\s*out/i })
      .or(page.getByText(/^sign\s*out$/i))
      .first();
    let lastError: unknown;
    for (let i = 0; i < triggers.length; i++) {
      try {
        await triggers[i]!.click({ timeout: 10_000 });
        await logout.waitFor({ state: "visible", timeout: 4_000 });
        return logout;
      } catch (e) {
        lastError = e;
        await page.keyboard.press("Escape").catch(() => {});
        await logout.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => {});
      }
    }
    throw new Error(
      `Plane: tried ${triggers.length} top-right icon button(s); none revealed "Sign out". Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  },

  // Penpot — cleanest case. Both trigger and logout use data-testids.
  Penpot: async (page) => {
    const profile = page.locator('[data-testid="profile-btn"]');
    await expect(profile, "Penpot profile button should render before opening logout menu").toBeVisible({
      timeout: 30_000,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await profile.click({ timeout: 5_000 });
        break;
      } catch (e) {
        if (attempt === 1) throw e;
        const continueButton = page
          .getByRole("button", { name: /continue/i })
          .or(page.locator("button").filter({ hasText: /continue/i }))
          .last();
        await continueButton.click({ timeout: 5_000, force: true });
        await page.locator('[class*="modal-overlay"], .relnotes').first()
          .waitFor({ state: "hidden", timeout: 5_000 })
          .catch(() => {});
      }
    }
    const logout = page.locator('[data-testid="logout-profile-opt"]');
    await logout.waitFor({ state: "visible", timeout: 5_000 });
    return logout;
  },

  // SurfSense — bottom-of-sidebar user-info row. The text content
  // includes the synthesised Cognito email (numeric@askii.ai). Filter
  // buttons by hasText regex to find the row, click it, then Radix
  // renders a role=menuitem Logout after ~1s animation.
  SurfSense: async (page) => {
    await page
      .locator("button")
      .filter({ hasText: /\d{5,}@/ })
      .first()
      .click({ timeout: 10_000 });
    const logout = page.getByRole("menuitem", { name: /^logout$/i });
    await logout.waitFor({ state: "visible", timeout: 10_000 });
    return logout;
  },

  // Twenty — Logout lives inside /settings/profile. Twenty's SPA
  // tends to route a hard page.goto back to the user's last view, so
  // we click the in-app Settings nav item (id is stable:
  // `nav-item-settings`) and let the SPA navigate. Logout then
  // renders as a span/menuitem inside the settings sidebar — wrap it
  // in `.locator('..')` to click the actual interactive parent.
  Twenty: async (page) => {
    await page
      .locator("#nav-item-settings")
      .click({ timeout: 10_000 });
    await page.waitForURL(/\/settings/, { timeout: 15_000 });
    // The logout text is a <span> inside a clickable nav item; the span
    // isn't itself clickable. Walk up to the nearest clickable ancestor.
    const logout = page.getByText(/^logout$/i).first();
    await logout.waitFor({ state: "visible", timeout: 10_000 });
    return logout.locator("xpath=ancestor-or-self::*[self::button or self::a or @role='button' or @role='menuitem'][1]");
  },
};
