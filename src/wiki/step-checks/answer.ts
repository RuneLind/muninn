/**
 * A page's owner-step checks, answered (mimir plan muninn-wiki-owner-step-checks,
 * PR 2): every open list step of a counted `you` lane whose first line ends in
 * a valid `<Check …/>`, each probe run once per (kind, value) inside a short
 * cache, per machine the check names. A page runs at most
 * {@link MAX_PROBES_PER_PAGE} distinct probes that run anything, its
 * `migration=` probes share one applied-set read, and git-spawning probes take
 * one of {@link GIT_PROBE_SLOTS} process-wide slots, held until their git has
 * ended. Read only: the route
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
import { combineStates, probeRuns, runProbe, startProbe, type ProbeDeps, type ProbeResult, type ProbeState } from "./probes.ts";

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
 * Answers the probes for one machine other than this one: `createPeerAnswerer`
 * (`peer.ts`) over `MUNINN_PEERS`. It is given the probes, never a step key.
 */
export type PeerAnswerer = (machine: string, probes: readonly CheckProbe[]) => Promise<ProbeResult[]>;

export const noPeer: PeerAnswerer = async (machine, probes) => probes.map(() => ({ state: "unknown", why: `no peer configured for ${machine}` }));

/** How many answers {@link ProbeCache} keeps: past it the oldest goes first. */
export const PROBE_CACHE_MAX = 500;
/** Distinct (kind, value) probes one page may run; the rest answer `unknown`. `restart` runs nothing and does not count. The largest real `you` lane has under 20 steps. */
export const MAX_PROBES_PER_PAGE = 60;
/** Git-spawning probes running at once, process-wide: 8 at once timed `ls-remote` out (measured in review). */
export const GIT_PROBE_SLOTS = 4;

const GIT_KINDS: ReadonlySet<CheckProbe["kind"]> = new Set(["checkout", "pushed"]);
const MIGRATIONS_KEY = "migrations\u0000*";
const TOO_MANY: ProbeResult = { state: "unknown", why: "too many checks on this page" };
const probeKey = (p: CheckProbe) => `${p.kind}\u0000${p.value}`;

interface CacheEntry {
  promise: Promise<unknown>;
  /** Null while a read waits for a slot: it has not started running. */
  startedAt: number | null;
  settledAt: number | null;
}

/**
 * Answers by key: reused for {@link PROBE_TTL_MS} after they settle, identical
 * reads in flight share one run. At most `maxEntries`, oldest first out;
 * expired entries are dropped on every miss. A read that rejects is not kept,
 * and one still unsettled {@link PROBE_TTL_MS} after it started running is no
 * longer shared. A read that first waits for a slot (`startsLater`) is shared
 * while it waits, and its age counts from the `started()` its run calls.
 */
export class ProbeCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PROBE_TTL_MS,
    private readonly maxEntries = PROBE_CACHE_MAX,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(probe: CheckProbe, run: (started: () => void) => Promise<ProbeResult>, opts: { startsLater?: boolean } = {}): Promise<ProbeResult> {
    return this.getKey(probeKey(probe), run, opts);
  }

  getKey<T>(key: string, run: (started: () => void) => Promise<T>, opts: { startsLater?: boolean } = {}): Promise<T> {
    const now = this.now();
    const fresh = (e: CacheEntry) => {
      const since = e.settledAt ?? e.startedAt;
      return since === null || now - since < this.ttlMs;
    };
    const hit = this.entries.get(key);
    if (hit && fresh(hit)) return hit.promise as Promise<T>;
    for (const [k, e] of this.entries) if (!fresh(e)) this.entries.delete(k);
    const entry: CacheEntry = { promise: Promise.resolve(), startedAt: opts.startsLater ? null : now, settledAt: null };
    entry.promise = run(() => {
      if (entry.startedAt === null) entry.startedAt = this.now();
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    entry.promise.then(
      () => {
        entry.settledAt = this.now();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.promise as Promise<T>;
  }
}

/**
 * A counting semaphore: at most `limit` runs at once, the rest wait in arrival
 * order. A run holds its slot until the promise `fn` returns settles; a
 * finished run hands its slot straight to the first waiter.
 */
export class ProbeSlots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // A waiter takes the slot over; `active` drops only when none waits.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const sharedGitSlots = new ProbeSlots(GIT_PROBE_SLOTS);

export interface AnswerDeps {
  probes: ProbeDeps;
  /** `MUNINN_MACHINE`, or null. */
  machine: string | null;
  cache: ProbeCache;
  peer?: PeerAnswerer;
  /** Defaults to {@link ANSWER_BOUND_MS}. */
  boundMs?: number;
  /** Defaults to one process-wide {@link ProbeSlots} of {@link GIT_PROBE_SLOTS}. */
  gitSlots?: ProbeSlots;
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

/** `r` without the `<name>: ` lead the peer client puts on an answered why (`peer.ts`). */
const untagged = (name: string, r: ProbeResult): ProbeResult => (r.why.startsWith(`${name}: `) ? { ...r, why: r.why.slice(name.length + 2) } : r);

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

/** What running probes on this machine needs: no machine name and no peer, so it can never forward. */
export type LocalAnswerDeps = Pick<AnswerDeps, "probes" | "cache" | "gitSlots" | "boundMs">;

const boundAnswer = (boundMs: number | undefined) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ state: "unknown", why: "timed out" }), boundMs ?? ANSWER_BOUND_MS);
  });
  return { deadline, timer };
};

