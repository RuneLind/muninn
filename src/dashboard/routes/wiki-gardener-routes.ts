import type { Hono } from "hono";
import path from "node:path";
import { renderWikiGardenerPage } from "../views/wiki-gardener-page.ts";
import { renderWikiHtml, stripFrontmatter } from "../../wiki/render.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { scanUnresolvedBodyLinks } from "../../gardener/draft.ts";
import { buildIndexEntry, selectWirablePages } from "../../gardener/wire.ts";
import type { WiringPreview } from "../views/components/wiki-gardener-wiring.ts";
import { lintWiki } from "../../wiki/lint.ts";
import { listWikis, resolveWikiRequest, type WikiRegistryEntry } from "../../wiki/registry.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { discoverAllBots, type BotConfig } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { lineDiff, type DiffLine } from "../../gardener/diff.ts";
import { applyWikiProposal, draftTitle, type ApplyDeps } from "../../gardener/apply.ts";
import {
  approveWikiProposal,
  rejectWikiProposal,
  markWikiProposalApplied,
  markWikiProposalStale,
  markWikiProposalError,
  listAllWikiProposals,
  getWikiProposalById,
  DEFAULT_COVERAGE_DEPS,
  type CoverageDeps,
  type WikiProposal,
} from "../../db/wiki-proposals.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { listSummaryCollections } from "../../summaries/list-collections.ts";
import type { StatsError } from "../../summaries/stats.ts";
import { collectWikiRefs, computeIngestBacklog, type ListedDoc } from "../../wiki/ingest-backlog.ts";
import { resolveGardenerConfig } from "../../gardener/types.ts";
import { runGardener, type GardenerDeps } from "../../gardener/runner.ts";
import {
  assembleBacklog,
  startBacklogRun,
  resetBacklogOffered,
  runExclusive,
  draftedCount,
  draftedKeysSince,
  passesAgeFloor,
  gardenerRunInFlight,
  getBacklogProgress,
  requestBacklogCancel,
  recoverRunJournal,
  BACKLOG_BATCH_SIZE,
  BACKLOG_MAX_PROPOSALS,
  BACKLOG_LOOKBACK_DAYS,
  DRAFT_TIMEOUT_MS,
  WIKI_GARDENER_OFFERED_KEY,
  WIKI_GARDENER_RUN_KEY,
  WIKI_GARDENER_LAST_RUN_KEY,
  type AssembledBacklog,
  type BacklogProgress,
  type DraftedScanProposal,
  type GardenerRunHooks,
  type LastBacklogRun,
  type RunJournal,
} from "../../gardener/backlog.ts";
import { buildGardenerSeams } from "../../watchers/wiki-gardener.ts";
import {
  getWikiGardenerWatcher,
  getWatcherSnapshot,
  setWatcherSnapshot,
} from "../../db/watchers.ts";
import { loadConfig } from "../../config.ts";
import { Tracer } from "../../tracing/index.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki-gardener");

const KNOWLEDGE_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

/** Bot configs are static until restart — discover once and memoize (see wiki-routes.ts). */
let cachedBots: BotConfig[] | null = null;
function getBots(): BotConfig[] {
  return (cachedBots ??= discoverAllBots());
}

/**
 * The gardener is bot-scoped — proposals are keyed by bot, and applying writes
 * into a bot's wiki. It shares the reader's memoized registry (one bot discovery
 * + `WIKI_EXTRA` parse for the whole dashboard) and filters to bot-source wikis
 * so the picker only lists bot wikis. Resolution still runs against the full
 * registry so a `?wiki=<extra>` (e.g. mimir) is recognized as a non-bot wiki
 * rather than silently falling through to the default bot.
 */
function getBotRegistry(): WikiRegistryEntry[] {
  return getWikiRegistry().filter((e) => e.source === "bot");
}

/** The rich per-proposal shape the review page renders (meta + server-computed preview/diff). */
interface ProposalView {
  id: string;
  topicKey: string;
  title: string;
  kind: string;
  mode: string;
  targetPath: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  rationale: string | null;
  sourceDocs: { collection: string; docId: string; title: string; url: string }[];
  /** Rendered draft preview — empty for terminal rows (applied/rejected/error). */
  previewHtml: string;
  diff: DiffLine[] | null;
  /** Body [[wikilinks]] that don't resolve against the live index (surfaced, not
   *  stripped). LEGACY read-time fallback: only computed for rows without a
   *  persisted `containedLinks` report (drafted before body containment). Read-time
   *  so a page created while the proposal awaited review stops being flagged. */
  unresolvedLinks: string[];
  /** Body [[wikilinks]] the persist-time guard auto-de-linked to plain text
   *  (informational, from the `contained_links` column). Null on legacy rows. */
  containedLinks: string[] | null;
  /** Read-time preview of the apply-time wire stage (index line + inbound See-also
   *  targets). Null for terminal rows (nothing will be wired). */
  wiring: WiringPreview | null;
}

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await Bun.file(absPath).text();
  } catch {
    return null;
  }
}

