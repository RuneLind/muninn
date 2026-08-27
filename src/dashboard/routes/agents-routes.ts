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
 * overview for up-next + recent. An IDLE page (no run starting or finishing)
 * refreshes on four triggers, none of which existed before: a visible-only 30 s
 * poll, the tab becoming visible (sharing the poll's floor), an SSE RECONNECT,
 * and one short retry per failure streak. A stream that closed for good — a
 * non-200, which EventSource never retries — ends the LIVE zone only; the poll
 * stops for the overview's OWN 401/403 and nothing else. `deps` stays
 * injectable for the overview test.
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
