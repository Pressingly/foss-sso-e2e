// Spec coverage for this file (see docs/spec-coverage.md):
// @spec security-hardening#sso-entry-points-shall-ignore-spoofed-host-headers

import { test, expect } from "@playwright/test";
import { MAIN_URL, AUTH_PROXY_DOMAIN, COOKIE_DOMAIN, APPS } from "../../constants";

// Host-header injection at SSO entry points.
//
// Classic attack — adapted to OIDC chains:
//
//   GET /oauth2/sign_in HTTP/1.1
//   Host: attacker.example
//
//   ...and the server uses the attacker-supplied Host to build:
//     - the Location: header on a 302 redirect to the IDP
//     - the `redirect_uri` query param in the IDP URL
//     - a Set-Cookie: Domain=attacker.example
//     - an absolute URL inside the response body
//
//   Any of those would let an attacker craft a link to the legitimate
//   SSO entry that ends up sending the user (or the user's eventual
//   auth code) to attacker.example. Variants of this are how
//   password-reset poisoning works against OIDC IdPs.
//
// Defence: every entry-point response — Location header, body, and
// Set-Cookie — MUST refer ONLY to the canonical platform hosts derived
// from the bundle's configured domain, regardless of the inbound Host
// header.
//
// Method: hit each SSO entry point with a custom Host header pointing
// at a known-malicious value (`attacker.example`). Verify:
//
//   - Response Location header (if any) does NOT contain
//     `attacker.example` anywhere
//   - Response body does NOT echo `attacker.example` as part of a URL
//     (defends against open-redirect/SSRF chains seeded via Host)
//   - Set-Cookie Domain (if any) does NOT contain `attacker.example`
//   - Status code is anything sane — 200/302/400/421 are all fine;
//     5xx would indicate a parse failure, which is a different bug
//     class (DoS) tested elsewhere
//
// NOTE on transport: Node's `http.request` lets you set the Host
// header explicitly while connecting to the real platform IP. That's
// the only way to send a spoofed Host without DNS games. The
// Playwright `request` API drops custom Host headers by default
// (security feature); we use a low-level node:https request instead.

import https from "node:https";
import { randomBytes } from "node:crypto";

// Randomized attacker hostname per probe — a unique nonce in the
// hostname makes any in-body / in-header match provably from the
// inbound Host (rather than a coincidence with static body content
// like a documentation example or a copyright string). Use
// `.invalid` (RFC 2606 reserved TLD) so a leaked DNS lookup never
// hits a real server.
function newAttackerHost(): string {
  return `attacker-${randomBytes(6).toString("hex")}.invalid`;
}

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ProbeResult {
  status: number;
  location: string | undefined;
  body: string;
  setCookies: string[];
}

function probe(url: string, spoofedHost: string): Promise<ProbeResult> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Host: spoofedHost, "User-Agent": "foss-sso-e2e/host-probe" },
        // We DO NOT validate that the cert matches the spoofed Host —
        // the server doesn't get to pick which cert it returns based
        // on a header. The TLS handshake uses SNI = real hostname.
        servername: u.hostname,
      },
      (res) => {
        let body = "";
        let finished = false;
        const finish = () => {
          if (finished) {
            return;
          }
          finished = true;
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === "string"
              ? res.headers.location
              : undefined,
            body,
            setCookies: Array.isArray(res.headers["set-cookie"])
              ? res.headers["set-cookie"]
              : [],
          });
        };
        res.on("data", (chunk) => {
          body += chunk.toString("utf8");
          // Cap the body read — Location-header attacks don't need
          // the whole document, and a malicious upstream could ship
          // gigabytes. 100KB is more than enough for any redirect
          // landing page or error body.
          if (body.length > 100_000) {
            res.destroy();
          }
        });
        res.once("end", finish);
        res.once("close", finish);
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error("host-header-probe: request timeout"));
    });
    req.end();
  });
}

