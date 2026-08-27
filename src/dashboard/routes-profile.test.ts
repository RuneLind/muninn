import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { createDashboardRoutes, NAIS_DROPPED_ROUTE_GROUPS } from "./routes.ts";

/**
 * The `nais` serving profile's route surface.
 *
 * The distinction under test is ABSENT versus DENIED. A dropped group has no
 * handler at all, so the answer is Hono's own 404 — not a 403 from the zone
 * middleware, which is a policy someone can later relax, and not a 500 from a
 * route reaching for a working tree that does not exist in a pod. That is why
 * every assertion below reads the status of a real request through a real
 * `createDashboardRoutes` rather than inspecting a list.
 *
 * These cases pass an explicit `{ profile }` rather than setting
 * `MUNINN_PROFILE`: the variable is in `AMBIENT_INSTANCE_ENV` (the preload
 * deletes it), and an env-driven test here would be the one thing that flips
 * behaviour for every OTHER file in the same `bun test` process.
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
  "anthropic": "/api/anthropic/candidates",
  "article": "/api/articles/summarize",
  "youtube": "/api/youtube/summarize",
  "x-article": "/api/x-articles/summarize",
  "tiktok": "/api/tiktok/summarize",
};

/** The page routes that go with them — a dropped group must take its HTML
 *  surface with it, or a `/plans` bookmark renders a shell whose every fetch
 *  404s and reads as a broken page rather than as an absent feature. */
const DROPPED_PAGES = ["/wiki", "/wiki/gardener", "/plans", "/logs", "/benchmark"];

function build(profile: "default" | "nais"): Hono {
  const app = new Hono();
  app.route("/", createDashboardRoutes(CONFIG, { profile }));
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

  test("the same paths are PRESENT on the default profile", async () => {
    // The other half of the pin: a 404 above has to mean "dropped", not "that
    // path never existed" — a typo'd path would make the whole suite vacuous.
    const app = build("default");
    for (const [group, path] of Object.entries(DROPPED_PATHS)) {
      expect(`${group} ${path} → ${(await status(app, path)) === 404}`).toBe(`${group} ${path} → false`);
    }
  });

  test("the inline instance routes and both health paths answer on nais", async () => {
    const app = build("nais");
    // `/` renders the dashboard shell, the favicons are inline, and the two
    // health paths are the open zone — none of them belong to a register* call,
    // and a profile must not be able to take a liveness probe away.
    expect((await app.request("/api/live")).status).toBe(200);
    expect((await app.request("/favicon.svg")).status).toBe(200);
    expect((await app.request("/favicon.ico")).status).toBe(200);
    expect((await app.request("/api/dashboard-build-hash")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
    // `/api/ready` and `/api/attention` both touch the database, so their STATUS
    // depends on the environment; what this asserts is that they are routed at
    // all (a 404 would mean the inline block was filtered).
    expect((await app.request("/api/ready")).status).not.toBe(404);
  });

  test("the surfaces the profile KEEPS are still registered", async () => {
    const app = build("nais");
    for (const path of ["/api/stats", "/traces", "/api/events", "/models", "/agents", "/jira", "/summaries"]) {
      expect(`${path} → ${(await app.request(path)).status === 404}`).toBe(`${path} → false`);
    }
  });

  test("createDashboardRoutes(config) with no options drops nothing", async () => {
    // The compatibility pin. Every existing caller — src/index.ts included —
    // passes one argument, and on a machine with no MUNINN_PROFILE that must be
    // byte-for-byte the surface it was before this PR.
    const app = new Hono();
    app.route("/", createDashboardRoutes(CONFIG));
    for (const path of [...Object.values(DROPPED_PATHS), ...DROPPED_PAGES]) {
      expect(`${path} → ${(await status(app, path)) === 404}`).toBe(`${path} → false`);
    }
  });
});
