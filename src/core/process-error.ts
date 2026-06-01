import type { Tracer } from "../tracing/index.ts";
import type { Platform } from "../types.ts";
import { activityLog } from "../observability/activity-log.ts";
import { agentStatus } from "../observability/agent-status.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { getLog } from "../logging.ts";
import type { LogProps } from "./message-processor.ts";

const log = getLog("core", "process-error");

export interface ProcessErrorParams {
  error: unknown;
  tracer: Tracer;
  /** When true, the caller owns the tracer lifecycle — don't call `tracer.error()`. */
  externalTracer: boolean;
  platform: Platform;
  say: (message: string) => Promise<void>;
  userId: string;
  username: string;
  botName: string;
  logProps: LogProps;
}

/**
 * Cleanup + user-facing error reporting after a failed processMessage attempt.
 * Resets dashboard state, finishes the trace (unless caller owns it), logs
 * the failure with the last completed phase, records the error in the
 * activity feed, and sends a platform-appropriate error message via `say`.
 */
export async function handleProcessError(params: ProcessErrorParams): Promise<void> {
  const { error, tracer, externalTracer, platform, say, userId, username, botName, logProps } = params;

  agentStatus.clearRequest();
  agentStatus.set("idle");
  if (!externalTracer) {
    tracer.error(error instanceof Error ? error : String(error));
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const s = tracer.summary();
  const elapsed = Math.round(tracer.totalMs());
  const lastPhase = lastCompletedPhase(s);

  log.error(
    "Request failed after {elapsed}ms (last completed phase: {lastPhase})\n" +
      `  Error: ${errorMessage}\n` +
      `  Phases: ${Object.entries(s).map(([k, v]) => `${k}=${Math.round(v ?? 0)}ms`).join(", ")}`,
    { ...logProps, elapsed, lastPhase },
  );
  activityLog.push("error", errorMessage, { userId, username, botName });

  if (platform.startsWith("telegram")) {
    await say(`Something went wrong: ${escapeHtml(errorMessage)}`).catch(() => {});
  } else {
    await say(`Something went wrong: ${errorMessage}`).catch(() => {});
  }
}

/** Phases are recorded chronologically, so `.pop()` yields the most recent one. */
export function lastCompletedPhase(summary: Record<string, number | undefined>): string {
  return Object.entries(summary)
    .filter(([, v]) => v != null)
    .map(([k]) => k)
    .pop() ?? "unknown";
}
