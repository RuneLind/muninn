import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { createChatRoutes } from "../chat/routes.ts";
import { createDashboardRoutes } from "../dashboard/routes.ts";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFRESH_SIDE_EFFECTING_GETS, SIDE_EFFECTING_GETS, isSideEffectingRequest } from "./origin.ts";

/**
 * The GET counterpart of `write-route-json-gate.test.ts`: the mechanical
 * carrier for `SIDE_EFFECTING_GETS`.
 *
 * The origin guard refuses a cross-site GET only when its path is on that
 * hand-kept list. This file walks every GET route of the app `src/index.ts`
 * serves and requires each one to be either on the list or on
 * {@link READ_ONLY_GETS} with a written reason, so a new GET starts RED here
 * until someone decides which it is.
 *
 * The criterion the two lists split on: a GET belongs on `SIDE_EFFECTING_GETS`
 * when one request spends a model call, spawns a process, consumes state, runs
 * a search / similarity / embedding computation the caller's input drives, or
 * fans out into a number of requests the data sizes. A fixed set of listings,
 * status reads or keyed fetches over configured collections stays read-only,
 * as does one bounded read of a sibling service.
 */

const CONFIG = { dashboardPort: 3010, profile: "default" } as Config;

const PAGE = "server-rendered HTML page; its data loads through the API routes";
const LOCAL = "reads muninn's own DB, memory or disk: no outbound call, spawn or model spend";
const HUGINN_READ = "one keyed fetch, listing or status read at huginn: no search, similarity or embedding work";
const LISTINGS = "a fixed set of huginn listings over the configured collections (no search), the page's own load";
const STREAM = "SSE over a job or run the server already started; subscribing starts nothing";
const LEDGER = "one time- and byte-bounded read of the claude-usage ledger, polled by its own page";
const REFRESH = "the plain read; its `?refresh=1` rebuild is on REFRESH_SIDE_EFFECTING_GETS";

