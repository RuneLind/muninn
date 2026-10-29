/**
 * The work map's process-wide loop, shaped like the Stale check's confirm loop
 * (`startStaleConfirmLoop`), not a watcher: a watcher type needs a migration, a
 * bot binding and a quiet-hours exemption.
 *
 * It starts only when `WORK_MAP_WIKIS` names a wiki, the scheduler is on, the
 * instance is not readonly and the profile is not `nais`, and it skips a wiki
 * whose root is in `WIKI_READONLY_ROOTS`. A 60 s tick compares the clock with
 * the previous tick, because timers stop while a Mac sleeps: it checks on the
 * first tick after boot, then whenever an hour of wall time has passed since
 * the last check or the gap shows the machine woke. A refusal right after a
 * wake (the tailnet may still be down) retries after 5 minutes, up to three
 * times, before falling back to hourly.
 *
 * A check runs a wiki that is past `WORK_MAP_HOUR` (Europe/Oslo) and has no
 * successful run in the last 20 h. A refusal costs nothing and retries on the
 * next check; a run that failed after the model call retries once, then waits
 * for the next day's hour.
 */

import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { isReadonlyWikiRoot, isWikiReadonly } from "../readonly.ts";
import { getWikiRegistry } from "../registry-memo.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { realWarmInputDeps } from "./inputs.ts";
import {
  abortWorkMapRuns,
  armWorkMapRuns,
  realWorkMapModel,
  startWorkMapRun,
  type WorkMapRunDeps,
  type WorkMapRunResult,
} from "./run.ts";
import { fileStateStore, WORK_MAP_MODEL_FAILURES_PER_DAY, type WorkMapState } from "./state.ts";

const log = getLog("wiki", "work-map");

export const WORK_MAP_TICK_MS = 60_000;
export const WORK_MAP_CHECK_INTERVAL_MS = 60 * 60_000;
/** A gap between ticks longer than this means the machine slept. */
export const WORK_MAP_WAKE_GAP_MS = 5 * 60_000;
export const WORK_MAP_WAKE_RETRY_MS = 5 * 60_000;
export const WORK_MAP_WAKE_RETRIES = 3;
/** A success this recent means the wiki is done for the day. */
export const WORK_MAP_FRESH_MS = 20 * 60 * 60_000;

const OSLO_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function osloWall(ms: number): { date: string; minutes: number } {
  const p = Object.fromEntries(OSLO_CLOCK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * The first instant of today's Oslo date whose wall clock reads `hour`:00 or
 * later, or null when that is after `nowMs`. On the fall-back day an hour that
 * happens twice resolves to its first occurrence; on the spring-forward day an
 * hour that never happens resolves to the moment the clock skips past it.
 */
export function todaysHourMs(nowMs: number, hour: number): number | null {
  const today = osloWall(nowMs).date;
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, hour);
  // Oslo is UTC+1 or UTC+2, so the boundary is one of these two instants.
  const boundary = [wallAsUtc - 2 * 3_600_000, wallAsUtc - 3_600_000].find((ms) => {
    const w = osloWall(ms);
    return w.date === today && w.minutes >= hour * 60;
  });
  if (boundary === undefined || boundary > nowMs) return null;
  return boundary;
}

/** Is `wiki` due for a run now, given its state file? */
export function workMapDue(state: WorkMapState | null, nowMs: number, hour: number): { due: boolean; why: string } {
  const boundary = todaysHourMs(nowMs, hour);
  if (boundary === null) return { due: false, why: "before the day's hour" };
  const last = state?.lastSuccessAt;
  if (last !== undefined && nowMs - last < WORK_MAP_FRESH_MS) return { due: false, why: "a success in the last 20 h" };
  const since = Math.max(boundary, last ?? -Infinity);
  const modelFailures = (state?.attempts ?? []).filter((a) => a.outcome === "failed" && a.at >= since).length;
  if (modelFailures >= WORK_MAP_MODEL_FAILURES_PER_DAY) return { due: false, why: "failed twice after the model call today" };
  return { due: true, why: "due" };
}

export interface WorkMapLoopDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  readState: (wiki: string) => Promise<WorkMapState | null>;
  run: (wiki: string, signal: AbortSignal) => Promise<WorkMapRunResult>;
  registry: () => readonly WikiRegistryEntry[];
  isReadonly?: () => boolean;
  isReadonlyRoot?: (root: string) => boolean;
}

/** The run deps a real instance uses, from its config. */
export function realWorkMapRunDeps(config: Config): WorkMapRunDeps {
  const state = fileStateStore();
  return {
    config: {
      workMapWikis: config.workMapWikis,
      workMapModel: config.workMapModel,
      ...(config.workMapEffort ? { workMapEffort: config.workMapEffort } : {}),
      schedulerEnabled: config.schedulerEnabled,
      profile: config.profile,
    },
    now: Date.now,
    registry: getWikiRegistry,
    inputs: realWarmInputDeps(),
    readText: async (abs) => {
      try {
        return await Bun.file(abs).text();
      } catch {
        return null;
      }
    },
    model: realWorkMapModel(config),
    state,
  };
}

let runDepsMemo: { config: Config; deps: WorkMapRunDeps } | null = null;
/** One run-deps object per config, shared by the loop and the routes, so both
 *  write through one state store. */
export function workMapRunDepsFor(config: Config): WorkMapRunDeps {
  if (runDepsMemo?.config !== config) runDepsMemo = { config, deps: realWorkMapRunDeps(config) };
  return runDepsMemo.deps;
}

