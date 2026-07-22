import { Hono } from "hono";
import type { Config } from "../config.ts";
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

export function createDashboardRoutes(config: Config): Hono {
  const app = new Hono();

  // Dashboard home page
  app.get("/", async (c) => {
    return c.html(await renderDashboardPage());
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

  registerDataRoutes(app);
  registerTracesRoutes(app);
  registerMemsearchRoutes(app);
  registerLogsRoutes(app, config);
  registerSearchRoutes(app, config);
  registerResearchRoutes(app, config);
  registerToolsRoutes(app);
  registerSummariesRoutes(app, config);
  registerAnthropicRoutes(app, config);
  registerArticleRoutes(app, config);
  registerYouTubeRoutes(app, config);
  registerXArticleRoutes(app, config);
  registerTikTokRoutes(app, config);
  registerSSERoutes(app);
  registerGraphRoutes(app, config);
  registerWikiRoutes(app, config);
  registerWikiGardenerRoutes(app);
  registerBenchmarkRoutes(app);
  registerModelsRoutes(app);
  registerIndexingRoutes(app, config);
  registerAgentsRoutes(app);

  return app;
}
