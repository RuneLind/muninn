import { getDb } from "./client.ts";
import type { JudgeResult } from "../benchmarks/types.ts";

export interface BenchmarkRunRow {
  id: string;
  issueKey: string;
  candidatePath: string;
  goldPath: string;
  goldContentHash: string;
  judgePromptVersion: string;
  judgeModel: string;
  /** trace_id of the JUDGE call we made when scoring */
  traceId: string | null;
  /** trace_id of the ORIGINAL analysis that produced the candidate report (null for historical reports) */
  analysisTraceId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "error";
  error: string | null;
  wallclockMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  judgeResult: JudgeResult | null;
  hitRate: number | null;
  highlightedRate: number | null;
  foundCount: number | null;
  partialCount: number | null;
  missingCount: number | null;
  highlightedTotal: number | null;
  highlightedFound: number | null;
  createdAt: number;
}

export interface SaveBenchmarkRunParams {
  issueKey: string;
  candidatePath: string;
  goldPath: string;
  goldContentHash: string;
  judgePromptVersion: string;
  judgeModel: string;
  traceId?: string | null;
  analysisTraceId?: string | null;
  startedAt: Date;
}

export interface CompleteBenchmarkRunParams {
  finishedAt: Date;
  status: "done" | "error";
  error?: string | null;
  wallclockMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  judgeResult?: JudgeResult;
}

export async function saveBenchmarkRun(params: SaveBenchmarkRunParams): Promise<string> {
  const sql = getDb();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO benchmark_runs (
      issue_key, candidate_path, gold_path, gold_content_hash,
      judge_prompt_version, judge_model, trace_id, analysis_trace_id, started_at, status
    ) VALUES (
      ${params.issueKey},
      ${params.candidatePath},
      ${params.goldPath},
      ${params.goldContentHash},
      ${params.judgePromptVersion},
      ${params.judgeModel},
      ${params.traceId ?? null},
      ${params.analysisTraceId ?? null},
      ${params.startedAt},
      'running'
    )
    RETURNING id
  `;
  const first = rows[0];
  if (!first) throw new Error("INSERT into benchmark_runs returned no rows");
  return first.id;
}

export async function completeBenchmarkRun(
  id: string,
  params: CompleteBenchmarkRunParams,
): Promise<void> {
  const sql = getDb();
  const stats = params.judgeResult?.stats ?? null;

  await sql`
    UPDATE benchmark_runs SET
      finished_at        = ${params.finishedAt},
      status             = ${params.status},
      error              = ${params.error ?? null},
      wallclock_ms       = ${params.wallclockMs ?? null},
      input_tokens       = ${params.inputTokens ?? null},
      output_tokens      = ${params.outputTokens ?? null},
      judge_result       = ${params.judgeResult ? sql.json(params.judgeResult as never) : null},
      hit_rate           = ${stats?.hitRate ?? null},
      highlighted_rate   = ${stats?.highlightedRate ?? null},
      found_count        = ${stats?.found ?? null},
      partial_count      = ${stats?.partial ?? null},
      missing_count      = ${stats?.missing ?? null},
      highlighted_total  = ${stats?.highlightedTotal ?? null},
      highlighted_found  = ${stats?.highlightedFound ?? null}
    WHERE id = ${id}
  `;
}

interface RawRow {
  id: string;
  issue_key: string;
  candidate_path: string;
  gold_path: string;
  gold_content_hash: string;
  judge_prompt_version: string;
  judge_model: string;
  trace_id: string | null;
  analysis_trace_id: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
  status: string;
  error: string | null;
  wallclock_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  judge_result: JudgeResult | null;
  hit_rate: string | number | null;
  highlighted_rate: string | number | null;
  found_count: number | null;
  partial_count: number | null;
  missing_count: number | null;
  highlighted_total: number | null;
  highlighted_found: number | null;
  created_at: string | Date;
}

function rowToBenchmarkRun(row: RawRow): BenchmarkRunRow {
  const num = (v: string | number | null): number | null =>
    v === null ? null : typeof v === "number" ? v : parseFloat(v);
  return {
    id: row.id,
    issueKey: row.issue_key,
    candidatePath: row.candidate_path,
    goldPath: row.gold_path,
    goldContentHash: row.gold_content_hash,
    judgePromptVersion: row.judge_prompt_version,
    judgeModel: row.judge_model,
    traceId: row.trace_id,
    analysisTraceId: row.analysis_trace_id,
    startedAt: new Date(row.started_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
    status: row.status as "running" | "done" | "error",
    error: row.error,
    wallclockMs: row.wallclock_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    judgeResult: row.judge_result,
    hitRate: num(row.hit_rate),
    highlightedRate: num(row.highlighted_rate),
    foundCount: row.found_count,
    partialCount: row.partial_count,
    missingCount: row.missing_count,
    highlightedTotal: row.highlighted_total,
    highlightedFound: row.highlighted_found,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export async function listBenchmarkRuns(limit: number = 50): Promise<BenchmarkRunRow[]> {
  const sql = getDb();
  const rows = await sql<RawRow[]>`
    SELECT * FROM benchmark_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToBenchmarkRun);
}

export async function getBenchmarkRun(id: string): Promise<BenchmarkRunRow | null> {
  const sql = getDb();
  const rows = await sql<RawRow[]>`
    SELECT * FROM benchmark_runs WHERE id = ${id}
  `;
  const first = rows[0];
  return first ? rowToBenchmarkRun(first) : null;
}
