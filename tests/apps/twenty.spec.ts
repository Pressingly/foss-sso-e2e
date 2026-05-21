import { APP_URLS } from "../../constants";
import { registerLinkCoverage } from "../lib/link-coverage";

// Twenty keeps a GraphQL-subscriptions websocket open after login, so the
// page never reaches `networkidle`. Its root also performs a client-side
// redirect on first paint, which races `load` / `domcontentloaded` and
// aborts the in-flight nav (ERR_ABORTED). `commit` resolves as soon as
// response headers arrive — before any client redirect can interrupt —
// and `waitForAnchors` covers the post-hydration delay. L7 re-collects
// anchors after each reset goto and silently skips ones no longer
// rendered, since Twenty's sidebar mutates by route.
registerLinkCoverage({
  appName: "Twenty (CRM)",
  baseUrl: APP_URLS.Twenty,
  waitUntil: "commit",
});
