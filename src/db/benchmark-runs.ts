import { getDb } from "./client.ts";
import type { JudgeResult } from "../benchmarks/types.ts";

/** Treatment shape stored in benchmark_runs.treatment as JSONB. */
export interface BenchmarkTreatment {
  connector: string;
  model: string;
  mcpStack: string;
  promptId: string;
}

/** Per-cell stack configuration — which Serena/Yggdrasil instances were running. */
export interface BenchmarkStackConfig {
  stack: string;
  serenaInstances?: Array<{ name: string; port: number; projectPath: string }>;
  yggdrasilInstances?: Array<{ name: string; port: number; projectPath: string }>;
}

/** Token + cost summary for the analysis call (separate from the judge call). */
export interface BenchmarkTokens {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  costUsd?: number;
  model?: string;
  durationMs?: number;
}

export interface BenchmarkToolCall {
  name: string;
  displayName: string;
  durationMs: number;
}

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
  // Phase 1: treatment + reproducibility fields
  treatment: BenchmarkTreatment | null;
  promptId: string | null;
  fullPrompt: string | null;
  fullPromptHash: string | null;
  reportMd: string | null;
  toolCalls: BenchmarkToolCall[] | null;
  tokens: BenchmarkTokens | null;
  modelSnapshotId: string | null;
  stackConfig: BenchmarkStackConfig | null;
  /**
   * Parent run this row is a re-judge of. Null for top-level analysis rows.
   * Re-judge rows share the parent's candidate + gold; only the judge call
   * (and its verdict) is new. The dashboard list view hides rows with a
   * non-null parent by default — they surface on the parent's detail page.
   */
  parentRunId: string | null;
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
  // Phase 1 — present when the runner produced the candidate; absent when
  // the score-report CLI is judging a historical report.
  treatment?: BenchmarkTreatment | null;
  promptId?: string | null;
  fullPrompt?: string | null;
  fullPromptHash?: string | null;
  stackConfig?: BenchmarkStackConfig | null;
  /** Set when this row is a re-judge pass of an existing parent run. */
  parentRunId?: string | null;
}

export interface CompleteBenchmarkRunParams {
  finishedAt: Date;
  status: "done" | "error";
  error?: string | null;
  wallclockMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  judgeResult?: JudgeResult;
  // Phase 1 — analysis-side outputs the runner attaches when it scores
  reportMd?: string | null;
  toolCalls?: BenchmarkToolCall[] | null;
  tokens?: BenchmarkTokens | null;
  modelSnapshotId?: string | null;
}

export async function saveBenchmarkRun(params: SaveBenchmarkRunParams): Promise<string> {
  const sql = getDb();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO benchmark_runs (
      issue_key, candidate_path, gold_path, gold_content_hash,
      judge_prompt_version, judge_model, trace_id, analysis_trace_id, started_at, status,
      treatment, prompt_id, full_prompt, full_prompt_hash, stack_config, parent_run_id
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
      'running',
      ${params.treatment ? sql.json(params.treatment as never) : null},
      ${params.promptId ?? null},
      ${params.fullPrompt ?? null},
      ${params.fullPromptHash ?? null},
      ${params.stackConfig ? sql.json(params.stackConfig as never) : null},
      ${params.parentRunId ?? null}
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
      highlighted_found  = ${stats?.highlightedFound ?? null},
      report_md          = ${params.reportMd ?? null},
      tool_calls         = ${params.toolCalls ? sql.json(params.toolCalls as never) : null},
      tokens             = ${params.tokens ? sql.json(params.tokens as never) : null},
      model_snapshot_id  = ${params.modelSnapshotId ?? null}
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
  treatment: BenchmarkTreatment | null;
  prompt_id: string | null;
  full_prompt: string | null;
  full_prompt_hash: string | null;
  report_md: string | null;
  tool_calls: BenchmarkToolCall[] | null;
  tokens: BenchmarkTokens | null;
  model_snapshot_id: string | null;
  stack_config: BenchmarkStackConfig | null;
  parent_run_id: string | null;
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
    treatment: row.treatment,
    promptId: row.prompt_id,
    fullPrompt: row.full_prompt,
    fullPromptHash: row.full_prompt_hash,
    reportMd: row.report_md,
    toolCalls: row.tool_calls,
    tokens: row.tokens,
    modelSnapshotId: row.model_snapshot_id,
    stackConfig: row.stack_config,
    parentRunId: row.parent_run_id,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/**
 * List top-level benchmark runs. Re-judge passes (rows with
 * parent_run_id IS NOT NULL) are hidden by default — they show up on
 * the parent row's detail page instead.
 */
export async function listBenchmarkRuns(
  limit: number = 50,
  opts: { includeChildren?: boolean } = {},
): Promise<BenchmarkRunRow[]> {
  const sql = getDb();
  const rows = opts.includeChildren
    ? await sql<RawRow[]>`
        SELECT * FROM benchmark_runs
        ORDER BY started_at DESC
        LIMIT ${limit}
      `
    : await sql<RawRow[]>`
        SELECT * FROM benchmark_runs
        WHERE parent_run_id IS NULL
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

/**
 * Return all re-judge children of a given parent run, oldest first so
 * the dashboard can number them pass 1, pass 2, ….
 */
export async function listRejudgeChildren(parentRunId: string): Promise<BenchmarkRunRow[]> {
  const sql = getDb();
  const rows = await sql<RawRow[]>`
    SELECT * FROM benchmark_runs
    WHERE parent_run_id = ${parentRunId}
    ORDER BY started_at ASC
  `;
  return rows.map(rowToBenchmarkRun);
}
