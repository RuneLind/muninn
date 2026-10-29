/**
 * The organize run's inputs must be warm. The sessions memo refreshes in the
 * background, the listing never waits for it, and a cached index keeps its
 * `work` until the next rebuild. So the run first awaits answers that STARTED
 * after it did — the worked ledger first (the sessions refresh asks under its
 * `rootAsked`), then the sessions — and only then rebuilds the index, whose
 * build folds in the now-warm memos. Any miss refuses the run with a stated
 * reason and keeps the previous map.
 */

import { getWikiIndex, type WikiIndex } from "../store.ts";
import { workSessionsForSession, type WorkSessionsMemo } from "../work-sessions.ts";
import { workedLedgerStartedAfter, type WorkedStartedAfter } from "../worked-ledger.ts";

/** Both claude-usage waits get this, not the 8 s sessions default. */
export const WORK_MAP_INPUT_TIMEOUT_MS = 15_000;

export interface WarmInputDeps {
  /** Is `CLAUDE_USAGE_URL` set? */
  urlConfigured: boolean;
  ledger: (root: string, timeoutMs: number) => Promise<WorkedStartedAfter>;
  sessions: (root: string, timeoutMs: number) => Promise<{ memo: WorkSessionsMemo | null; timedOut: boolean }>;
  rebuildIndex: (root: string) => Promise<WikiIndex | null>;
}

export function realWarmInputDeps(): WarmInputDeps {
  return {
    urlConfigured: (process.env.CLAUDE_USAGE_URL ?? "").trim() !== "",
    ledger: (root, timeoutMs) => workedLedgerStartedAfter(root, { timeoutMs }),
    sessions: (root, timeoutMs) => workSessionsForSession(root, { timeoutMs }),
    rebuildIndex: (root) => getWikiIndex({ root, refresh: true }),
  };
}

export type WarmInputs = { ok: true; index: WikiIndex } | { ok: false; reason: string };

/** Await warm inputs for `root`, for a run that started at `runStartMs`. */
export async function gatherWarmInputs(root: string, runStartMs: number, deps: WarmInputDeps): Promise<WarmInputs> {
  if (!deps.urlConfigured) return { ok: false, reason: "claude-usage not configured (CLAUDE_USAGE_URL is unset)" };
  const ledger = await deps.ledger(root, WORK_MAP_INPUT_TIMEOUT_MS);
  if (!ledger.ok) return { ok: false, reason: ledger.reason };
  const sessions = await deps.sessions(root, WORK_MAP_INPUT_TIMEOUT_MS);
  if (sessions.timedOut) return { ok: false, reason: "the work sessions did not answer in time" };
  if (!sessions.memo) return { ok: false, reason: "no work sessions answer from claude-usage" };
  if (sessions.memo.asOfMs < runStartMs) {
    return { ok: false, reason: "the work sessions answer predates the run (a recent refresh failed)" };
  }
  const index = await deps.rebuildIndex(root);
  if (!index) return { ok: false, reason: "the wiki index could not be built" };
  if (!index.work) return { ok: false, reason: "the rebuilt index carries no work threads" };
  if (index.work.asOfMs < runStartMs) return { ok: false, reason: "the rebuilt index holds an older sessions answer" };
  if (!index.workedCoverage || index.workedCoverage.asOfMs < runStartMs) {
    return { ok: false, reason: "the rebuilt index holds an older worked ledger" };
  }
  if (!index.gitTouches) return { ok: false, reason: "the rebuilt index carries no git history" };
  return { ok: true, index };
}
