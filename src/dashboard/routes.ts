import { Hono } from "hono";
import { resolveProfile, type Config, type MuninnProfile } from "../config.ts";
import { sessionRole } from "../auth/guard.ts";
import { HEALTH_LIVE_PATH, HEALTH_READY_PATH } from "../auth/zones.ts";
import { readiness } from "./health.ts";
import { renderDashboardPage } from "./views/page.ts";
import { FAVICON_SVG, FAVICON_HEADERS } from "./views/favicon.ts";
import { getDashboardBuildHash } from "./dashboard-build-hash.ts";
import { assembleAttention } from "./home-attention.ts";
import { registerDataRoutes } from "./routes/data-routes.ts";
import { registerTracesRoutes } from "./routes/traces-routes.ts";
import { registerMemsearchRoutes } from "./routes/memsearch-routes.ts";
import { registerLogsRoutes } from "./routes/logs-routes.ts";
import { registerSearchRoutes } from "./routes/search-routes.ts";
import { registerResearchRoutes } from "./routes/research-routes.ts";
import { registerToolsRoutes } from "./routes/tools-routes.ts";
import { registerYouTubeRoutes } from "./routes/youtube-routes.ts";
import { registerXArticleRoutes } from "./routes/x-article-routes.ts";
import { registerTikTokRoutes } from "./routes/tiktok-routes.ts";
import { registerSummariesRoutes } from "./routes/summaries-routes.ts";
import { registerAnthropicRoutes } from "./routes/anthropic-routes.ts";
import { registerArticleRoutes } from "./routes/article-routes.ts";
import { registerSSERoutes } from "./routes/sse-routes.ts";
import { registerGraphRoutes } from "./routes/graph-routes.ts";
import { registerWikiRoutes } from "./routes/wiki-routes.ts";
import { registerWikiGardenerRoutes } from "./routes/wiki-gardener-routes.ts";
import { registerBenchmarkRoutes } from "./routes/benchmark-routes.ts";
import { registerModelsRoutes } from "./routes/models-routes.ts";
import { registerIndexingRoutes } from "./routes/indexing-routes.ts";
import { registerAgentsRoutes } from "./routes/agents-routes.ts";
import { registerSyncRoutes } from "./routes/sync-routes.ts";
import { registerClaudeUsageRoutes } from "./routes/claude-usage-routes.ts";
import { registerPlansRoutes } from "./routes/plans-routes.ts";
import { registerJiraRoutes } from "./routes/jira-routes.ts";

/**
 * The route GROUPS a profile can drop, named once so the drop list, the test
 * and the PR body all read the same words. The name is the `register*` call it
 * gates, minus the ceremony.
 */
export type RouteGroup =
  | "data" | "traces" | "memsearch" | "logs" | "search" | "research" | "tools"
  | "summaries" | "anthropic" | "article" | "youtube" | "x-article" | "tiktok"
  | "sse" | "graph" | "wiki" | "wiki-gardener" | "benchmark" | "models"
  | "indexing" | "agents" | "sync" | "claude-usage" | "plans" | "jira";

/**
 * What the `nais` profile does NOT register — **absent, not denied**: there is
 * no handler, so the answer is Hono's own 404 and the route cannot be reached
 * by a role check that someone later relaxes.
 *
 * Two things belong here and nothing else does:
 *
 *  - **Filesystem-bound surfaces.** `wiki`, `wiki-gardener`, `plans` and `sync`
 *    all read and WRITE working trees (`WIKI_EXTRA` roots, mimir's `plans/`,
 *    the repo-sync checkouts) that exist on a laptop and on the mini and simply
 *    do not exist in a pod; `claude-usage` proxies a launchd service on the
 *    mini's loopback. `logs` is here for a different reason with the same
 *    shape: `/logs` + `/api/logs*` serve the JSONL sink verbatim, and those
 *    lines carry other people's message previews.
 *  - **The yt-dlp/ffmpeg capture verticals** — `anthropic`, `article`,
 *    `youtube`, `x-article`, `tiktok`. The nais image ships neither binary
 *    (`WITH_MEDIA=false`), so registering them would answer 500 on a route that
 *    can never work. `benchmark` joins them: it spawns judge runs against the
 *    Claude CLI, which the nais image also drops (`WITH_CLI=false`).
 *
 * Everything else STAYS, deliberately: `data`, `traces`, `memsearch`, `sse`,
 * `models`, `agents`, `indexing` and `jira` are DB- or huginn-bound and are the
 * operator surface the zone model already closes to a role `user`; `search`,
 * `research` and `graph` are huginn HTTP clients; `summaries` reads the job
 * store and huginn (its author-score file degrades to "no author" when absent);
 * `tools` discovers Serena instances from the bots' `.mcp.json` project paths
 * and reports an EMPTY list when there are none — which is what a pod has.
 */
export const NAIS_DROPPED_ROUTE_GROUPS: readonly RouteGroup[] = [
  "wiki", "wiki-gardener", "plans", "sync", "claude-usage", "benchmark", "logs",
  "anthropic", "article", "youtube", "x-article", "tiktok",
];

export interface DashboardRouteOptions {
  /**
   * Which profile decides the drop list. Defaults to `resolveProfile()` — the
   * env — rather than to `config.profile`, because the unit tests that build a
   * `{} as Config` by hand (health, owner-guard) must keep getting today's full
   * surface, and because this is the same one parse `loadConfig` uses.
   */
  readonly profile?: MuninnProfile;
}

