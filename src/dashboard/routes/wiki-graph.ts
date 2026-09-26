/**
 * `GET /api/wiki/graph?wiki=&scope=page|issue|series|wiki&root=&depth=&level=`
 * — the reader's graph mode: typed nodes in four lanes (issues, pages,
 * sessions, PRs) and the edges between them. The walk is
 * `src/wiki/graph.ts`; the wire shape and the query rules are
 * `graph-types.ts`.
 *
 * At `scope=wiki` the issue board adds `keyless=1`, `fields=issue` and
 * `ledger=keys` (`graph-board.ts`); without them the answer is PR 4's.
 *
 * Registered inside the `wiki` route group, so `MUNINN_PROFILE=nais` drops it
 * with the rest of `/wiki`, and listed on `SIDE_EFFECTING_GETS`: at level 2 and
 * up one GET fans out into claude-usage calls, bounded by
 * `GRAPH_SESSIONS_MAX` and by one `PROVENANCE_BUDGET_MS` deadline; with
 * `ledger=keys` into one more call per 200 keys, and with `fields=issue` into
 * huginn.
 *
 * A wiki with no `trackers` block answers 404: graph mode is a tracker
 * surface, and the reader offers no toggle there.
 */

import type { Hono } from "hono";
import { getWikiIndex } from "../../wiki/store.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { PROVENANCE_BUDGET_MS, type ProvenanceContext } from "../../wiki/provenance-service.ts";
import { buildGraph, graphLedgerPort } from "../../wiki/graph.ts";
import { joinIssueFields, joinKeysLedger } from "../../wiki/graph-board.ts";
import { parseGraphQuery, type GraphIssueNode } from "../../wiki/graph-types.ts";

export function registerWikiGraphRoute(app: Hono, ctx: ProvenanceContext): void {
  app.get("/api/wiki/graph", async (c) => {
    const parsed = parseGraphQuery({
      scope: c.req.query("scope"),
      root: c.req.query("root"),
      depth: c.req.query("depth"),
      level: c.req.query("level"),
      keyless: c.req.query("keyless"),
      fields: c.req.query("fields"),
      ledger: c.req.query("ledger"),
    });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { query } = parsed;
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    // One deadline over every network read, armed only when the request makes
    // one — level 1 with no board opt-in is index-local. A client that goes
    // away aborts the fan-out too; only the deadline reads as `timedOut`.
    const ledgerLeg = ctx.sessionLedger.urlConfigured && (query.level >= 2 || query.keysLedger === true);
    const deadline =
      ledgerLeg || query.issueFields ? AbortSignal.timeout(ctx.budgetMs ?? PROVENANCE_BUDGET_MS) : undefined;
    const signal = deadline ? AbortSignal.any([c.req.raw.signal, deadline]) : undefined;
    const result = await buildGraph(index, query, graphLedgerPort(ctx, signal, deadline));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const payload = result.payload;
    if (query.issueFields || query.keysLedger) {
      const issues = payload.nodes.filter((n): n is GraphIssueNode => n.lane === "issue");
      const trackers = index.readerConfig?.trackers ?? [];
      // Started together: a slow huginn must not spend the deadline
      // claude-usage was never asked inside.
      const [lookup, keysLedger] = await Promise.all([
        query.issueFields ? joinIssueFields(issues, trackers, ctx, signal, entry?.root ?? "") : null,
        query.keysLedger ? joinKeysLedger(issues, trackers, ctx, signal, deadline) : null,
      ]);
      if (lookup) payload.issueLookup = lookup;
      if (keysLedger) payload.keysLedger = keysLedger;
    }
    return c.json(payload);
  });
}