/** Real huginn reindex seam — best-effort POST, never throws (swallowed for apply). */
async function triggerReindex(collection: string): Promise<void> {
  try {
    await fetchKnowledgeApi(
      KNOWLEDGE_API_URL,
      `/api/collections/${encodeURIComponent(collection)}/update`,
      { method: "POST", timeoutMs: 10_000 },
    );
    log.info("Wiki-gardener: triggered reindex of collection {collection}", { collection });
  } catch (err) {
    log.warn("Wiki-gardener: reindex trigger failed for {collection}: {error}", {
      collection,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build the filesystem/index/reindex seams the apply step needs for a wiki root. */
function applyDepsFor(wikiDir: string): ApplyDeps {
  return {
    wikiDir,
    now: () => Date.now(),
    readFile: readFileOrNull,
    // Bun.write creates parent directories itself.
    writeFile: async (absPath, content) => {
      await Bun.write(absPath, content);
    },
    getWikiIndex: () => getWikiIndex({ root: wikiDir }),
    refreshIndex: async () => {
      await getWikiIndex({ root: wikiDir, refresh: true });
    },
    reindex: triggerReindex,
  };
}

/** Flip the terminal status via CAS; a null result means the row's state changed
 *  under us — surface that instead of reporting success. */
async function finishProposal(
  id: string,
  mark: (id: string) => Promise<WikiProposal | null>,
  label: string,
): Promise<boolean> {
  const row = await mark(id);
  if (!row) {
    log.error("Wiki-gardener: terminal CAS to {label} lost for proposal {id} — state changed during apply", {
      label,
      id,
    });
    return false;
  }
  return true;
}

// ── Ingest backlog (report-only "queued up" counter) ────────────────────────

/** Injectable coverage lookups so the route test can drive them without a DB —
 *  the shared {@link CoverageDeps} shape (also used by the summaries Stats route). */
export type IngestBacklogDeps = CoverageDeps;

/** A minimal `wiki-gardener` watcher projection — just the FK the offered memory needs. */
export interface GardenerWatcherRef {
  id: string;
}

/**
 * The wider deps the backlog-run routes need on top of {@link CoverageDeps}: the
 * bot's `wiki-gardener` watcher row (offered memory's `watcher_id`), a generic
 * per-key snapshot read/write (offered / run journal / last-run all live in the
 * same `watcher_snapshots` table), and the bot's proposal list (for the
 * interrupted-run scan). All injectable so the routes test without a DB.
 */
export interface BacklogRouteDeps extends CoverageDeps {
  getWikiGardenerWatcher: (botName: string) => Promise<GardenerWatcherRef | null>;
  getSnapshot: (watcherId: string, key: string) => Promise<unknown>;
  setSnapshot: (watcherId: string, key: string, value: unknown) => Promise<void>;
  listProposals: (botName: string) => Promise<DraftedScanProposal[]>;
}

export const DEFAULT_BACKLOG_ROUTE_DEPS: BacklogRouteDeps = {
  ...DEFAULT_COVERAGE_DEPS,
  getWikiGardenerWatcher: async (botName) => {
    const w = await getWikiGardenerWatcher(botName);
    return w ? { id: w.id } : null;
  },
  getSnapshot: (watcherId, key) => getWatcherSnapshot(watcherId, key),
  setSnapshot: (watcherId, key, value) => setWatcherSnapshot(watcherId, key, value),
  listProposals: (botName) => listAllWikiProposals(botName),
};

/** Read the offered-key snapshot as a Set (JSONB array → Set; anything else ⇒ ∅). */
async function readOffered(deps: BacklogRouteDeps, watcherId: string): Promise<Set<string>> {
  const snap = await deps.getSnapshot(watcherId, WIKI_GARDENER_OFFERED_KEY);
  return new Set(Array.isArray(snap) ? (snap as string[]) : []);
}

/** Read the run-journal snapshot, validating its shape (null when absent/cleared). */
async function readRunJournal(deps: BacklogRouteDeps, watcherId: string): Promise<RunJournal | null> {
  const snap = await deps.getSnapshot(watcherId, WIKI_GARDENER_RUN_KEY);
  if (snap && typeof snap === "object" && Array.isArray((snap as { batchKeys?: unknown }).batchKeys)) {
    return snap as RunJournal;
  }
  return null;
}

/**
 * Per-bot record of the most recent manual backlog run's outcome (in-memory —
 * a dashboard convenience, not durable). Surfaced by the extended GET so the UI
 * can render the "run finished — nothing clustered" / "drafted N" line.
 */
const lastBacklogRuns = new Map<string, LastBacklogRun>();
function setLastBacklogRun(botName: string, r: LastBacklogRun): void {
  lastBacklogRuns.set(botName, r);
}
function getLastBacklogRun(botName: string): LastBacklogRun | null {
  return lastBacklogRuns.get(botName) ?? null;
}

/** The per-request live fields merged onto the cached backlog payload. */
export interface BacklogLiveFields {
  running: boolean;
  offered: number;
  remaining: number;
  /**
   * Queued docs that are ALSO in the offered set — the honest "offered in past
   * runs" count. Computed server-side (not derived client-side as `queued −
   * remaining`, which the age floor would inflate with merely-too-fresh docs).
   * Gates the strip's Reset button + picks its label.
   */
  offeredStillQueued: number;
  /**
   * Queued docs still inside the weekly gardener's window (not offered, fails the
   * drain's age floor) — the "new arrivals" the strip leads with. These are the
   * weekly watcher's turf: the drain refuses them, so without this count they are
   * invisible (in `queued` but in neither `remaining` nor `offeredStillQueued`).
   */
  fresh: number;
  /** Per-source breakdown of `fresh` (non-zero sources only, listing order). */
  freshBySource: { label: string; count: number }[];
  /** The resolved age-floor window in days — lets the client label "new (last Nd)". */
  freshWindowDays: number;
  lastBacklogRun: LastBacklogRun | null;
  watcherSeeded: boolean;
  /** Live progress of an in-flight drain (null when idle — including weekly runs). */
  progress: BacklogProgress | null;
  /**
   * Set when a run journal survived a crash / error settle AND no run is in flight
   * (PR 3) — backs the recovery banner. `drafted` = journal batch keys that produced
   * proposals since `at`. Absent/null when there is no stranded run.
   */
  interrupted?: { at: number; batchSize: number; drafted: number } | null;
}

/**
 * Merge the per-request live fields onto the cached (by-reference) backlog
 * payload WITHOUT mutating the cached object: strip the server-only `queuedKeys`
 * and spread a fresh object. Exported so the non-mutation contract is unit-tested.
 *
 * The batch constants (`batchSize`/`maxProposals`) are always emitted from the
 * shared `src/gardener/backlog.ts` source so the client confirm panel can render
 * "drain a batch of N … up to M drafts" without hardcoding the numbers.
 */
export function mergeBacklogLiveFields(
  data: IngestBacklogResponse,
  live: BacklogLiveFields,
): Record<string, unknown> {
  const { queuedKeys: _drop, ...rest } = data;
  return {
    ...rest,
    ...live,
    batchSize: BACKLOG_BATCH_SIZE,
    maxProposals: BACKLOG_MAX_PROPOSALS,
  };
}

/**
 * Split the cached `queuedKeys` into the two honest live counts the strip needs,
 * applying the SAME age floor the drain uses ({@link passesAgeFloor}):
 *  - `remaining` = queued, NOT offered, AND past the age floor (the eligible-now
 *    set the "Drain a batch" button acts on);
 *  - `offeredStillQueued` = queued AND in the offered set (the exact "offered in
 *    past runs" count — replaces the old client-side `queued − remaining`, which
 *    the floor inflated by counting merely-too-fresh docs as offered);
 *  - `freshByCollection` = queued, NOT offered, and INSIDE the window (fails the
 *    floor) — the per-collection "new arrivals" bucket the strip leads with.
 *    Offered docs never count as fresh (pre-#288 burns belong to the tail).
 *
 * The three buckets partition the queued set exactly:
 * `remaining + offeredStillQueued + Σ freshByCollection === queuedKeys.length`.
 *
 * Pure + injectable so the route's floor branch is unit-testable. `q.id` is the
 * bare doc id (the floor's filename-prefix fallback needs it, not the key);
 * `q.collection` is carried through from the listing so the fresh bucket never
 * has to re-parse it out of the synthetic key.
 */
export function computeBacklogFloorCounts(
  queuedKeys: { key: string; id: string; collection: string; date?: string }[],
  offeredSet: Set<string>,
  minAgeDays: number,
  now: number,
): { remaining: number; offeredStillQueued: number; freshByCollection: Record<string, number> } {
  let remaining = 0;
  let offeredStillQueued = 0;
  const freshByCollection: Record<string, number> = {};
  for (const q of queuedKeys) {
    if (offeredSet.has(q.key)) {
      offeredStillQueued++;
      continue;
    }
    if (passesAgeFloor({ id: q.id, date: q.date }, minAgeDays, now)) {
      remaining++;
    } else {
      freshByCollection[q.collection] = (freshByCollection[q.collection] ?? 0) + 1;
    }
  }
  return { remaining, offeredStillQueued, freshByCollection };
}

/**
 * Per-collection backlog counts decorated with the summary-source id + label for
 * the UI. Deliberately count-only: the module's per-collection `queuedDocs` list
 * (up to ~hundreds of doc objects) stays server-side — no client consumes it, and
 * PR 2's drain uses the module directly, not this HTTP payload.
 */
interface BacklogCollection {
  collection: string;
  source: string;
  label: string;
  total: number;
  ingested: number;
  queued: number;
}

/** The full `/api/wiki/ingest-backlog` payload (the cached, expensive part). */
export interface IngestBacklogResponse {
  byCollection: BacklogCollection[];
  total: number;
  ingested: number;
  queued: number;
  /** Distinct normalized URLs found across the wiki (reconciliation diagnostic). */
  wikiUrlCount: number;
  generatedAt: number;
  /** Present only when ≥1 collection failed to load (partial data). */
  errors?: StatsError[];
  /**
   * Server-only: every queued doc's `<collection>/<id>` key, its bare `id`, and
   * its listing date (when known). Cached alongside the counts so the extended GET
   * can compute `remaining` (queued minus the offered set AND minus docs still
   * inside the weekly gardener's window — the same age floor the drain applies).
   * The `id` is the BARE doc id, kept alongside `key` because the age floor's
   * `docDateMs` filename-prefix fallback inspects the id, not the collection-prefixed
   * key. The date is needed for that floor; youtube ids carry no date prefix, so an
   * undated doc reads its date from the id prefix. STRIPPED before the wire by
   * {@link mergeBacklogLiveFields}.
   */
  queuedKeys?: { key: string; id: string; collection: string; date?: string }[];
}

const BACKLOG_TTL_MS = 5 * 60_000;

/**
 * Per-bot backlog cache. The backlog (wiki URL sweep + 4 collection listings +
 * partition) is expensive and stable within a TTL, so it's cached keyed by bot
 * name; `?refresh=1` bypasses the read, and an in-flight map single-flights
 * concurrent misses. Mirrors the summaries stats cache exactly.
 */
const backlogCache = new Map<string, { data: IngestBacklogResponse; at: number }>();
const backlogInFlight = new Map<string, Promise<IngestBacklogResponse>>();

/** Test-only: clear the backlog cache (and in-flight guard) between cases. */
export function __resetIngestBacklogCacheForTest(): void {
  backlogCache.clear();
  backlogInFlight.clear();
}

/**
 * Compute the backlog for a bot's wiki root: sweep the wiki for referenced URLs,
 * list every summary collection (via the shared sequential listing helper — never
 * unbounded concurrency at huginn's Python server), pull the consumed/pending
 * sets, and partition. A collection that fails contributes nothing and lands in
 * `errors` — never a page-breaking throw (huginn unreachable ⇒ partial/empty
 * data + errors).
 */
export async function computeIngestBacklogResponse(
  root: string,
  botName: string,
  deps: IngestBacklogDeps,
): Promise<IngestBacklogResponse> {
  const { byCollection: listedRaw, errors } = await listSummaryCollections(KNOWLEDGE_API_URL);

  const listedBySource: Record<string, ListedDoc[]> = {};
  for (const source of SUMMARY_SOURCES) {
    listedBySource[source.collection] = (listedRaw[source.collection] ?? []).map((d) => ({
      collection: source.collection,
      id: d.id,
      ...(d.url ? { url: d.url } : {}),
      ...(d.date ? { date: d.date } : {}),
    }));
  }

  const wikiRefs = await collectWikiRefs(root);
  const [consumed, pending] = await Promise.all([deps.getConsumed(botName), deps.getPending(botName)]);
  const backlog = computeIngestBacklog(listedBySource, wikiRefs, consumed, pending);

  // Counts only over the wire — queuedDocs stays in the module's return for
  // server-side consumers (PR 2's drain), never in the HTTP payload.
  const byCollection: BacklogCollection[] = backlog.byCollection.map((c) => {
    const src = SUMMARY_SOURCES.find((s) => s.collection === c.collection);
    return {
      collection: c.collection,
      source: src?.id ?? c.collection,
      label: src?.label ?? c.collection,
      total: c.total,
      ingested: c.ingested,
      queued: c.queued,
    };
  });

  // Server-only queued keys + dates (stripped before the wire) — used by the
  // extended GET to compute `remaining` against the offered set AND the age floor.
  const queuedKeys = backlog.byCollection.flatMap((c) =>
    c.queuedDocs.map((d) => ({
      key: `${d.collection}/${d.id}`,
      id: d.id,
      collection: d.collection,
      ...(d.date ? { date: d.date } : {}),
    })),
  );

  return {
    byCollection,
    total: backlog.total,
    ingested: backlog.ingested,
    queued: backlog.queued,
    wikiUrlCount: wikiRefs.urls.size,
    generatedAt: Date.now(),
    queuedKeys,
    ...(errors.length ? { errors } : {}),
  };
}

/**
 * TTL-cached, single-flighted backlog for a resolved bot wiki. `refresh` bypasses
 * the cache read; concurrent misses share one computation; a degraded (errors)
 * payload is never cached so a recovered huginn is picked up on the next request.
 * This caches ONLY the expensive computation — the route merges any per-request
 * live fields (PR 2) OUTSIDE this seam. NOTE: the returned object IS the cached
 * entry (by reference) — callers must never mutate it (spread/clone instead).
 */
export async function getIngestBacklogCached(
  root: string,
  botName: string,
  deps: IngestBacklogDeps,
  refresh: boolean,
): Promise<IngestBacklogResponse> {
  if (!refresh) {
    const cached = backlogCache.get(botName);
    if (cached && Date.now() - cached.at < BACKLOG_TTL_MS) return cached.data;
  }

  let inflight = backlogInFlight.get(botName);
  if (!inflight) {
    inflight = computeIngestBacklogResponse(root, botName, deps).finally(() => {
      backlogInFlight.delete(botName);
    });
    backlogInFlight.set(botName, inflight);
  }

  const data = await inflight;
  // Only cache fully-successful results — a degraded payload (a collection down)
  // must not be served for the whole TTL once huginn recovers.
  if (!data.errors || data.errors.length === 0) {
    backlogCache.set(botName, { data, at: Date.now() });
  }
  return data;
}

/**
 * Assemble the full `GardenerDeps` for a manual backlog run from an
 * {@link AssembledBacklog}: the consumed-complement (harvest cap), the memoized
 * per-collection `listDocs` (huginn listed once during assembly — never re-listed),
 * an all-time lookback, and the raised proposal cap. Every other seam is IDENTICAL
 * to the weekly checker's via `buildGardenerSeams`, so the two paths can't drift.
 */
function buildBacklogGardenerDeps(
  assembled: AssembledBacklog,
  ctx: {
    bot: BotConfig;
    config: ReturnType<typeof loadConfig>;
    apiUrl: string;
    root: string;
    tracer: Tracer;
  },
  hooks: GardenerRunHooks,
): GardenerDeps {
  const { bot, config, apiUrl, root, tracer } = ctx;
  return {
    // Progress + soft-cancel seams (owned by the backlog work fn; the route only
    // forwards them). Undefined on the weekly path — behavior is byte-identical.
    onProgress: hooks.onProgress,
    shouldAbort: hooks.shouldAbort,
    onAborted: hooks.onAborted,
    botName: bot.name,
    wikiDir: root,
    collections: SUMMARY_SOURCES.map((s) => s.collection),
    minClusterSize: resolveGardenerConfig(bot.gardener).minClusterSize,
    lookbackDays: BACKLOG_LOOKBACK_DAYS,
    maxProposalsPerRun: BACKLOG_MAX_PROPOSALS,
    draftTimeoutMs: DRAFT_TIMEOUT_MS,
    now: () => Date.now(),
    tracer,
    // Serve harvest's listing from the memoized snapshot (huginn listed once in
    // assembleBacklog) — the gardener ListedDoc shape is id/url/date (no collection).
    listDocs: async (collection) =>
      (assembled.listedBySource[collection] ?? []).map((d) => ({
        id: d.id,
        ...(d.url ? { url: d.url } : {}),
        ...(d.date ? { date: d.date } : {}),
      })),
    // consumed-complement: everything except the batch is "consumed", so harvest
    // caps to exactly the selected batch.
    consumedDocIds: async () => assembled.consumedComplement,
    // Thread the drain's own tracer (the `wiki-gardener-backlog` root, finished by
    // the route) so the cluster haiku row joins the trace and each draft stamps a
    // `claude` child span under the "draft" stage span — parity with the weekly
    // checker. The drain never surfaces on /agents via traces (its root isn't a
    // `watcher:%`/`%_message` span), so the child span can't double-count.
    ...buildGardenerSeams({ botConfig: bot, config, apiUrl, wikiDir: root, tracer }),
  };
}

/**
 * Shared resolve/guard prologue for the two backlog POSTs: resolve the wiki
 * request against the full registry, reject unknown / non-bot wikis, and find
 * the matching wikiDir-bearing bot. Returns the resolved bot + root or a
 * `{ error, status }` the handler returns verbatim.
 */
function resolveBacklogBot(
  wikiQuery: string | undefined,
  botQuery: string | undefined,
): { bot: BotConfig; root: string } | { error: string; status: 400 | 404 } {
  const { entry, unknownWiki } = resolveWikiRequest(
    getWikiRegistry(),
    wikiQuery,
    botQuery,
    process.env.WIKI_DIR,
  );
  if (unknownWiki) return { error: "no wiki configured for that name", status: 404 };
  if (entry && entry.source !== "bot") {
    return { error: "the ingest backlog is only available for bot wikis", status: 400 };
  }
  const root = entry?.root;
  const bot = entry
    ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir)
    : undefined;
  if (!bot || !root) return { error: "no wiki bot resolved", status: 404 };
  return { bot, root };
}

export function registerWikiGardenerRoutes(
  app: Hono,
  backlogDeps: BacklogRouteDeps = DEFAULT_BACKLOG_ROUTE_DEPS,
): void {
  // Review page.
  app.get("/wiki/gardener", async (c) => {
    const wikiBots = listWikis(getBotRegistry());
    // Resolve against the FULL registry so a `?wiki=<extra>` (e.g. mimir) is
    // recognized as a non-bot wiki and gets a clean "unavailable" state instead
    // of a picker that mis-highlights the first bot while the body errors.
    const { wiki: selected, envOverride, entry } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    const notBotWiki = !!entry && entry.source !== "bot";
    return c.html(await renderWikiGardenerPage({ wikiBots, selected, envOverride, notBotWiki }));
  });

  // List a bot's proposals (all statuses, newest first). Preview + diff are only
  // computed for the rows a reviewer actually inspects (draft/stale) so the page
  // cost doesn't grow unbounded with terminal history.
  app.get("/api/wiki/proposals", async (c) => {
    // One resolution against the full registry — root + source + bot all come from
    // the single resolved entry (no separate root lookup + re-resolve dance).
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ proposals: [], error: "no wiki configured for that name" });
    }
    if (entry && entry.source !== "bot") {
      return c.json({ proposals: [], error: "the gardener is only available for bot wikis" });
    }
    // The default wiki (bare request) resolves to a concrete bot entry, so `root`
    // matches the bot the proposals are drawn from — previews + update-diffs read
    // the same wiki the gardener writes into.
    const root = entry?.root;
    const bot = entry ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir) : undefined;
    if (!bot) return c.json({ proposals: [], error: "no wiki bot resolved" });

    const rows = await listAllWikiProposals(bot.name);
    const index = await getWikiIndex({ root });
    const resolve = index ? index.resolve : () => undefined;

    const proposals: ProposalView[] = await Promise.all(
      rows.map(async (p) => {
        const title = draftTitle(p);
        const reviewable = p.status === "draft" || p.status === "stale";
        let diff: DiffLine[] | null = null;
        if (reviewable && p.mode === "update" && root) {
          const current = await readFileOrNull(path.join(root, p.targetPath));
          if (current !== null) diff = lineDiff(current, p.draft);
        }
        // New rows carry a persisted containment report (`contained_links`); the
        // read-time scan is only a fallback for legacy rows drafted before body
        // containment. Computed read-time (a page created post-draft clears it).
        const containedLinks = p.containedLinks ? p.containedLinks.delinked : null;
        const unresolvedLinks =
          reviewable && !containedLinks
            ? scanUnresolvedBodyLinks(stripFrontmatter(p.draft), { resolve, selfTitle: title })
            : [];
        // Wiring preview: what the apply-time wire stage will do — the planned
        // index line (or entity skip) + the related pages that still resolve in the
        // live index and will gain an inbound See-also link. Read-time, no persisted
        // state; a NULL `related_pages` (pre-migration row) degrades to a note.
        let wiring: WiringPreview | null = null;
        if (reviewable) {
          const domain: "ai" | "life" = p.targetPath.startsWith("life/") ? "life" : "ai";
          const entry = buildIndexEntry({
            title,
            kind: p.kind,
            domain,
            rationale: p.rationale,
            body: stripFrontmatter(p.draft),
          });
          const seeAlso = selectWirablePages(p.relatedPages, index, p.targetPath).map(
            (wp) => wp.title,
          );
          wiring = {
            indexLine: entry ? entry.line : null,
            indexSkipEntity: p.kind === "entity",
            seeAlso,
            legacyNoRelated: p.relatedPages === null,
          };
        }
        return {
          id: p.id,
          topicKey: p.topicKey,
          title,
          kind: p.kind,
          mode: p.mode,
          targetPath: p.targetPath,
          status: p.status,
          createdAt: p.createdAt,
          resolvedAt: p.resolvedAt,
          rationale: p.rationale,
          sourceDocs: p.sourceDocs,
          previewHtml: reviewable ? renderWikiHtml(p.draft, resolve, { stripTitle: title }) : "",
          diff,
          unresolvedLinks,
          containedLinks,
          wiring,
        };
      }),
    );
    return c.json({ proposals });
  });

  // Report-only wiki lint findings, recomputed on demand from the wiki tree (no
  // DB table, no writes). Same bot resolution as `/api/wiki/proposals`; a
  // missing/unreadable wiki degrades to a 200 with an `error` field, never a 5xx.
  app.get("/api/wiki/linter-findings", async (c) => {
    const empty = { findings: [], counts: {}, generatedAt: Date.now() };
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ ...empty, error: "no wiki configured for that name" });
    }
    if (entry && entry.source !== "bot") {
      return c.json({ ...empty, error: "the linter is only available for bot wikis" });
    }
    const root = entry?.root;
    const bot = entry
      ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir)
      : undefined;
    if (!bot) return c.json({ ...empty, error: "no wiki bot resolved" });

    // Never-5xx contract: any unexpected throw (index build, file reads) degrades
    // to a 200 with an `error` field, like the resolution failures above.
    try {
      const index = await getWikiIndex({ root });
      if (!index) return c.json({ ...empty, error: "wiki directory is not readable" });

      const report = await lintWiki(index);
      return c.json(report);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("Wiki-linter: lint run failed for {bot}: {error}", { bot: bot.name, error: reason });
      return c.json({ ...empty, error: `lint failed: ${reason}` });
    }
  });

  // Report-only ingest backlog — the all-time count of summary docs never
  // ingested into the wiki (in any form), per collection. Same bot resolution +
  // never-5xx contract as `/api/wiki/linter-findings`; huginn unreachable ⇒ 200
  // with partial/empty data + an `errors` array (the page never breaks).
  app.get("/api/wiki/ingest-backlog", async (c) => {
    const empty = { byCollection: [], total: 0, ingested: 0, queued: 0, wikiUrlCount: 0, generatedAt: Date.now() };
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ ...empty, error: "no wiki configured for that name" });
    }
    if (entry && entry.source !== "bot") {
      return c.json({ ...empty, error: "the ingest backlog is only available for bot wikis" });
    }
    const root = entry?.root;
    const bot = entry
      ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir)
      : undefined;
    if (!bot || !root) return c.json({ ...empty, error: "no wiki bot resolved" });

    const refresh = c.req.query("refresh") === "1";
    // Never-5xx contract: getIngestBacklogCached swallows per-collection fetch
    // errors, so a throw here means the wiki sweep or DB lookups failed. Degrade
    // to a 200 with empty data + an error note rather than a 5xx.
    try {
      const data = await getIngestBacklogCached(root, bot.name, backlogDeps, refresh);
      // Per-request live fields (backlog-run state) are merged HERE — outside the
      // cached computation above. `mergeBacklogLiveFields` spreads a fresh object
      // (and strips the server-only `queuedKeys`), never mutating the cached entry.
      const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
      const offeredSet = watcher ? await readOffered(backlogDeps, watcher.id) : new Set<string>();
      const queuedKeys = data.queuedKeys ?? [];
      // Mirror the drain's age floor here (shared `computeBacklogFloorCounts` ⇒
      // `passesAgeFloor`) so the strip stops advertising docs the drain now refuses:
      // a doc counts as `remaining` only when it is not already offered AND is old
      // enough to have left the weekly gardener's window (undated ⇒ old backlog,
      // kept). `offeredStillQueued` (queued ∩ offered) is emitted explicitly so the
      // strip no longer derives it as `queued − remaining` (which the floor inflates).
      const minAgeDays = resolveGardenerConfig(bot.gardener).lookbackDays;
      const { remaining, offeredStillQueued, freshByCollection } = computeBacklogFloorCounts(
        queuedKeys,
        offeredSet,
        minAgeDays,
        Date.now(),
      );
      // Per-source fresh breakdown in listing order, labels from the cached
      // byCollection rows (non-zero only — the wire stays compact).
      const freshBySource = data.byCollection
        .filter((c) => (freshByCollection[c.collection] ?? 0) > 0)
        .map((c) => ({ label: c.label, count: freshByCollection[c.collection]! }));
      const fresh = Object.values(freshByCollection).reduce((s, n) => s + n, 0);
      const running = gardenerRunInFlight(bot.name);

      // Last-run: the in-memory record wins; after a restart it's gone, so fall back
      // to the durable `backlog:lastRun` snapshot written alongside it.
      let lastBacklogRun = getLastBacklogRun(bot.name);
      if (!lastBacklogRun && watcher) {
        const snap = await backlogDeps.getSnapshot(watcher.id, WIKI_GARDENER_LAST_RUN_KEY);
        if (snap && typeof snap === "object") lastBacklogRun = snap as LastBacklogRun;
      }

      // Interrupted-run detection: a journal that outlived its run (a crash or an
      // error settle KEEPS it) with no run currently in flight ⇒ surface a banner.
      let interrupted: BacklogLiveFields["interrupted"] = null;
      if (watcher && !running) {
        const journal = await readRunJournal(backlogDeps, watcher.id);
        // Re-probe after the read: an Ingest that started during the awaits above
        // may have just written ITS journal — that's a live run, not an interrupted
        // one (would flash a false banner for one poll).
        if (journal && !gardenerRunInFlight(bot.name)) {
          const proposals = await backlogDeps.listProposals(bot.name);
          const drafted = draftedKeysSince(proposals, journal.startedAt, journal.batchKeys);
          interrupted = { at: journal.startedAt, batchSize: journal.batchKeys.length, drafted: drafted.size };
        }
      }

      return c.json(
        mergeBacklogLiveFields(data, {
          running,
          offered: offeredSet.size,
          remaining,
          offeredStillQueued,
          fresh,
          freshBySource,
          freshWindowDays: minAgeDays,
          lastBacklogRun,
          watcherSeeded: !!watcher,
          progress: getBacklogProgress(bot.name),
          interrupted,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Ingest backlog computation failed for {bot}: {error}", { bot: bot.name, error: message });
      return c.json({
        ...empty,
        errors: [{ source: "backlog", collection: "", error: message }],
      });
    }
  });

  // Manual "ingest backlog" drain — kicks a DETACHED gardener run over a bounded
  // batch of never-ingested summary docs (URL-referenced docs are never drafted),
  // routed through the SAME pipeline so every draft is a reviewable proposal. No
  // Telegram alert (the user is at the dashboard). Responds immediately with the
  // run state; the client polls the GET while `running`.
  app.post("/api/wiki/gardener/backlog-run", async (c) => {
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { bot, root } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    const config = loadConfig();

    const result = startBacklogRun({
      botName: bot.name,
      gardenerEnabled: bot.gardener?.enabled !== false,
      hasWatcher: !!watcher,
      // A batch below the cluster minimum can't draft — the work fn short-circuits
      // to an `insufficient` outcome (no journal/offer/run) rather than burning the
      // tiny tail. Sourced from the SAME resolved config as the runner's clusterer.
      minClusterSize: resolveGardenerConfig(bot.gardener).minClusterSize,
      assemble: () =>
        assembleBacklog({
          botName: bot.name,
          wikiDir: root,
          apiUrl: KNOWLEDGE_API_URL,
          listCollections: listSummaryCollections,
          sweepWikiRefs: collectWikiRefs,
          getConsumed: backlogDeps.getConsumed,
          getPending: backlogDeps.getPending,
          getOffered: () => readOffered(backlogDeps, watcher!.id),
          // Age floor = the bot's RESOLVED weekly window, so the drain never
          // touches docs the weekly gardener still owns (would burn a fresh
          // arrival that can't cluster, hiding it from both paths).
          minAgeDays: resolveGardenerConfig(bot.gardener).lookbackDays,
          now: Date.now(),
        }),
      persistOffered: (keys) => backlogDeps.setSnapshot(watcher!.id, WIKI_GARDENER_OFFERED_KEY, keys),
      // Journal seams (PR 3) — the auto-recover + crash-safety record all ride the
      // same watcher_snapshots table, keyed by `backlog:run`.
      getOffered: () => readOffered(backlogDeps, watcher!.id),
      readRunJournal: () => readRunJournal(backlogDeps, watcher!.id),
      writeRunJournal: (j) => backlogDeps.setSnapshot(watcher!.id, WIKI_GARDENER_RUN_KEY, j),
      clearRunJournal: () => backlogDeps.setSnapshot(watcher!.id, WIKI_GARDENER_RUN_KEY, null),
      draftedKeysSince: async (startedAt, batchKeys) =>
        draftedKeysSince(await backlogDeps.listProposals(bot.name), startedAt, batchKeys),
      // The tracer root span must be finished HERE — runGardener only creates
      // sub-spans (the weekly checker finishes its own tracer the same way);
      // without this every drain leaves a malformed open trace in the waterfall.
      runGardener: async (assembled, hooks) => {
        const tracer = new Tracer("wiki-gardener-backlog", { botName: bot.name });
        try {
          const alerts = await runGardener(
            buildBacklogGardenerDeps(assembled, { bot, config, apiUrl: KNOWLEDGE_API_URL, root, tracer }, hooks),
          );
          tracer.finish("ok", {
            offered: assembled.batchKeys.length,
            drafted: draftedCount(alerts),
          });
          return alerts;
        } catch (err) {
          tracer.error(err instanceof Error ? err : String(err));
          throw err;
        }
      },
      recordLastRun: (r) => {
        setLastBacklogRun(bot.name, r);
        // Durable fallback for the extended GET after a restart drops the in-memory
        // map. Best-effort — a snapshot-write failure must not fail the settled run.
        if (watcher) {
          void backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_LAST_RUN_KEY, r).catch((err) => {
            log.warn("Backlog run: persisting last-run snapshot failed for {bot}: {error}", {
              bot: bot.name,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      },
    });

    if (result.state === "no-watcher") {
      return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);
    }
    if (result.state === "disabled") {
      return c.json({ error: "the wiki gardener is disabled for this bot" }, 400);
    }
    return c.json({ state: result.state });
  });

  // Reset the offered memory — writes an empty offered snapshot so every queued
  // doc is eligible again (the recovery path for rejected-but-still-offered docs).
  // Refused while a run is in flight: the run's persistOffered was computed from
  // a pre-reset read and would silently clobber the empty set.
  app.post("/api/wiki/gardener/backlog-reset", async (c) => {
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    const outcome = await resetBacklogOffered(bot.name, () =>
      backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY, []),
    );
    if (!outcome.ok) return c.json({ state: "running", error: outcome.error }, 409);
    return c.json({ ok: true });
  });

  // Soft-cancel an in-flight backlog drain — flips the run's cancel flag; the
  // runner stops after at most one more draft, keeping every persisted proposal
  // and returning the undrafted docs to the queue. Same resolution/watcher guards
  // as backlog-reset. No run in flight (a cancel racing the natural settle — the
  // likely case) is a no-op 200 `{cancelled:false}`, not an error.
  app.post("/api/wiki/gardener/backlog-cancel", async (c) => {
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    return c.json({ cancelled: requestBacklogCancel(bot.name) });
  });

  // Recover an interrupted (crashed / errored) drain — return its undrafted batch
  // docs to the offered pool so they're eligible again, then clear the journal. The
  // math is DELIBERATELY the coarse `batchKeys − draftedKeys` (not PR 2's cancel
  // math that subtracts only skipped clusters' docs): a crash may predate clustering
  // so no cluster info exists, and the user explicitly chose Recover over Dismiss.
  // Held under the per-bot mutex so a recover click racing an Ingest click serializes
  // rather than interleaving (the same check-then-persist TOCTOU §3a rejects for
  // run-start). No journal (a refresh race) ⇒ a clean no-op 200 `{recovered:0}`.
  app.post("/api/wiki/gardener/backlog-recover", async (c) => {
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    const run = runExclusive(bot.name, () =>
      // The ONE recover body, shared with startBacklogRun's in-mutex auto-recover.
      recoverRunJournal({
        readRunJournal: () => readRunJournal(backlogDeps, watcher.id),
        draftedKeysSince: async (startedAt, batchKeys) =>
          draftedKeysSince(await backlogDeps.listProposals(bot.name), startedAt, batchKeys),
        getOffered: async () => readOffered(backlogDeps, watcher.id),
        persistOffered: (keys) => backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY, keys),
        clearRunJournal: () => backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_RUN_KEY, null),
      }),
    );
    if (run === null) return c.json({ error: "a run is in flight" }, 409);
    return c.json({ recovered: await run });
  });

  // Dismiss an interrupted drain — leave the batch skipped (offered), just clear the
  // journal so the banner goes away. No journal is a clean no-op (refresh-race
  // friendly). Same resolution/watcher guards as the other backlog POSTs. Held under
  // the per-bot mutex like recover — a stale banner's Dismiss (e.g. another tab)
  // racing a fresh Ingest must NOT null the live run's journal, which would strand
  // that batch unrecoverably if it crashed.
  app.post("/api/wiki/gardener/backlog-dismiss", async (c) => {
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    const run = runExclusive(bot.name, () =>
      backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_RUN_KEY, null),
    );
    if (run === null) return c.json({ error: "a run is in flight" }, 409);
    await run;
    return c.json({ ok: true });
  });

  // Approve → CAS draft→approved, run the apply step, flip to applied|stale|error.
  // A row already in `approved` is re-runnable (recovery for a crash between the
  // approve CAS and the terminal CAS — apply itself is re-run safe).
  app.post("/api/wiki/proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const existing = await getWikiProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    let claimed: WikiProposal | null = null;
    if (existing.status === "draft") {
      claimed = await approveWikiProposal(id);
      if (!claimed) {
        return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
      }
    } else if (existing.status === "approved") {
      claimed = existing;
      log.info("Wiki-gardener: re-running apply for stuck approved proposal {id}", { id });
    } else {
      return c.json({ error: "proposal is not reviewable", status: existing.status }, 409);
    }

    const bot = getBots().find((b) => b.name === claimed.botName);
    if (!bot || !bot.wikiDir) {
      await finishProposal(id, markWikiProposalError, "error");
      log.error("Wiki-gardener approve: bot {bot} has no wikiDir — cannot apply proposal {id}", {
        bot: claimed.botName,
        id,
      });
      return c.json({ outcome: "error", error: "bot has no wikiDir configured" }, 500);
    }

    let result;
    try {
      result = await applyWikiProposal(claimed, applyDepsFor(bot.wikiDir));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await finishProposal(id, markWikiProposalError, "error");
      log.error("Wiki-gardener apply threw for {id}: {error}", { id, error: reason });
      return c.json({ outcome: "error", error: reason }, 500);
    }

    if (result.outcome === "applied") {
      if (!(await finishProposal(id, markWikiProposalApplied, "applied"))) {
        return c.json({ error: "proposal state changed during apply" }, 409);
      }
      log.info("Wiki-gardener applied proposal {id} → {path}", { id, path: result.writtenPath });
      return c.json({ outcome: "applied", writtenPath: result.writtenPath });
    }
    if (result.outcome === "stale") {
      if (!(await finishProposal(id, markWikiProposalStale, "stale"))) {
        return c.json({ error: "proposal state changed during apply" }, 409);
      }
      log.info("Wiki-gardener proposal {id} stale: {reason}", { id, reason: result.reason });
      return c.json({ outcome: "stale", reason: result.reason });
    }
    await finishProposal(id, markWikiProposalError, "error");
    log.error("Wiki-gardener apply error for {id}: {reason}", { id, reason: result.reason });
    return c.json({ outcome: "error", error: result.reason }, 500);
  });

  // Reject → CAS draft→rejected. Rejected topicKeys are skipped by the cluster filter.
  app.post("/api/wiki/proposals/:id/reject", async (c) => {
    const id = c.req.param("id");
    const existing = await getWikiProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    const rejected = await rejectWikiProposal(id);
    if (!rejected) {
      return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
    }
    return c.json({ outcome: "rejected" });
  });
}
