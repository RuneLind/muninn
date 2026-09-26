/**
 * `GET /api/wiki/graph?wiki=&scope=page|issue|series|wiki&root=&depth=&level=`
 * — the reader's graph mode: typed nodes in four lanes (issues, pages,
 * sessions, PRs) and the edges between them. The walk is
 * `src/wiki/trackers/graph.ts`; the wire shape and the query rules are
 * `graph-types.ts`.
 *
 * Registered inside the `wiki` route group, so `MUNINN_PROFILE=nais` drops it
 * with the rest of `/wiki`, and listed on `SIDE_EFFECTING_GETS`: at level 2 and
 * up one GET fans out into claude-usage calls, bounded by
 * `GRAPH_SESSIONS_MAX` and by one `PROVENANCE_BUDGET_MS` deadline.
 *
 * A wiki with no `trackers` block answers 404: graph mode is a tracker
 * surface, and the reader offers no toggle there.
 */

import type { Hono } from "hono";
import { getWikiIndex } from "../../wiki/store.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { PROVENANCE_BUDGET_MS, type ProvenanceContext } from "../../wiki/provenance-service.ts";
import { buildGraph, graphLedgerPort } from "../../wiki/trackers/graph.ts";
import { parseGraphQuery } from "../../wiki/trackers/graph-types.ts";

export function registerWikiGraphRoute(app: Hono, ctx: ProvenanceContext): void {
  app.get("/api/wiki/graph", async (c) => {
    const parsed = parseGraphQuery({
      scope: c.req.query("scope"),
      root: c.req.query("root"),
      depth: c.req.query("depth"),
      level: c.req.query("level"),
    });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    // One deadline over every ledger read, armed only when a level reaches the
    // ledger at all — level 1 is index-local.
    const signal =
      parsed.query.level >= 2 && ctx.sessionLedger.urlConfigured
        ? AbortSignal.timeout(ctx.budgetMs ?? PROVENANCE_BUDGET_MS)
        : undefined;
    const result = await buildGraph(index, parsed.query, graphLedgerPort(ctx, signal), signal);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result.payload);
  });
}
