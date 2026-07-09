/**
 * Summaries ingest-stats aggregation (pure).
 *
 * Backs the `/summaries` Stats tab: how many new summaries arrive per source per
 * calendar month, and how much of the recent window the wiki gardener actually
 * consumes. All functions here are pure (no IO) so the month grouping + coverage
 * partition are unit-testable without huginn or the DB — the route module wires
 * the fetch + DB lookups and calls these.
 *
 * Date parsing mirrors the gardener exactly (`docDateMs` from
 * `src/gardener/harvest.ts`): prefer an explicit `date`, else the `YYYY-MM-DD`
 * filename prefix. Month keys are computed in UTC to match how `Date.parse` reads
 * a bare `YYYY-MM-DD` (UTC midnight), so a doc never drifts a month near midnight.
 */

const DAY_MS = 86_400_000;

/** A summary doc, normalized for stats. `dateMs` is undefined when unparseable. */
export interface StatsDoc {
  /** Huginn collection name (e.g. `youtube-summaries`). */
  collection: string;
  /** Doc id within the collection (the listing filename). */
  id: string;
  /** Summary-source id (e.g. `youtube`) — the chart series + row badge. */
  source: string;
  /** Epoch ms of the doc's date, or undefined when no date could be parsed. */
  dateMs?: number;
  /** Human title if the listing carried one; falls back to the id. */
  title?: string;
  /** Original content url, when present. */
  url?: string;
}

/** One calendar month's per-source counts (a stacked bar in the chart). */
export interface MonthBucket {
  /** `YYYY-MM` (UTC). */
  month: string;
  /** Per-source-id doc count for this month. Missing source ⇒ zero. */
  counts: Record<string, number>;
  /** Sum across sources — the bar's full height. */
  total: number;
}

/** Per-source rollup over the charted window plus the undated bucket. */
export interface SourceRollup {
  /** Docs counted into the charted months (in-window, dated). */
  inWindow: number;
  /** Docs with no parseable date — reported, not charted. */
  undated: number;
}

export interface MonthlyAggregate {
  /** The charted months, oldest → newest. */
  months: MonthBucket[];
  /** Per-source-id rollup (charted + undated). */
  bySource: Record<string, SourceRollup>;
}

/** A doc the gardener never clustered — surfaced in the coverage list. */
export interface NeverClusteredDoc {
  collection: string;
  id: string;
  source: string;
  title: string;
  url?: string;
}

export interface CoverageResult {
  /** The window this coverage was computed over (days). */
  windowDays: number;
  /** Docs in the window (total = consumed + pending + neverClustered.length). */
  total: number;
  /** In `applied` proposals' source_docs. */
  consumed: number;
  /** In `draft`/`approved` proposals' source_docs. */
  pending: number;
  /** Neither consumed nor pending — the gardener has not touched these. */
  neverClustered: NeverClusteredDoc[];
  /**
   * Docs with no parseable date across the whole listing. They can't be placed
   * inside (or outside) the window, so they're excluded from `total` and the
   * partition — reported here so they're visible rather than silently inflating
   * the coverage numbers with arbitrarily old docs.
   */
  undated: number;
}

/** Per-collection fetch failure surfaced to the client (non-fatal). */
export interface StatsError {
  source: string;
  collection: string;
  error: string;
}

/** The full `/api/summaries/stats` response shape. */
export interface SummariesStats {
  /** Charted calendar months (oldest → newest), each with per-source counts. */
  months: MonthBucket[];
  /** Per-source-id rollup (charted total + undated bucket). */
  bySource: Record<string, SourceRollup>;
  /** Gardener consumption over the 30-day window. */
  coverage: CoverageResult;
  /** Present only when ≥1 collection failed to load (partial data). */
  errors?: StatsError[];
}

/**
 * Assemble the full stats payload from already-fetched docs. Pure — the route
 * supplies the docs (fetched from huginn), the consumed/pending sets (from the
 * proposals table), and `now`; this does the month grouping + coverage partition.
 */
