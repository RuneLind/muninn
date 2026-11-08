/**
 * The decision triage's half of the work map's tick (`work-map/loop.ts`): which
 * wikis it covers (`scope.ts`), its own state, and one night's run into the log.
 */

import { randomUUID } from "node:crypto";
import type { Config } from "../../config.ts";
import { resolveWikiAnswerConfig } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { agentStatus } from "../../observability/agent-status.ts";
import { finishAgentRunTrace } from "../../tracing/agent-run-trace.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { getWikiRegistry } from "../registry-memo.ts";
import { osloDay } from "../work-map/ids.ts";
import type { WorkMapState } from "../work-map/state.ts";
import { appendLogLines, DECISION_TRIAGE_DIR, nightlyLogPath, readLog, triageStateStore } from "./log.ts";
import { runDecisionTriage, type TriageProgress, type TriageRunDeps, type TriageRunResult } from "./run.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, MODEL_OFF_MODEL, MODEL_OFF_VERSION, type RunLine } from "./schema.ts";
import { NIGHTLY_MODEL_OFF, realTriageRunDeps, triageScope } from "./scope.ts";

const log = getLog("wiki", "decision-triage");
const DAY_MS = 86_400_000;

export interface TriageLoopDeps {
  /** The wikis this pass reads, from those the work map covers, read at each check. */
  wikis: (covered: readonly string[]) => Promise<string[]>;
  /** Called on every check: the two-nights-with-no-run-line warning. */
  beforeCheck: (wiki: string, nowMs: number) => Promise<void>;
  readState: (wiki: string) => Promise<WorkMapState | null>;
  run: (wiki: string, signal: AbortSignal) => Promise<TriagePassOutcome>;
  /** A pass that hit its bound, as a throw does: `partial` if it logged verdicts first, else `failed`.
   *  Writes nothing for a run whose run line is already taken. */
  recordFailed: (wiki: string, error: string) => Promise<"partial" | "failed" | void>;
}

/** How a pass ended, for the loop, Run now and the `/agents` row. */
export interface TriagePassOutcome {
  outcome: TriageRunResult["outcome"];
  /** Card lines the pass logged; absent when it wrote no run line. */
  cards?: number;
  reason?: string;
}

/**
 * One decision-triage pass at a time in this process, shared by the loop's hourly
 * check and `POST /api/wiki/decision-triage/run`: null while one is held. The
 * release is the holder's own and idempotent, so a second release, or one from
 * a holder that is no longer current, cannot free a later holder.
 */
let triageHolder: symbol | null = null;
export function tryHoldTriagePass(): (() => void) | null {
  if (triageHolder) return null;
  const me = Symbol("triage-pass");
  triageHolder = me;
  return () => {
    if (triageHolder === me) triageHolder = null;
  };
}
export const triagePassHeld = (): boolean => triageHolder !== null;

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

export const TRIAGE_AGENT_BOT = "decision-triage";

/** The span a pass's `/agents` row is rebuilt from after a restart. */
export type TriagePassTracer = Pick<Tracer, "finish" | "traceId">;

