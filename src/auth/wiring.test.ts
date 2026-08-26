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
    const policyAt = text.indexOf("setAuthPolicy(auth)");
    const resolveAt = text.indexOf("resolveAuthConfig()");
    const routesAt = text.indexOf("createDashboardRoutes(config)");
    expect(policyAt, "src/index.ts must call setAuthPolicy(auth)").toBeGreaterThan(-1);
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
    const auth = text.indexOf("createAuthMiddleware(auth)");
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

  test("all three middlewares are mounted only in an authenticating mode", async () => {
    // "Off is off": with MUNINN_AUTH unset there must be no middleware at all,
    // so all three `app.use` calls stay inside the same isAuthenticatingMode
    // branch.
    const text = await readFile(INDEX, "utf8");
    const branch = text.match(/if \(isAuthenticatingMode\(auth\.mode\)\) \{[\s\S]*?\n\}/);
    expect(branch, "the isAuthenticatingMode branch was not found").not.toBeNull();
    expect(branch![0]).toContain("createAuthMiddleware(auth)");
    expect(branch![0]).toContain("createOriginMiddleware(auth.allowedOrigins, config.dashboardPort)");
    expect(branch![0]).toContain("createZoneMiddleware(auth)");
  });
});
