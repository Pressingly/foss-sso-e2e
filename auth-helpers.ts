import { Page, Locator, expect } from "@playwright/test";
import { MAIN_URL, IDP_REGEX, FOSS_HOST_REGEX } from "./constants";

async function firstVisibleLocator(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) {
      return loc;
    }
  }
  return null;
}

export async function cognitoLogin(
  page: Page,
  opts?: { user?: string; pass?: string; skipInitialNav?: boolean }
): Promise<void> {
  const user = String(opts?.user ?? process.env.FOSS_USER ?? "");
  const pass = String(opts?.pass ?? process.env.FOSS_PASS ?? "");
  if (!user || !pass) {
    throw new Error(
      "cognitoLogin: provide {user, pass} or set FOSS_USER + FOSS_PASS in env"
    );
  }

  // skipInitialNav=true is for callers that have already navigated to a
  // deep URL and want the SSO chain to preserve it (deep-link-preservation
  // test). Default false matches all existing callers.
  if (!opts?.skipInitialNav) {
    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });
  }

  if (!IDP_REGEX.test(page.url())) {
    const loginCta = page
      .getByRole("button", { name: /(log\s*in|sign\s*in)/i })
      .or(page.getByRole("link", { name: /(log\s*in|sign\s*in)/i }))
      .first();
    await loginCta.click({ timeout: 10000 }).catch(() => {});
  }

  await page.waitForURL(IDP_REGEX, { timeout: 45000 });

  const passwordChooser = page.getByRole("button", { name: /(password login|username and password)/i });
  if (await passwordChooser.count()) {
    await passwordChooser.first().click();
  }

  const userInput =
    (await firstVisibleLocator(page, [
      'input[name="username"]',
      'input[name="mpassNumber"]',
      'input[autocomplete="username"]',
      'input[placeholder*="username" i]',
      'input[placeholder*="mPass" i]',
      'input[type="email"]',
    ])) ?? page.locator('input[type="text"]').first();
  await expect(userInput).toBeVisible({ timeout: 30000 });
  await userInput.fill(user);
  await expect(userInput, "username field should retain the supplied login value").toHaveValue(user);

  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  await expect(passInput).toBeVisible({ timeout: 10000 });
  await passInput.fill(pass);
  await expect(passInput, "password field should retain the supplied login value").toHaveValue(pass);

  await page.getByRole("button", { name: /^(login|sign in|submit)$/i }).first().click();

  // waitForURL is the navigation gate — no need to also wait for
  // networkidle (apps like Twenty keep websockets open and never reach it).
  await page.waitForURL(FOSS_HOST_REGEX, { timeout: 45000 });
}
