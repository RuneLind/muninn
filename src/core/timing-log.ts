import type { Tracer } from "../tracing/index.ts";
import type { ClaudeResult } from "../types.ts";
import type { PromptBuildResult } from "../ai/prompt-builder.ts";
import { fmtTokens } from "../utils/fmt-tokens.ts";
import { getLog } from "../logging.ts";
import type { LogProps } from "./message-processor.ts";

const log = getLog("core", "timing");

export interface TimingLogParams {
  tracer: Tracer;
  result: ClaudeResult;
  promptMeta: PromptBuildResult["meta"];
  logProps: LogProps;
}

/** Multi-line request lifecycle breakdown for human triage during incidents. */
export function logRequestTiming(params: TimingLogParams): void {
  const { tracer, result, promptMeta, logProps } = params;
  const s = tracer.summary();

  log.info(
    "Request timing breakdown:\n" +
      `  prompt_build:   ${pad(s.prompt_build)}  (db: ${Math.round(promptMeta.dbHistoryMs)}ms, embed: ${Math.round(promptMeta.embeddingMs)}ms, search: ${Math.round(promptMeta.memorySearchMs)}ms | ${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
      `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs ?? 0)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns, ${fmtTokens(result.inputTokens)} in / ${fmtTokens(result.outputTokens)} out)\n` +
      `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
      `  format+send:    ${pad(s.send)}\n` +
      `  ─────────────────────\n` +
      `  total:         ${pad(tracer.totalMs())}  ($${(result.costUsd ?? 0).toFixed(4)})`,
    logProps,
  );
}

function pad(ms: number | undefined): string {
  return `${Math.round(ms ?? 0)}ms`.padEnd(7);
}
