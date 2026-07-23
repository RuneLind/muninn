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
import type { GardenerProgress } from "./runner.ts";
import type { ClusterDropTally, ClusterDropReason } from "./cluster.ts";
import type { QueuedDoc, ListedDoc as WikiListedDoc, WikiRefs } from "../wiki/ingest-backlog.ts";
import type { SummaryCollectionListings } from "../summaries/list-collections.ts";
import { computeIngestBacklog } from "../wiki/ingest-backlog.ts";
import { SUMMARY_SOURCES } from "../summaries/sources.ts";
import { docDateMs, DAY_MS } from "./harvest.ts";
import { GARDENER_DEFAULTS } from "./types.ts";
import { agentStatus } from "../observability/agent-status.ts";
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
/**
 * The `watcher_snapshots` key holding the in-flight run journal (PR 3). Written
 * BEFORE the offered set is persisted, cleared only on a success/cancel settle
 * (deliberately KEPT on the error settle), so a crash — or a `runGardener` throw —
 * mid-run leaves a durable record the recovery banner routes through Recover/Dismiss.
 */
export const WIKI_GARDENER_RUN_KEY = "backlog:run";
/**
 * The `watcher_snapshots` key holding the most recent run's {@link LastBacklogRun}
 * (PR 3) — the durable fallback the extended GET reads after a restart drops the
 * in-memory `lastBacklogRuns` map.
 */
export const WIKI_GARDENER_LAST_RUN_KEY = "backlog:lastRun";
/**
 * The `watcher_snapshots` key holding the most recent WEEKLY gardener run's
 * {@link WeeklyGardenerRun} outcome — written by `checkWikiGardener` (the watcher
 * path), NOT the drain. Deliberately DISTINCT from `backlog:lastRun` (the drain's
 * {@link LastBacklogRun}, whose `attemptedDocs`/`fallbackDrafted`/… shape would
 * collide): the weekly run knows a different, honest set of facts (clusters found /
 * kept / dropped-by-reason / evicted topics). Backs the strip's weekly-run render
 * branch so a cap-eviction ("26 found, 3 kept, 23 dropped") is visible on
 * `/wiki/gardener` instead of dying as a log line.
 */
export const WIKI_GARDENER_WEEKLY_RUN_KEY = "gardener:lastRun";

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
  backlogProgress.clear();
}

// ── Per-bot backlog progress + soft cancel ───────────────────────────────────
//
// A live, pollable projection of the in-flight backlog run (seeded synchronously
// when the mutex is acquired, cleared when the run settles) plus a cooperative
// cancel flag the runner's `shouldAbort` seam reads. In-memory only — a dashboard
// convenience surfaced by the extended GET, never durable.

/** Live progress of an in-flight backlog drain (null when none is running). */
export interface BacklogProgress {
  stage: "assembling" | "harvesting" | "clustering" | "resolving" | "drafting";
  /** Proposals persisted so far this run. */
  draftsDone: number;
  /** Clusters that survived the post-resolve gate (0 until resolve gates them). */
  draftsTotal: number;
  /** Cluster label currently drafting. */
  currentTopic?: string;
  startedAt: number;
  cancelRequested: boolean;
}

const backlogProgress = new Map<string, BacklogProgress>();

/** The live progress of a bot's in-flight backlog drain, or null when idle. */
export function getBacklogProgress(botName: string): BacklogProgress | null {
  return backlogProgress.get(botName) ?? null;
}

/**
 * Request a soft cancel of a bot's in-flight backlog drain. Returns false when no
 * run is in flight (a cancel click racing the run's natural settle — the likely
 * case). The runner stops after at most one more draft (bounded latency).
 */
export function requestBacklogCancel(botName: string): boolean {
  const p = backlogProgress.get(botName);
  if (!p) return false;
  p.cancelRequested = true;
  return true;
}

