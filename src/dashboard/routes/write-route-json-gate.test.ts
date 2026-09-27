import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { createChatRoutes } from "../../chat/routes.ts";
import { createDashboardRoutes } from "../routes.ts";

/**
 * The mechanical carrier for the JSON gate (`json-request.ts`).
 *
 * A `text/plain`, form-encoded, multipart or bodyless POST is a CORS simple
 * request: a cross-origin page sends it with no preflight. The global origin
 * check (`src/auth/origin.ts`, mounted in every mode) refuses a cross-site one;
 * a write route's own 415 is the second layer. This file walks every write route of the app
 * `src/index.ts` serves — `createDashboardRoutes` at `/` and `createChatRoutes`
 * at `/chat` — and requires that 415, unless the route is on {@link UNGATED}
 * with a reason. A new write route therefore starts RED here until it is gated
 * or someone writes down why it is not.
 *
 * Only gated routes are requested: an allowlisted route's handler would run for
 * real (spawns, huginn calls, DB writes), so its entry is a claim this file
 * cannot probe — and an entry whose route later gains a gate is not noticed.
 * The list is the map of the remaining class: shrink it.
 */

const CONFIG = { dashboardPort: 3010, profile: "default" } as Config;

/** PUT/PATCH/DELETE are never CORS simple requests: a cross-origin one preflights,
 *  and muninn answers no CORS headers, so the browser never sends it. */
const NON_SIMPLE = "non-simple method: a cross-origin request preflights and gets no CORS answer";
/** Routes that answer their own preflight for the Chrome extensions (an echoed
 *  `chrome-extension:` origin): a JSON gate would not close them — the origin
 *  check does. Checked below, not only claimed. */
const EXTENSION_PREFLIGHT =
  "answers its own preflight for an extension origin: the origin check closes it, a JSON gate would not";
/** The plain remainder: a write route with no per-route 415 today. */
const OPEN = "dashboard-page POST with no per-route 415 yet: follow-up";
/** The `/chat` slice: no route there is JSON-gated yet. */
const CHAT = "/chat POST with no per-route 415 yet: follow-up";

const UNGATED: ReadonlyMap<string, string> = new Map([
  ["DELETE /api/threads/:id", NON_SIMPLE],
  ["PUT /api/watchers/:id", NON_SIMPLE],
  ["PUT /api/tasks/:id", NON_SIMPLE],
  ["PUT /api/connectors/:id", NON_SIMPLE],
  ["DELETE /api/connectors/:id", NON_SIMPLE],

  ["POST /api/research/chat", EXTENSION_PREFLIGHT],
  ["POST /api/x-articles/summarize", EXTENSION_PREFLIGHT],
  ["POST /api/x-articles/summarize-video", EXTENSION_PREFLIGHT],
  ["POST /api/tiktok/summarize", EXTENSION_PREFLIGHT],

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

  ["PUT /chat/preferences/:userId/:botName/connector", NON_SIMPLE],
  ["PUT /chat/bot-preferences/:botName/default-user", EXTENSION_PREFLIGHT],
  ["DELETE /chat/conversations/:id", NON_SIMPLE],
  ["PATCH /chat/threads/:id/connector", NON_SIMPLE],
  ["PATCH /chat/threads/:id/auto-respond", NON_SIMPLE],
  ["DELETE /chat/threads/:id", NON_SIMPLE],
  ["POST /chat/conversations", CHAT],
  ["POST /chat/threads", CHAT],
  ["POST /chat/feedback", CHAT],
  ["POST /chat/conversations/:id/messages", CHAT],
  ["POST /chat/mcp-status/:botName/refresh", CHAT],
  ["POST /chat/reports/:botName/:userId/:issueKey", CHAT],
  ["POST /chat/specs/:botName/:userId/:issueKey", CHAT],
]);

/** `ALL` is what `app.all(...)` and `app.mount(...)` register: a POST reaches it.
 *  An `app.use` middleware inside either factory would also show up as `ALL`;
 *  none is registered there today (it lives on the top-level app). */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

/** The top-level app as `src/index.ts` composes it, minus the middlewares. No
 *  bots: nothing here needs one, and none may be reachable. */
function writeRoutes(): { app: Hono; routes: string[] } {
  const app = new Hono();
  app.route("/", createDashboardRoutes(CONFIG));
  app.route("/chat", createChatRoutes([], CONFIG));
  const routes = [
    ...new Set(
      app.routes.filter((r) => WRITE_METHODS.has(r.method)).map((r) => `${r.method} ${r.path}`),
    ),
  ];
  return { app, routes };
}

const PROBE = "carrier-probe";
/** Values tried, in order, against a regex-constrained `:name{…}` param. */
const PARAM_CANDIDATES = [PROBE, "1", "carrier-probe.md", "carrier-probe/carrier-probe"];

/**
 * Hono's param shapes: `:name`, `:name?`, `:name{regex}` (a regex may itself
 * hold braces or `/`), plus the `*` wildcard. The name is anything up to `/`,
 * `{` or `?`, so `:id_2` and `:traceId` are one token.
 */
const PARAM = /:[^/{}?]+(\{(?:[^{}\\]|\\.|\{[^{}]*\})*\})?\??|\*/g;

/**
 * A concrete URL for a route pattern, or `null` when a regex-constrained param
 * accepts none of the candidates. `wiki`/`bot` name nothing: if a gate
 * regresses, the handler runs — these keep it pointed at no real wiki or bot,
 * and the `fetch` stub below at no real service, so a regression fails here as
 * a status rather than as a drain. The stub does not fence process spawns.
 */
