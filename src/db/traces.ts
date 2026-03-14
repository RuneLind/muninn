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
           c.input_tokens, c.output_tokens, c.tool_count
    FROM traces t
    LEFT JOIN LATERAL (
      SELECT
        (CASE
          WHEN jsonb_typeof(cs.attributes) = 'object' THEN (cs.attributes->>'inputTokens')::int
          WHEN jsonb_typeof(cs.attributes) = 'array'  THEN ((cs.attributes->>-1)::jsonb->>'inputTokens')::int
        END) AS input_tokens,
        (CASE
          WHEN jsonb_typeof(cs.attributes) = 'object' THEN (cs.attributes->>'outputTokens')::int
          WHEN jsonb_typeof(cs.attributes) = 'array'  THEN ((cs.attributes->>-1)::jsonb->>'outputTokens')::int
        END) AS output_tokens,
        (CASE
          WHEN jsonb_typeof(cs.attributes) = 'object' THEN (cs.attributes->>'toolCount')::int
          ELSE NULL
        END) AS tool_count
      FROM traces cs
      WHERE cs.trace_id = t.trace_id AND cs.parent_id = t.id AND cs.name = 'claude'
      LIMIT 1
    ) c ON true
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

export async function getToolUsageStats(userId: string, botName: string): Promise<ToolUsageStat[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT
      name,
      attributes->>'toolName' as tool_name,
      COUNT(*)::int as call_count,
      SUM(duration_ms)::int as total_ms,
      ROUND(AVG(duration_ms))::int as avg_ms
    FROM traces
    WHERE bot_name = ${botName}
      AND user_id = ${userId}
      AND parent_id IS NOT NULL
      AND attributes->>'toolName' IS NOT NULL
    GROUP BY name, attributes->>'toolName'
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
  // Normalize attributes: handle double-encoded strings/arrays from legacy bug
  let attrs = r.attributes ?? {};
  if (typeof attrs === "string") {
    try { attrs = JSON.parse(attrs); } catch { attrs = {}; }
  }
  if (Array.isArray(attrs)) {
    // Legacy bug: attributes stored as [string, object] array — merge all object entries
    attrs = attrs.reduce((acc: Record<string, unknown>, item: unknown) => {
      if (typeof item === "string") {
        try { const parsed = JSON.parse(item); if (typeof parsed === "object" && parsed) Object.assign(acc, parsed); } catch {}
      } else if (typeof item === "object" && item) {
        Object.assign(acc, item);
      }
      return acc;
    }, {});
  }

  // Merge token/tool data from child span join (if available and not already in attributes)
  if (r.input_tokens != null && !attrs.inputTokens) attrs = { ...attrs, inputTokens: Number(r.input_tokens) };
  if (r.output_tokens != null && !attrs.outputTokens) attrs = { ...attrs, outputTokens: Number(r.output_tokens) };
  if (r.tool_count != null && !attrs.toolCount) attrs = { ...attrs, toolCount: Number(r.tool_count) };

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
