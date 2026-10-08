import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { createDashboardRoutes } from "./routes.ts";
import { NAIS_DROPPED_ROUTE_GROUPS, servesWikiReadSliceOnly, wikiToolsRegistered } from "./route-groups.ts";
import { wikiRouteTable } from "../test/wiki-route-table.ts";
import { renderNav } from "./views/shared-styles.ts";

/**
 * The `nais` serving profile's surface — the routes it drops, and the nav that
 * must stop linking to them.
 *
 * The distinction under test on the DROPPED half is ABSENT versus DENIED, so
 * those cases issue a real request through a real `createDashboardRoutes`: a
 * dropped group has no handler at all, so the answer is Hono's own 404 — not a
 * 403 from the zone middleware, which is a policy someone can later relax, and
 * not a 500 from a route reaching for a working tree a pod does not have.
 *
 * The PRESENT half reads `app.routes` instead of issuing the same request
 * against a live registration. That is not squeamishness: `/api/events` is an
 * SSE stream that never closes, `/api/claude-usage/overview` fetches an
 * external service, and `/api/wiki/pages` reads whatever `WIKI_EXTRA` this
 * machine carries — a presence check that runs handlers is a presence check
 * that depends on the machine.
 *
 * The profile is passed on the `Config`, never through `MUNINN_PROFILE`: the
 * variable is in `AMBIENT_INSTANCE_ENV` (the preload deletes it), and an
 * env-driven test here would be the one thing that flips behaviour for every
 * OTHER file in the same `bun test` process.
 */
const CONFIG = { dashboardPort: 3010, profile: "default" } as Config;

/** One representative path per dropped group — the address a client would use. */
const DROPPED_PATHS: Record<string, string> = {
  "wiki": "/api/wiki/similar",
  "wiki-gardener": "/api/wiki/proposals",
  "plans": "/api/plans/board",
  "sync": "/api/sync/status",
  "claude-usage": "/api/claude-usage/overview",
  "benchmark": "/api/benchmark/runs",
  "logs": "/api/logs",
  "summaries": "/api/summaries/documents",
  "anthropic": "/api/anthropic/candidates",
  "article": "/api/articles/summarize",
  "youtube": "/api/youtube/summarize",
  "x-article": "/api/x-articles/summarize",
  "tiktok": "/api/tiktok/summarize",
  "vimeo": "/api/vimeo/summarize",
};

/** The page routes that go with them — a dropped group must take its HTML
 *  surface with it, or a `/plans` bookmark renders a shell whose every fetch
 *  404s and reads as a broken page rather than as an absent feature. */
const DROPPED_PAGES = ["/wiki/issues", "/wiki/gardener", "/plans", "/logs", "/benchmark", "/summaries"];

function build(profile: "default" | "nais"): Hono {
  const app = new Hono();
  app.route("/", createDashboardRoutes({ ...CONFIG, profile } as Config));
  return app;
}

/** A HEAD-free status probe: GET for reads, POST for the capture verticals
 *  (which register no GET). A 404 means "no handler"; anything else — 400 on a
 *  missing body, 500 from an unreachable huginn — means the route EXISTS. */
async function status(app: Hono, path: string): Promise<number> {
  const method = path.endsWith("/summarize") ? "POST" : "GET";
  const res = await app.request(path, {
    method,
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
  });
  return res.status;
}

/** Registered path patterns — presence without running a handler. */
function registeredPaths(app: Hono): ReadonlySet<string> {
  return new Set(app.routes.map((r) => r.path));
}

