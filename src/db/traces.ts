import { getDb } from "./client.ts";

export interface SpanRow {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  kind: string;
  status: string;
  botName: string | null;
  userId: string | null;
  username: string | null;
  platform: string | null;
  startedAt: number; // epoch ms
  durationMs: number | null;
  attributes: Record<string, unknown>;
  createdAt: number; // epoch ms
}

interface SaveSpanParams {
  id: string;
  traceId: string;
  parentId?: string | null;
  name: string;
  kind: "root" | "span" | "event";
  botName?: string | null;
  userId?: string | null;
  username?: string | null;
  platform?: string | null;
  startedAt: Date;
  durationMs?: number | null;
  attributes?: Record<string, unknown>;
}

interface UpdateSpanParams {
  durationMs?: number;
  status?: "ok" | "error";
  attributes?: Record<string, unknown>;
}

export async function saveSpan(params: SaveSpanParams): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO traces (id, trace_id, parent_id, name, kind, bot_name, user_id, username, platform, started_at, duration_ms, attributes)
    VALUES (
      ${params.id},
      ${params.traceId},
      ${params.parentId ?? null},
      ${params.name},
      ${params.kind},
      ${params.botName ?? null},
      ${params.userId ?? null},
      ${params.username ?? null},
      ${params.platform ?? null},
      ${params.startedAt},
      ${params.durationMs ?? null},
      ${sql.json((params.attributes ?? {}) as Record<string, never>)}
    )
  `;
}

export async function updateSpan(id: string, params: UpdateSpanParams): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE traces SET
      duration_ms = COALESCE(${params.durationMs ?? null}, duration_ms),
      status = COALESCE(${params.status ?? null}, status),
      attributes = CASE
        WHEN ${params.attributes ? true : null}::bool IS NOT NULL
        THEN attributes || ${sql.json((params.attributes ?? {}) as Record<string, never>)}
        ELSE attributes
      END
    WHERE id = ${id}
  `;
}

