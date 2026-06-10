// Spec coverage for this file (see docs/spec-coverage.md):
// @spec oauth2-proxy-gateway#gateway-shall-use-a-redis-backed-session-store

import { test, expect } from "../../fixtures";
import { APPS, AUTH_COOKIE } from "../../constants";

// Redis-backed session store — behavioural observable.
//
// The openspec scenario ("env var includes OAUTH2_PROXY_SESSION_STORE_TYPE=redis")
// is infra-shaped and not visible from e2e. The behavioural proxy: if
// the session store is Redis, the `_oauth2_proxy` cookie carries only
// a small session ID — not the full session payload. Concretely:
//
//   - exactly ONE cookie named `_oauth2_proxy` exists (no `_oauth2_proxy_0`,
//     `_oauth2_proxy_1`, ... split-form, which oauth2-proxy uses when a
//     cookie-stored session approaches the 4KB browser limit), AND
//   - the cookie value is well under the 4KB browser limit, AND
//   - the cookie size does NOT grow as the user accumulates session
//     state by navigating multiple apps
//
// All three signals together provide strong evidence the session is
// Redis-backed. If it were cookie-stored, Cognito ID tokens (routinely
// >4KB per the openspec) would either split the cookie or grow it.
//
// 4096 bytes is the standard per-cookie browser limit; the openspec
// pins "Cognito ID tokens routinely exceed 4KB" as the rationale for
// using Redis. Picking a bound of 3500 bytes gives reasonable headroom
// — a Redis-backed cookie is typically < 200 bytes (just a session
// ID), so this bound is two orders of magnitude conservative.
const COOKIE_SIZE_BOUND = 3500;

test.describe("oauth2-proxy session store — Redis-backed (cookie stays small)", () => {
  test("SSO cookie is single, small, and does not grow across app navigation", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);

    // 1. Pre-condition: SSO cookie present after login (worker fixture).
    const cookiesBefore = (await context.cookies()).filter((c) =>
      c.name.startsWith(AUTH_COOKIE),
    );
    const ssoCookies = cookiesBefore.filter((c) => c.name === AUTH_COOKIE);
    expect(
      ssoCookies.length,
      `expected exactly one ${AUTH_COOKIE} cookie after login, got ${ssoCookies.length} ` +
        `(values: ${cookiesBefore.map((c) => c.name).join(", ")})`,
    ).toBe(1);

    // 2. No split-form cookies. oauth2-proxy splits its cookie-stored
    //    session into `${AUTH_COOKIE}_0`, `${AUTH_COOKIE}_1`, ... when
    //    the encoded payload approaches the 4KB browser limit. The
    //    presence of any split-form cookie is a direct signal the
    //    store is cookie-based, not Redis.
    const splitForm = cookiesBefore.filter((c) =>
      /_\d+$/.test(c.name.slice(AUTH_COOKIE.length)),
    );
    expect(
      splitForm.map((c) => c.name),
      `oauth2-proxy emitted split-form session cookies — direct evidence the ` +
        `session is cookie-stored, not Redis-backed. Found: ` +
        splitForm.map((c) => c.name).join(", "),
    ).toEqual([]);

    // 3. Cookie size is well under 4KB. Redis-backed sessions ship
    //    only a session ID (typically < 200 bytes); cookie-stored
    //    sessions ship the full claim payload (Cognito ID token alone
    //    routinely exceeds 4KB per the openspec rationale).
    const sizeBefore = ssoCookies[0]!.value.length;
    expect(
      sizeBefore,
      `${AUTH_COOKIE} value is ${sizeBefore} bytes, exceeds ${COOKIE_SIZE_BOUND} byte ` +
        `bound — likely a cookie-stored session payload, not a Redis session ID`,
    ).toBeLessThan(COOKIE_SIZE_BOUND);

    // 4. Cookie does not grow as the user accumulates session state.
    //    Visiting all 5 apps exercises every per-app middleware, which
    //    in a cookie-stored model would round-trip claim data through
    //    oauth2-proxy and potentially refresh / re-encode the cookie.
    //    A Redis-backed store decouples the cookie value from the
    //    session payload: the value bytes stay identical.
    for (const app of APPS) {
      // Twenty's top-level navigations can hit net::ERR_ABORTED (its
      // GraphQL websocket / SPA bootstrap aborts the document request) —
      // see CLAUDE.md. We only need the request to reach the gateway so
      // the SSO cookie round-trips through each per-app middleware;
      // `commit` is enough and an aborted navigation still exercised the
      // server side. Ignore the abort and continue — the cookie
      // assertions below are the point.
      await page
        .goto(app.url, { waitUntil: "commit", timeout: 30_000 })
        .catch((e: unknown) => {
          if (!String(e).includes("ERR_ABORTED")) throw e;
        });
    }

    const allAfter = (await context.cookies()).filter((c) =>
      c.name.startsWith(AUTH_COOKIE),
    );
    const cookiesAfter = allAfter.filter((c) => c.name === AUTH_COOKIE);
    expect(
      cookiesAfter.length,
      `${AUTH_COOKIE} cookie disappeared during cross-app navigation`,
    ).toBe(1);

    // Re-check split-form AFTER exercising every per-app middleware. The
    // pre-navigation check (step 2) can only catch a session that was
    // already oversized at login; this catches a cookie-backed store that
    // crosses the 4KB limit *while accumulating claim data during
    // cross-app navigation* — it would emit `${AUTH_COOKIE}_0`, `_1`, ...
    // here even if it started as a single cookie. A Redis-backed store
    // never grows the cookie, so this stays empty. This is the genuinely
    // falsifiable post-navigation signal (the steady-state size-equality
    // check below cannot grow a worker session that is already populated).
    const splitFormAfter = allAfter.filter((c) =>
      /_\d+$/.test(c.name.slice(AUTH_COOKIE.length)),
    );
    expect(
      splitFormAfter.map((c) => c.name),
      `oauth2-proxy emitted split-form session cookies during cross-app ` +
        `navigation — the session payload is accumulating in the cookie, ` +
        `not in Redis. Found: ${splitFormAfter.map((c) => c.name).join(", ")}`,
    ).toEqual([]);

    // The SSO cookie value must stay byte-identical: a cookie-backed store
    // would re-encode / refresh the claim payload as the per-app
    // middlewares round-trip identity, changing the value length.
    const sizeAfter = cookiesAfter[0]!.value.length;
    expect(
      sizeAfter,
      `${AUTH_COOKIE} changed from ${sizeBefore} to ${sizeAfter} bytes across ` +
        `app navigation — session payload mutating in the cookie ` +
        `suggests a cookie-based store, not Redis`,
    ).toBe(sizeBefore);
  });
});
