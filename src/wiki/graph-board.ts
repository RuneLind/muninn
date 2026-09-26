/**
 * The two network joins the issue board asks `GET /api/wiki/graph` for at
 * `scope=wiki`, applied to the walk's issue nodes after `buildGraph`:
 *
 *  - `fields=issue` — the tracker's lookup (huginn): title, raw status, its
 *    category through the wiki's `statusMap`, last-updated, and `known`;
 *  - `ledger=keys` — one many-key ledger call per `ledgerKeysMax` keys
 *    (`/api/jira/keys`), never one call per key.
 *
 * Both run under the route's ONE deadline and neither can fail the answer: a
 * lookup that does not answer leaves the nodes bare and says so in
 * `issueLookup`; a ledger that does not answer (a claude-usage without the
 * route answers 404) leaves every key `unpriced`, never zero.
 */

import { trackerAdapter } from "./trackers/index.ts";
import { statusCategory } from "./trackers/rows.ts";
import type { KeyLedgerView, TrackerConfig } from "./trackers/types.ts";
import { lookupTrackerIssues, raceDeadline, type ProvenanceContext } from "./provenance-service.ts";
import type { GraphIssueNode, GraphKeysLedgerState } from "./graph-types.ts";

/** Join the trackers' lookups onto the issue nodes, in place. */
export async function joinIssueFields(
  nodes: readonly GraphIssueNode[],
  trackers: readonly TrackerConfig[],
  ctx: ProvenanceContext,
  signal?: AbortSignal,
  /** Names the wiki in the unmapped-status log line. */
  wikiRoot = "",
): Promise<{ available: boolean }> {
  const configOf = new Map(trackers.map((t) => [t.id, t]));
  const ids = [...new Set(nodes.map((n) => n.tracker))];
  const lookups = new Map(await Promise.all(ids.map(async (id) => [id, await lookupTrackerIssues(id, ctx, signal)] as const)));
  for (const n of nodes) {
    const facts = lookups.get(n.tracker);
    const config = configOf.get(n.tracker);
    if (!facts || !config) continue;
    const fact = facts.get(n.key);
    n.known = !!fact;
    n.category = statusCategory(fact?.status, config, wikiRoot);
    if (fact?.title) n.title = fact.title;
    if (fact?.status) n.status = fact.status;
    if (fact?.updated) n.updated = fact.updated;
  }
  return { available: ids.every((id) => lookups.get(id)) };
}

/** Split keys into calls of at most `max`. */
export function batchKeys<T>(keys: readonly T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < keys.length; i += Math.max(1, max)) out.push(keys.slice(i, i + Math.max(1, max)));
  return out;
}

/**
 * Price every issue node through its tracker's many-key ledger path, in
 * place. A key outside the tracker's `ledgerProjects` is `not-tracked` and
 * never asked (Connections' rule), and so is a key the ledger answers
 * `tracked: false` for.
 */
export async function joinKeysLedger(
  nodes: readonly GraphIssueNode[],
  trackers: readonly TrackerConfig[],
  ctx: ProvenanceContext,
  signal?: AbortSignal,
  deadline?: AbortSignal,
): Promise<GraphKeysLedgerState> {
  const configOf = new Map(trackers.map((t) => [t.id, t]));
  const fetchPath = ctx.sessionLedger.urlConfigured ? ctx.sessionLedger.fetchIssueLedger : undefined;
  const ask = new Map<string, GraphIssueNode[]>(); // tracker → nodes to price
  for (const n of nodes) {
    const config = configOf.get(n.tracker);
    const adapter = trackerAdapter(n.tracker);
    const project = adapter?.projectOf(n.key);
    if (!config || !project || !config.ledgerProjects.includes(project)) n.keyLedger = { state: "not-tracked" };
    else if (!fetchPath || !adapter?.ledgerKeysPath || !adapter.parseLedgerKeys) {
      n.keyLedger = { state: "unpriced", reason: "not-configured" };
    } else {
      const list = ask.get(n.tracker);
      if (list) list.push(n);
      else ask.set(n.tracker, [n]);
    }
  }

  let calls = 0;
  let reachable = true;
  const jobs: Promise<void>[] = [];
  for (const [tracker, list] of ask) {
    const adapter = trackerAdapter(tracker)!;
    for (const batch of batchKeys(list, adapter.ledgerKeysMax ?? 200)) {
      calls++;
      jobs.push(
        (async () => {
          const fail = (): KeyLedgerView => ({ state: "unpriced", reason: signal?.aborted ? "deadline" : "unreachable" });
          let rows: ReturnType<NonNullable<typeof adapter.parseLedgerKeys>> = null;
          try {
            if (!signal?.aborted) {
              // Raced as well as handed the signal: a fetch that ignored it
              // would otherwise hold the board open.
              const raw = await raceDeadline(fetchPath!(adapter.ledgerKeysPath!(batch.map((n) => n.key)), signal), signal);
              if (!(raw === null && signal?.aborted)) rows = adapter.parseLedgerKeys!(raw);
            }
          } catch {
            rows = null;
          }
          if (!rows) reachable = false;
          for (const n of batch) {
            const row = rows?.get(n.key.toUpperCase());
            if (!row) n.keyLedger = fail();
            else if (!row.tracked) n.keyLedger = { state: "not-tracked" };
            else {
              const { tracked: _t, ...priced } = row;
              n.keyLedger = { state: "priced", ...priced };
            }
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  return {
    configured: ctx.sessionLedger.urlConfigured,
    calls,
    reachable: calls > 0 ? reachable : false,
    timedOut: deadline?.aborted === true,
  };
}
