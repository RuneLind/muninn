/**
 * The decision triage's half of the work map's tick (`work-map/loop.ts`): which
 * wikis it covers, its own state, and one night's run into the log. A wiki needs a
 * `work` map and answer cards, so a themes wiki such as jarvis is out.
 */

import type { Config } from "../../config.ts";
import { resolveWikiAnswerConfig } from "../../config.ts";
import { listWikiAnswerHistory } from "../../db/wiki-answers.ts";
import { getLog } from "../../logging.ts";
import { getWikiRegistry } from "../registry-memo.ts";
import { getWikiIndex } from "../store.ts";
import { osloDay } from "../work-map/ids.ts";
import { workMapKindFromReaderText } from "../work-map/kind.ts";
import type { WorkMapState } from "../work-map/state.ts";
import { computeFloor } from "./floor.ts";
import { realGit } from "./git.ts";
import { appendLogLines, DECISION_TRIAGE_DIR, nightlyLogPath, readLog, triageStateStore } from "./log.ts";
import { realDecisionTriageModel, runDecisionTriage, type TriageRunDeps, type TriageRunResult } from "./run.ts";
import type { RunLine } from "./schema.ts";

const log = getLog("wiki", "decision-triage");
const DAY_MS = 86_400_000;

export interface TriageLoopDeps {
  /** The covered wikis this pass reads, from those the work map covers. */
  wikis: (covered: readonly string[]) => Promise<string[]>;
  /** Called on every check: the two-nights-with-no-run-line warning. */
  beforeCheck: (wiki: string, nowMs: number) => Promise<void>;
  readState: (wiki: string) => Promise<WorkMapState | null>;
  run: (wiki: string, signal: AbortSignal) => Promise<{ outcome: TriageRunResult["outcome"] }>;
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

const readerKind = async (root: string) => {
  try {
    return workMapKindFromReaderText(await Bun.file(`${root}/.wiki-reader.json`).text());
  } catch {
    return workMapKindFromReaderText(null);
  }
};

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
  const covered = async (names: readonly string[]) => {
    const out: string[] = [];
    for (const name of names) {
      const entry = entryOf(name);
      if (!entry || !answerConfig.wikis.has(name.toLowerCase())) continue;
      const kind = await readerKind(entry.root);
      if (kind.ok && kind.kind === "work") out.push(name);
    }
    return out;
  };
  let scope: Promise<string[]> | null = null;

  return {
    wikis: (names) => (scope ??= covered(names)),
    beforeCheck: async (wiki, nowMs) => {
      const { runs } = await readLog(nightlyLogPath(wiki, dir));
      const missed = missedNights(runs, nowMs);
      const today = osloDay(nowMs);
      if (missed >= 2 && warnedOn.get(wiki) !== today) {
        warnedOn.set(wiki, today);
        log.warn("Decision triage: {wiki} has {missed} nights with no run line", { wiki, missed });
      }
    },
    readState: (wiki) => state.read(wiki),
    run: async (wiki, signal) => {
      const entry = entryOf(wiki);
      const at = Date.now();
      if (!entry) {
        await state.record(wiki, { at, outcome: "refused", error: "not a registered wiki" });
        return { outcome: "refused" };
      }
      const names = await (scope ?? Promise.resolve([wiki]));
      const deps: TriageRunDeps = {
        entry,
        now: Date.now,
        repoRoots: config.decisionTriageRepoRoots,
        model: config.workMapModel,
        ...(config.workMapEffort ? { effort: config.workMapEffort } : {}),
        call: realDecisionTriageModel(config),
        git: realGit,
        loadIndex: () => getWikiIndex({ root: entry.root, refresh: true }),
        readFile: async (abs) => {
          try {
            return await Bun.file(abs).text();
          } catch {
            return null;
          }
        },
        answers: () => listWikiAnswerHistory(entry.name),
        owner: answerConfig.owner,
        groups: answerConfig.groups,
        append: (lines) => appendLogLines(nightlyLogPath(wiki, dir), lines),
        floor: () => computeFloor(names.flatMap((n) => {
          const e = entryOf(n);
          return e ? [{ wiki: e.name, root: e.root }] : [];
        }), listWikiAnswerHistory, realGit),
        signal,
      };
      let result: TriageRunResult;
      try {
        result = await runDecisionTriage(deps);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("Decision triage threw for {wiki}: {error}", { wiki, error });
        await state.record(wiki, { at, outcome: "failed", error });
        return { outcome: "failed" };
      }
      if (result.outcome === "aborted") return result;
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