export function buildStats(opts: {
  docs: StatsDoc[];
  consumed: Set<string>;
  pending: Set<string>;
  now: number;
  monthsBack?: number;
  windowDays?: number;
  errors?: StatsError[];
}): SummariesStats {
  const monthsBack = opts.monthsBack ?? 8;
  const windowDays = opts.windowDays ?? 30;
  const { months, bySource } = aggregateMonthly(opts.docs, opts.now, monthsBack);
  const coverage = partitionCoverage(
    docsInWindow(opts.docs, windowDays, opts.now),
    opts.consumed,
    opts.pending,
    windowDays,
    opts.docs.filter((d) => d.dateMs === undefined).length,
  );
  const result: SummariesStats = { months, bySource, coverage };
  if (opts.errors && opts.errors.length) result.errors = opts.errors;
  return result;
}

/** `YYYY-MM` (UTC) for an epoch-ms instant. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last `count` calendar-month keys ending at `now`'s month, oldest first. */
export function lastMonths(now: number, count: number): string[] {
  const d = new Date(now);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth(); // 0-based
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.unshift(`${year}-${String(month + 1).padStart(2, "0")}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return keys;
}

/**
 * Group docs into per-source monthly counts for the last `monthsBack` calendar
 * months. Dated docs outside that window are ignored (out of scope); undated
 * docs land in each source's `undated` bucket (reported, not charted).
 */
export function aggregateMonthly(
  docs: StatsDoc[],
  now: number,
  monthsBack = 8,
): MonthlyAggregate {
  const monthKeys = lastMonths(now, monthsBack);
  const monthSet = new Set(monthKeys);
  const buckets = new Map<string, MonthBucket>();
  for (const m of monthKeys) buckets.set(m, { month: m, counts: {}, total: 0 });

  const bySource: Record<string, SourceRollup> = {};
  const rollup = (source: string): SourceRollup =>
    (bySource[source] ??= { inWindow: 0, undated: 0 });

  for (const doc of docs) {
    if (doc.dateMs === undefined) {
      rollup(doc.source).undated += 1;
      continue;
    }
    const key = monthKey(doc.dateMs);
    if (!monthSet.has(key)) continue; // out of the charted window
    const bucket = buckets.get(key)!;
    bucket.counts[doc.source] = (bucket.counts[doc.source] ?? 0) + 1;
    bucket.total += 1;
    rollup(doc.source).inWindow += 1;
  }

  return { months: monthKeys.map((m) => buckets.get(m)!), bySource };
}

/**
 * Partition the coverage window's docs into consumed / pending / never-clustered.
 * `consumed` and `pending` are `<collection>/<id>` sets from the proposals table;
 * consumed wins if a doc somehow appears in both. Guarantees
 * `total === consumed + pending + neverClustered.length`.
 */
export function partitionCoverage(
  windowDocs: StatsDoc[],
  consumed: Set<string>,
  pending: Set<string>,
  windowDays: number,
  undated = 0,
): CoverageResult {
  let consumedCount = 0;
  let pendingCount = 0;
  const neverClustered: NeverClusteredDoc[] = [];
  for (const doc of windowDocs) {
    const key = `${doc.collection}/${doc.id}`;
    if (consumed.has(key)) {
      consumedCount += 1;
    } else if (pending.has(key)) {
      pendingCount += 1;
    } else {
      neverClustered.push({
        collection: doc.collection,
        id: doc.id,
        source: doc.source,
        title: doc.title || doc.id,
        ...(doc.url ? { url: doc.url } : {}),
      });
    }
  }
  return {
    windowDays,
    total: windowDocs.length,
    consumed: consumedCount,
    pending: pendingCount,
    neverClustered,
    undated,
  };
}

/**
 * Docs whose date puts them inside the `windowDays` window ending at `now`.
 * Undated docs are excluded — they can't be windowed, so keeping them (as the
 * gardener's best-effort `filterWindow` does for harvesting) would let
 * arbitrarily old docs inflate the coverage totals while the monthly chart
 * excludes them. They're surfaced via `CoverageResult.undated` instead.
 */
export function docsInWindow(docs: StatsDoc[], windowDays: number, now: number): StatsDoc[] {
  const cutoff = now - windowDays * DAY_MS;
  return docs.filter((d) => d.dateMs !== undefined && d.dateMs >= cutoff);
}
