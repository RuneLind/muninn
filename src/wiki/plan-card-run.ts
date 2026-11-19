/**
 * One plan-card child: the run the Agent lens route (`GET /api/wiki/plan-card`)
 * and the Discuss wiki agent (`POST /api/wiki/discuss`) both start. Moved out of
 * the route file so the agent, a route of its own, reaches it without a
 * route-to-route import. The route keeps its single-flight table; this module
 * only runs the child and parses its answer.
 */
import path from "node:path";
import { ProcTimeoutError, runProc, type ProcResult } from "../utils/run-proc.ts";
import { parsePlanCardJson, planCardArgs, planCardChildEnv, PLAN_CARD_TIMEOUT_MS, type PlanCardCut } from "./plan-card.ts";
import { stampInterpreterArgv } from "./stamp-roots.ts";

export type RunOutcome =
  | { ok: true; proc: ProcResult; ms: number }
  | { ok: false; timeout: boolean; message: string }
  | { ok: false; abandoned: true };

export interface PlanCardRunOptions {
  /** The script (`PLAN_CARD_BIN`). */
  bin: string;
  /** The page, spelled under plan-card's own root. */
  abs: string;
  since?: string;
  id?: string;
  /** The port the child's `PLAN_CARD_MUNINN_URL` names. */
  port: number;
  runProc?: typeof runProc;
  timeoutMs?: number;
  /** The interpreter argv before the script; default the running Bun with `--no-env-file`. */
  interpreter?: string[];
  killGraceMs?: number;
}

/** Start the child and wait for it. Never throws: a failed start or a timeout is an outcome. */
export async function runPlanCard(opts: PlanCardRunOptions): Promise<RunOutcome> {
  const argv = [...(opts.interpreter ?? stampInterpreterArgv(process.execPath)), ...planCardArgs(opts.bin, opts.abs, { since: opts.since, id: opts.id })];
  const t0 = performance.now();
  try {
    // The child runs in the script's own directory, so a `bunfig.toml` in
    // muninn's cwd does not load in it, and leads its own process group.
    const proc = await (opts.runProc ?? runProc)(argv, opts.timeoutMs ?? PLAN_CARD_TIMEOUT_MS, "plan-card", {
      ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
      env: planCardChildEnv(opts.port),
      cwd: path.dirname(opts.bin),
      processGroup: true,
    });
    return { ok: true, proc, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, timeout: err instanceof ProcTimeoutError, message: err instanceof Error ? err.message : String(err) };
  }
}

/** A finished run's card, or the sentence why there is none. */
export function planCardFromOutcome(
  outcome: RunOutcome,
  timeoutMs: number = PLAN_CARD_TIMEOUT_MS,
): { ok: true; text: string; chars: number; cuts: PlanCardCut[]; ms: number } | { ok: false; status: 499 | 502 | 504; error: string; exitCode?: number | null; timeout?: boolean } {
  if (!outcome.ok && "abandoned" in outcome) return { ok: false, status: 499, error: "the request was cancelled before plan-card started" };
  if (!outcome.ok) {
    return outcome.timeout
      ? { ok: false, status: 504, error: `plan-card did not answer within ${Math.round(timeoutMs / 1000)} s`, timeout: true }
      : { ok: false, status: 502, error: outcome.message };
  }
  const card = parsePlanCardJson(outcome.proc.stdout);
  if (outcome.proc.exitCode !== 0 || !card) {
    let message = outcome.proc.stderr.trim().split("\n")[0] || "plan-card printed no card";
    try {
      const e = JSON.parse(outcome.proc.stdout) as { error?: unknown };
      if (typeof e.error === "string") message = e.error;
    } catch {
      // not JSON: keep stderr's first line
    }
    return { ok: false, status: 502, error: message, exitCode: outcome.proc.exitCode };
  }
  return { ok: true, text: card.text, chars: card.chars, cuts: card.cuts, ms: outcome.ms };
}
