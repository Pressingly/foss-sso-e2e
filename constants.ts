// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------
// Single source of truth: FOSS_BASE_URL (the main portal). Everything else
// -- per-app hosts, ForwardAuth host, cookie domain -- is derived from it.
//
// Two host topologies are supported via FOSS_HOST_TOPOLOGY:
//
//   nested (default):
//     FOSS_BASE_URL           = https://foss.<domain>
//     ForwardAuth host        = auth.foss.<domain>
//     Outline (Docs)          = https://docs.foss.<domain>
//     Plane (PM)              = https://pm.foss.<domain>
//     Penpot (Design)         = https://design.foss.<domain>
//     SurfSense (Research)    = https://research.foss.<domain>
//     Twenty (CRM)            = https://twenty.foss.<domain>
//     Cookie domain           = foss.<domain>
//
//   peer:
//     FOSS_BASE_URL           = https://foss.<smb-domain>
//     ForwardAuth host        = auth.<smb-domain>
//     Outline (Docs)          = https://docs.<smb-domain>
//     Plane (PM)              = https://pm.<smb-domain>
//     Penpot (Design)         = https://design.<smb-domain>
//     SurfSense (Research)    = https://research.<smb-domain>
//     Twenty (CRM)            = https://twenty.<smb-domain>
//     Cookie domain           = <smb-domain>
//
// Example peer deployment:
//   FOSS_BASE_URL=https://foss.platform.askii.ai
//   FOSS_HOST_TOPOLOGY=peer
//   => docs.platform.askii.ai, pm.platform.askii.ai, auth.platform.askii.ai
//
// Pointing the suite at a different deployment is still an env-only change.
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
// Speculative — no current deployment uses peer mode. The branch lives
// here so that when one does, it works out of the box. See issue #42
// for the "validate against a real deployment or remove" tracker.
const HOST_TOPOLOGY = env("FOSS_HOST_TOPOLOGY", "nested");
const USE_PEER_TOPOLOGY = HOST_TOPOLOGY === "peer";

// Platform domain == the MAIN_URL hostname itself.
// For nested topology, app hosts are `<app>.<MAIN_HOST>`.
// For peer topology, app hosts are `<app>.<SMB_DOMAIN>`, where SMB_DOMAIN is
// MAIN_HOST without the leading `foss.` label when present.
const PLATFORM_DOMAIN = new URL(MAIN_URL).hostname;
const SMB_DOMAIN = PLATFORM_DOMAIN.startsWith("foss.")
  ? PLATFORM_DOMAIN.slice("foss.".length)
  : PLATFORM_DOMAIN;

const SCHEME = new URL(MAIN_URL).protocol; // "https:" usually

const sub = (prefix: string): string => {
  const base = USE_PEER_TOPOLOGY ? SMB_DOMAIN : PLATFORM_DOMAIN;
  return `${SCHEME}//${prefix}.${base}`;
};

export const AUTH_PROXY_DOMAIN = USE_PEER_TOPOLOGY
  ? `auth.${SMB_DOMAIN}`
  : `auth.${PLATFORM_DOMAIN}`;
export const COOKIE_DOMAIN = USE_PEER_TOPOLOGY ? SMB_DOMAIN : PLATFORM_DOMAIN;

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

// Reverse-lookup an AppName from a baseUrl (e.g. APP_URLS.Twenty →
// "Twenty"). Used by lib helpers that take a baseUrl but need the
// canonical AppName key — e.g. registerLinkCoverage gating on
// `appHealth[<AppName>]`.
const URL_TO_APP_NAME = Object.fromEntries(
  (Object.entries(APP_URLS) as [AppName, string][]).map(([name, url]) => [url, name]),
) as Record<string, AppName>;

export function appNameForBaseUrl(baseUrl: string): AppName | undefined {
  return URL_TO_APP_NAME[baseUrl];
}

// Identity-domain suffix synthesised onto Cognito bare-username `sub`
// claims by per-app middleware. Tests that match `<digits>@<domain>`
// for User A / User B identities read this rather than hard-coding the
// suffix in each file.
export const COGNITO_EMAIL_DOMAIN = env("FOSS_COGNITO_EMAIL_DOMAIN", "askii.ai");

