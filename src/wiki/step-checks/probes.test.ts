/**
 * The probes' truth tables against an in-memory machine: a fake git runner,
 * an in-memory `.env`, a fake migrations table (and one real-git row on
 * throwaway repos). Each row pins the one
 * state a fact may give, and every `unknown`/`not-yet` path; `ok` only where
 * the fact is proven.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realGit, type GitResult, type GitRun } from "../decision-triage/git.ts";
import { bounded, combineStates, probeCheckout, probeEnv, probeMigration, runProbe, type ProbeDeps } from "./probes.ts";

const DIR = realpathSync(testTempDirSync(path.join(tmpdir(), "step-probes-")));

const TIP = "a".repeat(40);
const OK = (stdout = ""): GitResult => ({ ok: true, stdout, exitCode: 0 });
const EXIT = (code: number): GitResult => ({ ok: false, stdout: "", exitCode: code });
const TIMED_OUT: GitResult = { ok: false, stdout: "", timedOut: true };

interface World {
  promisor?: GitResult;
  symref?: GitResult;
  catFile?: GitResult;
  ancestor?: GitResult;
}

/**
 * A git that answers as one repo at {@link DIR} named `muninn`; `calls` records every argv.
 * Its LOCAL `origin/HEAD` names `master` on purpose: the checkout probe must never read it.
 */
function fakeGit(w: World = {}, calls: string[][] = [], envs: (Readonly<Record<string, string>> | undefined)[] = []): GitRun {
  return async (_cwd, args, opts) => {
    calls.push([...args]);
    envs.push(opts?.env);
    const a = args.join(" ");
    if (a.startsWith("config --get-regexp")) return w.promisor ?? EXIT(1);
    if (a === "rev-parse --show-toplevel") return OK(`${DIR}\n`);
    if (a === "remote get-url origin") return OK("https://github.com/x/muninn.git\n");
    if (a.startsWith("symbolic-ref --quiet --short refs/remotes/origin/HEAD")) return OK("origin/master\n");
    if (a.startsWith("rev-parse --verify --quiet refs/remotes/origin/")) return OK("b".repeat(40));
    if (a === "ls-remote --symref origin HEAD") return w.symref ?? OK(`ref: refs/heads/main\tHEAD\n${TIP}\tHEAD\n`);
    if (a.startsWith("ls-remote origin refs/heads/")) return OK(`${"b".repeat(40)}\t${args[2]}\n`);
    if (a.startsWith("cat-file -e")) return w.catFile ?? OK();
    if (a.startsWith("merge-base --is-ancestor")) return w.ancestor ?? OK();
    return EXIT(128);
  };
}

function deps(over: Partial<ProbeDeps> = {}, w?: World, calls?: string[][], envs?: (Readonly<Record<string, string>> | undefined)[]): ProbeDeps {
  return {
    git: fakeGit(w, calls, envs),
    roots: { dirs: [], named: new Map([["muninn", DIR], ["mimir", DIR]]) },
    readEnvFile: async () => ({ bytes: new TextEncoder().encode("SET_KEY=s3cr3t-value\nBLANK_KEY=\n") }),
    processHasEnv: () => true,
    appliedMigrations: async () => new Set(["086"]),
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
  test("a key on a line the reader cannot read the way Bun does: unknown, even when the process has it", async () => {
    const UNREAD = { state: "unknown" as const, why: ".env line 1 is not a form muninn can read the way Bun does" };
    // `$UNSET` loads empty under Bun; `KEY: v` is Bun syntax the reader does not follow.
    for (const text of ["K=$UNSET\n", "K=${UNSET}\n", 'K="a$b"\n', "K: v\n", 'K="a\\"b"\n'])
      expect([text, await probeEnv("K", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode(text) }) }))]).toEqual([text, UNREAD]);
  });
  test("an unclosed quote, or a backslash in a quoted value, makes every key unknown: a clean line after it may be no key", async () => {
    const UNREAD = { state: "unknown" as const, why: ".env line 1 is not a form muninn can read the way Bun does" };
    // Bun reads `\"` as an escaped quote, so INESC is inside ESC's value.
    expect(await probeEnv("INESC", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode('ESC="a\\"\nINESC=fake\ntail"\n') }) }))).toEqual(UNREAD);
    // Bun sets AFTER and reads UNCLOSED raw; the reader cannot follow either.
    expect(await probeEnv("AFTER", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode('UNCLOSED="abc\nAFTER=after\n') }) }))).toEqual(UNREAD);
    // A key BEFORE the open quote is unknown too: a later line could assign it again.
    expect(await probeEnv("EARLY", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode('EARLY=1\nUNCLOSED="abc\n') }) }))).toEqual({ ...UNREAD, why: ".env line 2 is not a form muninn can read the way Bun does" });
  });
  test("a colon line before the key: unknown, never ok, though the shell exported the key (Bun reads the next line as the colon key's value)", async () => {
    const r = await probeEnv("WIKI_FLAG", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode("OTHER_SETTING:\nWIKI_FLAG=1\n") }), processHasEnv: () => true }));
    expect(r).toEqual({ state: "unknown", why: ".env line 1 is not a form muninn can read the way Bun does" });
    // Bun keeps AA=x (the `AA=` line is BB's value): not «empty value».
    expect((await probeEnv("AA", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode("AA=x\nBB:\nAA=\n") }) }))).state).toBe("unknown");
    // Bun sets E: not «not in .env».
    expect((await probeEnv("E", deps({ readEnvFile: async () => ({ bytes: new TextEncoder().encode("F:'\nE=x'\n") }) }))).state).toBe("unknown");
  });
  test("no answer carries a value", async () => {
    for (const over of [{}, { processHasEnv: () => false }]) for (const k of ["SET_KEY", "BLANK_KEY", "NOPE"]) expect(JSON.stringify(await probeEnv(k, deps(over)))).not.toContain("s3cr3t");
  });
});

