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
 *
 * **`?days=` is a curl-only debugging axis.** The card never sends it — it polls
 * the bare route and renders whatever window the default names. It is kept
 * because widening the window by hand is how the ledger's own numbers get
 * cross-checked against `:8787` directly, and it is safe to keep because
 * `clampDays` mirrors upstream `clampInt` exactly (same `Number()`/`Math.round`
 * semantics, same 1–90 clamp), so the two services cannot answer one query
 * string with two different windows.
 *
 * The `CLAUDE_USAGE_URL` DEFAULT is applied here, not in `config.ts`: config
 * reports only whether the operator set it (null ⇒ unset), and `configured` is
 * derived from that one fact at this layer — the `src/sync/` idiom.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import {
  assembleClaudeUsageOverview,
  clampDays,
  defaultClaudeUsageDeps,
  CLAUDE_USAGE_DEFAULT_URL,
  type ClaudeUsageDeps,
} from "../claude-usage-overview.ts";

export function registerClaudeUsageRoutes(
  app: Hono,
  config: Config,
  deps: ClaudeUsageDeps = defaultClaudeUsageDeps(
    config.claudeUsageUrl ?? CLAUDE_USAGE_DEFAULT_URL,
    config.claudeUsageUrl != null,
  ),
): void {
  app.get("/api/claude-usage/overview", async (c) => {
    const days = clampDays(c.req.query("days"));
    return c.json(await assembleClaudeUsageOverview(deps, days));
  });
}
