import { test, expect } from "@playwright/test";
import { APPS, isAuthWall, AppName } from "../../constants";

// Verifies the `AUTH_TYPE=SSO` header-trust gate hides local
// login/register/forgot-password UI on every app. Cross-cutting product
// contract (not in the openspec — orthogonal coverage): the SPA must
// also hide local login/register/forgot-password UI when SSO is set.
//
// If local login UI is reachable in SSO mode, two regressions are
// possible:
//
//   1. A user who somehow lands on the local form may set a local
//      password that diverges from their Cognito identity — silently
//      forking the account.
//   2. The local password form is a credential-harvesting surface for
//      anyone who manages to inject a link to it (phishing). The whole
//      point of SSO mode is to remove it.
//
// Test shape: for each app, navigate to known local-auth routes. Expect:
// either a redirect to the IDP (no local form ever rendered) OR the
// resulting page has no reachable `<input type="password">`.

// Per-app local-auth routes that exist in the upstream codebase. Apps in
// SSO mode either redirect these to the IDP or render a stub page with
// no password input.
const LOCAL_AUTH_ROUTES: Record<AppName, string[]> = {
  PM: ["/sign-in", "/auth", "/accounts/sign-in"],
  Outline: ["/auth/email", "/login"],
  Penpot: ["/#/auth/login", "/#/auth/register", "/#/auth/recovery-request"],
  SurfSense: ["/login", "/auth/login"],
  Twenty: ["/sign-in", "/welcome"],
};

test.describe("AUTH_TYPE=SSO gate — local login/register UI must be hidden", () => {
  for (const app of APPS) {
    // Per-app gated by the LOCAL_AUTH_ROUTES table — a new app added to
    // APPS without a corresponding entry should fail loudly so coverage
    // cannot silently regress. Adding routes is documented in
    // skills.md §5 ("Adding a new app").
    const routes = LOCAL_AUTH_ROUTES[app.name] ?? [];
    if (routes.length === 0) {
      test(`${app.name}: LOCAL_AUTH_ROUTES must be configured`, async () => {
        throw new Error(
          `${app.name}: no LOCAL_AUTH_ROUTES configured. Add the app's local-auth paths to enforce the AUTH_TYPE=SSO local-login-hidden coverage.`
        );
      });
      continue;
    }
    for (const route of routes) {
      test(`${app.name} ${route}: no reachable password input`, async ({ page }) => {
        // Fresh context (no SSO cookie). If the app still bounces us to
        // the IDP, the SSO gate is doing its job at the routing layer.
        // If we stay on the app, the SPA must not render a password
        // form — the gate must be enforced at the UI layer too.
        const res = await page.goto(`${app.url}${route}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const landedUrl = page.url();
        const status = res?.status();

        // If we bounced to the IDP, the route is gated at routing — pass.
        if (isAuthWall(landedUrl)) return;

        // 404 is the dangerous quiet pass: the upstream renamed the
        // route, our test fixture rotted, and we'd be asserting "no
        // password input on a missing page" — trivially true and zero
        // signal. Fail loudly so the test fixture gets updated.
        if (status === 404) {
          throw new Error(
            `${app.name} ${route}: returned 404 — upstream likely renamed this route. Update LOCAL_AUTH_ROUTES (test fixture is stale, not a real regression).`
          );
        }

        // 401/403 with body still rendering is the other quiet-pass
        // case: a real local-login page that explicitly returns a
        // forbidden status. Rare in practice (SSO gates almost
        // always redirect via 302, caught by isAuthWall above), but
        // worth checking the DOM anyway in case the SPA renders
        // alongside the error status.
        //
        // 5xx on a known-route fixture is the same shape of bug as a
        // 404: the route was real when this test was written, the
        // deployment now returns server-error, and a bare `return`
        // would silently pass. Fail loudly so the regression
        // surfaces.
        if (status !== undefined && status >= 500) {
          throw new Error(
            `${app.name} ${route}: returned ${status} — upstream regression on a route this test fixture asserts exists. Either the route is broken (real bug) or it's been removed and the fixture needs updating.`
          );
        }

        // Give SPAs a chance to hydrate the credential form if one exists.
        await page
          .locator('input[type="password"]')
          .first()
          .waitFor({ state: "attached", timeout: 4000 })
          .catch(() => {});

        // (1) No password input element.
        const passwordInputs = await page
          .locator('input[type="password"]')
          .count();
        expect(
          passwordInputs,
          `${app.name} ${route}: rendered ${passwordInputs} password input(s) at ${landedUrl} — SSO mode must hide local login UI (AUTH_TYPE=SSO product contract). The SPA is exposing a credential-entry surface.`
        ).toBe(0);

        // (2) No visible local-login affordance.
        //
        // Intentionally NARROW: matches text that's unambiguously
        // local-credential UI (`forgot password`, `reset password`,
        // `sign in with password`, `continue with email`). Bare
        // "Sign in" / "Log in" buttons are NOT matched, because the
        // SSO redirect page itself renders one (clicking it starts
        // the IDP flow). Broadening here would false-positive on the
        // legitimate auth entry surface.
        //
        // Consequence: a SPA that renders a local-login form with no
        // "Forgot password" / "Continue with email" affordances
        // escapes this check. The `input[type=password]` check above
        // is the stronger signal; this regex is a low-FP backstop.
        const LOCAL_AUTH_TEXT_RE =
          /(sign\s*in|log\s*in)\s*with\s*password|forgot\s*password|reset\s*password|continue\s*with\s*email/i;
        const localAuthText = await page
          .getByText(LOCAL_AUTH_TEXT_RE)
          .filter({ visible: true })
          .count();
        expect(
          localAuthText,
          `${app.name} ${route}: visible local-login affordance text at ${landedUrl} — SSO mode must hide local-login UI even when no <input type=password> is present.`
        ).toBe(0);
      });
    }
  }
});
