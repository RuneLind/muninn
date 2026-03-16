import type { Config } from "../config.ts";
import type { Platform } from "../types.ts";
import type { TraceContext } from "../tracing/index.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";

export interface ExtractionParams {
  userId: string;
  botName: string;
  botDir: string;
  userMessage: string;
  assistantResponse: string;
  sourceMessageId: string;
  platform: Platform;
}

/**
 * Fire-and-forget async calls to extract memories, goals, and scheduled tasks
 * from a conversation exchange. Skipped for research/analysis flows.
 */
export function runExtractionPipelines(
  params: ExtractionParams,
  config: Config,
  traceCtx: TraceContext,
): void {
  const { userId, botName, botDir, userMessage, assistantResponse, sourceMessageId, platform } = params;

  extractMemoryAsync(
    { userId, botName, botDir, userMessage, assistantResponse, sourceMessageId },
    config,
    traceCtx,
  );
  extractGoalAsync(
    { userId, botName, botDir, userMessage, assistantResponse, sourceMessageId, platform },
    config,
    traceCtx,
  );
  extractScheduleAsync(
    { userId, botName, botDir, userMessage, assistantResponse, platform },
    config,
    traceCtx,
  );
}