/** `over` replaces a real seam of the night's run, `tracer` the pass's span (tests). */
export function realTriageLoopDeps(
  config: Config,
  dir: string = DECISION_TRIAGE_DIR,
  over: Partial<Pick<TriageRunDeps, "call" | "answers" | "floor" | "append">> = {},
  tracer: (wiki: string) => TriagePassTracer = () => new Tracer("decision-triage-pass", { botName: TRIAGE_AGENT_BOT, platform: "wiki" }),
): TriageLoopDeps | null {
  if (!config.decisionTriageRepoRoots) {
    log.info("Decision triage off: DECISION_TRIAGE_REPO_ROOTS is not set");
    return null;
  }
  const state = triageStateStore(dir);
  /** Whether the night's run calls a model: a test's `call` seam, else the switch. */
  const modelOn = over.call !== undefined ? over.call !== null : !NIGHTLY_MODEL_OFF;
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
  /** A run's progress and who took its one run line: the pass (its own line) or this
   *  record (a throw or the bound). The first to claim writes; the other writes nothing. */
  type Slot = { progress: TriageProgress; line: null | { by: "pass" } | { by: "record"; outcome: "partial" | "failed"; cards: number } };
  const inFlight = new Map<string, Slot>();
  /** A run that threw or hit the bound, in the state's count and the log: the line
   *  carries its run id and what it had done, so its card lines have their run line.
   *  Verdicts already logged make it `partial`, which is `ok` to the state, so the
   *  next check does not pay for them twice. Claims the line before its first await:
   *  the bound calls this right after the abort that ends the run. A run whose line
   *  is already taken gets no second line or state record. */
  const recordFailed = async (wiki: string, error: string) => {
    const slot = inFlight.get(wiki);
    if (slot?.line) return slot.line.by === "record" ? slot.line.outcome : undefined;
    const done = slot?.progress;
    const now = Date.now();
    const outcome = done && done.verdicts > 0 ? "partial" : "failed";
    if (slot) slot.line = { by: "record", outcome, cards: done!.cardsLogged };
    const reason = done && done.open !== null ? `${error}; ${done.verdicts} verdict(s) in ${done.cardsLogged} card line(s) logged of ${done.open} open card(s), ${done.usage.calls} call(s) answered` : error;
    await state.record(wiki, { at: now, outcome: outcome === "partial" ? "ok" : "failed", error: reason });
    await appendLogLines(nightlyLogPath(wiki, dir), [
      { type: "run", runId: done?.runId ?? randomUUID(), at: done?.at ?? now, wiki, model: done?.model ?? (modelOn ? config.workMapModel : MODEL_OFF_MODEL), promptVersion: done?.promptVersion ?? (modelOn ? DECISION_TRIAGE_PROMPT_VERSION : MODEL_OFF_VERSION), usage: done?.usage ?? { calls: 0 }, repoRoots: config.decisionTriageRepoRoots, repos: done?.repos ?? [], cards: done?.cardsLogged ?? 0, floor: null, outcome, reason },
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
    run: (wiki, signal) => observedPass(wiki, tracer(wiki), config, () => runPass(wiki, signal)),
  };

  async function runPass(wiki: string, signal: AbortSignal): Promise<TriagePassOutcome> {
    const entry = entryOf(wiki);
    const at = Date.now();
    if (!entry) {
      await state.record(wiki, { at, outcome: "refused", error: "not a registered wiki" });
      return { outcome: "refused", reason: "not a registered wiki" };
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
    let slot: Slot | undefined;
    const track = (p: TriageProgress) => {
      slot = { progress: p, line: null };
      inFlight.set(wiki, slot);
    };
    const sink = over.append ?? deps.append;
    /** The pass's run line, only if no record (the bound) took this run's line first. */
    const append = async (lines: Parameters<typeof sink>[0]) => {
      if (slot && lines.some((l) => l.type === "run")) {
        if (slot.line) return;
        slot.line = { by: "pass" };
        try {
          return await sink(lines);
        } catch (err) {
          slot.line = null;
          throw err;
        }
      }
      return sink(lines);
    };
    const result = await settleTriageRun(() => runDecisionTriage({ ...deps, ...over, append, track }), signal, (error) => {
      log.warn("Decision triage threw for {wiki}: {error}", { wiki, error });
      return recordFailed(wiki, error);
    });
    const line = slot?.line;
    // An aborted run with no line keeps its progress for a record after it (Run now's bound).
    if (line && inFlight.get(wiki) === slot) inFlight.delete(wiki);
    // A throw's or the bound's line was the run's: report it, write nothing more.
    if (line?.by === "record") return { outcome: line.outcome, cards: line.cards };
    if (!("run" in result)) return result.outcome === "aborted" ? result : { outcome: result.outcome, cards: slot?.progress.cardsLogged ?? 0 };
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
    return { outcome: result.outcome, cards: result.run.cards, ...(result.run.reason ? { reason: result.run.reason } : {}) };
  }
}

/**
 * Every pass, the loop's or Run now's, as one `/agents` run and one stamped span
 * («Decision triage: <wiki>», kind `decision_triage`), so the durable Recent list
 * keeps it past a restart. `ok` and `partial` close it ok; anything else, a throw
 * included, closes it as an error.
 */
async function observedPass(wiki: string, tracer: TriagePassTracer, config: Pick<Config, "tracingEnabled">, pass: () => Promise<TriagePassOutcome>): Promise<TriagePassOutcome> {
  const run = { kind: "decision_triage", name: `Decision triage: ${wiki}` } as const;
  const reqId = agentStatus.startRequest(TRIAGE_AGENT_BOT, "organizing", undefined, run);
  agentStatus.setSourcePage(reqId, `/wiki?wiki=${encodeURIComponent(wiki)}`);
  const traceId = config.tracingEnabled === false ? {} : { traceId: tracer.traceId };
  try {
    const res = await pass();
    const status = res.outcome === "ok" || res.outcome === "partial" ? "ok" : "error";
    finishAgentRunTrace(tracer, run, status, { wiki, outcome: res.outcome, cards: res.cards ?? 0, ...(res.reason ? { reason: res.reason } : {}) });
    agentStatus.completeRequest(reqId, { status, ...traceId });
    return res;
  } catch (err) {
    finishAgentRunTrace(tracer, run, "error", { wiki, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    agentStatus.completeRequest(reqId, { status: "error", ...traceId });
    throw err;
  }
}

let loopDepsMemo: { config: Config; deps: TriageLoopDeps | null } | null = null;
/** One loop half per config, shared by the loop and Run now: one set of once-only
 *  warnings, and the floor's wikis from whichever called `wikis` last. */
export function triageLoopDepsFor(config: Config): TriageLoopDeps | null {
  if (loopDepsMemo?.config !== config) loopDepsMemo = { config, deps: realTriageLoopDeps(config) };
  return loopDepsMemo.deps;
}