const READ_ONLY_GETS: ReadonlyMap<string, string> = new Map([
  ...[
    "/", "/docs", "/traces", "/memsearch", "/logs", "/search", "/search/document/:collection/*",
    "/research", "/mcp-debug", "/serena", "/summaries", "/summaries/prompts", "/youtube",
    "/x-articles", "/tiktok", "/vimeo", "/graph", "/wiki", "/wiki/issues", "/wiki/gardener",
    "/benchmark", "/benchmark/retrieval", "/benchmark/run-live/:traceId", "/benchmark/runs/:id",
    "/models", "/indexing", "/agents", "/plans", "/jira", "/chat",
  ].map((p) => [p, PAGE] as const),
  ...[
    "/api/live", "/api/ready", "/favicon.svg", "/favicon.ico", "/api/dashboard-build-hash",
    "/api/attention", "/api/openapi.json", "/api/bots", "/api/bots/config", "/api/stats",
    "/api/memories", "/api/memories/by-user", "/api/memories/user/:userId", "/api/goals",
    "/api/goals/:userId", "/api/tasks", "/api/scheduled-tasks/:userId", "/api/threads",
    "/api/users", "/api/users/:userId/overview", "/api/user-settings/:userId",
    "/api/messages/:userId", "/api/slack-analytics", "/api/watchers", "/api/activity",
    "/api/activity/job/:id", "/api/connectors", "/api/traces", "/api/traces/:traceId",
    "/api/prompts/:traceId", "/api/trace-stats", "/api/trace-filters", "/api/memsearch-stats",
    "/api/logs/dates", "/api/logs", "/api/logs/tail", "/api/research/bots",
    "/api/research/variants", "/api/mcp/bots", "/api/mcp/config", "/api/serena/instances",
    "/api/summaries/share/presets", "/api/summaries/prompt", "/api/frames/:source/:id/:file",
    "/api/vimeo/frames/:videoId/:file", "/api/summaries/doc-context",
    "/api/summaries/factcheck/result", "/api/summaries/factcheck/badges",
    "/api/anthropic/jobs", "/api/anthropic/candidates", "/api/anthropic/candidates/stats",
    "/api/articles/jobs", "/api/youtube/jobs", "/api/youtube/options", "/api/x-articles/jobs",
    "/api/x-articles/video-options", "/api/tiktok/jobs", "/api/tiktok/options", "/api/vimeo/jobs",
    "/api/wiki/related", "/api/wiki/decision-chain", "/api/wiki/html",
    "/api/wiki/share/presets", "/api/wiki/chat-target", "/api/wiki/answers",
    "/api/wiki/answers/export", "/api/wiki/proposals", "/api/wiki/linter-findings", "/api/wiki/stale",
    "/api/benchmark/preview", "/api/benchmark/cells/live/:traceId", "/api/benchmark/runs",
    "/api/benchmark/runs/:id", "/api/benchmark/runs/:id/rejudge-children",
    "/api/models/overview", "/api/agents/overview", "/api/sync/status", "/api/jira/archive",
    "/api/jira/templates", "/api/jira/draft/:id", "/api/jira/drafts",
    "/chat/knowledge-config", "/chat/bots", "/chat/me", "/chat/preferences/:userId/:botName",
    "/chat/bot-preferences/:botName/default-user", "/chat/conversations",
    "/chat/conversations/:id", "/chat/threads/:userId/:botName",
    "/chat/conversations/:id/messages", "/chat/context-usage/:userId/:botName",
    "/chat/tool-usage/:userId/:botName", "/chat/reports/:botName/:userId/:issueKey",
    "/chat/specs/:botName/:userId/:issueKey", "/chat/dev-run/by-thread/:threadId",
  ].map((p) => [p, LOCAL] as const),
  ...[
    "/api/search/health", "/api/search/collections", "/api/search/collection/:name/documents",
    "/api/search/document/:collection/*", "/api/research/bot-collections", "/api/research/tags",
    "/api/research/documents", "/api/research/document/:collection/*",
    "/api/summaries/export", "/api/summaries/rerun/options", "/api/summaries/links/options", "/api/anthropic/document/*",
    "/api/articles/document/*", "/api/youtube/document/*", "/api/x-articles/document/*",
    "/api/tiktok/document/*", "/api/vimeo/document/*", "/api/graph/collections",
    "/api/wiki/gardener/backlog-doc-delete-status", "/api/indexing/overview",
  ].map((p) => [p, HUGINN_READ] as const),
  ...[
    "/api/summaries/documents", "/api/wiki/reindex-status",
  ].map((p) => [p, LISTINGS] as const),
  ...[
    "/api/wiki/pages", "/api/wiki/index-coverage", "/api/wiki/ingest-backlog", "/api/summaries/stats",
  ].map((p) => [p, REFRESH] as const),
  ...[
    "/api/events", "/chat/events", "/api/anthropic/stream/:jobId", "/api/articles/stream/:jobId",
    "/api/youtube/stream/:jobId", "/api/x-articles/stream/:jobId", "/api/tiktok/stream/:jobId",
    "/api/vimeo/stream/:jobId", "/api/benchmark/runs/:id/judge-stream",
  ].map((p) => [p, STREAM] as const),
  ["/api/claude-usage/overview", LEDGER],
  ["/api/plans/board", `${LEDGER}, plus the local plans directory`],
  ["/api/wiki/page", "the cached wiki index and one page file; it reads no `refresh` parameter"],
]);

/** Paths on the list that no Hono route registers, each with the reason. */
const NOT_HONO: ReadonlyMap<string, string> = new Map([
  ["/simulator/pending/", "the legacy alias `src/index.ts` 301s to `/chat/pending/`"],
  ["/chat/ws", "the WS upgrade, handled in `Bun.serve`'s fetch before `app.fetch`"],
  ["/simulator/ws", "the WS upgrade alias, handled in `Bun.serve`'s fetch"],
]);

