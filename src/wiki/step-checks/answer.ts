/**
 * A page's owner-step checks, answered (mimir plan muninn-wiki-owner-step-checks,
 * PR 2): every open list step of a counted `you` lane whose first line ends in
 * a valid `<Check …/>`, each probe run once per (kind, value) inside a short
 * cache, per machine the check names. Read only: the route
 * (`routes/wiki-step-checks.ts`) reads the page and hands the text here.
 *
 * Steps come from `youListStepLines` + `stepCheck`, the walk lint's
 * `check-placement` and Done read; a task-list row has no slot and gets no
 * answer. A step is `ok` only when every machine it names is `ok`; a machine
 * is `ok` only when every probe is, and the check dropped no attribute.
 */

import { stepCheck, type CheckProbe } from "../../format/check-tag.ts";
import { listYouSteps, youLaneRows, youListStepLines } from "../../format/step-done.ts";
import { sha256 } from "../../utils/date-hash.ts";
import { combineStates, runProbe, type ProbeDeps, type ProbeResult, type ProbeState } from "./probes.ts";

/** How long one probe answer is reused: opening a page twice runs no git. */
export const PROBE_TTL_MS = 30_000;
/** The whole answer's bound: a probe still running then answers `unknown`. */
export const ANSWER_BOUND_MS = 8_000;

export interface ProbeAnswer extends ProbeResult {
  kind: CheckProbe["kind"];
  value: string;
}

export interface MachineAnswer {
  /** The machine's name, or null for an `on`-less check on a muninn with no `MUNINN_MACHINE`. */
  name: string | null;
  state: ProbeState;
  why: string;
  probes: ProbeAnswer[];
}

export interface StepCheckAnswer {
  key: string;
  /** The step's lane among the page's counted `you` lanes, and its row there: Done's pairing. */
  lane: number;
  row: number;
  state: ProbeState;
  machines: MachineAnswer[];
  /** What the check's tag dropped (a malformed value, a bad `on`); any keeps the step from `ok`. */
  problems: string[];
}

export interface StepChecksAnswer {
  /** sha256 of the page bytes the answer read: the reader shows chips only for the same hash. */
  hash: string;
  machine: string | null;
  /** Per counted `you` lane, the rows its lists render: what the reader pairs against. */
  laneRows: number[];
  steps: StepCheckAnswer[];
}

/**
 * Answers the probes for one machine other than this one. PR 4 plugs a peer
 * call in here; it is given the probes, never a step key.
 */
export type PeerAnswerer = (machine: string, probes: readonly CheckProbe[]) => Promise<ProbeResult[]>;

export const noPeer: PeerAnswerer = async (machine, probes) => probes.map(() => ({ state: "unknown", why: `no peer configured for ${machine}` }));

/** Probe answers per (kind, value): reused for {@link PROBE_TTL_MS} after they settle; identical probes in flight share one run. */
export class ProbeCache {
  private readonly entries = new Map<string, { promise: Promise<ProbeResult>; settledAt: number | null }>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = PROBE_TTL_MS) {}

  get(probe: CheckProbe, run: () => Promise<ProbeResult>): Promise<ProbeResult> {
    const key = `${probe.kind}\u0000${probe.value}`;
    const hit = this.entries.get(key);
    if (hit && (hit.settledAt === null || this.now() - hit.settledAt < this.ttlMs)) return hit.promise;
    const entry = { promise: run(), settledAt: null as number | null };
    this.entries.set(key, entry);
    void entry.promise.then(() => {
      entry.settledAt = this.now();
    });
    return entry.promise;
  }
}

export interface AnswerDeps {
  probes: ProbeDeps;
  /** `MUNINN_MACHINE`, or null. */
  machine: string | null;
  cache: ProbeCache;
  peer?: PeerAnswerer;
  /** Defaults to {@link ANSWER_BOUND_MS}. */
  boundMs?: number;
}

/** The checked steps of `text`, with their keys, rows and checks. Null when the page's steps cannot be read. */
export function checkedSteps(text: string): { laneRows: number[]; steps: { key: string; lane: number; row: number; probes: CheckProbe[]; on: string[] | null; problems: string[] }[] } | null {
  const listed = listYouSteps(text);
  const lines = youListStepLines(text);
  if (!listed || !lines) return null;
  const laneRows = youLaneRows(text);
  if (!laneRows) return null;
  const byKey = new Map(listed.map((s) => [s.key, s]));
  const steps = lines.flatMap((l) => {
    const step = byKey.get(l.key);
    if (l.taskList || !step || step.row === null) return [];
    const check = stepCheck(l.text.split("\n")[0]!);
    return check ? [{ key: l.key, lane: step.lane, row: step.row, probes: check.probes, on: check.on, problems: check.problems }] : [];
  });
  return { laneRows, steps };
}

const machineOf = (name: string | null, probes: ProbeAnswer[], problems: readonly string[]): MachineAnswer => {
  const states = [...probes.map((p) => p.state), ...(problems.length ? (["unknown"] as const) : [])];
  const state = combineStates(states);
  const lead = probes.find((p) => p.state === state);
  const why =
    state === "ok"
      ? `all ${probes.length} ${probes.length === 1 ? "fact holds" : "facts hold"}`
      : lead
        ? lead.why
        : probes.length === 0
          ? "the check names no usable probe"
          : "the check's tag dropped an attribute";
  return { name, state, why, probes };
};

/**
 * The answer for page `text`. A page with no checked step answers `steps: []`
 * and runs nothing.
 */
export async function answerStepChecks(text: string, deps: AnswerDeps): Promise<StepChecksAnswer> {
  const hash = sha256(text);
  const found = checkedSteps(text);
  if (!found || found.steps.length === 0) return { hash, machine: deps.machine, laneRows: found?.laneRows ?? [], steps: [] };
  const { laneRows } = found;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ state: "unknown", why: "timed out" }), deps.boundMs ?? ANSWER_BOUND_MS);
  });
  const local = (p: CheckProbe) => Promise.race([deps.cache.get(p, () => runProbe(p, deps.probes)), deadline]);
  const peer = deps.peer ?? noPeer;
  try {
    const steps = await Promise.all(
      found.steps.map(async (s): Promise<StepCheckAnswer> => {
        const answer = async (name: string | null, own: boolean): Promise<MachineAnswer> => {
          const results = own
            ? await Promise.all(s.probes.map(local))
            : name === null || deps.machine === null
              ? s.probes.map(() => ({ state: "unknown" as const, why: "this muninn has no MUNINN_MACHINE" }))
              : await Promise.race([
                  peer(name, s.probes).catch(() => s.probes.map(() => ({ state: "unknown" as const, why: `the peer for ${name} failed` }))),
                  deadline.then((d) => s.probes.map(() => d)),
                ]);
          return machineOf(name, s.probes.map((p, k) => ({ kind: p.kind, value: p.value, ...(results[k] ?? { state: "unknown", why: "no answer" }) })), s.problems);
        };
        const machines = s.on === null ? [await answer(deps.machine, true)] : await Promise.all(s.on.map((m) => answer(m, deps.machine !== null && m === deps.machine)));
        return { key: s.key, lane: s.lane, row: s.row, state: combineStates(machines.map((m) => m.state)), machines, problems: s.problems };
      }),
    );
    return { hash, machine: deps.machine, laneRows, steps };
  } finally {
    clearTimeout(timer);
  }
}
