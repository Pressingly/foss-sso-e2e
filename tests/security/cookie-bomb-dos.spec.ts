// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#sso-chain-shall-fail-closed-under-oversized-request-headers

import { test, expect, request as pwRequest } from "@playwright/test";
import { MAIN_URL, AUTH_PROXY_DOMAIN, APPS } from "../../constants";

// Cookie-bomb / header-bomb DoS at SSO entry.
//
// Attack: an attacker who can set a cookie on the COOKIE_DOMAIN (e.g.,
// via a vulnerable subdomain XSS, or by hosting a sibling-domain page
// the user visits) can inflate the Cookie: header on every subsequent
// request to the platform. The worst failure mode here is:
//
//   5xx storm — oauth2-proxy / Traefik returns 500 because some
//   buffer overflows or panics; the user can't log in at all until
//   they clear cookies. Same-browser DoS for the victim. Worse, an
//   unauthenticated remote can trigger this on any victim with an
//   in-scope cookie write.
//
// Defence: the entry points MUST return a clean 4xx (typically 431
// "Request Header Fields Too Large", or 400 "Bad Request") OR close
// the connection at the transport layer, and MUST NOT 5xx. The
// specific header byte limit is the bundle's call (8KB, 16KB, 32KB
// are all defensible) — what we pin is the failure shape:
//
//   - 4xx / connection-close → ✅ fail-closed (the contract)
//   - 5xx                    → ❌ parser crash, contract violated
//
// EXPLICITLY OUT OF SCOPE — header truncation / authz bypass.
// Some servers, instead of crashing or 4xx-ing, silently truncate
// oversized headers and let the request proceed. If a truncation
// happened to drop the real `_oauth2_proxy` cookie while leaving the
// rest of the request intact, an attacker-controlled bomb could in
// principle mask a header for an authz bypass. Proving the bundle is
// immune from black-box e2e requires either (a) knowing the bundle's
// exact header limits ahead of time, or (b) probing the response
// shape post-truncation in a way that distinguishes "I dropped your
// real cookie" from "I ignored the bomb." Neither is reliable across
// bundle reconfigurations. The 5xx fail-closed shape pinned here is
// the load-bearing contract; truncation-bypass needs an upstream-
// side audit (verify `large_client_header_buffers` / `largeRequestSizeLimit`
// values directly) rather than a probe from outside.
//
// Why we don't just trust oauth2-proxy / Traefik defaults: ingress
// configs differ. Production bundles set their own Nginx/Traefik
// `large_client_header_buffers` / `largeRequestSizeLimit`, and a
// regression in those values would silently downgrade the
// fail-closed contract. The test catches it.
//
// We use Playwright's `request` API so the test is portable across
// environments. The header sizes here are chosen to exceed typical
// 8KB defaults but stay well under any sane upper bound (1MB+).

// 32KB of cookie value — bigger than oauth2-proxy default 8KB
// `cookie-domains` slot and bigger than Nginx default
// `large_client_header_buffers 4 8k`. Anything bigger than this and
// the test gets noisy without testing more contract.
const BOMB_SIZE = 32 * 1024;
const BOMB_VALUE = "A".repeat(BOMB_SIZE);
const BOMB_COOKIE = `bomb_${"x".repeat(8)}=${BOMB_VALUE}`;

test.describe("Cookie / header bomb — SSO chain MUST fail closed, not 5xx", () => {
  const TARGETS = [
    {
      name: "Main portal",
      url: MAIN_URL,
    },
    {
      name: "oauth2-proxy /oauth2/sign_in",
      url: `https://${AUTH_PROXY_DOMAIN}/oauth2/sign_in`,
    },
    ...APPS.map((a) => ({
      name: `${a.name} /oauth2/sign_in`,
      url: `${a.url}/oauth2/sign_in`,
    })),
  ];

  for (const target of TARGETS) {
    test(`${target.name}: ${BOMB_SIZE / 1024}KB oversized Cookie returns 4xx, not 5xx`, async () => {
      test.setTimeout(60_000);

      const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: false });
      try {
        let status: number;
        try {
          const res = await ctx.get(target.url, {
            headers: { Cookie: BOMB_COOKIE },
            maxRedirects: 0,
            timeout: 30_000,
          });
          status = res.status();
        } catch (err) {
          // A connection-reset / parser-rejection without an HTTP
          // status counts as fail-closed: the chain refused the
          // request before processing the oversized header. That's
          // the desired behaviour for Nginx defaults (which close
          // the connection at the parser).
          //
          // The shape we WANT to detect is "the chain returned a
          // 5xx HTTP response", which requires an actual response
          // object. An exception means no HTTP response was sent
          // = closed at the transport layer = fail-closed.
          const msg = (err as Error).message ?? "";
          // ECONNRESET / socket hang up: classic Nginx fail-closed.
          if (
            /ECONNRESET|socket hang up|connection closed|aborted/i.test(msg)
          ) {
            // Acceptable. Skip the status assertion path.
            return;
          }
          // Any other error (DNS, cert, suite infra) re-throws so
          // the test reports the real underlying issue instead of
          // pretending the contract holds.
          throw err;
        }

        // The contract for an HTTP response path: 4xx only. The
        // chain must fail closed with an explicit rejection (400 /
        // 413 / 431), or close the connection (handled in the catch
        // path above). Any 2xx/3xx means the oversized header was
        // still processed instead of being rejected.
        expect(
          status,
          `${target.name}: oversized Cookie produced HTTP ${status}. ` +
            `The chain MUST fail closed with 4xx (or connection-close) under oversized ` +
            `request headers. Verify Nginx / Traefik / oauth2-proxy header limits and ` +
            `that overflow is rejected rather than processed.`,
        ).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);
      } finally {
        await ctx.dispose();
      }
    });
  }
});
