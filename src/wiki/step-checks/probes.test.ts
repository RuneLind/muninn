/**
 * The five probes' truth tables against an in-memory machine: a fake git
 * runner, an in-memory `.env`, a fake migrations table. Each row pins the one
 * state a fact may give, and every `unknown`/`not-yet` path; `ok` only where
 * the fact is proven.
 */
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { GitResult, GitRun } from "../decision-triage/git.ts";
import { bounded, combineStates, probeCheckout, probeEnv, probeMigration, probePushed, probeRestart, type ProbeDeps } from "./probes.ts";

const DIR = realpathSync(testTempDirSync(path.join(tmpdir(), "step-probes-")));

const TIP = "a".repeat(40);
const OK = (stdout = ""): GitResult => ({ ok: true, stdout, exitCode: 0 });
const EXIT = (code: number): GitResult => ({ ok: false, stdout: "", exitCode: code });
const TIMED_OUT: GitResult = { ok: false, stdout: "", timedOut: true };

interface World {
  lsRemote?: GitResult;
  catFile?: GitResult;
  ancestor?: GitResult;
  originHead?: string | null;
  refs?: string;
  head?: GitResult;
  symHead?: GitResult;
  reflog?: Record<string, number | null>;
  status?: string;
}

/** A git that answers as one repo at {@link DIR} named `muninn`; `calls` records every argv. */
function fakeGit(w: World = {}, calls: string[][] = []): GitRun {
  return async (_cwd, args) => {
    calls.push([...args]);
    const a = args.join(" ");
    if (a === "rev-parse --show-toplevel") return OK(`${DIR}\n`);
    if (a === "remote get-url origin") return OK("https://github.com/x/muninn.git\n");
    if (a.startsWith("symbolic-ref --quiet --short refs/remotes/origin/HEAD")) return w.originHead === null ? EXIT(1) : OK(`origin/${w.originHead ?? "main"}\n`);
    if (a.startsWith("rev-parse --verify --quiet refs/remotes/origin/")) return w.originHead === null ? EXIT(1) : OK(TIP);
    if (a.startsWith("ls-remote origin refs/heads/")) return w.lsRemote ?? OK(`${TIP}\trefs/heads/main\n`);
    if (a.startsWith("cat-file -e")) return w.catFile ?? OK();
    if (a.startsWith("merge-base --is-ancestor")) return w.ancestor ?? OK();
    if (a.startsWith("for-each-ref")) return OK(w.refs ?? "main\trefs/remotes/origin/main\t\n");
    if (a === "symbolic-ref --quiet --short HEAD") return w.head ?? OK("main\n");
    if (a === "symbolic-ref --quiet HEAD") return w.symHead ?? OK("refs/heads/main\n");
    if (a.startsWith("log -g -1 --date=unix --format=%gd")) {
      const ref = args[args.length - 2]!;
      const at = (w.reflog ?? {})[ref] !== undefined ? w.reflog![ref] : 1_000;
      return at === null ? EXIT(128) : OK(`${ref}@{${at}}\n`);
    }
    if (a.startsWith("status --porcelain")) return OK(w.status ?? "");
    return EXIT(128);
  };
}

function deps(over: Partial<ProbeDeps> = {}, w?: World, calls?: string[][]): ProbeDeps {
  return {
    git: fakeGit(w, calls),
    roots: { dirs: [], named: new Map([["muninn", DIR], ["mimir", DIR]]) },
    readEnvFile: async () => ({ text: "SET_KEY=s3cr3t-value\nBLANK_KEY=\n" }),
    processHasEnv: () => true,
    hasMigration: async (v) => v === "086",
    dashboardPort: 3010,
    ownRepoDir: DIR,
    processStartMs: 5_000_000,
    mtimeMs: async () => 1_000,
    ...over,
  };
}

describe("combineStates", () => {
  test("ok only when every state is ok and there is one; not-yet beats unknown", () => {
    expect(combineStates(["ok", "ok"])).toBe("ok");
    expect(combineStates([])).toBe("unknown");
    expect(combineStates(["ok", "unknown"])).toBe("unknown");
    expect(combineStates(["unknown", "not-yet", "ok"])).toBe("not-yet");
  });
});

describe("bounded", () => {
  test("a probe still running at its bound answers unknown; one that throws answers unknown", async () => {
    expect(await bounded(new Promise(() => {}), 20)).toEqual({ state: "unknown", why: "timed out" });
    expect((await bounded(Promise.reject(new Error("boom /secret/path")), 1_000)).state).toBe("unknown");
    expect((await bounded(Promise.reject(new Error("boom /secret/path")), 1_000)).why).not.toContain("secret");
  });
});

