/**
 * The decision triage's half of the work map's tick (`work-map/loop.ts`): which
 * wikis it covers (`scope.ts`), its own state, and one night's run into the log.
 */

import { randomUUID } from "node:crypto";
import type { Config } from "../../config.ts";
import { resolveWikiAnswerConfig } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { getWikiRegistry } from "../registry-memo.ts";
import { osloDay } from "../work-map/ids.ts";
import type { WorkMapState } from "../work-map/state.ts";
import { appendLogLines, DECISION_TRIAGE_DIR, nightlyLogPath, readLog, triageStateStore } from "./log.ts";
import { runDecisionTriage, type TriageRunResult } from "./run.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, type RunLine } from "./schema.ts";
import { realTriageRunDeps, triageScope } from "./scope.ts";

const log = getLog("wiki", "decision-triage");
const DAY_MS = 86_400_000;

export interface TriageLoopDeps {
  /** The wikis this pass reads, from those the work map covers, read at each check. */
  wikis: (covered: readonly string[]) => Promise<string[]>;
  /** Called on every check: the two-nights-with-no-run-line warning. */
  beforeCheck: (wiki: string, nowMs: number) => Promise<void>;
  readState: (wiki: string) => Promise<WorkMapState | null>;
  run: (wiki: string, signal: AbortSignal) => Promise<{ outcome: TriageRunResult["outcome"] }>;
  /** A pass that hit its bound: counts as `failed`, as a throw does. */
  recordFailed: (wiki: string, error: string) => Promise<void>;
}

/** Whole Oslo nights between the last run line and today, not counting either. */
export function missedNights(runs: readonly Pick<RunLine, "at">[], nowMs: number): number {
  if (runs.length === 0) return 0;
  const today = osloDay(nowMs);
  let at = Math.max(...runs.map((r) => r.at));
  const last = osloDay(at);
  let missed = -1;
  for (let guard = 0; guard < 400 && osloDay(at) <= today; guard++, at += DAY_MS) {
    if (osloDay(at) === last || osloDay(at) === today) missed = Math.max(missed, 0);
    else missed++;
    if (osloDay(at) === today) break;
  }
  return Math.max(missed, 0);
}

/** A run's throw, as the state records it. A throw during a stop is the stop. */
export async function settleTriageRun<T extends { outcome: TriageRunResult["outcome"] }>(
  run: () => Promise<T>,
  signal: AbortSignal,
  recordFailed: (error: string) => Promise<void>,
): Promise<T | { outcome: "failed" | "aborted" }> {
  try {
    return await run();
  } catch (err) {
    if (signal.aborted) return { outcome: "aborted" };
    await recordFailed(err instanceof Error ? err.message : String(err));
    return { outcome: "failed" };
  }
}

export function realTriageLoopDeps(config: Config, dir: string = DECISION_TRIAGE_DIR): TriageLoopDeps | null {
  if (!config.decisionTriageRepoRoots) {
    log.info("Decision triage off: DECISION_TRIAGE_REPO_ROOTS is not set");
    return null;
  }
  const state = triageStateStore(dir);
  const answerConfig = resolveWikiAnswerConfig();
  const warnedOn = new Map<string, string>();
  let floorMet = false;
  const entryOf = (wiki: string) => getWikiRegistry().find((e) => e.name.toLowerCase() === wiki.toLowerCase());
  const droppedFor = new Map<string, string>();
  let announced = false;
  let names: string[] = [];

  const warnMissed = async (wiki: string, nowMs: number) => {
    const { runs } = await readLog(nightlyLogPath(wiki, dir));
    const missed = missedNights(runs, nowMs);
    const today = osloDay(nowMs);
    if (missed >= 2 && warnedOn.get(wiki) !== today) {
      warnedOn.set(wiki, today);
      log.warn("Decision triage: {wiki} has {missed} nights with no run line", { wiki, missed });
    }
  };
  /** A failed run, in the state's count and the log, so the night has its line. */
  const recordFailed = async (wiki: string, error: string) => {
    const at = Date.now();
    await state.record(wiki, { at, outcome: "failed", error });
    await appendLogLines(nightlyLogPath(wiki, dir), [
      { type: "run", runId: randomUUID(), at, wiki, model: config.workMapModel, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, usage: { calls: 0 }, repoRoots: config.decisionTriageRepoRoots, repos: [], cards: 0, floor: null, outcome: "failed", reason: error },
    ]);
  };

  return {
    wikis: async (workMapWikis) => {
      const scope = await triageScope({ workMapWikis, answerWikis: answerConfig.wikis, entryOf });
      names = scope.covered.map((e) => e.name);
      for (const wiki of names) droppedFor.delete(wiki);
      for (const { wiki, reason, fault } of scope.dropped) {
        if (droppedFor.get(wiki) !== reason) {
          droppedFor.set(wiki, reason);
          log.warn("Decision triage skips {wiki}: {reason}", { wiki, reason });
        }
        if (fault) await warnMissed(wiki, Date.now());
      }
      if (!announced) {
        announced = true;
        if (names.length > 0) log.info("Decision triage covers {wikis}", { wikis: names.join(", ") });
        else log.warn("Decision triage covers nothing, though DECISION_TRIAGE_REPO_ROOTS is set");
      }
      return names;
    },
    beforeCheck: warnMissed,
    readState: (wiki) => state.read(wiki),
    recordFailed,
    run: async (wiki, signal) => {
      const entry = entryOf(wiki);
      const at = Date.now();
      if (!entry) {
        await state.record(wiki, { at, outcome: "refused", error: "not a registered wiki" });
        return { outcome: "refused" };
      }
      const deps = realTriageRunDeps(config, entry, answerConfig, {
        append: (lines) => appendLogLines(nightlyLogPath(wiki, dir), lines),
        floorEntries: () => names.flatMap((n) => {
          const e = entryOf(n);
          return e ? [e] : [];
        }),
        signal,
      });
      const result = await settleTriageRun(() => runDecisionTriage(deps), signal, (error) => {
        log.warn("Decision triage threw for {wiki}: {error}", { wiki, error });
        return recordFailed(wiki, error);
      });
      if (!("run" in result)) return result;
      await state.record(wiki, {
        at,
        outcome: result.outcome === "partial" ? "ok" : result.outcome,
        ...(result.run.reason ? { error: result.run.reason } : {}),
      });
      if (result.outcome === "ok" || result.outcome === "partial") {
        log.info("Decision triage for {wiki}: {outcome}, {cards} card(s)", { wiki, outcome: result.outcome, cards: result.run.cards });
      }
      if (result.run.floor?.met && !floorMet) {
        const logs = await Promise.all(names.map((n) => readLog(nightlyLogPath(n, dir))));
        const before = logs.flatMap((l) => l.runs).filter((r) => r.floor?.met && r.runId !== result.run.runId);
        floorMet = true;
        if (before.length === 0) log.info("Decision triage: the score's floor is met for the first time");
      }
      return result;
    },
  };
}
