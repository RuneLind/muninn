/**
 * claude-usage ledger route — `GET /api/claude-usage/overview`, the feed for the
 * `/models` **Pipeline ledger** card.
 *
 * A read-only, server-side proxy of claude-usage's `GET /api/pipeline`. It exists
 * so the BROWSER never has to reach port 8787: the dashboard is viewed over the
 * tailnet, where a client-side loopback fetch hits the viewer's own machine and
 * a cross-host one is mixed content under `tailscale serve` HTTPS.
 *
 * Never 5xx — a degraded claude-usage is a card state (`reachable: false` +
 * `errors[]`), the same contract as `/api/indexing/overview`.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import {
  assembleClaudeUsageOverview,
  clampDays,
  defaultClaudeUsageDeps,
  type ClaudeUsageDeps,
} from "../claude-usage-overview.ts";

export function registerClaudeUsageRoutes(
  app: Hono,
  config: Config,
  deps: ClaudeUsageDeps = defaultClaudeUsageDeps(
    config.claudeUsageUrl,
    config.claudeUsageConfigured,
  ),
): void {
  app.get("/api/claude-usage/overview", async (c) => {
    const days = clampDays(c.req.query("days"));
    return c.json(await assembleClaudeUsageOverview(deps, days));
  });
}
