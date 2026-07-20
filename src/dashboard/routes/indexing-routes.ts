import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderIndexingPage } from "../views/indexing-page.ts";
import {
  assembleIndexingOverview,
  defaultIndexingDeps,
  type IndexingOverviewDeps,
} from "../indexing-overview.ts";

/**
 * `/indexing` page + `GET /api/indexing/overview` (JSON) — the read surface for
 * huginn's indexing-run ledger. The overview is the pure, injectable
 * `assembleIndexingOverview` over a `fetchJobs()` seam that proxies huginn's
 * `GET /api/indexing/jobs?history=N`. Never 5xx: an unreachable huginn lands in
 * the payload's `errors[]` (200), and the client shows an error banner.
 *
 * `deps` stays injectable for the overview test; production wires the
 * huginn-backed default from `config.knowledgeApiUrl`.
 */
export function registerIndexingRoutes(
  app: Hono,
  config: Config,
  deps: IndexingOverviewDeps = defaultIndexingDeps(config.knowledgeApiUrl),
): void {
  app.get("/indexing", async (c) => {
    return c.html(await renderIndexingPage());
  });

  app.get("/api/indexing/overview", async (c) => {
    const overview = await assembleIndexingOverview(deps);
    return c.json(overview);
  });
}
