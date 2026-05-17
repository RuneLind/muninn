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
import type { SingleRunResult } from "./cell.ts";

const log = getLog("benchmarks", "audit");

/**
 * Tools the benchmark spawn must NOT have access to. Two layers of defense:
 *
 * 1. Passed to the connector as `excludedTools` on the bot config — wired into
 *    `claude --disallowedTools` (CLI) or the SDK `query()` `disallowedTools`
 *    option (claude-sdk / copilot-sdk).
 * 2. Mirrored into the scratch `.claude/settings.json` deny list (belt-and-
 *    suspenders for the CLI path).
 *
 * The post-cell trace audit (`auditCellForLeaks`) is the canary that fires if
 * either layer is bypassed by version drift or a new harness tool.
 *
 * `ToolSearch` is special-cased: under the `claude-sdk` connector it is the
 * legitimate channel by which the Agent SDK exposes deferred MCP tools (see
 * sdk.d.ts — tools are deferred behind tool search by default). Blocking it
 * there breaks the bot's access to huginn / serena / yggdrasil. The Claude CLI
 * does not expose ToolSearch at all, so keeping it on the CLI deny list is a
 * harmless belt. See wiki/muninn/claude-sdk-task-reminder.md for the related
 * SDK-only behaviour we discovered alongside this.
 */
const BENCHMARK_DISALLOWED_TOOLS_BASE = [
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

/** Connectors where ToolSearch is the SDK's legitimate deferred-MCP discovery channel. */
const CONNECTORS_NEEDING_TOOL_SEARCH: ReadonlySet<string> = new Set([
  "claude-sdk",
]);

/**
 * Returns the deny list for a given connector. Adds `ToolSearch` for any
 * connector that doesn't depend on it for MCP discovery — currently every
 * connector except `claude-sdk`.
 */
export function disallowedToolsForConnector(connector: string | undefined): string[] {
  const base = [...BENCHMARK_DISALLOWED_TOOLS_BASE];
  if (connector && CONNECTORS_NEEDING_TOOL_SEARCH.has(connector)) return base;
  return [...base, "ToolSearch"];
}

/**
 * Back-compat export used by `preview.ts` and any other consumer that wants
 * a representative deny list. Returns the strictest variant (CLI / copilot)
 * so the preview overstates rather than understates what's blocked.
 */
export const BENCHMARK_DISALLOWED_TOOLS: readonly string[] = disallowedToolsForConnector(undefined);

const BENCHMARK_FORBIDDEN_SPAN_PATTERNS: RegExp[] = [
  /\(jetbrains\)$/,
  /\(claude-hivemind\)$/,
];

export function buildBenchmarkSpawnArgs(): string[] {
  // The CLI executor also reads `botConfig.excludedTools` and appends a
  // matching `--disallowedTools` arg (see ai/executor.ts). The benchmark sets
  // both — keeping the explicit flag here means a developer running the CLI
  // executor without an excludedTools-aware bot config still gets the deny
  // list applied. `--strict-mcp-config` prevents discovery of the user's
  // global `~/.claude/settings.json` MCP servers.
  return [
    "--strict-mcp-config",
    "--disallowedTools",
    disallowedToolsForConnector("claude-cli").join(" "),
  ];
}

/**
 * Pure helper: check a list of span names for benchmark leakage. Optionally
 * scoped to a connector so `ToolSearch` is not flagged when the connector
 * legitimately needs it for deferred MCP discovery.
 */
export function findLeakedSpans(spanNames: string[], connector?: string): string[] {
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
 * Query the trace store for any spans under `traceId` whose name matches
 * the Bug 11 forbidden set. Returns the unique forbidden names found
 * (empty when the cell is clean). Pass `connector` so the audit knows
 * whether `ToolSearch` is legitimate (claude-sdk) or a leak (anything else).
 */
export async function auditCellForLeaks(
  traceId: string,
  connector?: string,
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
