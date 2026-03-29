import { Hono } from "hono";
import type { Config } from "../config.ts";
import { renderDashboardPage } from "./views/page.ts";
import { registerDataRoutes } from "./routes/data-routes.ts";
import { registerTracesRoutes } from "./routes/traces-routes.ts";
import { registerMemsearchRoutes } from "./routes/memsearch-routes.ts";
import { registerLogsRoutes } from "./routes/logs-routes.ts";
import { registerSearchRoutes } from "./routes/search-routes.ts";
import { registerResearchRoutes } from "./routes/research-routes.ts";
import { registerToolsRoutes } from "./routes/tools-routes.ts";
import { registerYouTubeRoutes } from "./routes/youtube-routes.ts";
import { registerXArticleRoutes } from "./routes/x-article-routes.ts";
import { registerSSERoutes } from "./routes/sse-routes.ts";
import { registerGraphRoutes } from "./routes/graph-routes.ts";

export function createDashboardRoutes(config: Config): Hono {
  const app = new Hono();

  // Dashboard home page
  app.get("/", (c) => {
    return c.html(renderDashboardPage());
  });

  registerDataRoutes(app);
  registerTracesRoutes(app);
  registerMemsearchRoutes(app);
  registerLogsRoutes(app, config);
  registerSearchRoutes(app, config);
  registerResearchRoutes(app, config);
  registerToolsRoutes(app);
  registerYouTubeRoutes(app, config);
  registerXArticleRoutes(app, config);
  registerSSERoutes(app);
  registerGraphRoutes(app, config);

  return app;
}