export async function getTrace(traceId: string): Promise<SpanRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, trace_id, parent_id, name, kind, status, bot_name, user_id, username, platform,
           started_at, duration_ms, attributes, created_at
    FROM traces
    WHERE trace_id = ${traceId}
    ORDER BY started_at ASC
  `;
  return rows.map(mapRow);
}

export async function getRecentTraces(
  limit = 50,
  offset = 0,
  botName?: string,
  name?: string,
): Promise<SpanRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT t.id, t.trace_id, t.parent_id, t.name, t.kind, t.status, t.bot_name, t.user_id, t.username, t.platform,
           t.started_at, t.duration_ms, t.attributes, t.created_at,
           COALESCE(c.input_tokens, w.input_tokens, walk.input_tokens)   AS input_tokens,
           COALESCE(c.output_tokens, w.output_tokens, walk.output_tokens) AS output_tokens,
           COALESCE(c.tool_count, w.tool_count, walk.tool_count)         AS tool_count,
           COALESCE(c.model, w.model, walk.model)                        AS model,
           c.requested_model,
           COALESCE(c.connector, w.connector, walk.connector)            AS connector
    FROM traces t
    LEFT JOIN LATERAL (
      SELECT
        (cs.attributes->>'inputTokens')::int   AS input_tokens,
        (cs.attributes->>'outputTokens')::int  AS output_tokens,
        (cs.attributes->>'toolCount')::int     AS tool_count,
        cs.attributes->>'model'                AS model,
        cs.attributes->>'requestedModel'       AS requested_model,
        cs.attributes->>'connector'            AS connector
      FROM traces cs
      WHERE cs.trace_id = t.trace_id AND cs.parent_id = t.id AND cs.name = 'claude'
      LIMIT 1
    ) c ON true
    -- Scheduler-tick roots carry no telemetry themselves — aggregate it up from
    -- their watcher:<type> child spans (tokens summed across watchers in the
    -- tick, model/connector shown when unambiguous, 'mixed' otherwise) and
    -- count the watchers' tool child spans.
    LEFT JOIN LATERAL (
      SELECT
        SUM((ws.attributes->>'inputTokens')::int)  AS input_tokens,
        SUM((ws.attributes->>'outputTokens')::int) AS output_tokens,
        CASE WHEN COUNT(DISTINCT ws.attributes->>'model') > 1 THEN 'mixed'
             ELSE MIN(ws.attributes->>'model') END AS model,
        CASE WHEN COUNT(DISTINCT ws.attributes->>'connector') > 1 THEN 'mixed'
             ELSE MIN(ws.attributes->>'connector') END AS connector,
        NULLIF((
          SELECT COUNT(*)
          FROM traces ts
          WHERE ts.trace_id = t.trace_id
            AND ts.parent_id IN (SELECT ws2.id FROM traces ws2
                                 WHERE ws2.trace_id = t.trace_id
                                   AND ws2.parent_id = t.id
                                   AND ws2.name LIKE 'watcher:%')
            AND ts.attributes ? 'toolName'
        ), 0)::int AS tool_count
      FROM traces ws
      WHERE ws.trace_id = t.trace_id AND ws.parent_id = t.id AND ws.name LIKE 'watcher:%'
        AND ws.attributes ? 'inputTokens'
    ) w ON true
    -- Depth-agnostic AI-span aggregate — the general fallback for every trace
    -- shape the fast paths above miss (factcheck's claude:claim-<i>/compose
    -- spans, task:briefing → claude, gardener draft → claude, model-only
    -- extractors). Runs LAST so the c fast path and the w watcher aggregate keep
    -- precedence (a walk running before w would match one watcher span and shadow
    -- w's multi-watcher sum + mixed collapse). An AI span is any non-root span
    -- carrying a connector or model attribute. Deterministic, no recursion:
    --   - connector-bearing spans present ⇒ tokens SUM / model + connector
    --     single-value-or-'mixed' OVER THOSE SPANS ONLY (so factcheck's
    --     connector-less Haiku extract span is excluded from the mixed collapse
    --     and the token sum — it carries a model but no connector);
    --   - else fall back to model-only spans (connector honestly NULL).
    -- self-consistent: connector/model/tokens all come from the same span set.
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN agg.has_conn THEN agg.conn_input  ELSE agg.model_input  END AS input_tokens,
        CASE WHEN agg.has_conn THEN agg.conn_output ELSE agg.model_output END AS output_tokens,
        CASE WHEN agg.has_conn THEN agg.conn_model  ELSE agg.model_model  END AS model,
        CASE WHEN agg.has_conn THEN agg.conn_connector ELSE NULL          END AS connector,
        NULLIF((
          SELECT COUNT(*)
          FROM traces xs
          WHERE xs.trace_id = t.trace_id AND xs.parent_id IS NOT NULL
            AND xs.attributes ? 'toolName'
        ), 0)::int AS tool_count
      FROM (
        SELECT
          bool_or(ns.attributes ? 'connector') AS has_conn,
          SUM((ns.attributes->>'inputTokens')::int)  FILTER (WHERE ns.attributes ? 'connector') AS conn_input,
          SUM((ns.attributes->>'outputTokens')::int) FILTER (WHERE ns.attributes ? 'connector') AS conn_output,
          CASE WHEN COUNT(DISTINCT ns.attributes->>'model') FILTER (WHERE ns.attributes ? 'connector') > 1 THEN 'mixed'
               ELSE MIN(ns.attributes->>'model') FILTER (WHERE ns.attributes ? 'connector') END AS conn_model,
          CASE WHEN COUNT(DISTINCT ns.attributes->>'connector') > 1 THEN 'mixed'
               ELSE MIN(ns.attributes->>'connector') END AS conn_connector,
          SUM((ns.attributes->>'inputTokens')::int)  FILTER (WHERE ns.attributes ? 'model') AS model_input,
          SUM((ns.attributes->>'outputTokens')::int) FILTER (WHERE ns.attributes ? 'model') AS model_output,
          CASE WHEN COUNT(DISTINCT ns.attributes->>'model') FILTER (WHERE ns.attributes ? 'model') > 1 THEN 'mixed'
               ELSE MIN(ns.attributes->>'model') FILTER (WHERE ns.attributes ? 'model') END AS model_model
        FROM traces ns
        WHERE ns.trace_id = t.trace_id AND ns.parent_id IS NOT NULL
      ) agg
    ) walk ON true
    WHERE t.parent_id IS NULL
      AND (${botName ?? null}::text IS NULL OR t.bot_name = ${botName ?? null})
      AND (${name ?? null}::text IS NULL OR t.name = ${name ?? null})
    ORDER BY t.started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(mapRow);
}

export interface TraceStats {
  totalTraces: number;
  avgDurationMs: number;
  errorCount: number;
  byName: Record<string, { count: number; avgMs: number }>;
}

export async function getTraceStats(botName?: string): Promise<TraceStats> {
  const sql = getDb();

  const [totals] = await sql`
    SELECT COUNT(*) as total, AVG(duration_ms) as avg_ms,
           COUNT(*) FILTER (WHERE status = 'error') as errors
    FROM traces
    WHERE parent_id IS NULL
      AND (${botName ?? null}::text IS NULL OR bot_name = ${botName ?? null})
      AND started_at > NOW() - INTERVAL '24 hours'
  `;

  const byNameRows = await sql`
    SELECT name, COUNT(*) as count, AVG(duration_ms) as avg_ms
    FROM traces
    WHERE parent_id IS NULL
      AND (${botName ?? null}::text IS NULL OR bot_name = ${botName ?? null})
      AND started_at > NOW() - INTERVAL '24 hours'
    GROUP BY name
  `;

  const byName: Record<string, { count: number; avgMs: number }> = {};
  for (const row of byNameRows) {
    byName[row.name] = { count: Number(row.count), avgMs: Math.round(Number(row.avg_ms ?? 0)) };
  }

  return {
    totalTraces: Number(totals?.total ?? 0),
    avgDurationMs: Math.round(Number(totals?.avg_ms ?? 0)),
    errorCount: Number(totals?.errors ?? 0),
    byName,
  };
}

export async function getTraceFilterOptions(): Promise<{ bots: string[]; types: string[] }> {
  const sql = getDb();
  const [bots, types] = await Promise.all([
    sql`SELECT DISTINCT bot_name FROM traces WHERE bot_name IS NOT NULL ORDER BY bot_name`,
    sql`SELECT DISTINCT name FROM traces WHERE parent_id IS NULL ORDER BY name`,
  ]);
  return {
    bots: bots.map((r) => r.bot_name),
    types: types.map((r) => r.name),
  };
}

export interface ToolUsageStat {
  displayName: string;
  toolName: string;
  callCount: number;
  totalMs: number;
  avgMs: number;
}

export async function getToolUsageStats(userId: string, botName: string, threadId?: string): Promise<ToolUsageStat[]> {
  const sql = getDb();
  // When threadId is provided, scope to traces linked to messages in that thread via trace_id
  const threadFilter = threadId
    ? sql`AND t.trace_id IN (SELECT m.trace_id FROM messages m WHERE m.thread_id = ${threadId} AND m.trace_id IS NOT NULL)`
    : sql``;
  const rows = await sql`
    SELECT
      t.name,
      t.attributes->>'toolName' as tool_name,
      COUNT(*)::int as call_count,
      SUM(t.duration_ms)::int as total_ms,
      ROUND(AVG(t.duration_ms))::int as avg_ms
    FROM traces t
    WHERE t.bot_name = ${botName}
      AND t.user_id = ${userId}
      AND t.parent_id IS NOT NULL
      AND t.attributes->>'toolName' IS NOT NULL
      ${threadFilter}
    GROUP BY t.name, t.attributes->>'toolName'
    ORDER BY call_count DESC
    LIMIT 50
  `;
  return rows.map((r) => ({
    displayName: r.name,
    toolName: r.tool_name,
    callCount: Number(r.call_count),
    totalMs: Number(r.total_ms),
    avgMs: Number(r.avg_ms),
  }));
}

export async function cleanupOldTraces(retentionDays: number): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM traces WHERE created_at < NOW() - make_interval(days => ${retentionDays})
  `;
  return result.count;
}