describe("MUNINN_PROFILE=nais route surface", () => {
  test("every dropped group has a representative path pinned here", () => {
    // Guards the shape of this file rather than the code: a group added to the
    // drop list with no path below would be "asserted" by nothing at all.
    expect(Object.keys(DROPPED_PATHS).sort()).toEqual([...NAIS_DROPPED_ROUTE_GROUPS].sort());
  });

  test("the dropped groups answer 404 — no handler, not a denial", async () => {
    const app = build("nais");
    const answers: Record<string, number> = {};
    for (const [group, path] of Object.entries(DROPPED_PATHS)) {
      answers[group] = await status(app, path);
    }
    expect(answers).toEqual(Object.fromEntries(Object.keys(DROPPED_PATHS).map((g) => [g, 404])));
  });

  test("their page routes are gone too", async () => {
    const app = build("nais");
    for (const path of DROPPED_PAGES) {
      expect(`${path} → ${(await app.request(path)).status}`).toBe(`${path} → 404`);
    }
  });

  test("the same paths are REGISTERED on the default profile", () => {
    // The other half of the pin: a 404 above has to mean "dropped", not "that
    // path never existed" — a typo'd path would make the whole suite vacuous.
    const paths = registeredPaths(build("default"));
    for (const [group, path] of Object.entries({ ...DROPPED_PATHS, ...Object.fromEntries(DROPPED_PAGES.map((p) => [p, p])) })) {
      expect(`${group} ${path} → ${paths.has(path)}`).toBe(`${group} ${path} → true`);
    }
  });

  test("the inline instance routes and both health paths survive on nais", async () => {
    const app = build("nais");
    // ANSWERED, not merely registered: a registration check cannot tell
    // "renders" from "throws inside the handler", which is exactly the failure
    // a profile branch introduces. `/` renders the whole dashboard page, so
    // this asserts that render path executes — NOT the nais nav: this app IS
    // built with a `Config` carrying `profile: "nais"`, but `routes.ts` calls
    // `renderDashboardPage()` with no arguments, so the profile never reaches
    // `renderNav`, which falls back to the (blanked) env and runs its DEFAULT
    // branch here. The nais nav
    // (`droppedRouteGroups` omitting links) is covered by the explicit
    // "renderNav under the nais profile" describe below. These are the cheap,
    // hermetic paths: no DB, no network, no filesystem beyond the inlined
    // bundles.
    const answers: Record<string, number> = {};
    for (const path of ["/api/live", "/", "/favicon.svg", "/favicon.ico", "/api/dashboard-build-hash"]) {
      answers[path] = (await app.request(path)).status;
    }
    expect(answers).toEqual({
      "/api/live": 200, "/": 200, "/favicon.svg": 200, "/favicon.ico": 200, "/api/dashboard-build-hash": 200,
    });

    // The remaining two are asserted by registration only: `/api/ready` and
    // `/api/attention` touch the database, so their STATUS depends on the
    // environment; that they are ROUTED does not.
    const paths = registeredPaths(app);
    for (const path of ["/api/ready", "/api/attention"]) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });

  test("the surfaces the profile KEEPS are still registered", () => {
    const paths = registeredPaths(build("nais"));
    for (const path of ["/api/stats", "/traces", "/api/events", "/models", "/agents", "/jira", "/graph", "/research"]) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });

  test("a Config with no profile falls through to the env, i.e. today's full surface", () => {
    // The compatibility pin. The unit tests that hand-build a `{} as Config`
    // (health, owner-guard) go down this path, and on a machine with no
    // MUNINN_PROFILE it must be the surface it was before this PR.
    const app = new Hono();
    app.route("/", createDashboardRoutes({ dashboardPort: 3010 } as Config));
    const paths = registeredPaths(app);
    for (const path of [...Object.values(DROPPED_PATHS), ...DROPPED_PAGES]) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });
});

/**
 * The nav that goes with it.
 *
 * `renderNav` is on EVERY page, `/chat` included — the pod's one page — so a
 * hardcoded `/wiki` there is a dead link on the only surface a nais deployment
 * has. The nav is not part of `createDashboardRoutes`, so nothing above would
 * have caught it.
 */
describe("renderNav under the nais profile", () => {
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

  test("links to dropped groups are absent — on the chat page too", () => {
    for (const page of ["chat", "dashboard"] as const) {
      const linked = hrefs(renderNav(page, { profile: "nais" }));
      for (const dead of ["/plans", "/logs", "/benchmark", "/summaries"]) {
        expect(`${page} links ${dead}: ${linked.includes(dead)}`).toBe(`${page} links ${dead}: false`);
      }
    }
  });

  test("the kept links — including the Tools ▾ entries — are still there", () => {
    const linked = hrefs(renderNav("chat", { profile: "nais" }));
    for (const kept of ["/", "/chat", "/agents", "/traces", "/research", "/search", "/wiki", "/graph", "/jira", "/models", "/indexing"]) {
      expect(`nais links ${kept}: ${linked.includes(kept)}`).toBe(`nais links ${kept}: true`);
    }
  });

  test("the default profile links everything, dropdown included", () => {
    const linked = hrefs(renderNav("dashboard", { profile: "default" }));
    for (const kept of ["/wiki", "/plans", "/logs", "/benchmark", "/summaries", "/mcp-debug", "/serena"]) {
      expect(`default links ${kept}: ${linked.includes(kept)}`).toBe(`default links ${kept}: true`);
    }
  });

  test("no options at all is the default profile, byte for byte", () => {
    expect(renderNav("dashboard")).toBe(renderNav("dashboard", { profile: "default" }));
  });
});