describe("migration", () => {
  test("applied: ok; not applied: not-yet; the read fails: unknown", async () => {
    expect((await probeMigration("086", deps())).state).toBe("ok");
    expect((await probeMigration("087", deps())).state).toBe("not-yet");
    const r = await probeMigration("086", deps({ appliedMigrations: async () => Promise.reject(new Error("password=hunter2")) }));
    expect(r).toEqual({ state: "unknown", why: "this machine's database could not be read" });
  });
});

describe("checkout", () => {
  const SHORT = TIP.slice(0, 7);
  const SYMREF = (lines: string[]) => ({ symref: OK(lines.join("\n") + "\n") });
  test("HEAD equal to or ahead of origin's live tip: ok, read with one ls-remote --symref and never a fetch", async () => {
    const calls: string[][] = [];
    expect(await probeCheckout("muninn", deps({}, {}, calls))).toEqual({ state: "ok", why: `muninn contains origin's main tip ${SHORT}` });
    expect(calls.filter((c) => c[0] === "ls-remote")).toEqual([["ls-remote", "--symref", "origin", "HEAD"]]);
    expect(calls.some((c) => ["fetch", "pull", "checkout", "reset"].includes(c[0]!))).toBe(false);
    // HEAD ahead of the tip answers the same: merge-base --is-ancestor exits 0.
    expect((await probeCheckout("muninn", deps({}, { ancestor: OK() }))).state).toBe("ok");
  });
  test("the default branch comes from the live symref, never the local origin/HEAD or a guessed main/master", async () => {
    const calls: string[][] = [];
    const r = await probeCheckout("muninn", deps({}, SYMREF(["ref: refs/heads/trunk\tHEAD", `${TIP}\tHEAD`]), calls));
    expect(r).toEqual({ state: "ok", why: `muninn contains origin's trunk tip ${SHORT}` });
    expect(calls.some((c) => c.join(" ").includes("refs/remotes/origin/"))).toBe(false);
    expect(calls.find((c) => c[0] === "merge-base")).toEqual(["merge-base", "--is-ancestor", TIP, "HEAD"]);
  });
  test("HEAD behind origin's tip: not-yet", async () => {
    expect(await probeCheckout("muninn", deps({}, { ancestor: EXIT(1) }))).toEqual({ state: "not-yet", why: `muninn does not contain origin's main tip ${SHORT}: pull` });
  });
  test("the tip is cleanly missing here (cat-file -e exit 1, no stderr): not-yet", async () => {
    expect(await probeCheckout("muninn", deps({}, { catFile: EXIT(1) }))).toEqual({ state: "not-yet", why: `origin's main tip ${SHORT} is not in muninn: pull` });
  });
  test("cat-file failing any other way (fatal 128, stderr, timeout): unknown", async () => {
    expect((await probeCheckout("muninn", deps({}, { catFile: { ok: false, stdout: "", stderr: "fatal: not a git repository", exitCode: 128 } }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { catFile: EXIT(128) }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { catFile: { ok: false, stdout: "", stderr: "error: something", exitCode: 1 } }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { catFile: TIMED_OUT }))).state).toBe("unknown");
  });
  test("ls-remote fails or times out: unknown", async () => {
    expect((await probeCheckout("muninn", deps({}, { symref: EXIT(128) }))).state).toBe("unknown");
    expect(await probeCheckout("muninn", deps({}, { symref: TIMED_OUT }))).toEqual({ state: "unknown", why: "git ls-remote timed out: origin's default branch is unknown" });
  });
  test("a symref answer that is not exactly one branch line and one sha line: unknown", async () => {
    const rows: string[][] = [
      [`${TIP}\tHEAD`], // symref line missing (a remote with a detached HEAD, or no --symref support)
      ["ref: refs/heads/main\tHEAD", "ref: refs/heads/dev\tHEAD", `${TIP}\tHEAD`], // two symref lines
      ["ref: refs/heads/main\tHEAD"], // sha line missing
      ["ref: refs/heads/main\tHEAD", `${TIP}\tHEAD`, `${"c".repeat(40)}\tHEAD`], // two sha lines
      ["ref: refs/heads/main\tHEAD", "zzz\tHEAD"], // garbled sha
      ["ref: refs/heads/main\tHEAD", `${TIP.slice(1)}\tHEAD`], // short sha
      ["ref: refs/tags/v1\tHEAD", `${TIP}\tHEAD`], // HEAD is no branch
      ["ref: refs/heads/main HEAD", `${TIP}\tHEAD`], // no tab
      ["ref: refs/heads/main\tHEAD", `${TIP}\tHEAD`, "something else"], // a line of no known shape
      [],
    ];
    for (const lines of rows) expect([lines, (await probeCheckout("muninn", deps({}, SYMREF(lines)))).state]).toEqual([lines, "unknown"]);
  });
  test("a merge-base that fails otherwise: unknown", async () => {
    expect((await probeCheckout("muninn", deps({}, { ancestor: EXIT(128) }))).state).toBe("unknown");
  });
  test("every git call the probe makes, repo lookup included, runs with replace objects, grafts and lazy fetch off", async () => {
    const calls: string[][] = [];
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    expect((await probeCheckout("muninn", deps({}, {}, calls, envs))).state).toBe("ok");
    const OFF = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_NO_LAZY_FETCH: "1" };
    expect(calls.map((c, i) => [c[0], envs[i]])).toEqual(calls.map((c) => [c[0], OFF]));
    // findRepo's two reads, the config read, ls-remote, cat-file, merge-base.
    expect(calls.map((c) => c[0])).toEqual(["rev-parse", "remote", "config", "ls-remote", "cat-file", "merge-base"]);
  });
  test("a partial clone (a promisor remote or extensions.partialclone): unknown before any object lookup", async () => {
    const calls: string[][] = [];
    const r = await probeCheckout("muninn", deps({}, { promisor: OK("remote.origin.promisor true\n") }, calls));
    expect(r).toEqual({ state: "unknown", why: "muninn is a partial clone: muninn does not look up objects it would have to fetch" });
    expect(calls.some((c) => ["cat-file", "merge-base", "ls-remote"].includes(c[0]!))).toBe(false);
    expect(calls.find((c) => c[0] === "config")).toEqual(["config", "--get-regexp", "^(remote\\..*\\.promisor|extensions\\.partialclone)$"]);
    // The config read failing any way but «no match» (exit 1) proves nothing.
    expect((await probeCheckout("muninn", deps({}, { promisor: EXIT(128) }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { promisor: TIMED_OUT }))).state).toBe("unknown");
    expect((await probeCheckout("muninn", deps({}, { promisor: { ok: false, stdout: "", stderr: "error: x", exitCode: 1 } }))).state).toBe("unknown");
  });
  test("no roots, a repo not found: unknown", async () => {
    expect(await probeCheckout("muninn", deps({ roots: null }))).toEqual({ state: "unknown", why: "DECISION_TRIAGE_REPO_ROOTS is not set, so muninn cannot be found" });
    expect((await probeCheckout("huginn", deps())).state).toBe("unknown");
    // mimir resolves to a folder whose origin names muninn.
    expect((await probeCheckout("mimir", deps())).why).toBe("mimir not found under the repo roots: origin names another repo");
  });
});