function realLoopDeps(config: Config): WorkMapLoopDeps {
  const runDeps = workMapRunDepsFor(config);
  return {
    now: Date.now,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    readState: (wiki) => runDeps.state.read(wiki),
    run: (wiki, signal) => startWorkMapRun(wiki, runDeps, signal).promise,
    registry: getWikiRegistry,
  };
}

let timer: unknown = null;
let stopped = true;
let generation = 0;
let loopAbort: AbortController | null = null;
let checking: Promise<void> | null = null;
let activeDeps: WorkMapLoopDeps | null = null;

/**
 * Start the loop; returns the covered wikis, or [] when it did not start. A
 * second start while the loop runs is a no-op. Each listed name it cannot
 * cover logs one warning.
 */
export function startWorkMapLoop(
  config: Pick<Config, "schedulerEnabled" | "workMapWikis" | "workMapHour" | "profile"> & Partial<Config>,
  opts: { deps?: WorkMapLoopDeps } = {},
): string[] {
  if (!stopped || config.workMapWikis.length === 0) return [];
  const listed = config.workMapWikis.join(",");
  if (config.profile === "nais") {
    log.warn("Work map loop off: MUNINN_PROFILE=nais (WORK_MAP_WIKIS={wikis})", { wikis: listed });
    return [];
  }
  const deps = opts.deps ?? realLoopDeps(config as Config);
  if (!config.schedulerEnabled || (deps.isReadonly ?? isWikiReadonly)()) {
    log.info("Work map loop off: {why} (WORK_MAP_WIKIS={wikis})", {
      why: config.schedulerEnabled ? "the instance is readonly" : "SCHEDULER_ENABLED is off",
      wikis: listed,
    });
    return [];
  }
  const byName = new Map(deps.registry().map((e) => [e.name.toLowerCase(), e]));
  const wikis: string[] = [];
  for (const name of new Set(config.workMapWikis.map((n) => n.toLowerCase()))) {
    const entry = byName.get(name);
    if (!entry) log.warn("Work map: WORK_MAP_WIKIS names {wiki}, which is not a registered wiki — skipped", { wiki: name });
    else if ((deps.isReadonlyRoot ?? isReadonlyWikiRoot)(entry.root)) {
      log.warn("Work map: {wiki} has a readonly root (WIKI_READONLY_ROOTS) — skipped", { wiki: entry.name });
    } else wikis.push(entry.name);
  }
  if (wikis.length === 0) return [];

  armWorkMapRuns();
  stopped = false;
  activeDeps = deps;
  const gen = ++generation;
  const live = () => !stopped && gen === generation;
  const ac = new AbortController();
  loopAbort = ac;
  const hour = config.workMapHour;
  let lastTick: number | null = null;
  let lastCheck: number | null = null;
  let wakeRetriesLeft = 0;
  let nextWakeRetryAt: number | null = null;
  let pendingWake = false;

  const schedule = () => {
    if (!live()) return;
    timer = deps.setTimer(tick, WORK_MAP_TICK_MS);
  };
  const check = async (reason: "boot" | "wake" | "hourly" | "wake-retry") => {
    const at = deps.now();
    lastCheck = at;
    if (reason === "wake") wakeRetriesLeft = WORK_MAP_WAKE_RETRIES;
    let refused = false;
    for (const wiki of wikis) {
      if (!live()) return;
      const due = workMapDue(await deps.readState(wiki), deps.now(), hour);
      if (!due.due) continue;
      const res = await deps.run(wiki, ac.signal);
      if (res.outcome === "refused") refused = true;
    }
    const afterWake = reason === "wake" || reason === "wake-retry";
    if (afterWake && refused && wakeRetriesLeft > 0) {
      wakeRetriesLeft--;
      nextWakeRetryAt = deps.now() + WORK_MAP_WAKE_RETRY_MS;
    } else {
      nextWakeRetryAt = null;
    }
  };
  const tick = () => {
    timer = null;
    if (!live()) return;
    const now = deps.now();
    const woke = pendingWake || (lastTick !== null && now - lastTick > WORK_MAP_WAKE_GAP_MS);
    lastTick = now;
    pendingWake = false;
    if (checking) {
      pendingWake = woke;
      return schedule();
    }
    let reason: "boot" | "wake" | "hourly" | "wake-retry" | null = null;
    if (lastCheck === null) reason = "boot";
    else if (woke) reason = "wake";
    else if (now - lastCheck >= WORK_MAP_CHECK_INTERVAL_MS) reason = "hourly";
    else if (nextWakeRetryAt !== null && now >= nextWakeRetryAt) reason = "wake-retry";
    if (!reason) return schedule();
    const run = check(reason)
      .catch((err) => log.warn("Work map check failed: {error}", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (checking === run) checking = null;
      });
    checking = run;
    schedule();
  };
  // The first tick, one interval after boot, checks.
  schedule();
  return wikis;
}

/**
 * Stop the loop: no check or run starts after this, and no run in flight —
 * the POST's included — writes or commits once it fires. A model call already
 * sent is not cancelled (`runFencedOneShot` takes no signal); its answer is
 * dropped. The returned promise waits at most `waitMs` for a write already in
 * its section.
 */
export async function stopWorkMapLoop(waitMs = 5_000): Promise<void> {
  stopped = true;
  generation++;
  if (timer !== null) activeDeps?.clearTimer(timer);
  timer = null;
  loopAbort?.abort();
  loopAbort = null;
  checking = null;
  activeDeps = null;
  const writes = abortWorkMapRuns();
  if (writes.length === 0) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(writes).then(() => false),
    new Promise<boolean>((r) => (t = setTimeout(() => r(true), waitMs))),
  ]);
  clearTimeout(t);
  if (timedOut) log.warn("Shutdown: timed out waiting for the work map write");
}
