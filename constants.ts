// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------
// Single source of truth: FOSS_BASE_URL (the main portal). Everything else
// — per-app hosts, ForwardAuth host, cookie domain — is derived from it
// using the FOSS naming convention:
//
//   FOSS_BASE_URL           = https://foss.<domain>
//   ForwardAuth host        = auth.foss.<domain>
//   Outline (Docs)          = https://docs.foss.<domain>
//   Plane (PM)              = https://pm.foss.<domain>
//   Penpot (Design)         = https://design.foss.<domain>
//   SurfSense (Research)    = https://research.foss.<domain>
//   Twenty (CRM)            = https://twenty.foss.<domain>
//   Cookie domain           = foss.<domain>     (i.e. MAIN_URL hostname)
//
// Pointing the suite at a different deployment is a one-line .env change:
//   FOSS_BASE_URL=https://foss.example.com
//
// IDP hosts (Cognito + mPass) genuinely differ between deployments and are
// kept as separate env vars (FOSS_COGNITO_DOMAIN, FOSS_MPASS_DOMAIN).
// ---------------------------------------------------------------------------

const env = (key: string, fallback: string): string => {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : fallback;
};

const csv = (key: string, fallback: string): string[] =>
  env(key, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Hosts (derived from MAIN_URL)
// ---------------------------------------------------------------------------

export const MAIN_URL = env("FOSS_BASE_URL", "https://foss.arbisoft.com");

// Platform domain == the MAIN_URL hostname itself. Per-app hosts are
// nested as `<app>.foss.<domain>` (e.g. docs.foss.arbisoft.com), and the
// SSO cookie is scoped to this domain so it's shared across every app
// subdomain but does NOT leak to sibling subdomains of <domain>.
const PLATFORM_DOMAIN = new URL(MAIN_URL).hostname;

const SCHEME = new URL(MAIN_URL).protocol; // "https:" usually

const sub = (prefix: string): string => `${SCHEME}//${prefix}.${PLATFORM_DOMAIN}`;

export const AUTH_PROXY_DOMAIN = `auth.${PLATFORM_DOMAIN}`;
export const COOKIE_DOMAIN     = PLATFORM_DOMAIN;

export const COOKIE_DOMAIN_REGEX = new RegExp(
  `\\.?${COOKIE_DOMAIN.replace(/\./g, "\\.")}$`
);

export const AUTH_COOKIE = env("FOSS_AUTH_COOKIE", "_oauth2_proxy");

// IDPs vary by deployment — sandbox uses mPass on pressingly.net, prod will
// likely use a different mPass host. Cognito domain is generic AWS infra.
export const COGNITO_DOMAIN   = env("FOSS_COGNITO_DOMAIN", "amazoncognito.com");
export const MPASS_IDP_DOMAIN = env("FOSS_MPASS_DOMAIN",   "moneta-auth.sandbox.pressingly.net");

export const IDP_HOSTS = csv(
  "FOSS_IDP_HOSTS",
  `${COGNITO_DOMAIN},${MPASS_IDP_DOMAIN}`
);

// ---------------------------------------------------------------------------
// Apps (derived from PLATFORM_DOMAIN)
// ---------------------------------------------------------------------------

export const APP_URLS = {
  Outline:   sub("docs"),
  PM:        sub("pm"),
  Penpot:    sub("design"),
  SurfSense: sub("research"),
  Twenty:    sub("twenty"),
} as const;

export type AppName = keyof typeof APP_URLS;

export const APPS: ReadonlyArray<{ name: AppName; url: string }> =
  (Object.entries(APP_URLS) as [AppName, string][]).map(([name, url]) => ({
    name,
    url,
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAuthWall(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    const isHostOrSubdomain = (candidate: string): boolean =>
      host === candidate || host.endsWith(`.${candidate}`);
    return isHostOrSubdomain(AUTH_PROXY_DOMAIN) || IDP_HOSTS.some((h) => isHostOrSubdomain(h));
  } catch {
    return false;
  }
}

// Escape a hostname for safe interpolation into a RegExp. Used by per-app
// tests that build host-matching regexes — replaces the
// `host.replace(/\./g, "\\.")` pattern that was duplicated across 8+ specs.
export function escapeHostForRegex(hostname: string): string {
  return hostname.replace(/\./g, "\\.");
}

// Identity-domain suffix synthesised onto Cognito bare-username `sub`
// claims by per-app middleware. Tests that match `<digits>@<domain>`
// for User A / User B identities read this rather than hard-coding the
// suffix in each file.
export const COGNITO_EMAIL_DOMAIN = env("FOSS_COGNITO_EMAIL_DOMAIN", "askii.ai");

// Per-deployment workspace / team / search-space IDs. Hoisted here so
// switching deployments is a single env-file change rather than a
// per-spec hunt.
export const PENPOT_TEAM_ID =
  env("PENPOT_TEAM_ID", "c16a7502-dcf5-8188-8007-f336e4292883");
export const PLANE_WORKSPACE_SLUG =
  env("PLANE_ADMIN_WORKSPACE_SLUG", "fossarbisoft");
export const SURFSENSE_SEARCH_SPACE_ID =
  env("SURFSENSE_SEARCH_SPACE_ID", "1");

// Regex matching any IDP host (escaped). Used by login flow to detect the IDP step.
export const IDP_REGEX = new RegExp(
  IDP_HOSTS.map(escapeHostForRegex).join("|")
);

// Regex matching any FOSS app host or main portal — the post-login domains.
// Built from MAIN_URL + APP_URLS so it stays in sync.
export const FOSS_HOST_REGEX = (() => {
  const hosts = [MAIN_URL, ...Object.values(APP_URLS)].map((u) => new URL(u).hostname);
  const escaped = [...new Set(hosts)].map(escapeHostForRegex);
  return new RegExp(`^https://(${escaped.join("|")})`);
})();
