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
import type { KeyLedgerView, TrackerConfig } from "./trackers/types.ts";
import { applyIssueFact, lookupTrackerIssues, raceDeadline, type ProvenanceContext } from "./provenance-service.ts";
import type { GraphIssueNode, GraphKeysLedgerState, GraphPayload, GraphQuery } from "./graph-types.ts";

/**
 * The board's joins onto a built payload, in place: the issue nodes get the
 * lookup's facts and their prices, and the payload `issueLookup` and
 * `keysLedger`. The two joins start together, so a slow huginn cannot spend
 * the deadline claude-usage was never asked inside.
 */
export async function applyBoardJoins(
  payload: GraphPayload,
  query: Pick<GraphQuery, "issueFields" | "keysLedger">,
  trackers: readonly TrackerConfig[],
  ctx: ProvenanceContext,
  opts: { signal?: AbortSignal; deadline?: AbortSignal; wikiRoot?: string } = {},
): Promise<void> {
  if (!query.issueFields && !query.keysLedger) return;
  const issues = payload.nodes.filter((n): n is GraphIssueNode => n.lane === "issue");
  const [lookup, keysLedger] = await Promise.all([
    query.issueFields ? joinIssueFields(issues, trackers, ctx, opts.signal, opts.wikiRoot ?? "") : null,
    query.keysLedger ? joinKeysLedger(issues, trackers, ctx, opts.signal, opts.deadline) : null,
  ]);
  if (lookup) payload.issueLookup = lookup;
  if (keysLedger) payload.keysLedger = keysLedger;
}

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
    if (facts && config) applyIssueFact(n, facts.get(n.key), config, wikiRoot);
  }
  return { available: ids.every((id) => lookups.get(id)) };
}

/** Split a tracker's keys into many-key ledger calls of at most `max`. */
export function ledgerKeyBatches<T>(keys: readonly T[], max: number): T[][] {
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
    for (const batch of ledgerKeyBatches(list, adapter.ledgerKeysMax ?? 200)) {
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
            // An answer that holds no usable row for the key is its own
            // reason: the call reached, and the tooltip says so.
            if (!row) n.keyLedger = rows ? { state: "unpriced", reason: "no-row" } : fail();
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