test.describe("Host header injection — SSO entry points MUST ignore spoofed Host", () => {
  const TARGETS = [
    {
      name: "Main portal landing",
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
    test(`${target.name} ignores spoofed Host header`, async () => {
      test.setTimeout(45_000);

      const attackerHost = newAttackerHost();
      const result = await probe(target.url, attackerHost);
      const violations: string[] = [];

      // 1. (Load-bearing) Positive Location-header assertion. If the
      //    response carries a 3xx Location, it MUST point at the
      //    configured platform domain — NOT the attacker host, and not
      //    any arbitrary external host the request didn't ask for. A
      //    relative path (no scheme) is also acceptable. This catches
      //    the broad class of "redirect URL built from request.Host"
      //    bugs even when the attacker host doesn't appear verbatim
      //    (e.g. the host portion is rewritten / templated).
      if (result.location !== undefined) {
        const isRelative = !/^https?:\/\//i.test(result.location);
        const allowedHostRegex = new RegExp(
          `^https://(?:${escapeRegExpLiteral(COOKIE_DOMAIN)}|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${escapeRegExpLiteral(COOKIE_DOMAIN)})(/|$|\\?)`,
          "i",
        );
        const allowed = isRelative || allowedHostRegex.test(result.location);
        if (!allowed) {
          violations.push(
            `Location header points off-platform: "${result.location}". ` +
              `Authorised origins for a Location from these entry points are ` +
              `https://*.${COOKIE_DOMAIN}/ or a relative path. A redirect URL built ` +
              `from request.Host (or from inbound input) is an open-redirect surface — ` +
              `build it from configured ${COOKIE_DOMAIN} / static config instead.`,
          );
        }
      }

      // 2. Defence-in-depth — explicit attacker-host reflection check.
      //    Belt-and-braces against (1) for servers that quietly echo
      //    the Host in headers or body without using it for redirects.
      if (result.location && result.location.includes(attackerHost)) {
        violations.push(
          `Location header reflects attacker Host: "${result.location}".`,
        );
      }

      // 3. Response body must not echo attacker host as a URL.
      //    Randomised hostname per probe guarantees any match is from
      //    THIS request, not background body content.
      if (result.body.includes(attackerHost)) {
        violations.push(
          `Response body echoes attacker Host. Snippet around reflection: ` +
            `"${result.body.slice(
              Math.max(0, result.body.indexOf(attackerHost) - 60),
              result.body.indexOf(attackerHost) + attackerHost.length + 60,
            )}". ` +
            `This is an open-redirect/SSRF seed — a meta refresh or form action ` +
            `built from the inbound Host can be triggered without any JS execution.`,
        );
      }

      // 4. Set-Cookie Domain must not be attacker host. Cookies issued
      //    with `Domain=<attacker>` would not actually be sent back to
      //    the foss host (the cookie is parked at the wrong origin),
      //    but the bug shape itself indicates the bundle's cookie
      //    configuration is reading Host instead of the configured
      //    COOKIE_DOMAIN — a permanent foot-gun.
      for (const sc of result.setCookies) {
        const domainMatch = sc.match(/domain\s*=\s*([^;]+)/i);
        const domain = domainMatch?.[1]?.trim().toLowerCase();
        if (domain && domain.includes(attackerHost)) {
          violations.push(
            `Set-Cookie issued with attacker Domain: "${sc}". ` +
              `Cookie Domain MUST be derived from configured ${COOKIE_DOMAIN}, ` +
              `not from the inbound Host header.`,
          );
        }
      }

      // 4. (Health) — no 5xx. A 5xx on Host injection often means
      //    the upstream hit an unhandled parse error; that's a
      //    secondary concern but also worth flagging because it can
      //    be a DoS vector.
      expect(
        result.status,
        `${target.name}: probe returned ${result.status} (expected anything < 500). ` +
          `A 5xx on Host injection usually means the upstream is crashing on a parse, ` +
          `which is itself a DoS surface. Either way, it's a regression worth fixing.`,
      ).toBeLessThan(500);

      expect(
        violations,
        `${target.name} reflected the attacker-supplied Host header. Violations:\n` +
          violations.map((v) => `  - ${v}`).join("\n"),
      ).toEqual([]);
    });
  }
});
