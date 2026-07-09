/**
 * Manual "ingest backlog" drain — shared constants, the per-bot gardener mutex,
 * and the pure batch-selection + assembly logic behind the `/wiki/gardener`
 * "Ingest backlog (N)" button.
 *
 * The weekly wiki-gardener only ever clusters a *recent* window of summaries, so
 * the all-time tail of never-ingested summary docs grows unbounded (see
 * `src/wiki/ingest-backlog.ts`). This module drains that tail through the SAME
 * gardener pipeline, in bounded batches, on demand — one click replaces a manual
 * ingest session, and every judgment call still becomes a reviewable proposal in
 * the existing gate.
 *
 * The mechanism is the **consumed-complement trick**: rather than teach
 * `harvestDocs` a new "only these ids" option, we tell `runGardener` that every
 * listed doc EXCEPT the selected batch is already consumed — its existing
 * consumed-filter then caps harvest to exactly the batch. `lookbackDays` is set
 * to ~10 years so the window filter never drops an old backlog doc.
 *
 * Constants live here (not in the checker or the route) so route, helper, and
 * weekly checker cannot drift on the batch size, proposal cap, or draft timeout.
 */

import type { WatcherAlert } from "../types.ts";
import type { QueuedDoc, ListedDoc as WikiListedDoc } from "../wiki/ingest-backlog.ts";
import type { SummaryCollectionListings } from "../summaries/list-collections.ts";
import { computeIngestBacklog } from "../wiki/ingest-backlog.ts";
import { SUMMARY_SOURCES } from "../summaries/sources.ts";
import { docDateMs } from "./harvest.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "backlog");

/** Max backlog docs harvested + clustered per manual run (bounded, one click). */
export const BACKLOG_BATCH_SIZE = 40;
/** Max proposals a single backlog run may draft (raised from the weekly 3). */
export const BACKLOG_MAX_PROPOSALS = 8;
/** Per-draft one-shot timeout, ms — shared with the weekly checker (was private there). */
export const DRAFT_TIMEOUT_MS = 300_000;
/** Look back ~10 years so the harvest window filter never drops a backlog doc. */
export const BACKLOG_LOOKBACK_DAYS = 3650;

/** The `watcher_snapshots` key holding a bot's already-offered backlog keys. */
export const WIKI_GARDENER_OFFERED_KEY = "backlog:offered";

// ── Per-bot gardener mutex ───────────────────────────────────────────────────
//
// Both the manual backlog run and the weekly `checkWikiGardener` acquire this so
// a drain and an organic weekly run never overlap for the same bot. The stored
// value is the in-flight run promise (callers only ever check `.has()` — nobody
// awaits it), so a settled/rejected run always clears its own entry.

const gardenerRuns = new Map<string, Promise<unknown>>();

/** True when a gardener run (backlog or weekly) is in flight for the bot. */
export function gardenerRunInFlight(botName: string): boolean {
  return gardenerRuns.has(botName);
}

/**
 * Run `work` under the per-bot gardener mutex. Returns `null` WITHOUT starting
 * anything when a run is already in flight for the bot; otherwise registers the
 * promise, starts the work, and releases in `finally` (always). The entry is set
 * synchronously before returning, so two calls in the same tick can never both
 * acquire.
 */
export function runExclusive<T>(botName: string, work: () => Promise<T>): Promise<T> | null {
  if (gardenerRuns.has(botName)) return null;
  const p = (async () => work())().finally(() => gardenerRuns.delete(botName));
  gardenerRuns.set(botName, p);
  return p;
}

/** Test-only: clear the gardener mutex between cases. */
export function __resetGardenerMutexForTest(): void {
  gardenerRuns.clear();
}

// ── Batch selection ──────────────────────────────────────────────────────────

/** A backlog candidate selected for draining — `<collection>/<id>` is its key. */
export interface BacklogCandidate {
  collection: string;
  id: string;
  key: string;
  date?: string;
}

