import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderSummariesPage } from "../views/summaries-page.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { capturePresetOptions, resolveCapturePresets } from "../../summaries/presets.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { docDateMs } from "../../gardener/harvest.ts";
import { buildStats, type StatsDoc, type SummariesStats } from "../../summaries/stats.ts";
import { listSummaryCollections } from "../../summaries/list-collections.ts";
import { DEFAULT_COVERAGE_DEPS, type CoverageDeps } from "../../db/wiki-proposals.ts";
import { registerSummariesShareRoutes } from "./summaries-share.ts";

const log = getLog("dashboard");

interface SummaryDocumentMeta {
  id: string;
  url?: string;
  date?: string;
  /** Full-precision ingest timestamp from huginn — intra-day sort tiebreaker. */
  modifiedTime?: string;
  /** The poster frame, when the document's frontmatter carries one (Vimeo). */
  thumbnail_url?: string;
  title?: string;
  [key: string]: unknown;
}

/** Injectable coverage lookups so the route test can drive them without a DB —
 *  the shared {@link CoverageDeps} shape (also used by the wiki ingest backlog). */
export type SummariesStatsDeps = CoverageDeps;

const STATS_MONTHS_BACK = 8;
const STATS_WINDOW_DAYS = 30;
const STATS_TTL_MS = 5 * 60_000;

/**
 * In-process stats cache, keyed by bot name (coverage is per-bot). A 5-minute TTL
 * keeps the (per-collection full-listing) fetch off huginn's Python server on
 * every tab open; `?refresh=1` bypasses the cache read. An in-flight map
 * single-flights concurrent misses, mirroring the wiki digest cache.
 */
interface StatsCacheEntry {
  data: SummariesStats;
  at: number;
}
const statsCache = new Map<string, StatsCacheEntry>();
const statsInFlight = new Map<string, Promise<SummariesStats>>();

/**
 * Drop the whole stats cache — called by the gardener's doc-delete route, whose
 * proposal delete moves the "pending review" count a cached payload reports.
 * ALL keys, not the deleting bot's: the cache is keyed on the stats route's
 * `?bot=` (which the page never sends, so the live key is the literal fallback
 * `"jarvis"`), while the delete resolves a wiki-registry bot — two names that
 * only coincide on some instances. The in-flight guard is left alone: a compute
 * already running reads the DB after the caller's delete committed.
 */
export function invalidateSummariesStatsCache(): void {
  statsCache.clear();
}

/** Test-only: seed + read the cache, so a route in another module can prove it
 *  invalidated (the route test cannot drive a stats GET). */
export function __setSummariesStatsCacheForTest(botName: string, data: SummariesStats): void {
  statsCache.set(botName, { data, at: Date.now() });
}
export function __peekSummariesStatsCacheForTest(botName: string): SummariesStats | undefined {
  return statsCache.get(botName)?.data;
}

/** Test-only: clear the stats cache (and in-flight guard) between cases. */
export function __resetSummariesStatsCacheForTest(): void {
  statsCache.clear();
  statsInFlight.clear();
}

/**
 * Fetch every summary collection (via the shared sequential listing helper —
 * never unbounded concurrency at huginn's Python server), parse dates the way
 * the gardener does, and assemble the stats payload. A collection that fails
 * contributes nothing and lands in the `errors` array — never a page-breaking throw.
 */
async function computeSummariesStats(
  knowledgeApiUrl: string,
  botName: string,
  deps: SummariesStatsDeps,
  now: number = Date.now(),
): Promise<SummariesStats> {
  const { byCollection, errors } = await listSummaryCollections(knowledgeApiUrl);

  const docs: StatsDoc[] = [];
  for (const source of SUMMARY_SOURCES) {
    for (const d of byCollection[source.collection] ?? []) {
      docs.push({
        collection: source.collection,
        id: d.id,
        source: source.id,
        dateMs: docDateMs({ id: d.id, date: d.date }),
        ...(d.title ? { title: d.title } : {}),
        ...(d.url ? { url: d.url } : {}),
      });
    }
  }

  const [consumed, pending] = await Promise.all([
    deps.getConsumed(botName),
    deps.getPending(botName),
  ]);

  return buildStats({
    docs,
    consumed,
    pending,
    now,
    monthsBack: STATS_MONTHS_BACK,
    windowDays: STATS_WINDOW_DAYS,
    errors,
  });
}