/** A `refresh` read in a route source: `query("refresh")` or `queries("refresh")`. */
const REFRESH_READ = /\.quer(?:y|ies)\(\s*["'`]refresh["'`]\s*\)/g;
/** A GET registration with a literal path. */
const GET_REGISTRATION = /\.get\(\s*["'`]([^"'`]+)["'`]/g;

/**
 * Every `refresh` read in the route sources, attributed to the nearest GET
 * registration above it in the same file (`null` when there is none).
 */
function refreshReads(): { file: string; path: string | null }[] {
  const root = join(import.meta.dir, "..");
  const out: { file: string; path: string | null }[] = [];
  for (const dir of ["dashboard", "chat"]) {
    for (const rel of new Glob("**/*.ts").scanSync(join(root, dir))) {
      if (rel.endsWith(".test.ts")) continue;
      const file = join(dir, rel);
      const text = readFileSync(join(root, file), "utf8");
      const gets = [...text.matchAll(GET_REGISTRATION)].map((m) => ({ at: m.index!, path: m[1]! }));
      for (const m of text.matchAll(REFRESH_READ)) {
        const before = gets.filter((g) => g.at < m.index!);
        out.push({ file, path: before.length ? before[before.length - 1]!.path : null });
      }
    }
  }
  return out;
}

/** `ALL` is what `app.all`/`app.mount` register: a GET reaches it. */
const READ_METHODS = new Set(["GET", "ALL"]);

function getRoutes(): string[] {
  const app = new Hono();
  app.route("/", createDashboardRoutes(CONFIG));
  app.route("/chat", createChatRoutes([], CONFIG));
  return [...new Set(app.routes.filter((r) => READ_METHODS.has(r.method)).map((r) => r.path))];
}

/** A concrete path for a route pattern: every `:param` and `*` becomes one segment. */
function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z_]+(\{[^}]*\})?\??/g, "probe").replace(/\*/g, "probe");
}

describe("every GET route is classified for the origin guard", () => {
  const routes = getRoutes();

  test("the walk found the GET surface (not an empty route table)", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  test("each GET is on SIDE_EFFECTING_GETS or READ_ONLY_GETS, never both and never neither", () => {
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const route of routes) {
      const listed = isSideEffectingRequest("GET", concrete(route));
      const allowed = READ_ONLY_GETS.has(route);
      if (listed && allowed) both.push(route);
      if (!listed && !allowed) unclassified.push(route);
    }
    expect({ unclassified, both }).toEqual({ unclassified: [], both: [] });
  });

  test("every READ_ONLY_GETS entry is a registered GET (no stale entries)", () => {
    const registered = new Set(routes);
    expect([...READ_ONLY_GETS.keys()].filter((p) => !registered.has(p))).toEqual([]);
  });

  test("every SIDE_EFFECTING_GETS entry reaches a registered GET or names why it cannot", () => {
    const probes = routes.map(concrete);
    const stale = SIDE_EFFECTING_GETS.filter(
      (entry) =>
        !NOT_HONO.has(entry) &&
        !probes.some((p) => (entry.endsWith("/") ? p.startsWith(entry) : p === entry)),
    );
    expect(stale).toEqual([]);
  });

  test("a GET whose `?refresh=1` forces a rebuild is listed for that variant only", () => {
    for (const path of REFRESH_SIDE_EFFECTING_GETS) {
      expect({ path, routed: routes.includes(path) }).toEqual({ path, routed: true });
      for (const method of ["GET", "HEAD"]) {
        const on = (q: string) => isSideEffectingRequest(method, path, new URLSearchParams(q));
        expect({ path, method, plain: on(""), zero: on("refresh=0"), one: on("refresh=1"), any: on("refresh=0&refresh=1") })
          .toEqual({ path, method, plain: false, zero: false, one: true, any: true });
      }
    }
  });

  test("every `refresh` read in a GET route is on a list, and every refresh entry is read", () => {
    const reads = refreshReads();
    expect(reads.length).toBeGreaterThan(0);
    const unclassified = reads.filter(
      (r) =>
        r.path === null ||
        (!REFRESH_SIDE_EFFECTING_GETS.includes(r.path) && !isSideEffectingRequest("GET", concrete(r.path))),
    );
    expect(unclassified).toEqual([]);
    const readPaths = new Set(reads.map((r) => r.path));
    expect(REFRESH_SIDE_EFFECTING_GETS.filter((p) => !readPaths.has(p))).toEqual([]);
  });

  test("the search, similarity and embedding amplifiers are listed (finding 49)", () => {
    for (const path of [
      "/api/search/search",
      "/api/graph/similarity",
      "/api/graph/author",
      "/api/memsearch",
      "/api/summaries/same-story",
      "/api/research/similar",
      "/api/youtube/similar",
      "/api/wiki/similar",
      "/api/wiki/atlas",
    ]) {
      expect({ path, listed: isSideEffectingRequest("GET", path) }).toEqual({ path, listed: true });
    }
    // Exact paths: the cheap siblings the pages load stay read-only.
    expect(isSideEffectingRequest("GET", "/api/graph/collections")).toBe(false);
    expect(isSideEffectingRequest("GET", "/api/search/health")).toBe(false);
    expect(isSideEffectingRequest("GET", "/api/search/searchx")).toBe(false);
  });
});
