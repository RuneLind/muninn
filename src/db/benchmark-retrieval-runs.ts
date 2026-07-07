import { getDb } from "./client.ts";
import type {
  RetrievalMetrics,
  QueryMetrics,
  RetrievalTarget,
} from "../benchmarks/retrieval.ts";

/**
 * DB access for `benchmark_retrieval_runs` — the offline retrieval eval's
 * regression-tracking table. Mirrors the shape of `benchmark-runs.ts`
 * (save → complete → list/get) but for one aggregate row per eval run.
 */

export interface RetrievalRunRow {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "error";
  error: string | null;
  targetFilter: RetrievalTarget | null;
  queryCount: number;
  huginnBaseUrl: string | null;
  metrics: RetrievalMetrics | null;
  perQuery: QueryMetrics[] | null;
  notes: string | null;
  createdAt: number;
}

export interface SaveRetrievalRunParams {
  startedAt: Date;
  targetFilter?: RetrievalTarget | null;
  queryCount: number;
  huginnBaseUrl?: string | null;
  notes?: string | null;
}

export interface CompleteRetrievalRunParams {
  finishedAt: Date;
  status: "done" | "error";
  error?: string | null;
  metrics?: RetrievalMetrics | null;
  perQuery?: QueryMetrics[] | null;
}

export async function saveRetrievalRun(params: SaveRetrievalRunParams): Promise<string> {
  const sql = getDb();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO benchmark_retrieval_runs (
      started_at, status, target_filter, query_count, huginn_base_url, notes
    ) VALUES (
      ${params.startedAt},
      'running',
      ${params.targetFilter ?? null},
      ${params.queryCount},
      ${params.huginnBaseUrl ?? null},
      ${params.notes ?? null}
    )
    RETURNING id
  `;
  const first = rows[0];
  if (!first) throw new Error("INSERT into benchmark_retrieval_runs returned no rows");
  return first.id;
}

export async function completeRetrievalRun(
  id: string,
  params: CompleteRetrievalRunParams,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE benchmark_retrieval_runs SET
      finished_at = ${params.finishedAt},
      status      = ${params.status},
      error       = ${params.error ?? null},
      metrics     = ${params.metrics ? sql.json(params.metrics as never) : null},
      per_query   = ${params.perQuery ? sql.json(params.perQuery as never) : null}
    WHERE id = ${id}
  `;
}

interface RawRow {
  id: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  status: string;
  error: string | null;
  target_filter: string | null;
  query_count: number;
  huginn_base_url: string | null;
  metrics: RetrievalMetrics | null;
  per_query: QueryMetrics[] | null;
  notes: string | null;
  created_at: string | Date;
}

function rowToRetrievalRun(row: RawRow): RetrievalRunRow {
  return {
    id: row.id,
    startedAt: new Date(row.started_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
    status: row.status as "running" | "done" | "error",
    error: row.error,
    targetFilter: (row.target_filter as RetrievalTarget | null) ?? null,
    queryCount: row.query_count,
    huginnBaseUrl: row.huginn_base_url,
    metrics: row.metrics,
    perQuery: row.per_query,
    notes: row.notes,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export async function listRetrievalRuns(limit: number = 50): Promise<RetrievalRunRow[]> {
  const sql = getDb();
  const rows = await sql<RawRow[]>`
    SELECT * FROM benchmark_retrieval_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToRetrievalRun);
}

export async function getRetrievalRun(id: string): Promise<RetrievalRunRow | null> {
  const sql = getDb();
  const rows = await sql<RawRow[]>`
    SELECT * FROM benchmark_retrieval_runs WHERE id = ${id}
  `;
  const first = rows[0];
  return first ? rowToRetrievalRun(first) : null;
}