/**
 * Merged documents listing across every summary source. Fetches each source's
 * collection in parallel (with dates, so the page can group by recency) and
 * tags every doc with its `source` id. A source that errors or is unreachable
 * contributes nothing — the rest still render (no all-or-nothing failure).
 */
export function registerSummariesRoutes(
  app: Hono,
  config: Config,
  deps: SummariesStatsDeps = DEFAULT_COVERAGE_DEPS,
): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/summaries", async (c) => {
    // The kind picker offers what the SUMMARIZER bot offers — the same
    // resolution the Vimeo route validates a POSTed kind against.
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    const captureKinds = capturePresetOptions(
      resolveCapturePresets(summarizerBot?.prompts, summarizerBot?.connector),
    );
    return c.html(await renderSummariesPage({ captureKinds }));
  });

  // Share: `POST /api/summaries/share` (SSE) + its preset list — the doc panel's
  // 📤 Share button. Its own module (`summaries-share.ts`) because it is an
  // adapter onto the shared share layer, with its own injectable seams.
  registerSummariesShareRoutes(app, config);

  app.get("/api/summaries/stats", async (c) => {
    const botName = c.req.query("bot") || "jarvis";
    const refresh = c.req.query("refresh") === "1";

    if (!refresh) {
      const cached = statsCache.get(botName);
      if (cached && Date.now() - cached.at < STATS_TTL_MS) return c.json(cached.data);
    }

    // Single-flight: concurrent misses (or a refresh racing an auto-load) share
    // one fetch rather than each hammering huginn.
    let pending = statsInFlight.get(botName);
    if (!pending) {
      pending = computeSummariesStats(KNOWLEDGE_API_URL, botName, deps).finally(() => {
        statsInFlight.delete(botName);
      });
      statsInFlight.set(botName, pending);
    }

    try {
      const data = await pending;
      // Only cache fully-successful results — a degraded payload (a collection
      // down) must not be served for the whole TTL once huginn recovers.
      if (!data.errors || data.errors.length === 0) {
        statsCache.set(botName, { data, at: Date.now() });
      }
      return c.json(data);
    } catch (err) {
      // computeSummariesStats swallows per-collection fetch errors, so a throw
      // here means the coverage (DB) lookups failed. Degrade to a 200 with empty
      // data + an error note rather than a page-breaking 5xx.
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Summaries stats coverage lookup failed for {bot}: {error}", {
        bot: botName,
        error: message,
      });
      const fallback: SummariesStats = {
        months: [],
        bySource: {},
        coverage: { windowDays: STATS_WINDOW_DAYS, total: 0, consumed: 0, pending: 0, neverClustered: [], undated: 0 },
        errors: [{ source: "coverage", collection: "wiki_proposals", error: message }],
      };
      return c.json(fallback);
    }
  });

  app.get("/api/summaries/documents", async (c) => {
    const results = await Promise.all(
      SUMMARY_SOURCES.map(async (source) => {
        try {
          const data = await fetchKnowledgeApi(
            KNOWLEDGE_API_URL,
            // Thumbnails ride on the same one-read pass as the dates (huginn
            // #127); a document with none simply has no key.
            `/api/collection/${source.collection}/documents?include_dates=1&include_thumbnails=1`,
            { timeoutMs: 10000 },
          );
          const docs = (data?.documents ?? []) as SummaryDocumentMeta[];
          return { ok: true, docs: docs.map((d) => ({ ...d, source: source.id })) };
        } catch (err) {
          log.warn("Summaries documents fetch failed for {source}: {error}", {
            source: source.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: false, docs: [] as SummaryDocumentMeta[] };
        }
      }),
    );

    // A partial failure still returns the sources that loaded (and is logged
    // above). But if *every* source failed, surface it as an error so the
    // client shows "Failed to load" instead of a misleading "no summaries yet"
    // empty state — the old per-source pages did this via knowledgeApiHandler.
    if (!results.some((r) => r.ok)) {
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }

    return c.json({ documents: results.flatMap((r) => r.docs) });
  });
}