/**
 * Every dashboard route, minus whatever the serving profile drops.
 *
 * The five INLINE routes below (`/`, the two health paths, the favicons, the
 * build hash, `/api/attention`) are profile-independent and always present —
 * they are the instance itself, not a feature. So is the `/chat` slice, which
 * is mounted separately in `src/index.ts` and is therefore not filterable here
 * at all: on the nais profile chat is the whole point.
 *
 * `createDashboardRoutes(config)` with no options is byte-for-byte today's
 * behaviour on every instance that does not set `MUNINN_PROFILE`.
 */
export function createDashboardRoutes(config: Config, options?: DashboardRouteOptions): Hono {
  const app = new Hono();
  const profile = options?.profile ?? resolveProfile();
  const dropped: ReadonlySet<string> =
    profile === "nais" ? new Set<string>(NAIS_DROPPED_ROUTE_GROUPS) : new Set<string>();

  // Dashboard home page — role-aware since the zone model landed. `/` is the
  // address people type, and the dashboard behind it is admin-only, so a role
  // `user` is sent to the surface they DO have rather than 403'd at their own
  // bookmark. The branch lives here rather than in the zone middleware because
  // it is a product decision about one route, not a boundary: with auth off
  // `sessionRole` is null and this is byte-identical to what it was.
  app.get("/", async (c) => {
    if (sessionRole(c) === "user") return c.redirect("/chat", 302);
    return c.html(await renderDashboardPage());
  });

  /**
   * The open zone: the only two routes an authenticating instance answers with
   * NO credential (`AUTH_EXCLUDED_PATHS`). Registered inline here, beside the
   * other instance-level routes, and deliberately carrying nothing but a
   * verdict — see `src/dashboard/health.ts`.
   */
  app.get(HEALTH_LIVE_PATH, (c) => c.json({ status: "ok" }));
  app.get(HEALTH_READY_PATH, async (c) => {
    const result = await readiness();
    return c.json(result, result.ready ? 200 : 503);
  });

  // Brand favicon. Both paths serve the same SVG — browsers auto-fetch
  // /favicon.ico on every page (so all pages get the icon with no markup),
  // while the app shells also <link> /favicon.svg explicitly.
  const serveFavicon = (c: import("hono").Context) =>
    c.body(FAVICON_SVG, 200, FAVICON_HEADERS);
  app.get("/favicon.svg", serveFavicon);
  app.get("/favicon.ico", serveFavicon);

  // Build hash of the inlined browser bundles — the visibility-change watcher
  // in helpers-browser.ts compares this against the meta tag the page was
  // rendered with and shows a "Muninn was restarted" banner on mismatch.
  app.get("/api/dashboard-build-hash", async (c) => {
    return c.json({ hash: await getDashboardBuildHash() });
  });

  // Home "Attention" surface — stale watchers, pending gardener drafts, failed
  // recent runs. Assembly is the pure, injectable `home-attention.ts`; never 5xx
  // (degraded sources land in `errors[]`).
  app.get("/api/attention", async (c) => {
    return c.json(await assembleAttention());
  });

  // The register* list, wrapped UNIFORMLY first (the two arities are why —
  // filtering a list that mixes `f(app)` and `f(app, config)` invites the drop
  // to be written per-call and drift) and only then filtered. Registration
  // order is preserved exactly as it was.
  const groups: readonly (readonly [RouteGroup, (a: Hono) => void])[] = [
    ["data", (a) => registerDataRoutes(a)],
    ["traces", (a) => registerTracesRoutes(a)],
    ["memsearch", (a) => registerMemsearchRoutes(a)],
    ["logs", (a) => registerLogsRoutes(a, config)],
    ["search", (a) => registerSearchRoutes(a, config)],
    ["research", (a) => registerResearchRoutes(a, config)],
    ["tools", (a) => registerToolsRoutes(a)],
    ["summaries", (a) => registerSummariesRoutes(a, config)],
    ["anthropic", (a) => registerAnthropicRoutes(a, config)],
    ["article", (a) => registerArticleRoutes(a, config)],
    ["youtube", (a) => registerYouTubeRoutes(a, config)],
    ["x-article", (a) => registerXArticleRoutes(a, config)],
    ["tiktok", (a) => registerTikTokRoutes(a, config)],
    ["sse", (a) => registerSSERoutes(a)],
    ["graph", (a) => registerGraphRoutes(a, config)],
    ["wiki", (a) => registerWikiRoutes(a, config)],
    ["wiki-gardener", (a) => registerWikiGardenerRoutes(a)],
    ["benchmark", (a) => registerBenchmarkRoutes(a)],
    ["models", (a) => registerModelsRoutes(a)],
    ["indexing", (a) => registerIndexingRoutes(a, config)],
    ["agents", (a) => registerAgentsRoutes(a)],
    ["sync", (a) => registerSyncRoutes(a, config)],
    ["claude-usage", (a) => registerClaudeUsageRoutes(a, config)],
    ["plans", (a) => registerPlansRoutes(a, config)],
    ["jira", (a) => registerJiraRoutes(a, config)],
  ];

  for (const [name, register] of groups) {
    if (dropped.has(name)) continue;
    register(app);
  }

  return app;
}