/**
 * The wiki READ slice: the one wiki group `nais` keeps. Its routes answer and
 * every other wiki route is absent — the split the user zone's wiki entries
 * rest on (`src/auth/zones.ts`).
 */
describe("the wiki read slice under nais", () => {
  test("the read routes are registered", () => {
    const read = wikiRouteTable("read", "nais");
    expect(read.length).toBeGreaterThanOrEqual(7);
    expect(read.some((r) => r.path === "/api/wiki/related")).toBe(true);
    const paths = registeredPaths(build("nais"));
    for (const { path } of read) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });

  test("…and ANSWER — a handler runs, not Hono's 404", async () => {
    // Parameters that each handler refuses before any filesystem read, so the
    // answer is the route's own and does not depend on this machine's wikis.
    const app = build("nais");
    const answers: Record<string, number> = {};
    for (const path of ["/api/wiki/page", "/api/wiki/page/provenance", "/api/wiki/related", "/api/wiki/html", "/api/wiki/pages?wiki=__no_such_wiki__"]) {
      answers[path] = (await app.request(path)).status;
    }
    expect(answers).toEqual({
      "/api/wiki/page": 400, "/api/wiki/page/provenance": 400, "/api/wiki/related": 400, "/api/wiki/html": 400,
      "/api/wiki/pages?wiki=__no_such_wiki__": 200,
    });
  });

  test("every other wiki route is 404 — Explain, Ask, Stamp and every write", async () => {
    const routes = wikiRouteTable("tools");
    for (const must of ["/api/wiki/explain", "/api/wiki/ask", "/api/wiki/provenance/stamp", "/api/wiki/series", "/api/wiki/similar"]) {
      expect(routes.some((r) => r.path === must), must).toBe(true);
    }
    const app = build("nais");
    for (const r of routes) {
      const res = await app.request(r.path, {
        method: r.method,
        ...(r.method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      });
      expect(`${r.method} ${r.path} → ${res.status}`).toBe(`${r.method} ${r.path} → 404`);
    }
  });

  test("the default profile registers both halves", async () => {
    const paths = registeredPaths(build("default"));
    for (const r of wikiRouteTable("tools")) {
      expect(`${r.path} → ${paths.has(r.path)}`).toBe(`${r.path} → true`);
    }
    expect(paths.has("/api/wiki/page")).toBe(true);
  });

  test("the answer routes (`wiki-answers`) are KEPT by nais and registered on default (D14)", () => {
    const answers = wikiRouteTable("answers");
    expect(answers.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /api/wiki/answers",
      "GET /api/wiki/answers/export",
      "POST /api/wiki/answers",
      "POST /api/wiki/answers/export/confirm",
      "POST /api/wiki/answers/redact",
    ]);
    for (const profile of ["nais", "default"] as const) {
      const app = build(profile);
      for (const r of answers) {
        expect(`${profile} ${r.method} ${r.path} → ${app.routes.some((x) => x.method === r.method && x.path === r.path)}`)
          .toBe(`${profile} ${r.method} ${r.path} → true`);
      }
    }
  });

  test("…and ANSWER on nais — a handler runs, not Hono's 404", async () => {
    const app = build("nais");
    expect((await app.request("/api/wiki/answers")).status).toBe(400);
    const res = await app.request("/api/wiki/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  test("wikiToolsRegistered and servesWikiReadSliceOnly are complements on both profiles", () => {
    expect(wikiToolsRegistered("nais")).toBe(false);
    expect(wikiToolsRegistered("default")).toBe(true);
    expect(servesWikiReadSliceOnly("nais")).toBe(true);
    expect(servesWikiReadSliceOnly("default")).toBe(false);
  });
});

describe("the worked-on ledger's boot kick (fix round 2)", () => {
  /**
   * The gate `src/index.ts` warms the memo behind. A predicate rather than an
   * inline test at the boot site, so both profiles are drivable: under `nais`
   * there is no `/wiki` reader to warm the axis for, the wiki roots are working
   * trees that do not exist in a pod, and the claude-usage it would dial is a
   * launchd service on another machine's loopback.
   */
  test("the default profile kicks it and `nais` does not", () => {
    expect(wikiToolsRegistered("default")).toBe(true);
    expect(wikiToolsRegistered("nais")).toBe(false);
  });

  test("…and it is DERIVED from the drop set, not from the profile name", () => {
    // So a later profile that drops `wiki` skips the kick with no second edit.
    expect(NAIS_DROPPED_ROUTE_GROUPS.includes("wiki")).toBe(true);
  });
});
