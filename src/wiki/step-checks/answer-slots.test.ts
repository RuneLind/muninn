/**
 * Git slots: a checkout probe holds its slot until its git chain has SETTLED,
 * not until its answer was given at the probe's bound, so at most
 * GIT_PROBE_SLOTS git processes run at once whatever git's timing. The answer
 * still returns at the bound. A slot is released on resolve, reject and throw,
 * waiters start in arrival order, and an unsettled read's age counts from when
 * it got its slot, not from when it was queued. Every git is a counting fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { GitResult, GitRun } from "../decision-triage/git.ts";
import { answerStepChecks, GIT_PROBE_SLOTS, ProbeCache, ProbeSlots, type AnswerDeps } from "./answer.ts";
import { PROBE_BOUND_MS, type ProbeDeps } from "./probes.ts";

const page = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const TIP = "c".repeat(40);
const okRes = (stdout = ""): GitResult => ({ ok: true, stdout, exitCode: 0 });

const realBound = PROBE_BOUND_MS.checkout;
afterEach(() => {
  PROBE_BOUND_MS.checkout = realBound;
});

/** `n` repo folders under a temp root, named `repo<i>`. */
function repos(n: number): Map<string, string> {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-slots-")));
  const named = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const dir = path.join(base, `repo${i}`);
    mkdirSync(dir);
    named.set(`repo${i}`, dir);
  }
  return named;
}

/** A fake git that counts calls in flight; `delay` decides each call's duration. */
function countingGit(delay: (args: string) => Promise<void>) {
  const c = { active: 0, peak: 0, lsRemote: 0 };
  const git: GitRun = async (cwd, args) => {
    c.active++;
    c.peak = Math.max(c.peak, c.active);
    try {
      const a = args.join(" ");
      if (a.startsWith("ls-remote")) c.lsRemote++;
      await delay(a);
      if (a === "rev-parse --show-toplevel") return okRes(`${cwd}\n`);
      if (a === "remote get-url origin") return okRes(`https://github.com/x/${path.basename(cwd)}.git\n`);
      if (a === "ls-remote --symref origin HEAD") return okRes(`ref: refs/heads/main\tHEAD\n${TIP}\tHEAD\n`);
      if (a.startsWith("config --get-regexp")) return { ok: false, stdout: "", exitCode: 1 };
      return okRes();
    } finally {
      c.active--;
    }
  };
  return { git, c };
}

function probeDeps(git: GitRun, named: Map<string, string>): ProbeDeps {
  return {
    git,
    roots: { dirs: [], named },
    readEnvFile: async () => ({ missing: true }),
    processHasEnv: () => false,
    appliedMigrations: async () => new Set(),
  };
}

const deps = (probes: ProbeDeps, over: Partial<AnswerDeps> = {}): AnswerDeps => ({ probes, machine: null, cache: new ProbeCache(), gitSlots: new ProbeSlots(GIT_PROBE_SLOTS), ...over });
const checkouts = (n: number) => page(...Array.from({ length: n }, (_, i) => `${i + 1}. C <Check checkout="repo${i}" />`));