// ---------------------------------------------------------------------------
// Bundle convention parameters (foss-server-bundle PR #46 + #55)
// ---------------------------------------------------------------------------
//
// The bundle provisions one workspace per app, all named by a single env
// var `SMB_DEFAULT_WORKSPACE_NAME` (which itself defaults to `SMB_NAME` —
// the tenant slug). That value drives:
//   - Plane workspace slug
//   - Outline team subdomain
//   - Penpot team name
//   - SurfSense search-space name
//   - Twenty workspace subdomain
//
// Per-app role contract:
//   - `SYSTEM_BOT_EMAIL` (default `system-bot@<PLATFORM_DOMAIN>`) is the
//     bootstrap Admin of the shared workspace in each app.
//   - Other Cognito users join as the app's regular-member role.
//   - To promote an additional user, the bundle's bootstrap commands
//     (`workspace:bootstrap-sso-admin --email <email>`, etc.) must be
//     run with that user's email — this is NOT automatic.
//
// On the live sandbox these defaults track the actually-configured state
// (workspace name = `fossarbisoft`; bot = `system-bot@foss.arbisoft.com`).
// When switching to a different deployment, override either via .env or
// the upstream bundle's own env vars.
export const SMB_DEFAULT_WORKSPACE_NAME = env(
  "SMB_DEFAULT_WORKSPACE_NAME",
  "fossarbisoft",
);

// Optional. Set if a test needs to assert "the bot is the canonical
// Admin" or to drive an admin-only flow without bootstrapping FOSS_USER.
// Most existing admin tests don't need it — they test against each
// user's own-team admin scope, where FOSS_USER IS the Admin/Owner. Use
// this only for tests that pin the bundle's bot-Admin contract directly.
export const SYSTEM_BOT_EMAIL =
  env("SYSTEM_BOT_EMAIL", "system-bot@foss.arbisoft.com");

// Per-deployment workspace / team / search-space IDs. Hoisted here so
// switching deployments is a single env-file change rather than a
// per-spec hunt.
//
// Defaults reflect the **live sandbox state** as observed via direct
// API probes against `https://foss.arbisoft.com`. FOSS_USER's role
// per app on this deployment:
//
//   • Plane    — Member of `fossarbisoft` (role=15), Admin of `aa` (20)
//   • Outline  — workspace admin (`users.role = 'admin'`),
//                team UUID 1a2e0bad-3c60-40a5-92b5-98b6b71c3316
//   • Penpot   — Owner of personal "Default" team (UUID c16a7502-…);
//                only Editor in the SMB `fossarbisoft` team (fd5a0f56-…)
//   • SurfSense — search space id 1 (the auto-provisioned space)
//
// foss-server-bundle PR #63 added SMB-workspace admin promotion
// (scripts/provision-admin/*), but on this sandbox those scripts have
// not been run with FOSS_USER's email — so FOSS_USER's role hasn't
// been promoted in the SMB scope. Constants here track what FOSS_USER
// actually owns/can-admin today.
//
// When SMB provisioning is run with FOSS_USER's email, update the
// defaults below (or set env overrides) to point at the SMB team IDs
// instead. Adjacent test specs (outline-admin, penpot-admin, etc.)
// will pass against either configuration so long as the IDs match
// the live role state.
export const PENPOT_TEAM_ID =
  env("PENPOT_TEAM_ID", "c16a7502-dcf5-8188-8007-f336e4292883");
// Plane's shared workspace slug. Defaults to SMB_DEFAULT_WORKSPACE_NAME
// (the bundle convention from foss-server-bundle PR #46) — set
// PLANE_ADMIN_WORKSPACE_SLUG to override when the deployment uses a
// different value for Plane specifically.
export const PLANE_WORKSPACE_SLUG =
  env("PLANE_ADMIN_WORKSPACE_SLUG", SMB_DEFAULT_WORKSPACE_NAME);
export const PLANE_WORKSPACE_ID =
  env("PLANE_WORKSPACE_ID", "aab50fd3-d056-486e-9656-8ffb2f3e5996");
export const OUTLINE_TEAM_ID =
  env("OUTLINE_TEAM_ID", "1a2e0bad-3c60-40a5-92b5-98b6b71c3316");
export const SURFSENSE_SEARCH_SPACE_ID =
  env("SURFSENSE_SEARCH_SPACE_ID", "1");

// A workspace FOSS_USER is in but NORMAL_USER is NOT — used by
// workspace-membership-isolation tests (NORMAL_USER must not see
// FOSS_USER's other workspaces). On the sandbox FOSS_USER is Admin
// of `aa` while NORMAL_USER has no membership there; the contract
// is that NORMAL_USER's UI / API access to `aa` is refused.
export const FOSS_USER_PRIVATE_WORKSPACE_SLUG =
  env("FOSS_USER_PRIVATE_WORKSPACE_SLUG", "aa");

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