describe("checkout, real git: a stale local origin/HEAD", () => {
  const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  test("origin moved its default from master to main after the clone; a fetch leaves origin/HEAD on master: not-yet, never ok", async () => {
    const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-probes-git-")));
    const remote = path.join(base, "muninn.git");
    const work = path.join(base, "work");
    const clone = path.join(base, "clone");
    sh(base, "init", "-q", "--bare", "-b", "master", remote);
    sh(base, "clone", "-q", remote, work);
    sh(work, "commit", "-q", "--allow-empty", "-m", "one");
    sh(work, "push", "-q", "origin", "HEAD:master");
    sh(base, "clone", "-q", remote, clone);
    sh(work, "commit", "-q", "--allow-empty", "-m", "two on main");
    sh(work, "push", "-q", "origin", "HEAD:main");
    sh(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    sh(clone, "fetch", "-q");
    // The precondition the false ok needed: the local origin/HEAD still names master.
    expect(sh(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/master");
    const mainTip = sh(work, "rev-parse", "HEAD");
    const r = await probeCheckout("muninn", deps({ git: realGit, roots: { dirs: [], named: new Map([["muninn", clone]]) } }));
    expect(r).toEqual({ state: "not-yet", why: `muninn does not contain origin's main tip ${mainTip.slice(0, 7)}: pull` });
  });
});

describe("checkout, real git: replace refs and a partial clone", () => {
  const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  /** A bare `muninn.git` with one commit on main, and a work clone that pushes. */
  function remoteWithOneCommit() {
    const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-probes-git-")));
    const remote = path.join(base, "muninn.git");
    const work = path.join(base, "work");
    sh(base, "init", "-q", "--bare", "-b", "main", remote);
    sh(remote, "config", "uploadpack.allowFilter", "true");
    sh(base, "clone", "-q", remote, work);
    writeFileSync(path.join(work, "f"), "one\n");
    sh(work, "add", "f");
    sh(work, "commit", "-q", "-m", "one");
    sh(work, "push", "-q", "origin", "HEAD:main");
    return { base, remote, work };
  }
  const realDeps = (clone: string) => deps({ git: realGit, roots: { dirs: [], named: new Map([["muninn", clone]]) } });

  test("HEAD an orphan commit that `git replace` swaps for a fake child of origin's tip: not-yet, never ok", async () => {
    const { base, remote } = remoteWithOneCommit();
    const clone = path.join(base, "clone");
    sh(base, "clone", "-q", remote, clone);
    const tip = sh(clone, "rev-parse", "HEAD");
    sh(clone, "checkout", "-q", "--orphan", "lonely");
    sh(clone, "commit", "-q", "-m", "orphan");
    const orphan = sh(clone, "rev-parse", "HEAD");
    const fake = sh(clone, "commit-tree", `${orphan}^{tree}`, "-p", tip, "-m", "fake child");
    sh(clone, "replace", orphan, fake);
    // The precondition: honouring replace refs, git itself says the tip is in HEAD.
    expect(() => sh(clone, "merge-base", "--is-ancestor", tip, "HEAD")).not.toThrow();
    expect(await probeCheckout("muninn", realDeps(clone))).toEqual({ state: "not-yet", why: `muninn does not contain origin's main tip ${tip.slice(0, 7)}: pull` });
  });

  test("an info/grafts parent the same way: not-yet, never ok", async () => {
    const { base, remote } = remoteWithOneCommit();
    const clone = path.join(base, "clone");
    sh(base, "clone", "-q", remote, clone);
    const tip = sh(clone, "rev-parse", "HEAD");
    sh(clone, "checkout", "-q", "--orphan", "lonely");
    sh(clone, "commit", "-q", "-m", "orphan");
    writeFileSync(path.join(clone, ".git", "info", "grafts"), `${sh(clone, "rev-parse", "HEAD")} ${tip}\n`);
    expect(() => sh(clone, "merge-base", "--is-ancestor", tip, "HEAD")).not.toThrow();
    expect((await probeCheckout("muninn", realDeps(clone))).state).toBe("not-yet");
  });

  test("a blob:none partial clone behind origin: unknown, and nothing is fetched into it", async () => {
    const { base, remote, work } = remoteWithOneCommit();
    const clone = path.join(base, "partial");
    sh(base, "clone", "-q", "--filter=blob:none", `file://${remote}`, clone);
    writeFileSync(path.join(work, "f"), "two\n");
    sh(work, "commit", "-q", "-am", "two");
    sh(work, "push", "-q", "origin", "HEAD:main");
    const packs = () => readdirSync(path.join(clone, ".git", "objects", "pack")).sort();
    const loose = () => readdirSync(path.join(clone, ".git", "objects")).sort();
    const before = { packs: packs(), loose: loose() };
    const r = await probeCheckout("muninn", realDeps(clone));
    expect({ packs: packs().length, loose: loose() }).toEqual({ packs: before.packs.length, loose: before.loose });
    expect(packs()).toEqual(before.packs);
    expect(r).toEqual({ state: "unknown", why: "muninn is a partial clone: muninn does not look up objects it would have to fetch" });
  });
});

describe("restart: muninn cannot prove it yet", () => {
  test("restart answers unknown and spawns nothing, reads nothing", async () => {
    const calls: string[][] = [];
    let reads = 0;
    const d = deps({ readEnvFile: async () => (reads++, { bytes: new Uint8Array() }), appliedMigrations: async () => (reads++, new Set<string>()), processHasEnv: () => (reads++, true) }, {}, calls);
    expect(await runProbe({ kind: "restart", value: "3010" }, d)).toEqual({ state: "unknown", why: "muninn cannot prove this yet" });
    expect(calls).toEqual([]);
    expect(reads).toBe(0);
  });
});
