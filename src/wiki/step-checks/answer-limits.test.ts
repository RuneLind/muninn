/**
 * What one page may cost: one `schema_migrations` read however many `migration=`
 * values it names, at most 60 distinct probes, at most 4 git-spawning probes at
 * once, a bounded cache, and none of it ever making an answer `ok` that the
 * direct probe would not give. Every outside read is a counting fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { CheckProbe } from "../../format/check-tag.ts";
import type { GitResult, GitRun } from "../decision-triage/git.ts";
import { answerStepChecks, ProbeCache, ProbeSlots, type AnswerDeps } from "./answer.ts";
import { PROBE_BOUND_MS, runProbe, type ProbeDeps, type ProbeResult } from "./probes.ts";

const page = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const pad = (n: number) => String(n).padStart(3, "0");

interface Counts {
  dbReads: number;
  envReads: number;
}

/** Probe deps over a fixed world; `dbReads` counts every migrations read. */
function world(opts: { applied?: Set<string>; env?: Set<string>; git?: GitRun; roots?: ProbeDeps["roots"]; applyRead?: () => Promise<ReadonlySet<string>> } = {}, counts: Counts = { dbReads: 0, envReads: 0 }): ProbeDeps {
  const applied = opts.applied ?? new Set<string>();
  const env = opts.env ?? new Set<string>();
  const d: ProbeDeps = {
    git:
      opts.git ??
      (async () => {
        throw new Error("git must not run");
      }),
    roots: opts.roots ?? null,
    readEnvFile: async () => (counts.envReads++, { bytes: new TextEncoder().encode([...env].map((k) => `${k}=1`).join("\n") + "\n") }),
    processHasEnv: (k: string) => env.has(k),
    appliedMigrations: opts.applyRead ?? (async () => (counts.dbReads++, applied)),
  };
  return d;
}

const deps = (probes: ProbeDeps, over: Partial<AnswerDeps> = {}): AnswerDeps => ({ probes, machine: null, cache: new ProbeCache(), ...over });
const probesOf = (a: Awaited<ReturnType<typeof answerStepChecks>>) => a.steps.flatMap((s) => s.machines.flatMap((m) => m.probes));

