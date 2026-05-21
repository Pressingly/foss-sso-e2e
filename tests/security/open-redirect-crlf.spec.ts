// Spec coverage for this file (see docs/spec-coverage.md):
// (no openspec requirement — orthogonal OWASP A03 (injection)-aligned coverage)

import { test, expect, request } from "@playwright/test";
import { APPS } from "../../constants";

// Response-splitting via the `rd=` redirect parameter.
//
// The existing tests/security/open-redirect.spec.ts probes host
// validation: `rd=https://attacker.com`, `rd=//attacker.com`, etc.
// This spec is the SECOND attack class: even when host validation
// is correct, if oauth2-proxy reflects the rd= value into a redirect
// header without sanitising CRLF, an attacker can split the response
// and inject arbitrary headers (Set-Cookie, Location, etc.).
//
// Payload class: CRLF-encoded variants of `Set-Cookie: attacker=1`
// embedded in rd=. We send the payload via `/oauth2/sign_in?rd=...`
// (the canonical redirect surface) and assert the response does
// NOT contain an injected Set-Cookie. Modern oauth2-proxy versions
// reject these, but a regression in URL-decoding ordering could
// re-introduce the class.

const CRLF_PAYLOADS = [
  // URL-encoded CRLF + Set-Cookie injection
  "https://example.com/%0d%0aSet-Cookie:%20injected=1",
  // %0a only (some parsers normalise %0a → \n but not \r\n)
  "https://example.com/%0aSet-Cookie:%20injected=1",
  // Double-encoded — defeats one round of decoding if the proxy
  // re-decodes before validation
  "https://example.com/%250d%250aSet-Cookie:%20injected=1",
  // Mixed-case CRLF + uppercase header name (catches naive
  // case-sensitive blocklists)
  "https://example.com/%0D%0ASet-Cookie:%20INJECTED=1",
];

test.describe("Open redirect — CRLF injection in rd= must not split response", () => {
  for (const app of APPS) {
    for (const payload of CRLF_PAYLOADS) {
      test(`${app.name}: rd=${payload.slice(0, 60)}... — no Set-Cookie injection`, async () => {
        const ctx = await request.newContext();
        try {
          const url = `${app.url}/oauth2/sign_in?rd=${payload}`;
          const res = await ctx.fetch(url, {
            method: "GET",
            maxRedirects: 0,
            timeout: 15_000,
          });

          // Read every Set-Cookie header — there may be more than one
          // (oauth2-proxy sets its CSRF nonce + the legit ones).
          const headersArray = await res.headersArray();
          const setCookies = headersArray
            .filter((h) => h.name.toLowerCase() === "set-cookie")
            .map((h) => h.value);

          const injected = setCookies.find((c) => /injected/i.test(c));
          expect(
            injected,
            `${app.name}: response carries an injected Set-Cookie via CRLF in rd=. Payload: ${payload}\nAll Set-Cookies: ${setCookies.join("\n")}`
          ).toBeUndefined();

          // Same check on Location header — an attacker could split
          // and inject a different Location too.
          const location = res.headers()["location"] ?? "";
          expect(
            /injected/i.test(location),
            `${app.name}: response Location header contains injected payload. Location: ${location}`
          ).toBe(false);
        } finally {
          await ctx.dispose();
        }
      });
    }
  }
});
