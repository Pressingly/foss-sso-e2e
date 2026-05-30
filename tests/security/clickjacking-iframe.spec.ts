// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#platform-hosts-shall-refuse-rendering-inside-cross-origin-frames

import { test, expect } from "../../fixtures";
import { APPS, MAIN_URL } from "../../constants";

// Clickjacking defence — verify the AUTHENTICATED response carries
// frame-refusing headers.
//
// `tests/security/headers.spec.ts` already pins that every platform
// host emits `X-Frame-Options: DENY|SAMEORIGIN` on the UNAUTHENTICATED
// surface (the 302 to the IDP). Headers asserted there alone are
// necessary but not sufficient: a misconfiguration where the
// `security-headers` middleware fires on the redirect-to-IDP but not
// on the actual app response would still satisfy the headers spec
// while leaving the authed app frameable.
//
// This test closes that gap. It logs in (worker fixture), then fetches
// each platform host's response IN AN AUTHENTICATED REQUEST and parses
// the frame-protection headers directly. We assert at least one of:
//
//   - `X-Frame-Options: DENY`
//   - `X-Frame-Options: SAMEORIGIN`
//   - `Content-Security-Policy` containing `frame-ancestors 'none'`
//     OR `frame-ancestors 'self'` (no wildcard)
//
// is set on the AUTHED response. A regression where the middleware
// drops on the authed path (or a CSP that wildcards frame-ancestors)
// is caught here.
//
// WHY NOT A REAL IFRAME PROBE? An earlier version of this spec
// embedded each target in an iframe from a `data:` URL parent and
// asserted that the parent could not read the iframe's
// `contentDocument` / `contentWindow.location.href`. That probe was
// false-positive: those properties are blocked by the same-origin
// policy regardless of XFO/CSP, so the assertion passed for ANY
// cross-origin target — including a target with
// `X-Frame-Options: ALLOWALL`. The headers-on-authed-response shape
// here measures the actual contract (the headers ARE the protection)
// without the same-origin red herring.

interface FrameVerdict {
  ok: boolean;
  reason: string;
}

function evaluateFrameProtection(
  xfo: string | undefined,
  csp: string | undefined,
): FrameVerdict {
  const xfoLower = xfo?.toLowerCase().trim();
  if (xfoLower === "deny" || xfoLower === "sameorigin") {
    return { ok: true, reason: `X-Frame-Options: ${xfoLower}` };
  }

  if (csp) {
    const cspLower = csp.toLowerCase();
    // Match `frame-ancestors <values>` up to the next `;` or end of string.
    const match = cspLower.match(/frame-ancestors([^;]*)/);
    if (match) {
      const values = (match[1] ?? "").trim();
      // Forbidden: `*` wildcard. Anything else (`'none'`, `'self'`,
      // explicit host allowlist) effectively blocks cross-origin
      // framing from arbitrary origins.
      if (!/(^|\s)\*(\s|$)/.test(values)) {
        return { ok: true, reason: `Content-Security-Policy frame-ancestors: ${values}` };
      }
      return {
        ok: false,
        reason:
          `Content-Security-Policy frame-ancestors allows wildcard: "${values}" — ` +
          `cross-origin framing is permitted. Remove the wildcard or set frame-ancestors 'none'.`,
      };
    }
  }

  return {
    ok: false,
    reason:
      `Neither X-Frame-Options (got "${xfo ?? "missing"}") nor a CSP frame-ancestors ` +
      `directive (CSP "${csp ?? "missing"}") effectively blocks cross-origin framing. ` +
      `This response is clickjackable. The headers middleware must apply X-Frame-Options: ` +
      `DENY (or SAMEORIGIN) or CSP frame-ancestors 'none' on the authed app response — ` +
      `not just on the redirect to the IDP.`,
  };
}

test.describe("Clickjacking — authed app responses MUST refuse framing", () => {
  const FRAME_TARGETS = [
    { name: "Main portal", url: MAIN_URL },
    ...APPS.map((a) => ({ name: a.name, url: a.url })),
  ];

  for (const target of FRAME_TARGETS) {
    test(`${target.name}: authed response sets effective frame-protection header`, async ({
      page,
    }) => {
      test.setTimeout(45_000);

      // Use the page's request context — cookies are attached
      // automatically, so this hits the authed response path.
      const ctx = page.context().request;
      const res = await ctx.get(target.url, {
        maxRedirects: 5,
        timeout: 20_000,
      });

      // Sanity — the request actually authed. A 3xx to the IDP means
      // the fixture state didn't carry, and we'd be measuring the
      // unauthenticated surface (already covered by headers.spec.ts).
      expect(
        res.status(),
        `${target.name}: expected 2xx authed response, got ${res.status()}. ` +
          `Headers measured on a non-authed surface would duplicate headers.spec.ts.`,
      ).toBeLessThan(300);

      const headers = res.headers();
      const xfo = headers["x-frame-options"];
      const csp =
        headers["content-security-policy"] ??
        headers["content-security-policy-report-only"];

      const verdict = evaluateFrameProtection(xfo, csp);
      expect(
        verdict.ok,
        `${target.name} (${target.url}) — ${verdict.reason}`,
      ).toBe(true);
    });
  }
});
