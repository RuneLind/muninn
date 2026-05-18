/**
 * Bug 11 leak guard. The benchmark runner spawns Claude with a hard
 * `--disallowedTools` deny-list AND a mirrored deny-list in the scratch
 * `.claude/settings.json`. After each cell, the trace is audited to confirm
 * neither layer was bypassed. Both layers are necessary because Claude CLI
 * version drift has historically dropped one or the other.
 *
 * See benchmarks/known-bugs.md Bug 11 for the incident this list mitigates.
 */

import { getLog } from "../logging.ts";
import { getDb } from "../db/client.ts";
import { completeBenchmarkRun } from "../db/benchmark-runs.ts";
import type { ProcessMessageResult } from "../core/message-processor.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { SingleRunResult } from "./cell.ts";

const log = getLog("benchmarks", "audit");

/**
 * Tools the benchmark spawn must NOT have access to. Two layers of defense:
 *
 * 1. Passed to the connector as `excludedTools` on the bot config — wired into
 *    `claude --disallowedTools` (CLI) or the SDK `query()` `disallowedTools`
 *    option (claude-sdk / copilot-sdk).
 * 2. Mirrored into the scratch `.claude/settings.json` deny list for the CLI.
 *
 * `auditCellForLeaks` is the canary that fires if either layer is bypassed.
 *
 * `ToolSearch` is excluded from the claude-sdk variant because the Agent SDK
 * uses it as the legitimate channel for deferred MCP tool discovery — blocking
 * it severs the bot's access to huginn / serena / yggdrasil. The CLI does not
 * expose ToolSearch, so keeping it on the CLI list is a harmless belt.
 */
const DISALLOWED_BASE = [
  // File / shell access — could read prod-HEAD code instead of the worktree
  "Bash", "BashOutput", "KillBash", "Read", "Write", "Edit", "MultiEdit",
  "Glob", "Grep", "NotebookEdit",
  // Agent-loop tools — can spawn sub-agents with their own (unrestricted) toolset
  "Agent", "Skill", "Task", "Monitor",
  // Task list — leaks state into the parent runner's task tracker
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  // Out-of-process IO that defeats reproducibility
  "WebFetch", "WebSearch", "ScheduleWakeup", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "CronCreate", "CronDelete", "CronList", "RemoteTrigger",
] as const;

const DISALLOWED_WITH_TOOL_SEARCH: readonly string[] = [...DISALLOWED_BASE, "ToolSearch"];

export function disallowedToolsForConnector(connector: ConnectorType | undefined): readonly string[] {
  return connector === "claude-sdk" ? DISALLOWED_BASE : DISALLOWED_WITH_TOOL_SEARCH;
}

const BENCHMARK_FORBIDDEN_SPAN_PATTERNS: RegExp[] = [
  /\(jetbrains\)$/,
  /\(claude-hivemind\)$/,
];

export function buildBenchmarkSpawnArgs(): string[] {
  // --strict-mcp-config blocks discovery of the user's global ~/.claude MCP
  // servers. --disallowedTools is duplicated on botConfig.excludedTools so SDK
  // connectors get it too; passing it here also covers CLI invocations that
  // don't go through the scratch-bot overlay.
  return [
    "--strict-mcp-config",
    "--disallowedTools",
    disallowedToolsForConnector("claude-cli").join(" "),
  ];
}

/** Pure helper: check a list of span names for benchmark leakage. */
export function findLeakedSpans(spanNames: string[], connector?: ConnectorType): string[] {
  const forbidden = new Set(disallowedToolsForConnector(connector));
  const leaked: string[] = [];
  for (const name of spanNames) {
    if (forbidden.has(name)) {
      leaked.push(name);
      continue;
    }
    if (BENCHMARK_FORBIDDEN_SPAN_PATTERNS.some((re) => re.test(name))) {
      leaked.push(name);
    }
  }
  return leaked;
}

/**
 * Query the trace store for any spans under `traceId` whose name matches the
 * forbidden set. Pass `connector` so claude-sdk's legitimate ToolSearch usage
 * (deferred MCP discovery) isn't flagged.
 */
export async function auditCellForLeaks(
  traceId: string,
  connector?: ConnectorType,
): Promise<string[]> {
  const sql = getDb();
  const rows = await sql<Array<{ name: string }>>`
    SELECT DISTINCT name FROM traces WHERE trace_id = ${traceId}
  `;
  return findLeakedSpans(rows.map((r) => r.name), connector);
}

/**
 * Mark a benchmark cell as failed and return the error-shaped SingleRunResult.
 * Shared by the empty-candidate guard and the Bug 11 leak audit so they can't
 * drift on the token-fields they record (contextTokens/modelSnapshotId).
 */
export async function failCellWithError(args: {
  benchmarkRunId: string | null;
  summary: string;
  result: ProcessMessageResult;
  reportText: string;
  runIndex: number;
  analysisTraceId: string;
  candidatePath: string;
}): Promise<SingleRunResult> {
  const { benchmarkRunId, summary, result, reportText, runIndex, analysisTraceId, candidatePath } = args;
  log.error("{summary} (trace {traceId})", {
    botName: "benchmarks",
    summary,
    traceId: analysisTraceId,
  });
  if (benchmarkRunId) {
    await completeBenchmarkRun(benchmarkRunId, {
      finishedAt: new Date(),
      status: "error",
      error: summary,
      reportMd: reportText,
      toolCalls: result.toolCalls ?? null,
      tokens: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        contextTokens: result.contextTokens,
        costUsd: result.costUsd,
        model: result.model,
        durationMs: result.durationMs,
      },
      modelSnapshotId: result.model,
    }).catch((err) => {
      log.error("Failed to mark benchmark_run {id} as error: {error}", {
        botName: "benchmarks",
        id: benchmarkRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return {
    runIndex,
    benchmarkRunId,
    analysisTraceId,
    judgeTraceId: null,
    candidatePath,
    hitRate: null,
    highlightedRate: null,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: result.model,
    toolCallCount: result.toolCalls?.length ?? 0,
    status: "error",
    error: summary,
  };
}
