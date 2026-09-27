import { test, expect, describe } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * `src/index.ts` is the only boot path, and three things it does are invisible
 * to every other test in this directory: it publishes the auth policy, and it
 * mounts the two middlewares in an order that matters. All three fail SILENTLY
 * and in the fail-OPEN direction, which is why they are pinned by reading the
 * file rather than left to be noticed.
 *
 * A source-text assertion is a blunt instrument and is used here for the same
 * reason `e2e/ports.test.ts` uses one: the alternative is booting the real
 * process, which needs a database, every bot token and a free port.
 */
const INDEX = "src/index.ts";

describe("src/index.ts wiring", () => {
  test("setAuthPolicy is called, and before any route is built", async () => {
    // The policy default is `off`. A call placed after `createDashboardRoutes`
    // would leave a window in which a wildcard CORS header and a cross-user
    // `scope='shared'` memory read are both still live on an authenticating
    // instance.
    const text = await readFile(INDEX, "utf8");
    const policyAt = text.indexOf("setAuthPolicy(auth, config.dashboardPort)");
    const resolveAt = text.indexOf("resolveAuthConfig()");
    const routesAt = text.indexOf("createDashboardRoutes(config)");
    expect(policyAt, "src/index.ts must call setAuthPolicy(auth, config.dashboardPort)").toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(routesAt).toBeGreaterThan(-1);
    expect(policyAt).toBeGreaterThan(resolveAt);
    expect(policyAt).toBeLessThan(routesAt);
  });

  test("the three middlewares are mounted in order: auth, origin, zones", async () => {
    // Order decides which answer a caller gets, and each step is a different
    // refusal: 401 by identity (you are not logged in), then 403 by origin
    // (this side effect did not come from a page of mine), then 403 by role
    // (you are not an operator). Zones LAST because a request with no identity
    // has no role, so a zone check in front would answer 403 where the honest
    // answer is 401.
    const text = await readFile(INDEX, "utf8");
    const auth = text.indexOf("createAuthMiddleware(auth, introspector)");
    const origin = text.indexOf("createOriginMiddleware(auth.allowedOrigins, config.dashboardPort)");
    const zones = text.indexOf("createZoneMiddleware(auth)");
    expect(auth).toBeGreaterThan(-1);
    expect(origin, "src/index.ts must mount createOriginMiddleware").toBeGreaterThan(-1);
    expect(zones, "src/index.ts must mount createZoneMiddleware").toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(auth);
    expect(zones).toBeGreaterThan(origin);
  });

  test("the zone middleware is on the TOP-LEVEL app, before both app.route calls", async () => {
    // Mounted inside `createDashboardRoutes` it would miss the `/chat` sub-app
    // entirely — i.e. the one surface the user zone is written around — and
    // Hono matches in registration order, so a `use` after a `route` never runs
    // for those routes.
    const text = await readFile(INDEX, "utf8");
    const zones = text.indexOf("createZoneMiddleware(auth)");
    const firstRoute = text.indexOf("app.route(");
    expect(firstRoute).toBeGreaterThan(-1);
    expect(zones).toBeLessThan(firstRoute);
  });

  test("auth and zones mount only in an authenticating mode; off mounts the origin guard alone", async () => {
    // With auth off there is no identity, so no auth or zone middleware — but
    // the origin guard IS mounted, in its `off` shape, or any page the user
    // visits can POST to localhost:3010. The else branch must hold exactly it,
    // before the first `app.route`.
    const text = await readFile(INDEX, "utf8");
    const branch = text.match(/if \(isAuthenticatingMode\(auth\.mode\)\) \{[\s\S]*?\n\} else \{([\s\S]*?)\n\}/);
    expect(branch, "the isAuthenticatingMode if/else was not found").not.toBeNull();
    const authBranch = branch![0].slice(0, branch![0].indexOf("\n} else {"));
    expect(authBranch).toContain("createAuthMiddleware(auth, introspector)");
    expect(authBranch).toContain("createOriginMiddleware(auth.allowedOrigins, config.dashboardPort)");
    expect(authBranch).toContain("createZoneMiddleware(auth)");
    const offBranch = branch![1]!;
    expect(offBranch).toContain(`app.use("*", createOriginMiddleware(auth.allowedOrigins, config.dashboardPort, "off"))`);
    expect(offBranch).not.toContain("createAuthMiddleware");
    expect(offBranch).not.toContain("createZoneMiddleware");
    expect(text.indexOf('config.dashboardPort, "off")')).toBeLessThan(text.indexOf("app.route("));
  });

  test("the introspector is built ONCE and injected into both consumers", async () => {
    // The duplicate-introspector shape is invisible to tsc, to every unit test
    // and to a live instance's happy path: two instances both work. What breaks
    // is (a) the `/chat/ws` upgrade missing the HTTP cache the chat page's own
    // first request just filled, milliseconds earlier — the exact pair the
    // cache exists for — and (b) in `entra` mode, where the introspector is also
    // the DB-provisioning path, two first-login transactions racing.
    const text = await readFile(INDEX, "utf8");
    const calls = text.match(/createIntrospector\(/g) ?? [];
    expect(calls.length, "src/index.ts must call createIntrospector exactly once").toBe(1);
    expect(text).toContain("createAuthMiddleware(auth, introspector)");
    expect(text).toContain("createWsUpgradeAuthorizer(auth, config.dashboardPort, introspector)");
  });

  test("no consumer builds its own introspector", async () => {
    // The other half of the pin above: `createAuthMiddleware` and
    // `createWsUpgradeAuthorizer` both DID call `createIntrospector` before this
    // PR, so re-adding one is a one-line regression that nothing else notices.
    for (const file of ["src/auth/middleware.ts", "src/auth/ws-upgrade.ts"]) {
      expect(await readFile(file, "utf8"), file).not.toContain("createIntrospector(");
    }
  });
});
