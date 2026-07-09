import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderSummariesPage } from "../views/summaries-page.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { docDateMs } from "../../gardener/harvest.ts";
import { buildStats, type StatsDoc, type SummariesStats } from "../../summaries/stats.ts";
import { listSummaryCollections } from "../../summaries/list-collections.ts";
import { DEFAULT_COVERAGE_DEPS, type CoverageDeps } from "../../db/wiki-proposals.ts";

const log = getLog("dashboard");

interface SummaryDocumentMeta {
  id: string;
  url?: string;
  date?: string;
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
    return c.html(await renderSummariesPage());
  });

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
            `/api/collection/${source.collection}/documents?include_dates=1`,
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