function mapRow(r: Record<string, any>): SpanRow {
  // Guard against hand-INSERTed rows storing non-object JSONB.
  let attrs: Record<string, unknown> = r.attributes ?? {};
  if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) attrs = {};

  // Backfill from the LATERAL JOIN in one pass — avoids 6 intermediate spreads
  // per row in the trace-list query.
  const delta: Record<string, unknown> = {};
  if (r.input_tokens != null && !attrs.inputTokens) delta.inputTokens = Number(r.input_tokens);
  if (r.output_tokens != null && !attrs.outputTokens) delta.outputTokens = Number(r.output_tokens);
  if (r.tool_count != null && !attrs.toolCount) delta.toolCount = Number(r.tool_count);
  if (r.model != null && !attrs.model) delta.model = String(r.model);
  if (r.requested_model != null && !attrs.requestedModel) delta.requestedModel = String(r.requested_model);
  if (r.connector != null && !attrs.connector) delta.connector = String(r.connector);
  if (Object.keys(delta).length > 0) attrs = { ...attrs, ...delta };

  return {
    id: r.id,
    traceId: r.trace_id,
    parentId: r.parent_id ?? null,
    name: r.name,
    kind: r.kind,
    status: r.status,
    botName: r.bot_name ?? null,
    userId: r.user_id ?? null,
    username: r.username ?? null,
    platform: r.platform ?? null,
    startedAt: new Date(r.started_at).getTime(),
    durationMs: r.duration_ms ?? null,
    attributes: attrs,
    createdAt: new Date(r.created_at).getTime(),
  };
}
