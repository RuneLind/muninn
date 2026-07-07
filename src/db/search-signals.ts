/**
 * Durable ledger of per-sub-question search quality — "what the knowledge base
 * couldn't confidently answer".
 *
 * Huginn returns per-search lowConfidence / bestScore / no-hits / Path-D
 * corrective-rescue info; muninn stores it in `traces` attributes and today lets
 * it hard-delete with the 7-day trace retention cleanup. `harvestSearchSignals`
 * rolls the research `search` spans into this table BEFORE cleanupOldTraces runs
 * (see src/scheduler/runner.ts), so the signal outlives the trace it came from.
 *
 * The source spans are the `search` spans written by
 * src/ai/research-knowledge.ts (name = 'search', one per sub-question), whose
 * attributes carry `subQuestion`, `resultCount`, `bestScore`, `lowConfidence`,
 * `collections`, and — when Path D fired — a nested
 * `searchTrace.response.corrective` block (shape per span-label.ts).
 *
 * `span_id` (the source `traces.id`) is UNIQUE, so the hourly harvest is
 * idempotent via ON CONFLICT DO NOTHING — re-scanning overlapping windows is a
 * no-op.
 */

import { getDb } from "./client.ts";

/**
 * Harvest research `search` spans from `traces` into `search_signals`. Extracts
 * the quality attrs (incl. the nested Path-D corrective block) entirely in SQL —
 * one INSERT…SELECT, no round-trip per row — and dedupes on `span_id`. Returns
 * the number of newly-inserted rows. Idempotent: already-harvested spans skip.
 *
 * Only spans that carry a `subQuestion` attribute are harvested — that key is
 * unique to research-knowledge's per-sub-question searches, so it filters out any
 * unrelated span that happens to be named `search`.
 */
export async function harvestSearchSignals(): Promise<number> {
  const sql = getDb();
  const result = await sql`
    INSERT INTO search_signals (
      span_id, trace_id, bot_name, query, collections,
      result_count, best_score, low_confidence, no_hits,
      rescue_fired, rescue_verdict, rescue_retries, span_started_at
    )
    SELECT
      t.id,
      t.trace_id,
      t.bot_name,
      t.attributes->>'subQuestion',
      t.attributes->'collections',
      COALESCE((t.attributes->>'resultCount')::int, 0),
      -- bestScore + the corrective block come from huginn (untrusted JSON):
      -- regex-guard every cast so one malformed span can't fail the whole
      -- INSERT…SELECT and starve the retention cleanup behind it.
      CASE WHEN t.attributes->>'bestScore' ~ '^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$'
           THEN (t.attributes->>'bestScore')::real END,
      COALESCE((t.attributes->>'lowConfidence')::boolean, false),
      COALESCE((t.attributes->>'resultCount')::int, 0) = 0,
      COALESCE(t.attributes#>>'{searchTrace,response,corrective,rescueFired}' = 'true', false),
      CASE WHEN t.attributes#>>'{searchTrace,response,corrective,rescueFired}' = 'true'
           THEN t.attributes#>>'{searchTrace,response,corrective,verdict}' END,
      CASE WHEN t.attributes#>>'{searchTrace,response,corrective,rescueFired}' = 'true'
            AND t.attributes#>>'{searchTrace,response,corrective,retries}' ~ '^\\d+$'
           THEN (t.attributes#>>'{searchTrace,response,corrective,retries}')::int END,
      t.started_at
    FROM traces t
    WHERE t.name = 'search'
      AND t.attributes ? 'subQuestion'
      -- Errored sub-searches (timeout, huginn 5xx) carry no resultCount and
      -- would harvest as no_hits=true — a transient outage is not a knowledge
      -- gap, so they are excluded rather than recorded.
      AND NOT (t.attributes ? 'error')
    ON CONFLICT (span_id) DO NOTHING
  `;
  return result.count;
}

export interface SearchSignalRow {
  id: string;
  spanId: string;
  traceId: string | null;
  botName: string | null;
  query: string | null;
  collections: string[] | null;
  resultCount: number;
  bestScore: number | null;
  lowConfidence: boolean;
  noHits: boolean;
  rescueFired: boolean;
  rescueVerdict: string | null;
  rescueRetries: number | null;
  spanStartedAt: number | null;
  createdAt: number;
}

/** Read a signal row by its source span id (tests + drill-down). */
export async function getSearchSignalBySpanId(spanId: string): Promise<SearchSignalRow | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, span_id, trace_id, bot_name, query, collections, result_count,
           best_score, low_confidence, no_hits, rescue_fired, rescue_verdict,
           rescue_retries, span_started_at, created_at
    FROM search_signals
    WHERE span_id = ${spanId}
  `;
  const r = rows[0];
  return r ? mapSignalRow(r) : null;
}

export interface LowConfidenceQuery {
  query: string;
  hits: number;
  lastSeen: number;
}

/**
 * Top recurring low-confidence / no-hit queries in the last N days — the raw
 * material for a "knowledge gaps" dashboard view. Grouped by query text, ranked
 * by frequency. Exported for later UI; no dashboard wired in this PR.
 */
export async function getTopLowConfidenceQueries(days = 7, limit = 20): Promise<LowConfidenceQuery[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT query,
           COUNT(*)::int AS hits,
           MAX(created_at) AS last_seen
    FROM search_signals
    WHERE query IS NOT NULL
      AND (low_confidence = true OR no_hits = true)
      AND created_at > NOW() - make_interval(days => ${days})
    GROUP BY query
    ORDER BY hits DESC, last_seen DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    query: r.query,
    hits: Number(r.hits),
    lastSeen: new Date(r.last_seen).getTime(),
  }));
}

function mapSignalRow(r: Record<string, any>): SearchSignalRow {
  const collections = Array.isArray(r.collections)
    ? (r.collections.filter((c: unknown): c is string => typeof c === "string"))
    : null;
  return {
    id: r.id,
    spanId: r.span_id,
    traceId: r.trace_id ?? null,
    botName: r.bot_name ?? null,
    query: r.query ?? null,
    collections,
    resultCount: Number(r.result_count),
    bestScore: r.best_score != null ? Number(r.best_score) : null,
    lowConfidence: Boolean(r.low_confidence),
    noHits: Boolean(r.no_hits),
    rescueFired: Boolean(r.rescue_fired),
    rescueVerdict: r.rescue_verdict ?? null,
    rescueRetries: r.rescue_retries != null ? Number(r.rescue_retries) : null,
    spanStartedAt: r.span_started_at != null ? new Date(r.span_started_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
  };
}
