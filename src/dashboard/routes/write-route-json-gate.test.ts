import { test, expect, describe } from "bun:test";
import type { Config } from "../../config.ts";
import { createDashboardRoutes } from "../routes.ts";

/**
 * The mechanical carrier for the JSON gate (`json-request.ts`).
 *
 * A `text/plain` or bodyless POST is a CORS simple request: a cross-origin page
 * sends it with no preflight. Under `MUNINN_AUTH=off` the global origin check is
 * not mounted, so a write route's own 415 is the guard. This file walks every
 * write route `createDashboardRoutes` registers and requires that 415 — unless
 * the route is on {@link UNGATED} with a reason. A new write route therefore
 * starts RED here until it is gated or someone writes down why it is not.
 *
 * Only gated routes are requested: an allowlisted route's handler would run for
 * real (spawns, huginn calls, DB writes), so its entry is a claim this file
 * cannot probe. The list is the map of the remaining class — shrink it.
 */

const CONFIG = { dashboardPort: 3010, profile: "default" } as Config;

/** PUT/PATCH/DELETE are never CORS simple requests: a cross-origin one preflights,
 *  and muninn answers no CORS headers, so the browser never sends it. */
const NON_SIMPLE = "non-simple method: a cross-origin request preflights and gets no CORS answer";
/** Routes a Chrome extension calls cross-origin, answered with `applyCors`. */
const EXTENSION = "Chrome-extension route with its own CORS; JSON gate not added yet";
/** The plain remainder: a write route with no per-route 415 today. */
const OPEN = "dashboard-page POST with no per-route 415 yet: follow-up";

const UNGATED: ReadonlyMap<string, string> = new Map([
  ["DELETE /api/threads/:id", NON_SIMPLE],
  ["PUT /api/watchers/:id", NON_SIMPLE],
  ["PUT /api/tasks/:id", NON_SIMPLE],
  ["PUT /api/connectors/:id", NON_SIMPLE],
  ["DELETE /api/connectors/:id", NON_SIMPLE],

  ["POST /api/research/chat", EXTENSION],
  ["POST /api/x-articles/summarize", EXTENSION],
  ["POST /api/x-articles/summarize-video", EXTENSION],
  ["POST /api/tiktok/summarize", EXTENSION],

  ["POST /api/users", OPEN],
  ["POST /api/watchers/:id/trigger", OPEN],
  ["POST /api/tasks/:id/trigger", OPEN],
  ["POST /api/connectors", OPEN],
  ["POST /api/mcp/connect", OPEN],
  ["POST /api/mcp/call", OPEN],
  ["POST /api/mcp/disconnect", OPEN],
  ["POST /api/serena/:name/start", OPEN],
  ["POST /api/serena/:name/stop", OPEN],
  ["POST /api/serena/:name/index", OPEN],
  ["POST /api/summaries/share", OPEN],
  ["POST /api/anthropic/candidates/:id/summarize", OPEN],
  ["POST /api/articles/summarize", OPEN],
  ["POST /api/anthropic/candidates/:id/dismiss", OPEN],
  ["POST /api/wiki/atlas/draft-synthesis", OPEN],
  ["POST /api/wiki/reindex", OPEN],
  ["POST /api/wiki/share", OPEN],
  ["POST /api/wiki/remember", OPEN],
  ["POST /api/wiki/ask/chat", OPEN],
  ["POST /api/wiki/factcheck/append", OPEN],
  ["POST /api/wiki/factcheck/integrate", OPEN],
  ["POST /api/wiki/factcheck/integrate/apply", OPEN],
  ["POST /api/benchmark/cells", OPEN],
  ["POST /api/benchmark/cells/live/:traceId/kill", OPEN],
  ["POST /api/benchmark/runs/:id/rejudge", OPEN],
  ["POST /api/models/bot-config", OPEN],
  ["POST /api/models/role", OPEN],
  ["POST /api/sync/run", OPEN],
]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function writeRoutes(): { app: ReturnType<typeof createDashboardRoutes>; routes: string[] } {
  const app = createDashboardRoutes(CONFIG);
  const routes = [
    ...new Set(
      app.routes.filter((r) => WRITE_METHODS.has(r.method)).map((r) => `${r.method} ${r.path}`),
    ),
  ];
  return { app, routes };
}

/**
 * A concrete URL for a route pattern: every `:param` becomes a probe value, and
 * `wiki`/`bot` name nothing. If a gate regresses, the handler runs — these keep
 * it pointed at no real wiki or bot, and the `fetch` stub below at no real
 * service, so a regression fails here as a status rather than as a drain.
 */
function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "carrier-probe") + "?wiki=carrier-probe&bot=carrier-probe";
}

describe("every dashboard write route answers a non-JSON request with 415", () => {
  test("the walk found the write surface (not an empty route table)", () => {
    expect(writeRoutes().routes.length).toBeGreaterThan(40);
  });

  test("every allowlist entry is a registered write route (no stale entries)", () => {
    const registered = new Set(writeRoutes().routes);
    const stale = [...UNGATED.keys()].filter((k) => !registered.has(k));
    expect(stale).toEqual([]);
  });

  test("every other write route: text/plain → 415 and bodyless → 415", async () => {
    const { app, routes } = writeRoutes();
    const wrong: string[] = [];
    let probed = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`carrier probe reached the network: ${String(input)}`);
    }) as unknown as typeof fetch;
    try {
      for (const route of routes) {
        if (UNGATED.has(route)) continue;
        const [method, pattern] = route.split(" ") as [string, string];
        const url = concrete(pattern);
        for (const [label, init] of [
          ["text/plain", { method, headers: { "content-type": "text/plain" }, body: "{}" }],
          ["bodyless", { method }],
        ] as Array<[string, RequestInit]>) {
          probed += 1;
          const res = await app.request(url, init);
          if (res.status !== 415) wrong.push(`${route} (${label}) → ${res.status}`);
        }
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(wrong).toEqual([]);
    expect(probed).toBeGreaterThan(0);
  });
});