describe("env", () => {
  test("set in .env and in the process: ok", async () => {
    expect(await probeEnv("SET_KEY", deps())).toEqual({ state: "ok", why: "SET_KEY is set in .env and in the running process" });
  });
  test("set in .env, not in the process: not-yet, restart", async () => {
    const r = await probeEnv("SET_KEY", deps({ processHasEnv: () => false }));
    expect(r).toEqual({ state: "not-yet", why: "SET_KEY is set in .env, not in the running process: restart" });
  });
  test("in the process only, blank in .env, or absent: not-yet", async () => {
    expect((await probeEnv("OTHER_KEY", deps())).state).toBe("not-yet");
    expect(await probeEnv("BLANK_KEY", deps())).toEqual({ state: "not-yet", why: "BLANK_KEY is in .env with an empty value" });
  });
  test("no .env file: not-yet; an unreadable one: unknown", async () => {
    expect((await probeEnv("SET_KEY", deps({ readEnvFile: async () => ({ missing: true }) }))).state).toBe("not-yet");
    expect(await probeEnv("SET_KEY", deps({ readEnvFile: async () => ({ failed: true }) }))).toEqual({ state: "unknown", why: ".env could not be read" });
  });
  test("no answer carries a value", async () => {
    for (const over of [{}, { processHasEnv: () => false }]) for (const k of ["SET_KEY", "BLANK_KEY", "NOPE"]) expect(JSON.stringify(await probeEnv(k, deps(over)))).not.toContain("s3cr3t");
  });
});

describe("migration", () => {
  test("applied: ok; not applied: not-yet; the read fails: unknown", async () => {
    expect((await probeMigration("086", deps())).state).toBe("ok");
    expect((await probeMigration("087", deps())).state).toBe("not-yet");
    const r = await probeMigration("086", deps({ hasMigration: async () => Promise.reject(new Error("password=hunter2")) }));
    expect(r).toEqual({ state: "unknown", why: "this machine's database could not be read" });
  });
});

describe("checkout", () => {
  test("HEAD contains origin's tip (equal or ahead): ok, read with ls-remote and never a fetch", async () => {
    const calls: string[][] = [];
    expect(await probeCheckout("muninn", deps({}, {}, calls))).toEqual({ state: "ok", why: `muninn contains origin's main tip ${TIP.slice(0, 7)}` });
    expect(calls.some((c) => c[0] === "ls-remote")).toBe(true);
    expect(calls.some((c) => ["fetch", "pull", "checkout", "reset"].includes(c[0]!))).toBe(false);
  });
  test("HEAD behind origin's tip: not-yet", async () => {
    expect((await probeCheckout("muninn", deps({}, { ancestor: EXIT(1) }))).state).toBe("not-yet");
  });
  test("the tip is not in the checkout at all: not-yet", async () => {
    expect((await probeCheckout("muninn", deps({}, { catFile: EXIT(128) }))).why).toBe(`origin's main tip ${TIP.slice(0, 7)} is not in muninn: pull`);
    expect((await probeCheckout("muninn", deps({}, { catFile: EXIT(1) }))).state).toBe("not-yet");
  });
  test("ls-remote fails, times out, or names no single tip: unknown", async () => {
    expect((await probeCheckout("muninn", deps({}, { lsRemote: EXIT(128) }))).state).toBe("unknown");
    expect(await probeCheckout("muninn", deps({}, { lsRemote: TIMED_OUT }))).toEqual({ state: "unknown", why: "git ls-remote timed out: origin's main is unknown" });
    expect((await probeCheckout("muninn", deps({}, { lsRemote: OK("") }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { lsRemote: OK(`${TIP}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/main\n`) }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { lsRemote: OK("zzz\trefs/heads/main\n") }))).state).toBe("unknown");
  });
  test("a merge-base or cat-file that fails otherwise: unknown", async () => {
    expect((await probeCheckout("muninn", deps({}, { ancestor: EXIT(128) }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { catFile: TIMED_OUT }))).state).toBe("unknown");
  });
  test("no roots, a repo not found, no origin default branch: unknown", async () => {
    expect(await probeCheckout("muninn", deps({ roots: null }))).toEqual({ state: "unknown", why: "DECISION_TRIAGE_REPO_ROOTS is not set, so muninn cannot be found" });
    expect((await probeCheckout("huginn", deps())).state).toBe("unknown");
    // mimir resolves to a folder whose origin names muninn.
    expect((await probeCheckout("mimir", deps())).why).toBe("mimir not found under the repo roots: origin names another repo");
    expect((await probeCheckout("muninn", deps({}, { originHead: null }))).state).toBe("unknown");
  });
});

