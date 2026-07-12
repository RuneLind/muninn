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
  /** Model that actually ran, from the chat root's child `claude` span
   *  (`attributes->>'model'`) or, for watcher rows, the watcher span's OWN
   *  `model` attribute. Null when no model was recorded. */
  model: string | null;
  /** Token totals stamped on the watcher span's OWN attributes (childless spans —
   *  the opposite lookup direction from the chat child-span join). Null for chat
   *  rows and for watcher runs that ran no model. */
  inputTokens: number | null;
  outputTokens: number | null;
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
    SELECT t.trace_id, t.name, t.status, t.bot_name, t.started_at, t.duration_ms,
           -- Chat rows: the child claude span's model. Watcher rows are childless,
           -- so fall back to the watcher span's OWN model attribute.
           COALESCE(c.model, t.attributes->>'model') AS model,
           -- Token totals live on the watcher span's OWN attributes (stamped by the
           -- runner); chat rows never carry them here.
           t.attributes->>'inputTokens'  AS input_tokens,
           t.attributes->>'outputTokens' AS output_tokens
    FROM traces t
    LEFT JOIN LATERAL (
      SELECT cs.attributes->>'model' AS model
      FROM traces cs
      WHERE cs.trace_id = t.trace_id AND cs.parent_id = t.id AND cs.name = 'claude'
      LIMIT 1
    ) c ON true
    WHERE t.created_at >= now() - make_interval(hours => ${windowHours})
      AND (
        (t.parent_id IS NULL AND (t.name LIKE '%_message' OR t.name = 'telegram_voice'))
        OR (
          t.name LIKE 'watcher:%'
          AND NOT (t.attributes ? 'quietHoursSkipped')
          AND NOT (t.attributes ? 'skippedInFlight')
        )
      )
    ORDER BY t.started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    traceId: r.trace_id,
    name: r.name,
    status: r.status,
    botName: r.bot_name ?? null,
    startedAt: new Date(r.started_at).getTime(),
    durationMs: r.duration_ms ?? null,
    model: (r.model as string | null) ?? null,
    inputTokens: r.input_tokens != null ? Number(r.input_tokens) : null,
    outputTokens: r.output_tokens != null ? Number(r.output_tokens) : null,
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
  source: string; // 'memory' | 'goals' | 'schedule' | 'wiki_gardener_{cluster,triage,draft}'
  model: string | null;
  botName: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: number; // epoch ms
}

/**
 * Recent extractor + gardener-Haiku calls — carries model + tokens + created_at,
 * the only completion signal these leave.
 *
 * Explicit allow-list, NOT a blanket un-filter. Recent is a per-kind
 * source-of-truth UNION (`RING_RECENT_KINDS`): watcher rows come from `traces`
 * (their tokens stamped on the watcher span — see `getRecentAgentTraces`), and
 * `task`/`reminder`/`briefing`/`knowledge-decompose` are deliberately excluded.
 * Pulling `watcher-*`/`task` from `haiku_usage` too would emit a SECOND Recent
 * row per run (the sources share no dedup key).
 *
 * The three `wiki_gardener_*` sources ARE included — the gardener uses
 * `callHaikuWithFallback`/`executeOneShot`, not the runner's spawnHaiku
 * telemetry, so its cluster/triage/draft tokens surface NOWHERE else. This is
 * NOT double-counting against the `gardener_drain` ring entry: that ring row is
 * completed with `{}` (no tokens — see `startBacklogRun`), so it shows the drain
 * run's duration only, while these rows add the per-call token counts. The
 * weekly gardener's `watcher:wiki-gardener` trace row likewise carries no tokens
 * (gardener isn't wired to runner telemetry), so no token number is duplicated.
 */
export async function getRecentExtractorUsage(limit = 40, windowHours = 48): Promise<RecentExtractorRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT source, model, bot_name, input_tokens, output_tokens, created_at
    FROM haiku_usage
    WHERE source IN (
        'memory', 'goals', 'schedule',
        'wiki_gardener_cluster', 'wiki_gardener_triage', 'wiki_gardener_draft'
      )
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
