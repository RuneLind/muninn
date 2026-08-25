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

  test("the origin middleware is mounted AFTER the auth middleware", async () => {
    // Order decides the status a caller with no credential sees: 401 by
    // identity, not 403 by origin. A scripted client must be able to tell
    // "you are not logged in" from "your origin is refused".
    const text = await readFile(INDEX, "utf8");
    const auth = text.indexOf("createAuthMiddleware(auth)");
    const origin = text.indexOf("createOriginMiddleware(auth.allowedOrigins)");
    expect(auth).toBeGreaterThan(-1);
    expect(origin, "src/index.ts must mount createOriginMiddleware").toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(auth);
  });

  test("both middlewares are mounted only in an authenticating mode", async () => {
    // "Off is off": with MUNINN_AUTH unset there must be no middleware at all,
    // so both `app.use` calls stay inside the same isAuthenticatingMode branch.
    const text = await readFile(INDEX, "utf8");
    const branch = text.match(/if \(isAuthenticatingMode\(auth\.mode\)\) \{[\s\S]*?\n\}/);
    expect(branch, "the isAuthenticatingMode branch was not found").not.toBeNull();
    expect(branch![0]).toContain("createAuthMiddleware(auth)");
    expect(branch![0]).toContain("createOriginMiddleware(auth.allowedOrigins)");
  });
});