function concrete(pattern: string): string | null {
  let unmatched = false;
  const path = pattern.replace(PARAM, (_token, braced: string | undefined) => {
    if (!braced) return PROBE;
    const rx = new RegExp(`^(?:${braced.slice(1, -1)})$`);
    const value = PARAM_CANDIDATES.find((v) => rx.test(v));
    if (value === undefined) unmatched = true;
    return value ?? PROBE;
  });
  return unmatched ? null : `${path}?wiki=${PROBE}&bot=${PROBE}`;
}

function form(): FormData {
  const f = new FormData();
  f.set("x", "{}");
  return f;
}

/** The four CORS-simple shapes a cross-origin page can send with no preflight. */
const PROBES: ReadonlyArray<[string, () => Omit<RequestInit, "method">]> = [
  ["text/plain", () => ({ headers: { "content-type": "text/plain" }, body: "{}" })],
  [
    "form-urlencoded",
    () => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x=%7B%7D" }),
  ],
  ["multipart", () => ({ body: form() })],
  ["bodyless", () => ({})],
];

describe("every write route answers a non-JSON request with 415", () => {
  test("the walk found the write surface (not an empty route table)", () => {
    const { routes } = writeRoutes();
    expect(routes.length).toBeGreaterThan(70);
    expect(routes.some((r) => r.startsWith("POST /chat/"))).toBe(true);
  });

  test("every allowlist entry is a registered write route (no stale entries)", () => {
    const registered = new Set(writeRoutes().routes);
    const stale = [...UNGATED.keys()].filter((k) => !registered.has(k));
    expect(stale).toEqual([]);
  });

  test("concrete() fills every Hono param shape so the route still matches", async () => {
    const app = new Hono();
    const patterns = [
      "/p/:id_2",
      "/p/:a1/:b/opt/:c?",
      "/p/re/:n{[0-9]+}",
      "/p/md/:file{.+\\.md}",
      "/p/wild/*",
      // Only the `/`-containing candidate satisfies this one.
      "/p/nested/:path{[^/]+/[^/]+}",
    ];
    for (const p of patterns) app.post(p, (c) => c.text("hit"));
    const missed: string[] = [];
    for (const p of patterns) {
      const url = concrete(p);
      const res = url ? await app.request(url, { method: "POST" }) : null;
      if (!res || (await res.text()) !== "hit") missed.push(`${p} → ${url}`);
    }
    expect(missed).toEqual([]);
    expect(concrete("/p/:n{[a-f]{40}}")).toBeNull();
    expect(concrete("/p/nested/:path{[^/]+/[^/]+}")).toStartWith(`/p/nested/${PROBE}/${PROBE}?`);
  });

  test("concrete() keeps the probe query intact for every param shape", () => {
    // A leftover `?` in the path would turn the query key into `?wiki`, and a
    // regressed handler would then resolve the real default wiki and bot.
    const cases: Array<[string, string]> = [
      ["/q/:c", `/q/${PROBE}`],
      ["/q/:a/:c?", `/q/${PROBE}/${PROBE}`],
      ["/q/*", `/q/${PROBE}`],
      ["/q/:n{[0-9]+}", "/q/1"],
    ];
    for (const [pattern, path] of cases) {
      const url = new URL(concrete(pattern)!, "http://carrier.test");
      expect([pattern, url.pathname, [...url.searchParams]]).toEqual([
        pattern,
        path,
        [
          ["wiki", PROBE],
          ["bot", PROBE],
        ],
      ]);
    }
  });

  test("an allowlisted route answers a cross-origin preflight as its reason says", async () => {
    // OPTIONS reaches a route's own preflight handler, and also any `app.all` or
    // `app.mount` handler; no allowlisted route is either today (0 ALL routes).
    const { app } = writeRoutes();
    const wrong: string[] = [];
    for (const [route, reason] of UNGATED) {
      const [method, pattern] = route.split(" ") as [string, string];
      const preflight = (origin: string) =>
        app.request(concrete(pattern)!, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-type",
          },
        });
      const ext = "chrome-extension://abcdefghijklmnop";
      const extAnswer = (await preflight(ext)).headers.get("access-control-allow-origin");
      if ((extAnswer === ext) !== (reason === EXTENSION_PREFLIGHT)) {
        wrong.push(`${route} → extension allow-origin ${extAnswer} (listed: ${reason})`);
      }
      // No route names a foreign page, and none answers `*`.
      const evilAnswer = (await preflight("https://evil.example")).headers.get("access-control-allow-origin");
      if (evilAnswer !== null) wrong.push(`${route} → evil allow-origin ${evilAnswer}`);
    }
    expect(wrong).toEqual([]);
  });

  test("every other write route: each CORS-simple shape → 415", async () => {
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
        const [routeMethod, pattern] = route.split(" ") as [string, string];
        // A browser's cross-origin simple request is a POST.
        const method = routeMethod === "ALL" ? "POST" : routeMethod;
        const url = concrete(pattern);
        if (url === null) {
          wrong.push(`${route} → no probe value satisfies its param regex`);
          continue;
        }
        for (const [label, init] of PROBES) {
          probed += 1;
          const res = await app.request(url, { method, ...init() });
          if (res.status !== 415) wrong.push(`${route} (${label}) → ${res.status}`);
        }
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(wrong).toEqual([]);
    // Measured 2026-09-27: 27 gated routes × 4 shapes = 108 probes.
    expect(probed).toBeGreaterThanOrEqual(100);
  });
});
