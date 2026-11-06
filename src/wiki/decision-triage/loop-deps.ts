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
import { runDecisionTriage, type TriageProgress, type TriageRunDeps, type TriageRunResult } from "./run.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, MODEL_OFF_MODEL, MODEL_OFF_VERSION, type RunLine } from "./schema.ts";
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
  /** A pass that hit its bound, as a throw does: `partial` if it logged verdicts first, else `failed`. */
  recordFailed: (wiki: string, error: string) => Promise<"partial" | "failed" | void>;
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
  recordFailed: (error: string) => Promise<"partial" | "failed" | void>,
): Promise<T | { outcome: "partial" | "failed" | "aborted" }> {
  try {
    return await run();
  } catch (err) {
    if (signal.aborted) return { outcome: "aborted" };
    return { outcome: (await recordFailed(err instanceof Error ? err.message : String(err))) || "failed" };
  }
}

/** `over` replaces a real seam of the night's run (tests). */
export function realTriageLoopDeps(config: Config, dir: string = DECISION_TRIAGE_DIR, over: Partial<Pick<TriageRunDeps, "call" | "answers" | "floor" | "append">> = {}): TriageLoopDeps | null {
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
  const inFlight = new Map<string, TriageProgress>();
  /** A run that threw or hit the bound, in the state's count and the log: the line
   *  carries its run id and what it had done, so its card lines have their run line.
   *  Verdicts already logged make it `partial`, which is `ok` to the state, so the
   *  next check does not pay for them twice. Reads the progress before its first await:
   *  the bound calls this right after the abort that ends the run. */
  const recordFailed = async (wiki: string, error: string) => {
    const done = inFlight.get(wiki);
    inFlight.delete(wiki);
    const now = Date.now();
    const outcome = done && done.verdicts > 0 ? "partial" : "failed";
    const reason = done && done.open !== null ? `${error}; ${done.verdicts} verdict(s) in ${done.cardsLogged} card line(s) logged of ${done.open} open card(s), ${done.usage.calls} call(s) answered` : error;
    await state.record(wiki, { at: now, outcome: outcome === "partial" ? "ok" : "failed", error: reason });
    await appendLogLines(nightlyLogPath(wiki, dir), [
      { type: "run", runId: done?.runId ?? randomUUID(), at: done?.at ?? now, wiki, model: done?.model ?? (over.call ? config.workMapModel : MODEL_OFF_MODEL), promptVersion: done?.promptVersion ?? (over.call ? DECISION_TRIAGE_PROMPT_VERSION : MODEL_OFF_VERSION), usage: done?.usage ?? { calls: 0 }, repoRoots: config.decisionTriageRepoRoots, repos: done?.repos ?? [], cards: done?.cardsLogged ?? 0, floor: null, outcome, reason },
    ]);
    return outcome;
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
        nightlyDir: dir,
        floorEntries: () => names.flatMap((n) => {
          const e = entryOf(n);
          return e ? [e] : [];
        }),
        signal,
      });
      const track = (progress: TriageProgress) => void inFlight.set(wiki, progress);
      const result = await settleTriageRun(() => runDecisionTriage({ ...deps, ...over, track }), signal, (error) => {
        log.warn("Decision triage threw for {wiki}: {error}", { wiki, error });
        return recordFailed(wiki, error);
      });
      if (!("run" in result)) return result;
      inFlight.delete(wiki);
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
