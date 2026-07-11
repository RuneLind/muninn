import type { Hono } from "hono";
import { renderAgentsPage } from "../views/agents-page.ts";
import {
  assembleAgentsOverview,
  DEFAULT_AGENTS_OVERVIEW_DEPS,
  type AgentsOverviewDeps,
} from "../agents-overview.ts";

/**
 * `/agents` live-agent dashboard + `GET /api/agents/overview` (JSON). The page
 * renders a server shell; the client subscribes to the `agent_runs` SSE event
 * (on the shared `/api/events` stream) for the live zone and fetches the
 * overview for up-next + recent. `deps` stays injectable for the overview test.
 */
export function registerAgentsRoutes(
  app: Hono,
  deps: AgentsOverviewDeps = DEFAULT_AGENTS_OVERVIEW_DEPS,
): void {
  app.get("/agents", async (c) => {
    return c.html(await renderAgentsPage());
  });

  app.get("/api/agents/overview", async (c) => {
    const overview = await assembleAgentsOverview(deps);
    return c.json(overview);
  });
}
