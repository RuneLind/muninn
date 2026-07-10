import type { Hono } from "hono";
import path from "node:path";
import { renderWikiGardenerPage } from "../views/wiki-gardener-page.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import { getWikiIndex } from "../../wiki/store.ts";
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
import { collectWikiUrls, computeIngestBacklog, type ListedDoc } from "../../wiki/ingest-backlog.ts";
import { resolveGardenerConfig } from "../../gardener/types.ts";
import { runGardener, type GardenerDeps } from "../../gardener/runner.ts";
import {
  assembleBacklog,
  startBacklogRun,
  resetBacklogOffered,
  draftedCount,
  gardenerRunInFlight,
  BACKLOG_MAX_PROPOSALS,
  BACKLOG_LOOKBACK_DAYS,
  DRAFT_TIMEOUT_MS,
  WIKI_GARDENER_OFFERED_KEY,
  type AssembledBacklog,
  type LastBacklogRun,
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
 * bot's `wiki-gardener` watcher row (offered memory's `watcher_id`) plus the
 * offered-set snapshot read/write. All injectable so the routes test without a DB.
 */
export interface BacklogRouteDeps extends CoverageDeps {
  getWikiGardenerWatcher: (botName: string) => Promise<GardenerWatcherRef | null>;
  getOffered: (watcherId: string) => Promise<Set<string>>;
  setOffered: (watcherId: string, keys: string[]) => Promise<void>;
}

export const DEFAULT_BACKLOG_ROUTE_DEPS: BacklogRouteDeps = {
  ...DEFAULT_COVERAGE_DEPS,
  getWikiGardenerWatcher: async (botName) => {
    const w = await getWikiGardenerWatcher(botName);
    return w ? { id: w.id } : null;
  },
  getOffered: async (watcherId) => {
    const snap = await getWatcherSnapshot(watcherId, WIKI_GARDENER_OFFERED_KEY);
    return new Set(Array.isArray(snap) ? (snap as string[]) : []);
  },
  setOffered: (watcherId, keys) => setWatcherSnapshot(watcherId, WIKI_GARDENER_OFFERED_KEY, keys),
};

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
  lastBacklogRun: LastBacklogRun | null;
  watcherSeeded: boolean;
}

/**
 * Merge the per-request live fields onto the cached (by-reference) backlog
 * payload WITHOUT mutating the cached object: strip the server-only `queuedKeys`
 * and spread a fresh object. Exported so the non-mutation contract is unit-tested.
 */
export function mergeBacklogLiveFields(
  data: IngestBacklogResponse,
  live: BacklogLiveFields,
): Record<string, unknown> {
  const { queuedKeys: _drop, ...rest } = data;
  return { ...rest, ...live };
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
   * Server-only: `<collection>/<id>` keys of every queued doc. Cached alongside
   * the counts so the extended GET can compute `remaining` (queued minus the
   * offered set) precisely, but STRIPPED before the wire by {@link mergeBacklogLiveFields}.
   */
  queuedKeys?: string[];
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

  const wikiUrls = await collectWikiUrls(root);
  const [consumed, pending] = await Promise.all([deps.getConsumed(botName), deps.getPending(botName)]);
  const backlog = computeIngestBacklog(listedBySource, wikiUrls, consumed, pending);

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

  // Server-only queued keys (stripped before the wire) — used by the extended GET
  // to compute `remaining` against the offered set.
  const queuedKeys = backlog.byCollection.flatMap((c) =>
    c.queuedDocs.map((d) => `${d.collection}/${d.id}`),
  );

  return {
    byCollection,
    total: backlog.total,
    ingested: backlog.ingested,
    queued: backlog.queued,
    wikiUrlCount: wikiUrls.size,
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
): GardenerDeps {
  const { bot, config, apiUrl, root, tracer } = ctx;
  return {
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
    ...buildGardenerSeams({ botConfig: bot, config, apiUrl, wikiDir: root }),
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
      const offeredSet = watcher ? await backlogDeps.getOffered(watcher.id) : new Set<string>();
      const queuedKeys = data.queuedKeys ?? [];
      const remaining = queuedKeys.filter((k) => !offeredSet.has(k)).length;
      return c.json(
        mergeBacklogLiveFields(data, {
          running: gardenerRunInFlight(bot.name),
          offered: offeredSet.size,
          remaining,
          lastBacklogRun: getLastBacklogRun(bot.name),
          watcherSeeded: !!watcher,
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
      assemble: () =>
        assembleBacklog({
          botName: bot.name,
          wikiDir: root,
          apiUrl: KNOWLEDGE_API_URL,
          listCollections: listSummaryCollections,
          sweepWikiUrls: collectWikiUrls,
          getConsumed: backlogDeps.getConsumed,
          getPending: backlogDeps.getPending,
          getOffered: () => backlogDeps.getOffered(watcher!.id),
        }),
      persistOffered: (keys) => backlogDeps.setOffered(watcher!.id, keys),
      // The tracer root span must be finished HERE — runGardener only creates
      // sub-spans (the weekly checker finishes its own tracer the same way);
      // without this every drain leaves a malformed open trace in the waterfall.
      runGardener: async (assembled) => {
        const tracer = new Tracer("wiki-gardener-backlog", { botName: bot.name });
        try {
          const alerts = await runGardener(
            buildBacklogGardenerDeps(assembled, { bot, config, apiUrl: KNOWLEDGE_API_URL, root, tracer }),
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
      recordLastRun: (r) => setLastBacklogRun(bot.name, r),
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

    const outcome = await resetBacklogOffered(bot.name, () => backlogDeps.setOffered(watcher.id, []));
    if (!outcome.ok) return c.json({ state: "running", error: outcome.error }, 409);
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
