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
  /** Clusters that survived filtering (0 until clustering resolves them). */
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
 *
 * `minAgeDays` is the **age floor**: docs newer than `now − minAgeDays` still
 * belong to the weekly gardener's lookback window, so the drain must not touch
 * them (it would burn a fresh 1–9-doc arrival that can't cluster, hiding it from
 * both paths). A doc is eligible when it is at least `minAgeDays` old OR its date
 * is undeterminable (undated docs are genuinely old backlog — the `undefined`
 * case is special-cased because `undefined <= cutoff` is `false`, which would
 * wrongly drop them). Both this floor (`<= cutoff`) and the weekly window
 * (`>= cutoff`, `filterWindow`) are inclusive, so a doc exactly at the boundary
 * is covered by at least one path. The floor defaults to the gardener's default
 * lookback for callers with no bot config in reach.
 */
export function selectBacklogBatch(
  queuedDocs: QueuedDoc[],
  offeredKeys: Set<string>,
  batchSize: number = BACKLOG_BATCH_SIZE,
  minAgeDays: number = GARDENER_DEFAULTS.lookbackDays,
  now: number = Date.now(),
): BacklogCandidate[] {
  const cutoff = now - minAgeDays * DAY_MS;
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
    .filter((c) => {
      const ms = docDateMs(c);
      // Age floor: undated docs are old backlog (stay eligible); dated docs must
      // be at least `minAgeDays` old to leave the weekly gardener's window.
      return ms === undefined || ms <= cutoff;
    })
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
  recordLastRun: (r: LastBacklogRun) => void;
}

export type StartBacklogRunResult = { state: "started" | "running" | "no-watcher" | "disabled" };

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
export function startBacklogRun(deps: StartBacklogRunDeps): StartBacklogRunResult {
  if (!deps.hasWatcher) return { state: "no-watcher" };
  if (!deps.gardenerEnabled) return { state: "disabled" };

  const run = runExclusive(deps.botName, async () => {
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
    };

    const alerts = await deps.runGardener(assembled, hooks);
    const drafted = draftedCount(alerts);

    // On cancel, return exactly the not-yet-drafted clusters' docs to the offered
    // set — declined/never-clustered docs stay offered (at-most-once). Subtract the
    // skipped keys from the offered-with-batch union persisted above.
    if (aborted && skippedKeys.length) {
      const offeredAfter = new Set(offeredWithBatch);
      for (const k of skippedKeys) offeredAfter.delete(k);
      await deps.persistOffered([...offeredAfter]);
    }

    return {
      offered: assembled.batchKeys.length,
      drafted,
      ...(aborted ? { cancelled: { drafted, of: lastTotal } } : {}),
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