/** One probe run on this machine: the shared cache, the git slots, the migration read, raced against `deadline`. */
function localRunner(deps: LocalAnswerDeps, deadline: Promise<ProbeResult>): (p: CheckProbe) => Promise<ProbeResult> {
  // One applied-set read per cache window, shared by every `migration=` probe.
  const probeDeps: ProbeDeps = { ...deps.probes, appliedMigrations: () => deps.cache.getKey(MIGRATIONS_KEY, () => deps.probes.appliedMigrations()) };
  const slots = deps.gitSlots ?? sharedGitSlots;
  // A git probe answers at its bound but keeps its slot until its git chain has
  // ended, so the git still running behind a timed-out answer counts against the slots.
  const slotted = (p: CheckProbe, started: () => void) =>
    new Promise<ProbeResult>((resolve) => {
      slots
        .run(() => {
          started();
          const s = startProbe(p, probeDeps);
          void s.answer.then(resolve);
          return s.settled;
        })
        .catch(() => resolve({ state: "unknown", why: "the probe failed" }));
    });
  // A migration answer is not cached on its own: it would outlive the set it was read from.
  return (p) =>
    Promise.race([
      p.kind === "migration"
        ? runProbe(p, probeDeps)
        : GIT_KINDS.has(p.kind)
          ? deps.cache.get(p, (started) => slotted(p, started), { startsLater: true })
          : deps.cache.get(p, () => runProbe(p, probeDeps)),
      deadline,
    ]);
}

/**
 * `probes` answered on this machine, in order, exactly as a page's own steps
 * are (same cache, slots and per-probe bounds), the whole within `boundMs`.
 * `GET /api/checks/answer` runs this; it takes no peer, so it never forwards.
 */
export async function answerProbesHere(probes: readonly CheckProbe[], deps: LocalAnswerDeps): Promise<ProbeResult[]> {
  const { deadline, timer } = boundAnswer(deps.boundMs);
  try {
    const run = localRunner(deps, deadline);
    return await Promise.all(probes.map(run));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The answer for page `text`. A page with no checked step answers `steps: []`
 * and runs nothing.
 */
export async function answerStepChecks(text: string, deps: AnswerDeps): Promise<StepChecksAnswer> {
  const hash = sha256(text);
  const found = checkedSteps(text);
  if (!found || found.steps.length === 0) return { hash, machine: deps.machine, laneRows: found?.laneRows ?? [], steps: [] };
  const { laneRows } = found;
  const { deadline, timer } = boundAnswer(deps.boundMs);
  // The page's first MAX_PROBES_PER_PAGE distinct probes run; the rest are capped.
  // `restart` runs nothing, so it takes no seat and is never capped.
  const allowed = new Set<string>();
  for (const s of found.steps) for (const p of s.probes) if (probeRuns(p.kind) && allowed.size < MAX_PROBES_PER_PAGE) allowed.add(probeKey(p));
  const capped = (p: CheckProbe) => probeRuns(p.kind) && !allowed.has(probeKey(p));
  const run = localRunner(deps, deadline);
  const local = (p: CheckProbe): Promise<ProbeResult> => (capped(p) ? Promise.resolve(TOO_MANY) : run(p));
  const peer = deps.peer ?? noPeer;
  const viaPeer = async (name: string, probes: readonly CheckProbe[]): Promise<ProbeResult[]> => {
    const asked = probes.filter((p) => !capped(p));
    const got = asked.length ? await peer(name, asked) : [];
    let k = 0;
    return probes.map((p) => (capped(p) ? TOO_MANY : (got[k++] ?? { state: "unknown", why: "no answer" })));
  };
  try {
    const steps = await Promise.all(
      found.steps.map(async (s): Promise<StepCheckAnswer> => {
        // The reader names each machine of a several-machine step itself, so its peer whys drop the client's `<machine>: `.
        const many = (s.on?.length ?? 0) > 1;
        const answer = async (name: string | null, own: boolean): Promise<MachineAnswer> => {
          const results = own
            ? await Promise.all(s.probes.map(local))
            : name === null || deps.machine === null
              ? s.probes.map(() => ({ state: "unknown" as const, why: "this muninn has no MUNINN_MACHINE" }))
              : await Promise.race([
                  viaPeer(name, s.probes).catch(() => s.probes.map(() => ({ state: "unknown" as const, why: `the peer for ${name} failed` }))),
                  deadline.then((d) => s.probes.map(() => d)),
                ]).then((rs) => (many ? rs.map((r) => untagged(name, r)) : rs));
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
