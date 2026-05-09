import type { Tracer } from "../tracing/index.ts";
import type { Platform } from "../types.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { agentStatus } from "../dashboard/agent-status.ts";
import { getLog } from "../logging.ts";

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
  /** Log properties (botName/userId/username/platform) carried from the orchestrator. */
  logProps: Record<string, unknown>;
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
  const lastPhase = Object.entries(s)
    .filter(([, v]) => v != null)
    .map(([k]) => k)
    .pop() ?? "unknown";

  log.error(
    "Request failed after {elapsed}ms (last completed phase: {lastPhase})\n" +
      `  Error: ${errorMessage}\n` +
      `  Phases: ${Object.entries(s).map(([k, v]) => `${k}=${Math.round(v ?? 0)}ms`).join(", ")}`,
    { ...logProps, elapsed, lastPhase },
  );
  activityLog.push("error", errorMessage, { userId, username, botName });

  if (platform.startsWith("telegram")) {
    const escaped = errorMessage.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await say(`Something went wrong: ${escaped}`).catch(() => {});
  } else {
    await say(`Something went wrong: ${errorMessage}`).catch(() => {});
  }
}