/** The optional progress/cancel seams the work fn threads into `runGardener`. */
export interface GardenerRunHooks {
  onProgress?: (p: GardenerProgress) => void;
  shouldAbort?: () => boolean;
  onAborted?: (skippedClusterDocKeys: string[]) => void;
  /** Aggregate cluster-drop tally + post-gate survivor count (mirrors {@link GardenerDeps.onTally}). */
  onTally?: (tally: ClusterDropTally, keptClusters: number) => void;
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
 * The per-doc result the low-volume source-draft fallback seam reports — a minimal
 * projection of the source drafter's outcome (`src/gardener/source-drafter.ts`), kept
 * local so `backlog.ts` stays free of a runtime dependency on the drafter module (the
 * seam is bound to the real `draftOneBacklogDoc` at the route). `drafted`/`error` are
 * real model attempts (count toward the cap); `covered`/`skipped` are cheap
 * deterministic no-ops (don't).
 */
export interface SourceFallbackOutcome {
  outcome: "drafted" | "covered" | "skipped" | "error";
}

/**
 * The low-volume vertical fallback (R4): when a drain produces ZERO gardener cluster
 * drafts — the batch was below `minClusterSize`, the harvest floor tripped, or the
 * cluster-size gate zeroed a batch that ran — draft the batch docs individually as
 * source pages instead, so X/Anthropic/article verticals always produce something
 * reviewable rather than returning empty.
 *
 * Fans out over `batch` (candidates carry `collection`/`id` separately — no key
 * parsing), stopping after {@link BACKLOG_MAX_PROPOSALS} REAL model attempts
 * (`drafted`/`error`); cheap `covered`/`skipped` outcomes don't consume the cap, so
 * a run of already-covered docs at the head can't starve the reachable tail. The seam
 * fetches each doc's body internally (the drain discarded harvested bodies). One
 * doc's draft error never aborts the rest (skip-not-fail, mirroring the source
 * backlog batch). Returns how many docs were actually drafted into proposals.
 *
 * On path (c) the batch can be up to {@link BACKLOG_BATCH_SIZE} (40) docs from a
 * not-actually-low-volume vertical, so this fans out up to the cap (8) in real model
 * one-shots — bounded, and every draft is still gate-reviewable.
 *
 * `hooks.shouldStop` (bound to the run's `cancelRequested` flag) is polled at the top of
 * each iteration so a soft cancel stops the fan-out promptly — already-drafted proposals
 * stay, and the returned count is honest. `hooks.onProgress` reports the running drafted
 * count (+ the current doc key) so the live progress projection isn't wedged while up to
 * 8 real one-shots run.
 */
export async function runSourceFallback(
  batch: BacklogCandidate[],
  draftSourceFallback: (cand: BacklogCandidate) => Promise<SourceFallbackOutcome>,
  botName: string,
  cap: number = BACKLOG_MAX_PROPOSALS,
  hooks?: { shouldStop?: () => boolean; onProgress?: (draftsDone: number, currentKey?: string) => void },
): Promise<number> {
  let drafted = 0;
  let modelAttempts = 0;
  for (const cand of batch) {
    if (modelAttempts >= cap) break;
    // Honor a soft cancel mid-fan-out — stop drafting further docs, keep what landed.
    if (hooks?.shouldStop?.()) break;
    hooks?.onProgress?.(drafted, cand.key);
    let outcome: SourceFallbackOutcome;
    try {
      outcome = await draftSourceFallback(cand);
    } catch (err) {
      // The bound seam is skip-not-fail (returns an `error` outcome rather than
      // throwing), but contain a throw here so one bad doc can't abort the fan-out.
      // A throw is a failed real attempt — it consumes the cap.
      modelAttempts++;
      log.warn("Backlog fallback: drafting {key} for {bot} threw: {error}", {
        botName,
        key: cand.key,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (outcome.outcome === "drafted") {
      drafted++;
      modelAttempts++;
      hooks?.onProgress?.(drafted, cand.key);
    } else if (outcome.outcome === "error") {
      modelAttempts++;
    }
    // covered/skipped are cheap deterministic no-ops — they don't consume the cap.
  }
  return drafted;
}

/**
 * The **age-floor** eligibility predicate — the single source of truth shared by
 * {@link selectBacklogBatch}'s filter and the GET route's `remaining` count (so
 * the drain and the strip can never advertise a different eligible set).
 *
 * A doc is eligible when it is at least `minAgeDays` old OR its date is
 * undeterminable (undated docs are genuinely old backlog — the `undefined` case
 * is explicit because `undefined <= cutoff` is `false`, which would wrongly drop
 * them). Docs newer than `now − minAgeDays` still belong to the weekly gardener's
 * lookback window, so the drain must not touch them (it would burn a fresh
 * 1–9-doc arrival that can't cluster, hiding it from both paths). Both this floor
 * (`<= cutoff`) and the weekly window (`>= cutoff`, `filterWindow`) are inclusive,
 * so a doc exactly at the boundary is covered by at least one path.
 *
 * `doc.id` must be the **bare** doc id (not a `<collection>/<id>` key): `docDateMs`
 * falls back to the `YYYY-MM-DD` filename prefix for undated docs, which a
 * composite key (prefixed with the collection name) would defeat.
 */
export function passesAgeFloor(
  doc: { id: string; date?: string },
  minAgeDays: number,
  now: number,
): boolean {
  const ms = docDateMs(doc);
  return ms === undefined || ms <= now - minAgeDays * DAY_MS;
}

/**
 * Select the batch to drain: newest-first over the queued docs (by listing
 * date), drop keys already offered in a prior run, and take at most
 * {@link BACKLOG_BATCH_SIZE}. Pure — the offered-memory read + persist live in
 * the caller.
 *
 * The age floor is {@link passesAgeFloor} (shared with the route's `remaining`
 * count). It defaults to the gardener's default lookback for callers with no bot
 * config in reach.
 */
export function selectBacklogBatch(
  queuedDocs: QueuedDoc[],
  offeredKeys: Set<string>,
  batchSize: number = BACKLOG_BATCH_SIZE,
  minAgeDays: number = GARDENER_DEFAULTS.lookbackDays,
  now: number = Date.now(),
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
  return cands
    // Age floor via the shared predicate — `c.id` is the bare doc id.
    .filter((c) => passesAgeFloor(c, minAgeDays, now))
    .filter((c) => !offeredKeys.has(c.key))
    .slice(0, batchSize);
}

// ── Backlog assembly (huginn listed ONCE, then reused) ───────────────────────

/** Seams the assembly step needs — all injectable so it's unit-testable. */
export interface AssembleBacklogDeps {
  botName: string;
  wikiDir: string;
  apiUrl: string;
  listCollections: (apiUrl: string) => Promise<SummaryCollectionListings>;
  sweepWikiRefs: (root: string) => Promise<WikiRefs>;
  getConsumed: (botName: string) => Promise<Set<string>>;
  getPending: (botName: string) => Promise<Set<string>>;
  getOffered: () => Promise<Set<string>>;
  /**
   * Age floor (days) for {@link selectBacklogBatch} — the bot's RESOLVED gardener
   * `lookbackDays` (must equal the weekly window, so no doc is invisible to both
   * paths). Defaults to the gardener default when the route omits it.
   */
  minAgeDays?: number;
  /** Clock for the age floor — injectable so the selection is unit-testable. */
  now?: number;
}

export interface AssembledBacklog {
  /** Listing snapshot (collection → wiki-shaped listed docs) — huginn listed once. */
  listedBySource: Record<string, WikiListedDoc[]>;
  /** Keys of the selected batch (excludes already-offered), newest-first. */
  batchKeys: string[];
  /**
   * The selected candidates (collection/id/date SEPARATE) behind {@link batchKeys},
   * in the same newest-first order — so the low-volume source-draft fallback (R4) can
   * draft each doc individually without parsing a composite `<collection>/<id>` key
   * (doc ids routinely contain slashes, e.g. `ai/rag/Foo.md`, so a naive split
   * corrupts both). `assembleBacklog` always sets this; optional only so the many
   * hand-built `AssembledBacklog` test fixtures that don't exercise the fallback need
   * not carry it (absent ⇒ the fallback finds nothing to draft, a safe no-op).
   */
  batch?: BacklogCandidate[];
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

  const [wikiRefs, consumed, pending, offeredBefore] = await Promise.all([
    deps.sweepWikiRefs(deps.wikiDir),
    deps.getConsumed(deps.botName),
    deps.getPending(deps.botName),
    deps.getOffered(),
  ]);

  const backlog = computeIngestBacklog(listedBySource, wikiRefs, consumed, pending);
  const queuedDocs = backlog.byCollection.flatMap((c) => c.queuedDocs);
  const batch = selectBacklogBatch(
    queuedDocs,
    offeredBefore,
    BACKLOG_BATCH_SIZE,
    deps.minAgeDays ?? GARDENER_DEFAULTS.lookbackDays,
    deps.now ?? Date.now(),
  );
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
    batch,
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
  /** Set when the run was soft-cancelled — `drafted` of `of` clusters drafted. */
  cancelled?: { drafted: number; of: number };
  /**
   * Set when the eligible batch was below `minClusterSize` — the run was provably
   * incapable of drafting (the clusterer needs ≥ minClusterSize docs on one topic),
   * so NOTHING was journalled, offered, or run. `eligible` is the too-small batch
   * size. Distinct from a `drafted: 0`/`offered > 0` run, which DID burn its batch.
   */
  outcome?: "insufficient";
  eligible?: number;
  /** The resolved threshold the guard fired against — for honest UI copy (per-bot configurable). */
  minClusterSize?: number;
  /**
   * How many docs the run ATTEMPTED to draft (the assembled batch size). Persisted
   * alongside {@link dropTally} so a zero-draft run can render "drained N docs, none
   * clustered" — the tally counts CLUSTERS, this counts DOCS (kept distinct in copy).
   */
  attemptedDocs?: number;
  /**
   * The aggregate cluster-drop tally from the run (size/skip/hallucinated/duplicate/
   * cap). Present on a completed run that reached clustering; absent on the
   * harvest-floor early return (renderer falls back to {@link attemptedDocs}) and the
   * `insufficient` short-circuit (which never ran the pipeline). Lets the review gate
   * show WHY a drain drafted nothing without opening the logs.
   */
  dropTally?: ClusterDropTally;
  /**
   * Post-gate cluster survivor count (`resolved.length` from the runner). Present on
   * a completed run that reached clustering. `keptClusters > 0` with `drafted === 0`
   * means every draft attempt failed (draft-call error or shape-gate reject) — the
   * all-zeros {@link dropTally} alone can't distinguish that from "nothing clustered".
   */
  keptClusters?: number;
  /**
   * How many docs the low-volume source-draft fallback (R4) drafted into source-page
   * proposals when the gardener produced ZERO cluster drafts (insufficient batch,
   * harvest floor, or cluster-size gate) AND no clusters survived the gate. The
   * fallback is deliberately SKIPPED when `keptClusters > 0` (clusters formed but every
   * draft failed transiently) — those docs stay cluster-worthy for a re-run rather than
   * being permanently converted to per-doc source pages. A DISTINCT count from {@link drafted}
   * (which counts gardener CLUSTER proposals) — kept separate so the #311 zero-draft
   * rollback (fires on `drafted === 0`) is unaffected and the strip can render the
   * honest "drafted N source pages (fallback — nothing clustered)" copy. Absent/0 ⇒
   * no fallback fired (or it drafted nothing).
   */
  fallbackDrafted?: number;
}

/**
 * One evicted (dropped) cluster in the WEEKLY run's snapshot — the structured,
 * UNtruncated counterpart to {@link ClusterDropTally.clusters_dropped_topics}
 * (which the trace caps ~500 chars). `topicKey` is the cluster's topic slug,
 * `reason` why it was dropped, `size` its doc count.
 */
export interface WeeklyEvictedTopic {
  topicKey: string;
  reason: ClusterDropReason;
  size: number;
}

/**
 * The durable outcome of the most recent WEEKLY wiki-gardener run (the watcher
 * path — NOT the drain). Persisted by `checkWikiGardener` to
 * {@link WIKI_GARDENER_WEEKLY_RUN_KEY} so the review-gate strip can render WHY a
 * weekly run drafted little/nothing (the cap-eviction case) without opening the
 * logs. Declared here (write side) and hand-mirrored in the client strip
 * (`wiki-gardener-strip.ts`) — same client-bundle-hygiene reason {@link LastBacklogRun}
 * is declared twice.
 *
 * `clustersFound === kept + dropped` always holds; `dropTally` carries the per-reason
 * counts (its own topics string stays trace-truncated), and {@link evictedTopics} is
 * the lossless structured tail.
 */
export interface WeeklyGardenerRun {
  finishedAt: number;
  /** Total clusters the run produced (kept + dropped). */
  clustersFound: number;
  /** Clusters that survived the gate (== `resolved.length` == drafted candidates). */
  kept: number;
  /** Clusters dropped across all sites (== `dropTally.clusters_dropped`). */
  dropped: number;
  /** Per-reason drop counts (topics string is trace-truncated; use {@link evictedTopics} for the full tail). */
  dropTally: ClusterDropTally;
  /** The lossless, structured evicted-topic list — never truncated. */
  evictedTopics: WeeklyEvictedTopic[];
}

// ── Run journal + interrupted-run recovery (PR 3, crash safety) ───────────────

/**
 * The durable record of an in-flight backlog run, persisted to `backlog:run`
 * (see {@link WIKI_GARDENER_RUN_KEY}). Written BEFORE the batch is offered so a
 * crash between the journal and the offer recovers as a harmless no-op (it
 * subtracts keys never offered), never the reverse — which would recreate today's
 * unjournaled strand in that window.
 */
export interface RunJournal {
  startedAt: number;
  batchKeys: string[];
}

/** The minimal proposal projection {@link draftedKeysSince} scans (DB-shape subset). */
export interface DraftedScanProposal {
  sourceDocs: { collection: string; docId: string }[];
  createdAt: number;
}

/**
 * The keys of `batchKeys` that a run actually turned into drafts: a batch key is
 * "drafted" when it appears in the `source_docs` of a proposal created **at or
 * after** `startedAt`. The time bound is load-bearing — `source_docs` persist on
 * terminal (rejected/applied) rows too, so after a Reset a re-batched doc could
 * match an OLDER run's rejected proposal and be wrongly counted as drafted (and so
 * never returned to the pool). Pure + DOM/DB-free — the single scan behind BOTH the
 * GET-side `interrupted` count and the in-mutex auto-recover.
 */
export function draftedKeysSince(
  proposals: DraftedScanProposal[],
  startedAt: number,
  batchKeys: string[],
): Set<string> {
  const batch = new Set(batchKeys);
  const drafted = new Set<string>();
  for (const p of proposals) {
    if (p.createdAt < startedAt) continue;
    for (const d of p.sourceDocs) {
      const key = `${d.collection}/${d.docId}`;
      if (batch.has(key)) drafted.add(key);
    }
  }
  return drafted;
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
  /**
   * The bot's RESOLVED gardener `minClusterSize` (`resolveGardenerConfig`). A batch
   * with fewer eligible docs than this cannot possibly cluster, so the work fn
   * short-circuits to an `insufficient` outcome — writing no journal, no offered
   * snapshot, and skipping `runGardener` — rather than burning the tail (see the
   * guard in {@link startBacklogRun}). Populated at the route call site.
   */
  minClusterSize: number;
  assemble: () => Promise<AssembledBacklog>;
  /** Persist the new offered set (called BEFORE runGardener — at-most-once). */
  persistOffered: (keys: string[]) => Promise<void>;
  /** Read the current offered set — used by the in-mutex auto-recover only. */
  getOffered: () => Promise<Set<string>>;
  /** Read the pending run journal (null when none) — first step of the work fn. */
  readRunJournal: () => Promise<RunJournal | null>;
  /** Write this run's journal — called BEFORE {@link persistOffered}. */
  writeRunJournal: (j: RunJournal) => Promise<void>;
  /** Clear the journal — on a success/cancel settle; KEPT on the error settle. */
  clearRunJournal: () => Promise<void>;
  /** The §3b proposal scan (fetch + {@link draftedKeysSince}) for the auto-recover. */
  draftedKeysSince: (startedAt: number, batchKeys: string[]) => Promise<Set<string>>;
  /**
   * Run the gardener, threading the progress/cancel hooks the work fn constructs.
   * The route's closure merely forwards these into `runGardener`'s optional deps —
   * all hook logic (progress-map writes, `cancelRequested` read, skipped-key
   * capture) lives here, under the mutex.
   */
  runGardener: (assembled: AssembledBacklog, hooks: GardenerRunHooks) => Promise<WatcherAlert[]>;
  /**
   * Low-volume vertical fallback (R4): draft ONE batch doc individually as a source
   * page, fetching its body internally. Bound at the route to the real
   * `draftOneBacklogDoc` (via `defaultSourceBacklogDeps`), NOT to bare `draftSourcePage`
   * (which needs a fully-formed body+url the drain discarded) nor `runSourceDraftBacklog`
   * (which re-takes THIS same mutex and would dead-return null). Absent ⇒ no fallback
   * (older callers / tests) — a zero-draft run then just reports nothing, as before.
   */
  draftSourceFallback?: (cand: BacklogCandidate) => Promise<SourceFallbackOutcome>;
  recordLastRun: (r: LastBacklogRun) => void;
}

export type StartBacklogRunResult = { state: "started" | "running" | "no-watcher" | "disabled" };

/** What the detached work fn resolves with — read by the success settle handler. */
interface BacklogRunResult {
  offered: number;
  drafted: number;
  cancelled?: { drafted: number; of: number };
  /** Set when the batch was below `minClusterSize` — nothing was journalled/offered/run. */
  outcome?: "insufficient";
  eligible?: number;
  minClusterSize?: number;
  /** Assembled batch size (docs attempted) — persisted for the zero-draft reason line. */
  attemptedDocs?: number;
  /** Aggregate cluster-drop tally (absent when the pipeline never clustered). */
  dropTally?: ClusterDropTally;
  /** Post-gate cluster survivor count — >0 with drafted 0 ⇒ all drafts failed. */
  keptClusters?: number;
  /** Source pages the low-volume fallback (R4) drafted when the gardener drafted 0. */
  fallbackDrafted?: number;
}

/**
 * Recover a pending run journal: return the batch's undrafted keys to the pool
 * (drafted subset stays offered) and clear the journal. Returns how many keys
 * actually left the offered set — 0 for the journal-written-but-never-offered
 * crash window, where deleting keys never offered is a harmless no-op. The ONE
 * body behind both the in-mutex auto-recover in {@link startBacklogRun} and the
 * manual `backlog-recover` endpoint; callers must hold the per-bot mutex.
 */
export async function recoverRunJournal(
  deps: Pick<
    StartBacklogRunDeps,
    "readRunJournal" | "draftedKeysSince" | "getOffered" | "persistOffered" | "clearRunJournal"
  >,
): Promise<number> {
  const pending = await deps.readRunJournal();
  if (!pending) return 0;
  const drafted = await deps.draftedKeysSince(pending.startedAt, pending.batchKeys);
  const undrafted = pending.batchKeys.filter((k) => !drafted.has(k));
  let recovered = 0;
  if (undrafted.length) {
    const offered = await deps.getOffered();
    for (const k of undrafted) {
      if (offered.delete(k)) recovered++;
    }
    if (recovered) await deps.persistOffered([...offered]);
  }
  await deps.clearRunJournal();
  return recovered;
}

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
/**
 * Run the low-volume source-draft fallback over the assembled batch when the seam is
 * wired and there is a batch to draft — the single call site behind BOTH zero-draft
 * paths (the insufficient short-circuit and the completed-but-nothing-clustered
 * branch). Returns 0 when no seam is injected or the batch is empty/absent.
 */
async function maybeRunFallback(
  deps: StartBacklogRunDeps,
  assembled: AssembledBacklog,
): Promise<number> {
  if (!deps.draftSourceFallback) return 0;
  const batch = assembled.batch ?? [];
  if (batch.length === 0) return 0;
  // Move the live progress projection into a "drafting" stage so the UI reflects the
  // fallback fan-out (up to BACKLOG_MAX_PROPOSALS one-shots) instead of looking wedged
  // at the last gardener stage ("assembling" on the insufficient path). draftsTotal is
  // the cap-bounded upper bound on drafts; draftsDone ticks as each source page lands.
  const prog = backlogProgress.get(deps.botName);
  if (prog) {
    prog.stage = "drafting";
    prog.draftsDone = 0;
    prog.draftsTotal = Math.min(batch.length, BACKLOG_MAX_PROPOSALS);
    prog.currentTopic = undefined;
  }
  return runSourceFallback(batch, deps.draftSourceFallback, deps.botName, BACKLOG_MAX_PROPOSALS, {
    // Bind cancel to the run's live flag so a soft cancel halts the fan-out.
    shouldStop: () => backlogProgress.get(deps.botName)?.cancelRequested === true,
    onProgress: (draftsDone, currentKey) => {
      const p = backlogProgress.get(deps.botName);
      if (!p) return;
      p.draftsDone = draftsDone;
      p.currentTopic = currentKey;
    },
  });
}

export function startBacklogRun(deps: StartBacklogRunDeps): StartBacklogRunResult {
  if (!deps.hasWatcher) return { state: "no-watcher" };
  if (!deps.gardenerEnabled) return { state: "disabled" };

  const run = runExclusive(deps.botName, async (): Promise<BacklogRunResult> => {
    const startedAt = Date.now();
    // Seeded synchronously (before the first await) so the entry — and the cancel
    // flag `requestBacklogCancel` reads — exists the moment the mutex is acquired.
    backlogProgress.set(deps.botName, {
      stage: "assembling",
      draftsDone: 0,
      draftsTotal: 0,
      startedAt,
      cancelRequested: false,
    });

    // Mirror the drain into the AgentRun registry (/agents dashboard) — additive
    // alongside the 3s-poll strip at /wiki/gardener, which is untouched. Only the
    // MANUAL/route-driven drain flows through startBacklogRun; the weekly watcher
    // path (checkWikiGardener) calls runGardener directly and already registers a
    // `kind:"watcher"` run via the runner — so this never double-registers a card.
    // The registry run is completed in the `finally` below (covers success, cancel,
    // AND a runGardener throw), independent of the outer settle handlers.
    const reqId = agentStatus.startRequest(deps.botName, "assembling", undefined, {
      kind: "gardener_drain",
      name: "Backlog drain",
    });
    agentStatus.setSourcePage(reqId, "/wiki/gardener");

    try {
    // Auto-recover a pending journal (a prior crash / `runGardener` throw stranded
    // its batch) BEFORE assembling the new one. Under the mutex — NOT a route
    // pre-flight — so a near-simultaneous second Ingest click can't interleave this
    // recover's offered-write between the other run's offered read and its persist
    // (the lost-update TOCTOU class the reset guard documents). Recovered docs are
    // newest-first candidates for the very batch we're about to select, so this is
    // strictly safe. A journal-aware start also means a fresh Ingest never clobbers
    // a pending journal and orphans that batch permanently.
    // (Clears the journal before selecting the new batch — if assemble throws
    // below, the strand is already returned to the pool and the journal must not
    // linger as a ghost.)
    await recoverRunJournal(deps);

    const assembled = await deps.assemble();

    // Insufficient-batch guard: a batch below the cluster minimum is PROVABLY
    // incapable of drafting (the clusterer requires ≥ minClusterSize docs on one
    // topic), so running it would burn the whole batch into the offered set for
    // nothing — permanently stranding a tiny old tail. Short-circuit: write NO
    // journal, NO offered snapshot, and skip runGardener entirely; record an
    // `insufficient` outcome so the UI warns instead of rendering a bland "done".
    // (The registry run started above is still completed in the finally below.)
    if (assembled.batchKeys.length < deps.minClusterSize) {
      log.info(
        "Backlog run: {n} eligible doc(s) below minClusterSize {min} for {bot} — nothing offered",
        { botName: deps.botName, n: assembled.batchKeys.length, min: deps.minClusterSize },
      );
      // Low-volume fallback (R4, path a — the common genuinely-small vertical): the
      // batch can't cluster, so draft its docs individually as source pages rather
      // than returning empty. Nothing was journalled/offered/run; the drafted docs
      // become pending via their own proposals, the rest stay queued.
      const fallbackDrafted = await maybeRunFallback(deps, assembled);
      return {
        offered: 0,
        drafted: 0,
        outcome: "insufficient",
        eligible: assembled.batchKeys.length,
        minClusterSize: deps.minClusterSize,
        attemptedDocs: assembled.batchKeys.length,
        ...(fallbackDrafted > 0 ? { fallbackDrafted } : {}),
      };
    }

    // Journal BEFORE offering — a crash between the two recovers as a harmless no-op
    // (subtracting keys never offered); the reverse order would recreate the strand.
    await deps.writeRunJournal({ startedAt, batchKeys: assembled.batchKeys });
    // Persist BEFORE running — a crash after this skips the batch, never re-offers it.
    const offeredWithBatch = [...new Set([...assembled.offeredBefore, ...assembled.batchKeys])];
    await deps.persistOffered(offeredWithBatch);

    // The hooks write the live progress map, read the cancel flag, and capture the
    // skipped keys on abort — all here, under the mutex, so the offered-set
    // subtraction (below) sees them.
    let aborted = false;
    let skippedKeys: string[] = [];
    let lastTotal = 0;
    // Captured from the runner's onTally hook (fires once, after clustering) — the
    // aggregate drop tally the zero-draft reason line renders from. Undefined when
    // the run early-returns at the harvest floor before any tally is computed.
    let dropTally: ClusterDropTally | undefined;
    // Post-gate survivor count — lets the zero-draft reason line tell "nothing
    // clustered" (0) apart from "clusters formed but every draft failed" (>0).
    let keptClusters: number | undefined;
    const hooks: GardenerRunHooks = {
      onProgress: (p) => {
        const prog = backlogProgress.get(deps.botName);
        if (!prog) return;
        prog.stage = p.stage;
        if (p.draftsDone !== undefined) prog.draftsDone = p.draftsDone;
        if (p.draftsTotal !== undefined) {
          prog.draftsTotal = p.draftsTotal;
          lastTotal = p.draftsTotal;
        }
        prog.currentTopic = p.currentTopic;
        // Mirror the stage + n/m into the registry run (the stage IS the card's
        // phase → "Drain: <stage>"; draftsTotal is 0 until clustering resolves,
        // which the card renders as an indeterminate bar).
        agentStatus.updatePhase(reqId, p.stage);
        agentStatus.updateProgress(reqId, {
          done: prog.draftsDone,
          total: prog.draftsTotal,
          ...(p.currentTopic ? { currentItem: p.currentTopic } : {}),
        });
      },
      shouldAbort: () => {
        const cancel = backlogProgress.get(deps.botName)?.cancelRequested === true;
        if (cancel) agentStatus.setCancelRequested(reqId, true);
        return cancel;
      },
      onAborted: (keys) => {
        aborted = true;
        skippedKeys = keys;
      },
      onTally: (t, kept) => {
        dropTally = t;
        keptClusters = kept;
      },
    };

    const alerts = await deps.runGardener(assembled, hooks);
    const drafted = draftedCount(alerts);

    // Zero-draft burn guard (audit rec 2 / #289 extension): a run that COMPLETED
    // (not cancelled) but drafted NOTHING has nothing to show for burning its batch —
    // every doc was declined by clustering/gate/draft with no proposal produced.
    // Roll the offered snapshot back to its pre-run state so the whole batch stays
    // eligible for the next run, instead of permanently stranding a small old tail
    // (yesterday's `offered: 4, drafted: 0` case). `offeredBefore` is exactly
    // `offeredWithBatch − batchKeys` (selectBacklogBatch excludes already-offered
    // keys, so the batch and offeredBefore are disjoint). Distinct from the cancel
    // path below, whose deliberate semantics keep declined/never-clustered docs
    // offered (soft cancel is a user choice, not "the run had nothing to show").
    const zeroDraftBurn = !aborted && drafted === 0;
    // Low-volume fallback (R4, paths b + c): a COMPLETED run that clustered nothing
    // draftable (harvest floor, or the cluster-size gate zeroed a batch that ran)
    // falls back to per-doc source drafts. Runs BEFORE the #311 rollback below only
    // for readability — the two are independent: the rollback returns UNDRAFTED docs
    // to the pool, while the fallback's drafted docs get credited as pending via their
    // own proposals (so keeping #311 rollback semantics is correct — verified: the
    // fallback and the offered set touch disjoint doc states).
    //
    // MUST NOT fire when clusters DID form and pass the gate (keptClusters > 0) but
    // every draft attempt failed transiently (timeout / shape-gate). Those docs are
    // cluster-worthy — converting them to per-doc source pages makes them pending and
    // they're never re-clustered (permanent loss of concept synthesis on a transient
    // failure), and the strip would then render the "(fallback — nothing clustered)"
    // lie the R1 draft-failure branch exists to prevent. `keptClusters` is undefined
    // on the harvest-floor early return (no tally fired) — the fallback SHOULD still
    // fire there, so the guard is `!(keptClusters > 0)`, not `=== 0`. (The insufficient
    // path is a separate short-circuit above and is unaffected.)
    const clustersFormed = (keptClusters ?? 0) > 0;
    let fallbackDrafted = 0;
    if (zeroDraftBurn && !clustersFormed) {
      fallbackDrafted = await maybeRunFallback(deps, assembled);
    }
    if (aborted && skippedKeys.length) {
      // On cancel, return exactly the not-yet-drafted clusters' docs to the offered
      // set — declined/never-clustered docs stay offered (at-most-once). Subtract the
      // skipped keys from the offered-with-batch union persisted above.
      const offeredAfter = new Set(offeredWithBatch);
      for (const k of skippedKeys) offeredAfter.delete(k);
      await deps.persistOffered([...offeredAfter]);
    } else if (zeroDraftBurn) {
      await deps.persistOffered([...assembled.offeredBefore]);
      log.info(
        "Backlog run: drafted 0 of {n} offered doc(s) for {bot} — offered set rolled back, batch stays eligible{fb}",
        {
          botName: deps.botName,
          n: assembled.batchKeys.length,
          fb: fallbackDrafted > 0 ? ` (${fallbackDrafted} source page(s) drafted as fallback)` : "",
        },
      );
    }

    return {
      // A rolled-back zero-draft run reports offered:0 — nothing stayed burned.
      offered: zeroDraftBurn ? 0 : assembled.batchKeys.length,
      drafted,
      ...(aborted ? { cancelled: { drafted, of: lastTotal } } : {}),
      // Persist the drop reason so the review gate can explain a zero-draft run.
      // minClusterSize rides along on every completed run (the zero-draft copy needs
      // it too, not just the `insufficient` short-circuit).
      attemptedDocs: assembled.batchKeys.length,
      minClusterSize: deps.minClusterSize,
      ...(dropTally ? { dropTally } : {}),
      ...(keptClusters !== undefined ? { keptClusters } : {}),
      ...(fallbackDrafted > 0 ? { fallbackDrafted } : {}),
    };
    } finally {
      // Complete the registry run on EVERY exit path — success, soft-cancel
      // (returns normally), and a runGardener/assemble throw (rethrown after this).
      // No meta is available here (no trace/token counts on a drain); Recent sources
      // gardener_drain from the completed-runs ring keyed on the stable name above.
      agentStatus.completeRequest(reqId, {});
    }
  });
  if (run === null) return { state: "running" };

  // Two-arg `then` (not `.then().catch()`): the rejection handler must catch only
  // the RUN's failure, never a clearRunJournal failure inside the success handler —
  // otherwise a journal-clear hiccup would wrongly record an error outcome.
  void run.then(
    async (r) => {
      backlogProgress.delete(deps.botName);
      // Success OR cancel (a cancel returns normally) — clear the journal. A clear
      // failure must not swallow recordLastRun, so it's guarded independently.
      try {
        await deps.clearRunJournal();
      } catch (err) {
        log.warn("Backlog run: clearing journal failed for {bot}: {error}", {
          botName: deps.botName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      deps.recordLastRun({
        finishedAt: Date.now(),
        offered: r.offered,
        drafted: r.drafted,
        ...(r.cancelled ? { cancelled: r.cancelled } : {}),
        ...(r.outcome ? { outcome: r.outcome, eligible: r.eligible } : {}),
        // minClusterSize rides on both the `insufficient` short-circuit AND a completed
        // zero-draft run (its reason copy says "need N on one topic"), so forward it
        // whenever present rather than only inside the outcome block.
        ...(r.minClusterSize !== undefined ? { minClusterSize: r.minClusterSize } : {}),
        ...(r.attemptedDocs !== undefined ? { attemptedDocs: r.attemptedDocs } : {}),
        ...(r.dropTally ? { dropTally: r.dropTally } : {}),
        ...(r.keptClusters !== undefined ? { keptClusters: r.keptClusters } : {}),
        ...(r.fallbackDrafted !== undefined ? { fallbackDrafted: r.fallbackDrafted } : {}),
      });
    },
    (err) => {
      backlogProgress.delete(deps.botName);
      // KEEP the journal on the error settle — a `runGardener` throw strands its
      // batch exactly like a crash, so leaving `backlog:run` in place routes the
      // errored batch through the same Recover/Dismiss banner (detection is
      // `journal exists && !running`, which holds after an error settle too).
      const message = err instanceof Error ? err.message : String(err);
      log.error("Backlog run failed for {bot}: {error}", { botName: deps.botName, error: message });
      deps.recordLastRun({ finishedAt: Date.now(), offered: 0, drafted: 0, error: message });
    },
  );
  return { state: "started" };
}

/**
 * Reset the offered memory (write an empty offered set) — but ONLY when no
 * gardener run is in flight for the bot. A reset during a drain would be
 * silently clobbered: the run's `persistOffered` was computed from a pre-reset
 * read and would overwrite the empty set moments later.
 */
export async function resetBacklogOffered(
  botName: string,
  persistEmpty: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (gardenerRunInFlight(botName)) {
    return { ok: false, error: "reset unavailable while a run is in flight" };
  }
  await persistEmpty();
  return { ok: true };
}