describe("pushed", () => {
  const REFS = ["main\trefs/remotes/origin/main\t", "feat-a\trefs/remotes/origin/feat-a\t[ahead 2]", "feat-b\trefs/remotes/origin/feat-b\t[ahead 1, behind 3]", "old\trefs/remotes/origin/old\t[behind 4]", "local-only\t\t"].join("\n");
  test("branches ahead of their upstream: not-yet, naming them", async () => {
    expect(await probePushed("muninn", deps({}, { refs: REFS }))).toEqual({ state: "not-yet", why: "2 branches feat-a, feat-b have commits not pushed in muninn" });
    expect((await probePushed("muninn", deps({}, { refs: "main\trefs/remotes/origin/main\t[ahead 1]" }))).why).toBe("branch main has commits not pushed in muninn");
  });
  test("behind, or no upstream on another branch, is pushed: ok", async () => {
    expect((await probePushed("muninn", deps({}, { refs: "main\trefs/remotes/origin/main\t[behind 1]\nlocal-only\t\t" }))).state).toBe("ok");
  });
  test("the current branch without an upstream, a detached HEAD, a gone upstream: unknown", async () => {
    expect((await probePushed("muninn", deps({}, { refs: "main\t\t" }))).why).toBe("muninn's current branch main has no upstream");
    expect((await probePushed("muninn", deps({}, { head: EXIT(1) }))).why).toBe("muninn has a detached HEAD");
    expect((await probePushed("muninn", deps({}, { refs: "main\trefs/remotes/origin/main\t\nx\trefs/remotes/origin/x\t[gone]" }))).state).toBe("unknown");
    expect((await probePushed("muninn", deps({ roots: null }))).state).toBe("unknown");
  });
});

describe("restart", () => {
  // Reflog second 1000 ⇒ the move is proven over only from 1_001_000 ms on.
  test("this port, current code, started after the code last changed: ok", async () => {
    expect((await probeRestart("3010", deps({ processStartMs: 1_001_000 }))).state).toBe("ok");
  });
  test("another port: unknown, naming this muninn's", async () => {
    expect(await probeRestart("3011", deps())).toEqual({ state: "unknown", why: "this muninn serves port 3010, not 3011" });
  });
  test("started inside the second HEAD moved, or before: not-yet", async () => {
    expect((await probeRestart("3010", deps({ processStartMs: 1_000_500 }, { reflog: { "refs/heads/main": 500 } }))).state).toBe("not-yet");
    expect((await probeRestart("3010", deps({ processStartMs: 900_000 }))).why).toContain(": restart");
  });
  test("the branch moved after HEAD's reflog: its time counts", async () => {
    expect((await probeRestart("3010", deps({ processStartMs: 1_500_000 }, { reflog: { HEAD: 1_000, "refs/heads/main": 2_000 } }))).state).toBe("not-yet");
  });
  test("code on disk not current: not-yet, even when started after HEAD moved", async () => {
    expect((await probeRestart("3010", deps({}, { ancestor: EXIT(1) }))).why).toContain("does not contain origin's main tip");
  });
  test("origin unreachable: unknown", async () => {
    expect((await probeRestart("3010", deps({}, { lsRemote: TIMED_OUT }))).state).toBe("unknown");
  });
  test("no reflog: unknown", async () => {
    expect((await probeRestart("3010", deps({}, { reflog: { HEAD: null } }))).state).toBe("unknown");
    expect((await probeRestart("3010", deps({}, { reflog: { "refs/heads/main": null } }))).state).toBe("unknown");
  });
  test("a tracked file edited after the start: not-yet; one deleted: unknown", async () => {
    expect((await probeRestart("3010", deps({ mtimeMs: async () => 6_000_000 }, { status: " M src/x.ts\0" }))).state).toBe("not-yet");
    expect((await probeRestart("3010", deps({ mtimeMs: async () => 4_000_000 }, { status: " M src/x.ts\0" }))).state).toBe("ok");
    expect((await probeRestart("3010", deps({ mtimeMs: async () => null }, { status: " D src/x.ts\0" }))).state).toBe("unknown");
  });
});

describe("the --watch rule", () => {
  test("the real start time is performance.timeOrigin, which a watch reload re-executes and moves", async () => {
    const { realProbeDeps } = await import("./real-deps.ts");
    expect(realProbeDeps({ decisionTriageRepoRoots: null, dashboardPort: 3010 } as never).processStartMs).toBe(performance.timeOrigin);
  });
});
