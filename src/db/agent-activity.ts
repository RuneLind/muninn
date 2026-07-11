import { getDb } from "./client.ts";

/**
 * Read-only queries backing the `/agents` overview's Recent list. These are the
 * durable sources (a/b/c in `assembleAgentsOverview`): chat + watcher trace
 * spans, and extractor `haiku_usage` rows. Gardener/capture/research/per-task
 * Recent rows come from the registry's in-memory completed-runs ring instead.
 */

/** A recent chat-turn or watcher run, sourced from `traces`. */
export interface RecentTraceRow {
  traceId: string;
  /** Span name — a chat root (`<platform>_message` / `telegram_voice`) or a
   *  watcher child span (`watcher:<type>`). */
  name: string;
  status: string;
  botName: string | null;
  startedAt: number; // epoch ms
  durationMs: number | null;
}

/**
 * Recent chat turns (root `%_message` / `telegram_voice` spans) UNION watcher
 * child spans (`watcher:%`), keyed by span NAME — NOT `parent_id IS NULL`
 * (watchers are child spans of the scheduler_tick root). No-op skip spans
 * (quiet-hours + in-flight guard) finish "ok" with ~0ms and carry the
 * `quietHoursSkipped` / `skippedInFlight` JSONB attributes — excluded here so
 * Recent shows real runs only.
 */
export async function getRecentAgentTraces(limit = 40, windowHours = 48): Promise<RecentTraceRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT trace_id, name, status, bot_name, started_at, duration_ms
    FROM traces
    WHERE created_at >= now() - make_interval(hours => ${windowHours})
      AND (
        (parent_id IS NULL AND (name LIKE '%_message' OR name = 'telegram_voice'))
        OR (
          name LIKE 'watcher:%'
          AND NOT (attributes ? 'quietHoursSkipped')
          AND NOT (attributes ? 'skippedInFlight')
        )
      )
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    traceId: r.trace_id,
    name: r.name,
    status: r.status,
    botName: r.bot_name ?? null,
    startedAt: new Date(r.started_at).getTime(),
    durationMs: r.duration_ms ?? null,
  }));
}

/** A `watcher:<type>` child span, feeding the `/agents` ETA estimator's watcher
 *  identity durations. Carries the two skip flags so the pure grouping step
 *  (`groupWatcherDurations`) can exclude no-op ticks — see `src/dashboard/agent-eta.ts`. */
export interface WatcherDurationRow {
  name: string; // `watcher:<type>`
  durationMs: number | null;
  quietHoursSkipped: boolean;
  skippedInFlight: boolean;
}

/**
 * Watcher child-span durations (`watcher:%`) over the last `windowDays`,
 * newest-first — the durable ETA source for watcher runs (survives a process
 * restart, unlike the in-memory completed-runs ring). Skip spans are NOT filtered
 * in SQL: the two `attributes ? '…'` flags are returned so the pure grouping step
 * (`groupWatcherDurations`) can exclude them (keeps that exclusion unit-testable).
 *
 * Windowed PER TYPE (`ROW_NUMBER() OVER (PARTITION BY name …)` capped at
 * `perTypeLimit`), NOT a single global `LIMIT` — otherwise a 5-min-interval
 * watcher would flood a weekly one out of the window within days. The cap sits a
 * bit above the pure layer's ~20 median cap so skip-span exclusion still leaves
 * enough real rows.
 */
export async function getWatcherRunDurations(windowDays = 30, perTypeLimit = 25): Promise<WatcherDurationRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT name, duration_ms, quiet_skip, inflight_skip
    FROM (
      SELECT name, duration_ms, started_at,
             (attributes ? 'quietHoursSkipped') AS quiet_skip,
             (attributes ? 'skippedInFlight')   AS inflight_skip,
             ROW_NUMBER() OVER (PARTITION BY name ORDER BY started_at DESC) AS rn
      FROM traces
      WHERE name LIKE 'watcher:%'
        AND duration_ms IS NOT NULL
        AND created_at >= now() - make_interval(days => ${windowDays})
    ) t
    WHERE rn <= ${perTypeLimit}
    ORDER BY name, started_at DESC
  `;
  return rows.map((r) => ({
    name: r.name as string,
    durationMs: r.duration_ms ?? null,
    quietHoursSkipped: r.quiet_skip === true,
    skippedInFlight: r.inflight_skip === true,
  }));
}

/** A recent extractor run, sourced from `haiku_usage`. */
export interface RecentExtractorRow {
  source: string; // 'memory' | 'goals' | 'schedule'
  model: string | null;
  botName: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: number; // epoch ms
}

/** Recent extractor Haiku calls (memory / goals / schedule) — carries model +
 *  tokens + created_at, the only completion signal these leave. */
export async function getRecentExtractorUsage(limit = 40, windowHours = 48): Promise<RecentExtractorRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT source, model, bot_name, input_tokens, output_tokens, created_at
    FROM haiku_usage
    WHERE source IN ('memory', 'goals', 'schedule')
      AND created_at >= now() - make_interval(hours => ${windowHours})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    source: r.source as string,
    model: (r.model as string | null) ?? null,
    botName: (r.bot_name as string | null) ?? null,
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    createdAt: new Date(r.created_at).getTime(),
  }));
}