describe("migrations: one read of the applied set", () => {
  test("30 distinct migration values: exactly one DB read, each answered from the set", async () => {
    const counts = { dbReads: 0, envReads: 0 };
    const applied = new Set(Array.from({ length: 15 }, (_, i) => pad(i)));
    const text = page(...Array.from({ length: 30 }, (_, i) => `${i + 1}. M <Check migration="${pad(i)}" />`));
    const a = await answerStepChecks(text, deps(world({ applied }, counts)));
    expect(counts.dbReads).toBe(1);
    expect(a.steps.map((s) => s.state)).toEqual(Array.from({ length: 30 }, (_, i) => (i < 15 ? "ok" : "not-yet")));
  });

  test("inside the TTL a second page reads no set; after it the set is read again", async () => {
    let now = 0;
    const counts = { dbReads: 0, envReads: 0 };
    const cache = new ProbeCache(() => now, 30_000);
    const p = world({ applied: new Set(["086"]) }, counts);
    await answerStepChecks(page('1. A <Check migration="086" />'), deps(p, { cache }));
    now = 29_999;
    await answerStepChecks(page('1. B <Check migration="087" />'), deps(p, { cache }));
    expect(counts.dbReads).toBe(1);
    now = 30_001;
    await answerStepChecks(page('1. B <Check migration="087" />'), deps(p, { cache }));
    expect(counts.dbReads).toBe(2);
  });

  test("a migration answered from a cached set never outlives the set's TTL", async () => {
    let now = 0;
    let applied = new Set(["086"]);
    const cache = new ProbeCache(() => now, 30_000);
    const p = world({ applyRead: async () => applied });
    // The set is read at 0; a probe of 086 first asked at 20 s must not keep its `ok` past 30 s.
    await answerStepChecks(page('1. A <Check migration="087" />'), deps(p, { cache }));
    now = 20_000;
    expect((await answerStepChecks(page('1. A <Check migration="086" />'), deps(p, { cache }))).steps[0]!.state).toBe("ok");
    applied = new Set();
    now = 30_001;
    expect((await answerStepChecks(page('1. A <Check migration="086" />'), deps(p, { cache }))).steps[0]!.state).toBe("not-yet");
  });

  test("a set read that never returns: every migration probe is unknown inside the bound", async () => {
    const t0 = Date.now();
    const a = await answerStepChecks(page('1. A <Check migration="086" />', '2. B <Check migration="087" />'), deps(world({ applyRead: () => new Promise(() => {}) }), { boundMs: 80 }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(probesOf(a).map((p) => p.state)).toEqual(["unknown", "unknown"]);
  });
});

describe("the per-page cap", () => {
  test("70 distinct probes: the first 60 run, the other 10 answer unknown and read nothing", async () => {
    const counts = { dbReads: 0, envReads: 0 };
    const env = new Set(Array.from({ length: 70 }, (_, i) => `K${i}`));
    const text = page(...Array.from({ length: 70 }, (_, i) => `${i + 1}. E <Check env="K${i}" />`));
    const a = await answerStepChecks(text, deps(world({ env }, counts)));
    const states = probesOf(a).map((p) => p.state);
    expect(states.slice(0, 60).every((s) => s === "ok")).toBe(true);
    expect(states.slice(60)).toEqual(Array(10).fill("unknown"));
    expect(probesOf(a)[65]!.why).toBe("too many checks on this page");
    expect(counts.envReads).toBe(60);
  });

  test("a repeated (kind, value) counts once toward the cap", async () => {
    const counts = { dbReads: 0, envReads: 0 };
    const env = new Set(Array.from({ length: 60 }, (_, i) => `K${i}`));
    const items = [...Array.from({ length: 60 }, (_, i) => `${i + 1}. E <Check env="K${i}" />`), '61. Again <Check env="K0" />'];
    const a = await answerStepChecks(page(...items), deps(world({ env }, counts)));
    expect(a.steps.every((s) => s.state === "ok")).toBe(true);
  });
});

describe("only probes that run count toward the cap", () => {
  test("60 `pushed=` steps and one `env=`: the env probe runs", async () => {
    const counts = { dbReads: 0, envReads: 0 };
    const items = [...Array.from({ length: 60 }, (_, i) => `${i + 1}. P <Check pushed="repo${i}" />`), '61. E <Check env="K0" />'];
    const a = await answerStepChecks(page(...items), deps(world({ env: new Set(["K0"]) }, counts)));
    expect(a.steps[60]!.machines[0]!.probes[0]).toEqual({ kind: "env", value: "K0", state: "ok", why: "K0 is set in .env and in the running process" });
    expect(counts.envReads).toBe(1);
    expect(a.steps[0]!.machines[0]!.probes[0]!.why).toBe("muninn cannot prove this yet");
  });

  test("60 running probes, then restart and pushed: those answer as always, not as capped", async () => {
    const env = new Set(Array.from({ length: 60 }, (_, i) => `K${i}`));
    const items = [...Array.from({ length: 60 }, (_, i) => `${i + 1}. E <Check env="K${i}" />`), '61. R <Check restart="3010" pushed="muninn" />'];
    const a = await answerStepChecks(page(...items), deps(world({ env })));
    expect(a.steps[60]!.machines[0]!.probes.map((p) => p.why)).toEqual(["muninn cannot prove this yet", "muninn cannot prove this yet"]);
  });
});

describe("cache invariants the answer leans on", () => {
  test("a failed migrations read is not served for the TTL: the next page reads again", async () => {
    let now = 0;
    let calls = 0;
    const cache = new ProbeCache(() => now, 30_000);
    const p = world({ applyRead: async () => (++calls === 1 ? Promise.reject(new Error("db down")) : new Set(["086"])) });
    const text = page('1. A <Check migration="086" />');
    expect((await answerStepChecks(text, deps(p, { cache }))).steps[0]!.machines[0]!.probes[0]!.why).toBe("this machine's database could not be read");
    now = 1_000;
    expect((await answerStepChecks(text, deps(p, { cache }))).steps[0]!.state).toBe("ok");
    expect(calls).toBe(2);
  });

  test("the TTL counts from when a read settles, not from when it started", async () => {
    let now = 0;
    let settle!: (r: ProbeResult) => void;
    let runs = 0;
    const cache = new ProbeCache(() => now, 30_000);
    const probe: CheckProbe = { kind: "env", value: "K" };
    const first = cache.get(probe, () => (runs++, new Promise<ProbeResult>((r) => (settle = r))));
    now = 25_000;
    settle({ state: "ok", why: "x" });
    await first;
    now = 40_000;
    await cache.get(probe, async () => (runs++, { state: "ok", why: "y" }));
    expect(runs).toBe(1);
    now = 55_001;
    await cache.get(probe, async () => (runs++, { state: "ok", why: "z" }));
    expect(runs).toBe(2);
  });

  test("a migrations read still unsettled past the TTL is no longer shared: the next page reads again", async () => {
    let now = 0;
    const counts = { dbReads: 0, envReads: 0 };
    const cache = new ProbeCache(() => now, 30_000);
    const p = world({ applyRead: () => (counts.dbReads++, new Promise(() => {})) }, counts);
    const text = page('1. A <Check migration="086" />');
    await answerStepChecks(text, deps(p, { cache, boundMs: 30 }));
    now = 29_999;
    await answerStepChecks(text, deps(p, { cache, boundMs: 30 }));
    expect(counts.dbReads).toBe(1);
    now = 30_001;
    await answerStepChecks(text, deps(p, { cache, boundMs: 30 }));
    expect(counts.dbReads).toBe(2);
  });

  test("a migrations read that settles after the bound fills the cache with its true set, stamped at settle", async () => {
    let now = 0;
    const counts = { dbReads: 0, envReads: 0 };
    const cache = new ProbeCache(() => now, 30_000);
    let settle!: (s: ReadonlySet<string>) => void;
    const p = world({ applyRead: () => (counts.dbReads++, new Promise((r) => (settle = r))) }, counts);
    const text = page('1. A <Check migration="086" />');
    expect((await answerStepChecks(text, deps(p, { cache, boundMs: 30 }))).steps[0]!.state).toBe("unknown");
    now = 29_000;
    settle(new Set(["086"]));
    await Bun.sleep(0);
    now = 50_000;
    expect((await answerStepChecks(text, deps(p, { cache }))).steps[0]!.state).toBe("ok");
    expect(counts.dbReads).toBe(1);
  });
});

describe("peer answers land on their own probes around capped ones", () => {
  test("a step with a capped probe before an allowed one: the peer's answer goes to the allowed probe", async () => {
    const env = new Set(Array.from({ length: 59 }, (_, i) => `K${i}`));
    const asked: unknown[] = [];
    const items = [...Array.from({ length: 59 }, (_, i) => `${i + 1}. E <Check env="K${i}" />`), '60. M <Check migration="001" />', '61. Both <Check env="NEW" migration="001" on="mini" />'];
    const a = await answerStepChecks(
      page(...items),
      deps(world({ env, applied: new Set(["001"]) }), { machine: "laptop", peer: async (m, ps) => (asked.push([m, ps]), ps.map((p) => ({ state: "ok" as const, why: `peer has ${p.value}` }))) }),
    );
    expect(asked).toEqual([["mini", [{ kind: "migration", value: "001" }]]]);
    expect(a.steps[60]!.machines[0]!.probes.map((p) => [p.kind, p.state, p.why])).toEqual([
      ["env", "unknown", "too many checks on this page"],
      ["migration", "ok", "peer has 001"],
    ]);
  });
});

describe("git-spawning probes run at most 4 at a time", () => {
  test("12 distinct checkout probes: never more than 4 git processes at once, all answered", async () => {
    const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-limits-")));
    const named = new Map<string, string>();
    for (let i = 0; i < 12; i++) {
      const dir = path.join(base, `repo${i}`);
      mkdirSync(dir);
      named.set(`repo${i}`, dir);
    }
    let active = 0;
    let peak = 0;
    const tip = "c".repeat(40);
    const ok = (stdout = ""): GitResult => ({ ok: true, stdout, exitCode: 0 });
    const git: GitRun = async (cwd, args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await Bun.sleep(5);
        const a = args.join(" ");
        if (a === "rev-parse --show-toplevel") return ok(`${cwd}\n`);
        if (a === "remote get-url origin") return ok(`https://github.com/x/${path.basename(cwd)}.git\n`);
        if (a === "ls-remote --symref origin HEAD") return ok(`ref: refs/heads/main\tHEAD\n${tip}\tHEAD\n`);
        // No partial-clone key (git config exits 1 on no match).
        if (a.startsWith("config --get-regexp")) return { ok: false, stdout: "", exitCode: 1 };
        return ok();
      } finally {
        active--;
      }
    };
    const text = page(...Array.from({ length: 12 }, (_, i) => `${i + 1}. C <Check checkout="repo${i}" />`));
    const a = await answerStepChecks(text, deps(world({ git, roots: { dirs: [], named } })));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(a.steps.map((s) => s.state)).toEqual(Array(12).fill("ok"));
  });
});

describe("ProbeCache is bounded", () => {
  const probe = (i: number): CheckProbe => ({ kind: "env", value: `K${i}` });
  const res: ProbeResult = { state: "ok", why: "x" };

  test("never holds more than its cap; the oldest goes first", async () => {
    const cache = new ProbeCache(() => 0, 30_000, 5);
    const runs: number[] = [];
    for (let i = 0; i < 20; i++) {
      await cache.get(probe(i), async () => (runs.push(i), res));
      expect(cache.size).toBeLessThanOrEqual(5);
    }
    await cache.get(probe(19), async () => (runs.push(19), res));
    await cache.get(probe(0), async () => (runs.push(0), res));
    expect(runs.slice(20)).toEqual([0]);
  });

  test("expired entries are dropped", async () => {
    let now = 0;
    const cache = new ProbeCache(() => now, 1_000, 50);
    for (let i = 0; i < 10; i++) await cache.get(probe(i), async () => res);
    now = 1_001;
    await cache.get(probe(99), async () => res);
    expect(cache.size).toBe(1);
  });
});

describe("property: capped, cached and slotted answers are never ok where the direct probe is not", () => {
  // A seeded generator, so a failure replays.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const tip = "c".repeat(40);
  const REPOS = 12;
  const realBound = PROBE_BOUND_MS.checkout;
  afterEach(() => {
    PROBE_BOUND_MS.checkout = realBound;
  });

  /** Per repo: ok, not-yet (tip missing), failing (ls-remote fails) or slow (past the probe's bound). */
  type RepoKind = "ok" | "not-yet" | "failing" | "slow";
  const repoGit = (kinds: RepoKind[]): GitRun => async (cwd, args) => {
    const kind = kinds[Number(path.basename(cwd).slice(4))]!;
    const a = args.join(" ");
    if (kind === "slow") await Bun.sleep(25);
    if (a === "rev-parse --show-toplevel") return { ok: true, stdout: `${cwd}\n`, exitCode: 0 };
    if (a === "remote get-url origin") return { ok: true, stdout: `https://github.com/x/${path.basename(cwd)}.git\n`, exitCode: 0 };
    if (a.startsWith("config --get-regexp")) return { ok: false, stdout: "", exitCode: 1 };
    if (a.startsWith("ls-remote")) return kind === "failing" ? { ok: false, stdout: "", exitCode: 128 } : { ok: true, stdout: `ref: refs/heads/main\tHEAD\n${tip}\tHEAD\n`, exitCode: 0 };
    if (a.startsWith("cat-file")) return kind === "not-yet" ? { ok: false, stdout: "", exitCode: 1 } : { ok: true, stdout: "", exitCode: 0 };
    return { ok: true, stdout: "", exitCode: 0 };
  };

  // The world changes only when time moves past the TTL: inside one TTL a cached
  // answer may be stale by design, past it never.
  test("250 random pages over changing worlds: capped, cached, slotted, slow and failing probes", async () => {
    PROBE_BOUND_MS.checkout = 15;
    const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-prop-")));
    const named = new Map<string, string>();
    for (let i = 0; i < REPOS; i++) {
      mkdirSync(path.join(base, `repo${i}`));
      named.set(`repo${i}`, path.join(base, `repo${i}`));
    }
    let now = 0;
    const cache = new ProbeCache(() => now, 30_000, 40);
    const gitSlots = new ProbeSlots(2);
    const kindsOf: RepoKind[] = ["ok", "not-yet", "failing", "slow"];
    const newWorld = () => ({
      applied: new Set(Array.from({ length: 50 }, (_, i) => pad(i)).filter(() => rand() < 0.5)),
      env: new Set(Array.from({ length: 50 }, (_, i) => `K${i}`).filter(() => rand() < 0.5)),
      dbDown: rand() < 0.2,
      kinds: Array.from({ length: REPOS }, () => kindsOf[Math.floor(rand() * (rand() < 0.9 ? 3 : 4))]!),
    });
    let w = newWorld();
    const probeWorld = () => world({ env: w.env, git: repoGit(w.kinds), roots: { dirs: [], named }, applyRead: async () => (w.dbDown ? Promise.reject(new Error("down")) : w.applied) });
    for (let trial = 0; trial < 250; trial++) {
      // Up to 120 steps over 125 distinct probes: past the cap of 60 on many pages.
      const n = 1 + Math.floor(rand() * 120);
      const items = Array.from({ length: n }, (_, i) => {
        const r = rand();
        const v = Math.floor(rand() * 50);
        const attr = r < 0.4 ? `migration="${pad(v)}"` : r < 0.8 ? `env="K${v}"` : r < 0.9 ? `checkout="repo${v % REPOS}"` : r < 0.95 ? `pushed="repo${v % REPOS}"` : `restart="3010"`;
        return `${i + 1}. S <Check ${attr} />`;
      });
      const a = await answerStepChecks(page(...items), deps(probeWorld(), { cache, gitSlots }));
      for (const got of probesOf(a)) {
        if (got.state !== "ok") continue;
        const direct = await runProbe({ kind: got.kind, value: got.value } as CheckProbe, probeWorld());
        expect([trial, got.kind, got.value, direct.state]).toEqual([trial, got.kind, got.value, "ok"]);
      }
      if (rand() < 0.3) {
        now += 30_001;
        w = newWorld();
      } else now += 100;
    }
  }, 30_000);
});
