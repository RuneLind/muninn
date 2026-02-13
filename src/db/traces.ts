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
      ${params.attributes ? JSON.stringify(params.attributes) : "{}"}
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
        WHEN ${params.attributes ? JSON.stringify(params.attributes) : null}::jsonb IS NOT NULL
        THEN attributes || ${params.attributes ? JSON.stringify(params.attributes) : "{}"}::jsonb
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
    SELECT id, trace_id, parent_id, name, kind, status, bot_name, user_id, username, platform,
           started_at, duration_ms, attributes, created_at
    FROM traces
    WHERE parent_id IS NULL
      AND (${botName ?? null}::text IS NULL OR bot_name = ${botName ?? null})
      AND (${name ?? null}::text IS NULL OR name = ${name ?? null})
    ORDER BY started_at DESC
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

export async function cleanupOldTraces(retentionDays: number): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM traces WHERE created_at < NOW() - make_interval(days => ${retentionDays})
  `;
  return result.count;
}

function mapRow(r: Record<string, any>): SpanRow {
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
    attributes: r.attributes ?? {},
    createdAt: new Date(r.created_at).getTime(),
  };
}
