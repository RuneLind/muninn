import { Hono } from "hono";
import type { Config } from "../config.ts";
import { renderDashboardPage } from "./views/page.ts";
import { getDashboardBuildHash } from "./dashboard-build-hash.ts";
import { registerDataRoutes } from "./routes/data-routes.ts";
import { registerTracesRoutes } from "./routes/traces-routes.ts";
import { registerMemsearchRoutes } from "./routes/memsearch-routes.ts";
import { registerLogsRoutes } from "./routes/logs-routes.ts";
import { registerSearchRoutes } from "./routes/search-routes.ts";
import { registerResearchRoutes } from "./routes/research-routes.ts";
import { registerToolsRoutes } from "./routes/tools-routes.ts";
import { registerYouTubeRoutes } from "./routes/youtube-routes.ts";
import { registerXArticleRoutes } from "./routes/x-article-routes.ts";
import { registerSummariesRoutes } from "./routes/summaries-routes.ts";
import { registerSSERoutes } from "./routes/sse-routes.ts";
import { registerGraphRoutes } from "./routes/graph-routes.ts";
import { registerBenchmarkRoutes } from "./routes/benchmark-routes.ts";

export function createDashboardRoutes(config: Config): Hono {
  const app = new Hono();

  // Dashboard home page
  app.get("/", async (c) => {
    return c.html(await renderDashboardPage());
  });

  // Build hash of the inlined browser bundles — the visibility-change watcher
  // in helpers-browser.ts compares this against the meta tag the page was
  // rendered with and shows a "Muninn was restarted" banner on mismatch.
  app.get("/api/dashboard-build-hash", async (c) => {
    return c.json({ hash: await getDashboardBuildHash() });
  });

  registerDataRoutes(app);
  registerTracesRoutes(app);
  registerMemsearchRoutes(app);
  registerLogsRoutes(app, config);
  registerSearchRoutes(app, config);
  registerResearchRoutes(app, config);
  registerToolsRoutes(app);
  registerSummariesRoutes(app, config);
  registerYouTubeRoutes(app, config);
  registerXArticleRoutes(app, config);
  registerSSERoutes(app);
  registerGraphRoutes(app, config);
  registerBenchmarkRoutes(app);

  return app;
}
