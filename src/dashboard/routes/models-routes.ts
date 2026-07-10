import type { Hono } from "hono";
import { renderModelsPage } from "../views/models-page.ts";
import {
  assembleModelsOverview,
  DEFAULT_MODELS_OVERVIEW_DEPS,
  type ModelsOverviewDeps,
} from "../models-overview.ts";

/**
 * `/models` page + `GET /api/models/overview` (JSON). The overview is assembled
 * fresh on every request — it's a cheap in-process read (config + two small
 * aggregate queries), and staleness would defeat the "what's actually
 * configured right now" purpose. `deps` is injectable for the route test.
 */
export function registerModelsRoutes(
  app: Hono,
  deps: ModelsOverviewDeps = DEFAULT_MODELS_OVERVIEW_DEPS,
): void {
  app.get("/models", async (c) => {
    return c.html(await renderModelsPage());
  });

  app.get("/api/models/overview", async (c) => {
    const bot = c.req.query("bot") || "jarvis";
    const overview = await assembleModelsOverview(bot, deps);
    return c.json(overview);
  });
}
