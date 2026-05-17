import type { Config } from "../config.ts";
import type { Platform } from "../types.ts";
import type { TraceContext } from "../tracing/index.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";
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
  /** Bot's main connector — forwarded to the Haiku router for per-bot backend selection. */
  connector?: ConnectorType;
  /** Per-bot override from `BotConfig.haikuBackend`. */
  haikuBackend?: HaikuBackend;
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
  const { userId, botName, botDir, userMessage, assistantResponse, sourceMessageId, platform, connector, haikuBackend } = params;

  extractMemoryAsync(
    { userId, botName, botDir, userMessage, assistantResponse, sourceMessageId, connector, haikuBackend },
    config,
    traceCtx,
  );
  extractGoalAsync(
    { userId, botName, botDir, userMessage, assistantResponse, sourceMessageId, platform, connector, haikuBackend },
    config,
    traceCtx,
  );
  extractScheduleAsync(
    { userId, botName, botDir, userMessage, assistantResponse, platform, connector, haikuBackend },
    config,
    traceCtx,
  );
}