describe("a checkout probe holds its slot until its git chain settles", () => {
  for (const n of [8, 20]) {
    test(`${n} repos, every git call slower than the probe's bound: at most ${GIT_PROBE_SLOTS} git calls at once, every answer unknown inside the route bound`, async () => {
      PROBE_BOUND_MS.checkout = 40;
      const { git, c } = countingGit(() => Bun.sleep(30));
      const t0 = Date.now();
      const a = await answerStepChecks(checkouts(n), deps(probeDeps(git, repos(n)), { boundMs: 5_000 }));
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(c.peak).toBeLessThanOrEqual(GIT_PROBE_SLOTS);
      expect(c.peak).toBe(GIT_PROBE_SLOTS);
      expect(a.steps.map((s) => s.machines[0]!.probes[0]!.why)).toEqual(Array(n).fill("timed out"));
    }, 10_000);
  }

  test("the answer still comes at the probe's bound while the git chain runs on", async () => {
    PROBE_BOUND_MS.checkout = 40;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { git, c } = countingGit((a) => (a.startsWith("ls-remote") ? gate : Promise.resolve()));
    const slots = new ProbeSlots(1);
    const t0 = Date.now();
    const a = await answerStepChecks(checkouts(1), deps(probeDeps(git, repos(1)), { gitSlots: slots }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(a.steps[0]!.machines[0]!.probes[0]!.why).toBe("timed out");
    // The chain is still in ls-remote, so the one slot is still held.
    expect(c.active).toBe(1);
    let entered = false;
    const next = slots.run(async () => void (entered = true));
    await Bun.sleep(20);
    expect(entered).toBe(false);
    release();
    await next;
    expect(entered).toBe(true);
  });
});

describe("an unsettled read's age counts from when it got its slot", () => {
  test("a checkout queued past the TTL, then started: a second page shares it, one ls-remote", async () => {
    let now = 0;
    const cache = new ProbeCache(() => now, 30_000);
    const slots = new ProbeSlots(1);
    let unblock!: () => void;
    const blocker = slots.run(() => new Promise<void>((r) => (unblock = r)));
    let openLs!: () => void;
    const lsGate = new Promise<void>((r) => (openLs = r));
    const { git, c } = countingGit((a) => (a.startsWith("ls-remote") ? lsGate : Promise.resolve()));
    const d = deps(probeDeps(git, repos(1)), { cache, gitSlots: slots, boundMs: 5_000 });
    const first = answerStepChecks(checkouts(1), d);
    await Bun.sleep(10);
    now = 31_000;
    unblock();
    await blocker;
    for (let i = 0; i < 100 && c.lsRemote === 0; i++) await Bun.sleep(5);
    expect(c.lsRemote).toBe(1);
    const second = answerStepChecks(checkouts(1), d);
    await Bun.sleep(10);
    openLs();
    const [a, b] = await Promise.all([first, second]);
    expect(c.lsRemote).toBe(1);
    expect([a.steps[0]!.state, b.steps[0]!.state]).toEqual(["ok", "ok"]);
  });

  test("a checkout still running a TTL after it started is no longer shared: a second page runs its own", async () => {
    let now = 0;
    const cache = new ProbeCache(() => now, 30_000);
    let openLs!: () => void;
    const lsGate = new Promise<void>((r) => (openLs = r));
    const { git, c } = countingGit((a) => (a.startsWith("ls-remote") ? lsGate : Promise.resolve()));
    const d = deps(probeDeps(git, repos(1)), { cache, boundMs: 5_000 });
    const first = answerStepChecks(checkouts(1), d);
    for (let i = 0; i < 100 && c.lsRemote === 0; i++) await Bun.sleep(5);
    now = 30_001;
    const second = answerStepChecks(checkouts(1), d);
    for (let i = 0; i < 100 && c.lsRemote < 2; i++) await Bun.sleep(5);
    openLs();
    await Promise.all([first, second]);
    expect(c.lsRemote).toBe(2);
  });
});

describe("ProbeSlots", () => {
  /** A task whose settling the test controls; `running` tracks what holds a slot. */
  function harness(limit: number) {
    const slots = new ProbeSlots(limit);
    const h = { running: 0, peak: 0, started: [] as number[] };
    const settle = new Map<number, (ok: boolean) => void>();
    const launch = (id: number) =>
      slots
        .run(
          () =>
            new Promise<void>((resolve, reject) => {
              h.running++;
              h.peak = Math.max(h.peak, h.running);
              h.started.push(id);
              settle.set(id, (ok) => {
                h.running--;
                settle.delete(id);
                if (ok) resolve();
                else reject(new Error("x"));
              });
            }),
        )
        .catch(() => {});
    return { slots, h, settle, launch };
  }
  /** Drains the microtask queue far enough for a handoff to start its waiter. */
  const tick = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  test("a slot handed to a waiter is not also freed: a new arrival waits", async () => {
    const { h, settle, launch } = harness(2);
    launch(1);
    launch(2);
    launch(3);
    await tick();
    expect(h.started).toEqual([1, 2]);
    settle.get(1)!(true);
    await tick();
    expect(h.started).toEqual([1, 2, 3]);
    launch(4);
    await tick();
    expect(h.started).toEqual([1, 2, 3]);
    expect(h.peak).toBe(2);
  });

  test("released on resolve, on reject and on a synchronous throw; waiters start in arrival order", async () => {
    const slots = new ProbeSlots(1);
    const order: string[] = [];
    const runs = [
      slots.run(async () => void order.push("resolve")),
      slots.run(async () => (order.push("reject"), Promise.reject(new Error("r")))).catch(() => {}),
      slots
        .run(() => {
          order.push("throw");
          throw new Error("t");
        })
        .catch(() => {}),
      slots.run(async () => void order.push("after")),
    ];
    await Promise.all(runs);
    expect(order).toEqual(["resolve", "reject", "throw", "after"]);
    // Every slot came back: a fresh run starts at once.
    let ran = false;
    await slots.run(async () => void (ran = true));
    expect(ran).toBe(true);
  });

  test("property: random arrivals and settlings never run more than the limit, and starts follow arrival order", async () => {
    let seed = 848;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 200; trial++) {
      const limit = 1 + Math.floor(rand() * 5);
      const { h, settle, launch } = harness(limit);
      let next = 0;
      const total = 5 + Math.floor(rand() * 40);
      while (next < total || settle.size > 0) {
        if (next < total && (settle.size === 0 || rand() < 0.5)) launch(next++);
        else {
          const ids = [...settle.keys()];
          settle.get(ids[Math.floor(rand() * ids.length)]!)!(rand() < 0.7);
        }
        await tick();
        expect(h.running).toBeLessThanOrEqual(limit);
      }
      expect([trial, h.peak <= limit, h.started]).toEqual([trial, true, Array.from({ length: total }, (_, i) => i)]);
    }
  });
});