/**
 * Select the batch to drain: newest-first over the queued docs (by listing
 * date), drop keys already offered in a prior run, and take at most
 * {@link BACKLOG_BATCH_SIZE}. Pure — the offered-memory read + persist live in
 * the caller.
 */
export function selectBacklogBatch(
  queuedDocs: QueuedDoc[],
  offeredKeys: Set<string>,
  batchSize: number = BACKLOG_BATCH_SIZE,
): BacklogCandidate[] {
  const cands: BacklogCandidate[] = queuedDocs.map((d) => ({
    collection: d.collection,
    id: d.id,
    key: `${d.collection}/${d.id}`,
    ...(d.date ? { date: d.date } : {}),
  }));
  // Newest-first; undated docs sort last (treated as −∞).
  cands.sort(
    (a, b) =>
      (docDateMs(b) ?? Number.NEGATIVE_INFINITY) - (docDateMs(a) ?? Number.NEGATIVE_INFINITY),
  );
  return cands.filter((c) => !offeredKeys.has(c.key)).slice(0, batchSize);
}

// ── Backlog assembly (huginn listed ONCE, then reused) ───────────────────────

/** Seams the assembly step needs — all injectable so it's unit-testable. */
export interface AssembleBacklogDeps {
  botName: string;
  wikiDir: string;
  apiUrl: string;
  listCollections: (apiUrl: string) => Promise<SummaryCollectionListings>;
  sweepWikiUrls: (root: string) => Promise<Set<string>>;
  getConsumed: (botName: string) => Promise<Set<string>>;
  getPending: (botName: string) => Promise<Set<string>>;
  getOffered: () => Promise<Set<string>>;
}

export interface AssembledBacklog {
  /** Listing snapshot (collection → wiki-shaped listed docs) — huginn listed once. */
  listedBySource: Record<string, WikiListedDoc[]>;
  /** Keys of the selected batch (excludes already-offered), newest-first. */
  batchKeys: string[];
  /** consumed-complement: every listed key EXCEPT the batch (harvest's cap). */
  consumedComplement: Set<string>;
  /** The already-offered set read this run (so the caller persists the union). */
  offeredBefore: Set<string>;
  /** Total queued (all-time never-ingested) across all collections. */
  queuedCount: number;
}

/**
 * List every summary collection ONCE, sweep the wiki for referenced URLs, pull
 * the consumed/pending/offered sets, partition into queued docs, and select the
 * batch. Returns the listing snapshot (so `runGardener.listDocs` never re-lists
 * huginn) plus the consumed-complement + batch keys.
 */
export async function assembleBacklog(deps: AssembleBacklogDeps): Promise<AssembledBacklog> {
  const { byCollection: listedRaw, errors } = await deps.listCollections(deps.apiUrl);
  if (errors.length) {
    log.warn("Backlog assemble: {n} collection(s) failed to list — draining partial data", {
      botName: deps.botName,
      n: errors.length,
    });
  }

  const listedBySource: Record<string, WikiListedDoc[]> = {};
  for (const source of SUMMARY_SOURCES) {
    listedBySource[source.collection] = (listedRaw[source.collection] ?? []).map((d) => ({
      collection: source.collection,
      id: d.id,
      ...(d.url ? { url: d.url } : {}),
      ...(d.date ? { date: d.date } : {}),
    }));
  }

  const [wikiUrls, consumed, pending, offeredBefore] = await Promise.all([
    deps.sweepWikiUrls(deps.wikiDir),
    deps.getConsumed(deps.botName),
    deps.getPending(deps.botName),
    deps.getOffered(),
  ]);

  const backlog = computeIngestBacklog(listedBySource, wikiUrls, consumed, pending);
  const queuedDocs = backlog.byCollection.flatMap((c) => c.queuedDocs);
  const batch = selectBacklogBatch(queuedDocs, offeredBefore);
  const batchKeys = batch.map((b) => b.key);

  // consumed-complement — mark every listed key except the batch as consumed, so
  // harvestDocs' existing consumed-filter caps the harvest to exactly the batch.
  const batchSet = new Set(batchKeys);
  const consumedComplement = new Set<string>();
  for (const [collection, docs] of Object.entries(listedBySource)) {
    for (const d of docs) {
      const key = `${collection}/${d.id}`;
      if (!batchSet.has(key)) consumedComplement.add(key);
    }
  }

  return {
    listedBySource,
    batchKeys,
    consumedComplement,
    offeredBefore,
    queuedCount: backlog.queued,
  };
}

