import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { createDashboardRoutes } from "./routes.ts";
import { NAIS_DROPPED_ROUTE_GROUPS } from "./route-groups.ts";
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
  "wiki": "/api/wiki/pages",
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
};

/** The page routes that go with them — a dropped group must take its HTML
 *  surface with it, or a `/plans` bookmark renders a shell whose every fetch
 *  404s and reads as a broken page rather than as an absent feature. */
const DROPPED_PAGES = ["/wiki", "/wiki/gardener", "/plans", "/logs", "/benchmark", "/summaries"];

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
    // `/api/live` is the liveness contract itself, so it is asserted by ANSWER.
    expect((await app.request("/api/live")).status).toBe(200);
    // The rest are asserted by registration: none of them belongs to a
    // `register*` call, and a profile must not be able to take them away.
    // (`/api/ready` and `/api/attention` touch the database, so their STATUS
    // depends on the environment; that they are ROUTED does not.)
    const paths = registeredPaths(app);
    for (const path of ["/", "/favicon.svg", "/favicon.ico", "/api/dashboard-build-hash", "/api/ready", "/api/attention"]) {
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
      for (const dead of ["/wiki", "/plans", "/logs", "/benchmark", "/summaries"]) {
        expect(`${page} links ${dead}: ${linked.includes(dead)}`).toBe(`${page} links ${dead}: false`);
      }
    }
  });

  test("the kept links — including the Tools ▾ entries — are still there", () => {
    const linked = hrefs(renderNav("chat", { profile: "nais" }));
    for (const kept of ["/", "/chat", "/agents", "/traces", "/research", "/search", "/graph", "/jira", "/models", "/indexing"]) {
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
