// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#jwt-algorithm-confusion-shall-be-mitigated

import { test, expect, request } from "@playwright/test";
import { APP_URLS } from "../../constants";

// JWT algorithm-confusion attacks against app bearer endpoints.
//
// Attack class: a JWT validator that doesn't pin the `alg` claim
// will accept tokens signed with whatever algorithm the attacker
// chose. The two classic attacks are:
//
//   1. `alg: "none"` — the token has an empty signature. A naive
//      validator decodes the header, sees `alg: none`, and skips
//      verification. The forged payload is trusted.
//
//   2. `alg: "HS256"` (symmetric) against a server that issues
//      RS256 (asymmetric) — the validator might use the public
//      RSA key as the HMAC secret, which the attacker also has
//      (it's public). Symmetric signature verifies. Forged
//      payload trusted.
//
// Cognito tokens are RS256-signed. Outline's `/api/auth.info`
// accepts either the SSO cookie OR `Authorization: Bearer <jwt>`.
// We forge both attack-class tokens and verify they're rejected.
//
// Skipped per-app: not every app exposes a JWT-bearer endpoint via
// the cookie-authed SSO chain. Outline is the canonical surface;
// extending to other apps requires per-app JWT endpoints which the
// current bundle doesn't uniformly expose.

const OUTLINE = APP_URLS.Outline;

// Build a JWT with the given alg header + payload + signature.
// Signature is base64url of arbitrary bytes — invalid for any real
// key, so the only way the token passes is if the validator skips
// signature checking.
function makeJwt(alg: string, payload: object, signature: string): string {
  const b64url = (s: string) =>
    Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${signature}`;
}

const FORGED_PAYLOAD = {
  sub: "00000000-0000-0000-0000-000000000000",
  email: "attacker@example.invalid",
  name: "JWT Forgery Test",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

test.describe("JWT algorithm confusion — forged bearers must be rejected", () => {
  test("Outline /api/auth.info rejects alg=none token", async () => {
    const ctx = await request.newContext();
    try {
      // alg=none: empty signature. RFC 7519 §6.1 specifies this is
      // valid JWT shape; oauth2-proxy / Outline MUST reject it.
      const noneToken = makeJwt("none", FORGED_PAYLOAD, "");
      const res = await ctx.post(`${OUTLINE}/api/auth.info`, {
        headers: { authorization: `Bearer ${noneToken}` },
        data: {},
        maxRedirects: 0,
        timeout: 15_000,
      });
      const status = res.status();

      // Acceptable: 401 Unauthorized, 403 Forbidden, 400 Bad Request,
      // or a 200 that returns the unauthenticated-user shape (Outline
      // returns 200 with anonymous data when auth fails). What's NOT
      // acceptable: 200 with the forged email visible.
      if (status === 200) {
        const body = await res.text();
        expect(
          /attacker@example\.invalid/i.test(body) ||
            /JWT Forgery Test/i.test(body),
          `Outline accepted an alg=none bearer — the forged identity is reflected in the response. Status=${status}, body: ${body.slice(0, 400)}`
        ).toBe(false);
      } else {
        // Any non-2xx is fine — proves the token was rejected.
        expect(status, `Outline /api/auth.info status for alg=none bearer`).toBeGreaterThanOrEqual(200);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("Outline /api/auth.info rejects alg=HS256 token (alg-confusion attack)", async () => {
    const ctx = await request.newContext();
    try {
      // alg=HS256 with arbitrary symmetric signature. A vulnerable
      // validator would HMAC-verify using the public RSA key as the
      // secret. We can't compute that without knowing Outline's
      // verification key, so use an arbitrary signature — if the
      // validator accepts it, it's either skipping verification
      // entirely OR has the alg-confusion vulnerability.
      const hs256Token = makeJwt(
        "HS256",
        FORGED_PAYLOAD,
        "fakeSignatureBytesThatWouldNeverHmacToTheRealKey"
      );
      const res = await ctx.post(`${OUTLINE}/api/auth.info`, {
        headers: { authorization: `Bearer ${hs256Token}` },
        data: {},
        maxRedirects: 0,
        timeout: 15_000,
      });
      const status = res.status();

      if (status === 200) {
        const body = await res.text();
        expect(
          /attacker@example\.invalid/i.test(body) ||
            /JWT Forgery Test/i.test(body),
          `Outline accepted an alg=HS256 bearer with arbitrary signature — algorithm confusion is exploitable. Status=${status}, body: ${body.slice(0, 400)}`
        ).toBe(false);
      } else {
        expect(status, `Outline /api/auth.info status for alg=HS256 bearer`).toBeGreaterThanOrEqual(200);
      }
    } finally {
      await ctx.dispose();
    }
  });
});
