import type { AgentKind } from "../observability/agent-status.ts";
import type { Tracer } from "./tracer.ts";

/**
 * What a `/agents` Recently-finished row needs that a trace span does not carry
 * on its own: which kind of job this was, and the name its card showed.
 */
export interface AgentRunIdentity {
  kind: AgentKind;
  name: string;
}

/** The spend a Recently-finished row shows, under the names the row's query reads. */
export interface AgentRunUsage {
  model?: string;
  /** For a root whose own `model` would change `/traces`, which prefers a root's
   *  attribute over its child spans' aggregate. The row reads this one first. */
  agentModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Finish the span of a job that `/agents` lists from the completed-runs ring, so
 * the row can be rebuilt from Postgres after that in-memory ring is gone.
 *
 * `agentKind` and `agentName` are the contract with the Recently-finished query:
 * a span carrying them is one finished run. So stamp exactly one span per run,
 * the one whose `traceId` the ring row carries, and leave a superseded attempt
 * unstamped. They are written last so a caller's attributes cannot overwrite them.
 *
 * With no `run` (a capture job whose run already settled, or a test's bare
 * `attachRun`) this is a plain finish: no ring row exists to rebuild.
 */
export function finishAgentRunTrace(
  tracer: Pick<Tracer, "finish">,
  run: AgentRunIdentity | null | undefined | void,
  status: "ok" | "error",
  attrs: AgentRunUsage & Record<string, unknown> = {},
): void {
  tracer.finish(status, run ? { ...attrs, agentKind: run.kind, agentName: jsonbSafe(run.name) } : attrs);
}

/** A run name ends in a title or question, cut with a bare `slice` at some sites.
 *  jsonb refuses a lone surrogate and a NUL, and a refused UPDATE loses the whole
 *  finish (status, duration, spend) to a log line. */
function jsonbSafe(name: string): string {
  return name.toWellFormed().replaceAll("\u0000", "");
}
