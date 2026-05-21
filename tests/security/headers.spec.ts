import { test, expect, request } from "@playwright/test";
import { APPS, MAIN_URL, AUTH_PROXY_DOMAIN, APP_URLS } from "../../constants";

// HTTP security headers contract. These are set by the `security-headers`
// Traefik middleware on every `*-secure` router (foss-server-bundle
// docker-compose.yml). The middleware fires BEFORE mpass-auth, so headers
// are present on both authed responses and the 302 redirect to the IDP —
// no login is needed to verify them.
//
// Spec references:
//   HSTS:           RFC 6797
//   X-Content-Type: https://owasp.org/www-project-secure-headers/
//   Frame-Options:  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
//   Referrer:       https://www.w3.org/TR/referrer-policy/
//   Permissions:    https://w3c.github.io/webappsec-permissions-policy/

interface HeaderRule {
  name: string;
  // Predicate runs in lower-case-string mode. Header is normalised by the
  // checker before being passed in.
  matches: (value: string) => boolean;
  why: string;
}

const HEADER_RULES: HeaderRule[] = [
  {
    name: "strict-transport-security",
    matches: (v) =>
      /max-age=\d+/.test(v) &&
      Number(v.match(/max-age=(\d+)/)?.[1] ?? "0") >= 15552000 && // ≥ 180 days
      v.includes("includesubdomains"),
    why: "HSTS must include max-age ≥ 6 months and includeSubdomains to protect every foss-* host",
  },
  {
    name: "x-content-type-options",
    matches: (v) => v === "nosniff",
    why: "Blocks MIME-sniffing-driven XSS; must be exactly 'nosniff'",
  },
  {
    name: "x-frame-options",
    matches: (v) => v === "deny" || v === "sameorigin",
    why: "Clickjacking defence; DENY or SAMEORIGIN required",
  },
  {
    name: "referrer-policy",
    matches: (v) =>
      [
        "no-referrer",
        "no-referrer-when-downgrade",
        "same-origin",
        "strict-origin",
        "strict-origin-when-cross-origin",
      ].includes(v),
    why: "Must not leak full URLs (no `unsafe-url` / `origin`-only) to third parties",
  },
  {
    name: "permissions-policy",
    matches: (v) =>
      // Require sensitive APIs to be denied by default. Other
      // values may follow.
      ["camera", "microphone", "geolocation"].every((feature) =>
        new RegExp(`${feature}\\s*=\\s*\\(\\s*\\)`).test(v)
      ),
    why: "Sensitive APIs (camera, microphone, geolocation) must be disallowed by default",
  },
];

async function fetchHeaders(url: string): Promise<Record<string, string>> {
  const ctx = await request.newContext({ ignoreHTTPSErrors: false });
  try {
    // maxRedirects: 0 — we want the immediate response from the FOSS host,
    // not the headers from a downstream IDP page.
    const res = await ctx.get(url, { maxRedirects: 0 });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers())) {
      headers[k.toLowerCase()] = String(v).toLowerCase();
    }
    return headers;
  } finally {
    await ctx.dispose();
  }
}

test.describe("Security headers", () => {
  // Targets covered by the `*-secure` catch-all router on each host.
  // These responses come from the security-headers middleware in the
  // primary mpass-auth chain.
  const SECURE_TARGETS = [
    { name: "Main portal", url: MAIN_URL },
    ...APPS.map((a) => ({ name: a.name, url: a.url })),
  ];

  // Targets covered by routers that LIVE OUTSIDE the `*-secure` chain.
  // The 2026-05 production rollout (foss-server-bundle#30) added the
  // same `security-headers` middleware to every bypass + SSO-surface
  // router. Headers are per-response, not host-cached — a browser
  // checks `X-Frame-Options` on the specific response it's framing, so
  // setting XFO on `plane-secure` does NOT protect `/god-mode` (served
  // by `plane-bypass`). One test per router type proves the rollout
  // landed.
  const NON_SECURE_TARGETS = [
    {
      name: "Plane /god-mode (plane-bypass)",
      url: `${APP_URLS.PM}/god-mode`,
    },
    {
      name: "auth-proxy /oauth2/sign_in (oauth2-proxy-secure)",
      url: `https://${AUTH_PROXY_DOMAIN}/oauth2/sign_in`,
    },
    {
      name: "Outline /favicon.ico (outline-bypass static)",
      url: `${APP_URLS.Outline}/favicon.ico`,
    },
    // `oauth2-apps` router: oauth2-proxy serves `/oauth2/*` on every
    // app host (same process, different host binding). The targets
    // below verify that the `security-headers` middleware fires for
    // every host binding — not that each app emits headers
    // independently (it doesn't; oauth2-proxy handles all of them).
    ...APPS.map((a) => ({
      name: `${a.name} /oauth2/sign_in (oauth2-apps)`,
      url: `${a.url}/oauth2/sign_in`,
    })),
  ];

  for (const target of [...SECURE_TARGETS, ...NON_SECURE_TARGETS]) {
    test(`${target.name} sets the canonical security headers`, async () => {
      const headers = await fetchHeaders(target.url);
      const failures: string[] = [];

      for (const rule of HEADER_RULES) {
        const value = headers[rule.name];
        if (value === undefined) {
          failures.push(`${rule.name}: missing — ${rule.why}`);
          continue;
        }
        if (!rule.matches(value)) {
          failures.push(`${rule.name}: "${value}" does not satisfy contract — ${rule.why}`);
        }
      }

      expect(
        failures,
        `${target.name} (${target.url}) header violations:\n${failures.join("\n")}`
      ).toEqual([]);
    });
  }
});