// ── Drain orchestration (mutex + at-most-once offered persist + run) ──────────

export interface LastBacklogRun {
  finishedAt: number;
  offered: number;
  drafted: number;
  error?: string;
}

/** The number of proposals a gardener run drafted, from its alert id. */
export function draftedCount(alerts: WatcherAlert[]): number {
  if (!alerts.length) return 0;
  const id = alerts[0]!.id; // "wiki-gardener:<id1,id2,…>"
  const idx = id.indexOf(":");
  if (idx === -1) return 0;
  const rest = id.slice(idx + 1);
  return rest ? rest.split(",").filter(Boolean).length : 0;
}

export interface StartBacklogRunDeps {
  botName: string;
  gardenerEnabled: boolean;
  /** false ⇒ no `wiki-gardener` watcher row seeded (offered memory has no FK). */
  hasWatcher: boolean;
  assemble: () => Promise<AssembledBacklog>;
  /** Persist the new offered set (called BEFORE runGardener — at-most-once). */
  persistOffered: (keys: string[]) => Promise<void>;
  runGardener: (assembled: AssembledBacklog) => Promise<WatcherAlert[]>;
  recordLastRun: (r: LastBacklogRun) => void;
  now?: () => number;
}

export type StartBacklogRunResult = { state: "started" | "running" | "no-watcher" | "disabled" };

/**
 * Kick a detached backlog drain under the per-bot mutex. Returns immediately:
 *  - `no-watcher` — no `wiki-gardener` row (offered memory has no watcher_id FK);
 *  - `disabled`   — the bot's gardener is turned off;
 *  - `running`    — a run is already in flight (a second click is a no-op);
 *  - `started`    — a run began (fire-and-forget; `recordLastRun` fires on settle).
 *
 * The selected batch's keys are persisted to the offered snapshot BEFORE
 * `runGardener` runs — at-most-once semantics: a crashed run skips its batch
 * rather than re-offering it and starving the tail. (A rejected proposal's docs
 * re-enter the queued COUNT but stay offered — never re-offered — recovered only
 * by an explicit reset. Accepted divergence.)
 */
export function startBacklogRun(deps: StartBacklogRunDeps): StartBacklogRunResult {
  if (!deps.hasWatcher) return { state: "no-watcher" };
  if (!deps.gardenerEnabled) return { state: "disabled" };

  const run = runExclusive(deps.botName, async () => {
    const assembled = await deps.assemble();
    // Persist BEFORE running — a crash after this skips the batch, never re-offers it.
    await deps.persistOffered([...new Set([...assembled.offeredBefore, ...assembled.batchKeys])]);
    const alerts = await deps.runGardener(assembled);
    return { offered: assembled.batchKeys.length, drafted: draftedCount(alerts) };
  });
  if (run === null) return { state: "running" };

  const now = deps.now ?? (() => Date.now());
  void run
    .then((r) => deps.recordLastRun({ finishedAt: now(), offered: r.offered, drafted: r.drafted }))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Backlog run failed for {bot}: {error}", { botName: deps.botName, error: message });
      deps.recordLastRun({ finishedAt: now(), offered: 0, drafted: 0, error: message });
    });
  return { state: "started" };
}
