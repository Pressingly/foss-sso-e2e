// Shared spoofed-header set used by every test that probes the
// strip-auth-headers / mpass-auth chain. Kept in one place so the
// "what would an attacker forge" set stays consistent across
// `header-spoofing.spec.ts` (the live strip test) and
// `strip-on-bypass.spec.ts` (router-reachability smoke that attaches
// the same headers as forward-compat documentation).

export const SPOOFED_HEADERS: Record<string, string> = {
  "X-Auth-Request-Email": "attacker@evil.example",
  "X-Auth-Request-User": "attacker",
  "X-Auth-Request-Preferred-Username": "attacker",
  "X-Forwarded-Email": "attacker@evil.example",
  "X-Forwarded-User": "attacker",
};
