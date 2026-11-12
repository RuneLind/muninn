/**
 * `pushed=`'s truth table over a fake git: every `unknown` and `not-yet` path,
 * what each call carries (switches, stdin), and the `why` sentences. The same
 * rows against real git on throwaway repos are in `pushed-git*.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { GitResult, GitRun } from "../decision-triage/git.ts";
import { CHECKOUT_GIT_ENV, parseRemoteHeads, parseWorktreeHeads, probePushed, type ProbeDeps } from "./probes.ts";

const DIR = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-fake-")));
const OK = (stdout = ""): GitResult => ({ ok: true, stdout, exitCode: 0 });
const EXIT = (code: number): GitResult => ({ ok: false, stdout: "", exitCode: code });
const TIMED_OUT: GitResult = { ok: false, stdout: "", timedOut: true };

const LOCAL = "1".repeat(40);
const R1 = "2".repeat(40);
const R2 = "3".repeat(40);
const WT = "4".repeat(40);
const ZERO = "0".repeat(40);
const URL = "git@github.com:x/skills.git";
const INDEX = `H 100644 ${"5".repeat(40)} 0\tf\0H 100755 ${"6".repeat(40)} 0\tbin/run\0`;
const WORKTREES = `worktree /w\0HEAD ${LOCAL}\0branch refs/heads/main\0\0`;
// One path per --git-path argument, none of which exists under DIR.
const gitPaths = (args: readonly string[]) => OK(args.filter((a, i) => args[i - 1] === "--git-path").map((f) => `.git/${f}\n`).join(""));

interface World {
  promisor?: GitResult;
  shallow?: GitResult;
  origin?: GitResult;
  gitPath?: (args: readonly string[]) => GitResult;
  index?: GitResult;
  status?: GitResult;
  head?: GitResult;
  branch?: GitResult;
  worktrees?: GitResult;
  heads?: GitResult;
  batch?: (stdin: string) => GitResult;
  count?: GitResult;
  source?: GitResult;
}
interface Call {
  args: string[];
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}

/** One repo `skills` at {@link DIR}; records argv, env and stdin of every call. */
function pushedGit(w: World, log: Call[] = []): GitRun {
  return async (_cwd, args, opts) => {
    log.push({ args: [...args], env: opts?.env, stdin: opts?.stdin });
    const a = args.join(" ").replace(/^-c core\.fsmonitor=false /, "");
    if (a === "rev-parse --show-toplevel") return OK(`${DIR}\n`);
    if (a === "remote get-url origin") return OK(`${URL}\n`);
    if (a.startsWith("config --get-regexp") && a.includes("promisor")) return w.promisor ?? EXIT(1);
    if (a.startsWith("config --get-regexp") && a.includes("pushurl")) return w.origin ?? OK(`remote.origin.url ${URL}\n`);
    if (a === "rev-parse --is-shallow-repository") return w.shallow ?? OK("false\n");
    if (a.startsWith("rev-parse --git-path")) return (w.gitPath ?? gitPaths)(args);
    if (a === "ls-files -v -s -z") return w.index ?? OK(INDEX);
    if (a.startsWith("status --porcelain")) return w.status ?? OK("");
    if (a === "rev-parse --verify --quiet HEAD^{commit}") return w.head ?? OK(`${LOCAL}\n`);
    if (a.startsWith("for-each-ref")) return w.branch ?? OK("refs/heads/main\n");
    if (a === "worktree list --porcelain -z") return w.worktrees ?? OK(WORKTREES);
    if (a === "ls-remote --heads origin") return w.heads ?? OK(`${R1}\trefs/heads/main\n${R2}\trefs/heads/wip\n`);
    if (a === "cat-file --batch-check") return w.batch ? w.batch(opts?.stdin ?? "") : OK((opts?.stdin ?? "").split("\n").filter(Boolean).map((t) => `${t} commit 200`).join("\n") + "\n");
    if (a.startsWith("rev-list --count")) return w.count ?? OK("0\n");
    if (a.startsWith("log ")) return w.source ?? OK("wip-x\n");
    return EXIT(128);
  };
}
const deps = (git: GitRun): ProbeDeps => ({
  git,
  roots: { dirs: [], named: new Map([["skills", DIR]]) },
  readEnvFile: async () => ({ missing: true }),
  processHasEnv: () => false,
  appliedMigrations: async () => new Set(),
});
const run = (w: World = {}, log?: Call[]) => probePushed("skills", deps(pushedGit(w, log)));

describe("pushed: the truth table over a fake git", () => {
  test("nothing missing from the live remote and a clean tree: ok", async () => {
    expect(await run()).toEqual({ state: "ok", why: "every commit on skills's branches and worktree HEADs is on an origin branch, and nothing tracked is uncommitted" });
  });

  test("every call carries the lookup switches; tips and worktree HEADs go on stdin; refs/remotes is never read", async () => {
    const log: Call[] = [];
    await run({ worktrees: OK(`${WORKTREES}worktree /w2\0HEAD ${WT}\0detached\0\0`) }, log);
    expect(log.every((c) => c.env === CHECKOUT_GIT_ENV)).toBe(true);
    expect(log.some((c) => c.args.join(" ").includes("refs/remotes"))).toBe(false);
    const revList = log.find((c) => c.args[0] === "rev-list")!;
    expect(revList.args).toEqual(["rev-list", "--count", "--branches", "HEAD", "--stdin"]);
    expect(revList.stdin).toBe(`${LOCAL}\n${WT}\n^${R1}\n^${R2}\n`);
    expect(log.find((c) => c.args[0] === "cat-file")!.stdin).toBe(`${R1}\n${R2}\n`);
  });

  test("status and ls-files run with fsmonitor off", async () => {
    const log: Call[] = [];
    await run({}, log);
    for (const cmd of ["status", "ls-files"]) expect(log.find((c) => c.args.includes(cmd))!.args.slice(0, 3)).toEqual(["-c", "core.fsmonitor=false", cmd]);
  });

  test("commits missing and every remote tip here: not-yet, a count and a start that reaches one of them", async () => {
    expect(await run({ count: OK("3\n") })).toEqual({ state: "not-yet", why: "3 commits in skills are on no origin branch (one of them on wip-x): push" });
    expect(await run({ count: OK("1\n"), source: OK("HEAD\n") })).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch (on HEAD): push" });
    expect(await run({ count: OK("2\n"), source: OK(`${WT}\n`), worktrees: OK(`${WORKTREES}worktree /w2\0HEAD ${WT}\0detached\0\0`) })).toEqual({
      state: "not-yet",
      why: "2 commits in skills are on no origin branch (one of them on a worktree's HEAD 4444444): push",
    });
    // A source git cannot name still says how many.
    expect(await run({ count: OK("2\n"), source: EXIT(128) })).toEqual({ state: "not-yet", why: "2 commits in skills are on no origin branch: push" });
  });

  test("commits missing while a remote tip is absent here: unknown, they may sit under that tip; only present tips are walked", async () => {
    const log: Call[] = [];
    const r = await run({ count: OK("2\n"), batch: () => OK(`${R1} commit 200\n${R2} missing\n`) }, log);
    expect(r).toEqual({ state: "unknown", why: "origin has 1 branch tip skills does not have: fetch first" });
    expect(log.find((c) => c.args[0] === "rev-list")!.stdin).toBe(`${LOCAL}\n^${R1}\n`);
  });

  test("nothing missing while a remote tip is absent here: ok, every local commit is under a tip origin has", async () => {
    expect((await run({ batch: () => OK(`${R1} commit 200\n${R2} missing\n`) })).state).toBe("ok");
  });

  test("an empty remote with a local commit: not-yet", async () => {
    expect((await run({ heads: OK(""), count: OK("4\n"), source: OK("main\n") })).state).toBe("not-yet");
  });

  test("tracked changes, staged or not: not-yet before anything remote is asked", async () => {
    const log: Call[] = [];
    expect(await run({ status: OK(" M f\0") }, log)).toEqual({ state: "not-yet", why: "skills has uncommitted changes: commit and push" });
    expect(log.some((c) => c.args[0] === "ls-remote")).toBe(false);
    expect(log.find((c) => c.args.includes("status"))!.args).toContain("--untracked-files=no");
    expect((await run({ status: { ok: true, stdout: "M  f\0", capped: true } })).state).toBe("not-yet");
  });

  test("findings 1, 4: an assume-unchanged, skip-worktree or submodule entry is unknown, with a true why", async () => {
    expect(await run({ index: OK(`h 100644 ${"5".repeat(40)} 0\tf\0`) })).toEqual({ state: "unknown", why: "1 tracked file is marked assume-unchanged or skip-worktree in skills, so git does not show their changes" });
    expect(await run({ index: OK(`S 100644 ${"5".repeat(40)} 0\tf\0s 100644 ${"6".repeat(40)} 0\tg\0`) })).toEqual({ state: "unknown", why: "2 tracked files are marked assume-unchanged or skip-worktree in skills, so git does not show their changes" });
    expect(await run({ index: OK(`${INDEX}H 160000 ${"7".repeat(40)} 0\tsub\0`) })).toEqual({ state: "unknown", why: "skills has submodules: muninn does not check their commits" });
    // An unmerged entry (`M`) is not hidden: status shows it.
    expect((await run({ index: OK(`M 100644 ${"5".repeat(40)} 1\tf\0`), status: OK("UU f\0") })).state).toBe("not-yet");
  });

  test("finding 5: each operation's file in the git dir git names: unknown, naming the operation", async () => {
    const expected: [string, string][] = [
      ["MERGE_HEAD", "merge"],
      ["REBASE_HEAD", "rebase"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase or am"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["sequencer", "cherry-pick or revert"],
      ["BISECT_LOG", "bisect"],
      ["BISECT_START", "bisect"],
    ];
    for (const [file, op] of expected) {
      // That one file resolves to an existing path (DIR itself); the rest do not exist.
      const gitPath = (args: readonly string[]) => OK(args.filter((a, i) => args[i - 1] === "--git-path").map((f) => (f === file ? `${DIR}\n` : `.git/${f}\n`)).join(""));
      expect(await run({ gitPath })).toEqual({ state: "unknown", why: `skills has a ${op} in progress` });
    }
  });

  test("a git-dir path lstat cannot answer (not ENOENT): unknown", async () => {
    writeFileSync(path.join(DIR, "plain-file"), "x");
    const gitPath = (args: readonly string[]) => OK(args.filter((a, i) => args[i - 1] === "--git-path").map((f) => `plain-file/${f}\n`).join(""));
    expect(await run({ gitPath })).toEqual({ state: "unknown", why: "muninn could not tell whether skills has an operation in progress" });
  });

  test("finding 6: origin's pushurl, a second url or a pushInsteadOf on its url: unknown", async () => {
    const split = "skills's origin pushes to another URL than the one muninn reads";
    expect(await run({ origin: OK(`remote.origin.url ${URL}\nremote.origin.pushurl git@elsewhere:x/skills.git\n`) })).toEqual({ state: "unknown", why: split });
    expect(await run({ origin: OK(`remote.origin.url ${URL}\nremote.origin.url git@b:x/skills.git\n`) })).toEqual({ state: "unknown", why: "skills's origin has 2 URLs" });
    expect(await run({ origin: OK(`remote.origin.url ${URL}\nurl.git@elsewhere:.pushinsteadof git@github.com:\n`) })).toEqual({ state: "unknown", why: split });
    // A pushInsteadOf that does not match origin's url changes nothing.
    expect((await run({ origin: OK(`remote.origin.url ${URL}\nurl.x.pushinsteadof https://gitlab.com/\n`) })).state).toBe("ok");
    expect(await run({ origin: EXIT(1) })).toEqual({ state: "unknown", why: "skills has no origin" });
  });

  const unknownRows: [string, World][] = [
    ["a partial clone", { promisor: OK("remote.origin.promisor true\n") }],
    ["config failing", { promisor: TIMED_OUT }],
    ["a shallow clone", { shallow: OK("true\n") }],
    ["shallow unreadable", { shallow: OK("maybe\n") }],
    ["origin config failing", { origin: EXIT(128) }],
    ["git-path failing", { gitPath: () => EXIT(128) }],
    ["git-path answering short", { gitPath: () => OK(".git/MERGE_HEAD\n") }],
    ["ls-files failing", { index: EXIT(128) }],
    ["ls-files capped", { index: { ok: true, stdout: INDEX, capped: true } }],
    ["ls-files garbled", { index: OK("what\0") }],
    ["status failing", { status: EXIT(128) }],
    ["status timing out", { status: TIMED_OUT }],
    ["an unborn HEAD", { head: EXIT(1) }],
    ["no local branch", { branch: OK("") }],
    ["for-each-ref failing", { branch: EXIT(128) }],
    ["worktree list failing", { worktrees: EXIT(128) }],
    ["worktree list garbled", { worktrees: OK(`HEAD ${LOCAL}\0\0`) }],
    ["worktree list with a short sha", { worktrees: OK("worktree /w\0HEAD abc\0\0") }],
    ["worktree list empty", { worktrees: OK("") }],
    ["ls-remote failing", { heads: EXIT(128) }],
    ["ls-remote timing out", { heads: TIMED_OUT }],
    ["ls-remote capped", { heads: { ok: true, stdout: `${R1}\trefs/heads/main`, capped: true } }],
    ["a garbled ls-remote line", { heads: OK(`${R1}\trefs/heads/main\nnot a line\n`) }],
    ["a short sha in ls-remote", { heads: OK("abc\trefs/heads/main\n") }],
    ["a tag in the heads list", { heads: OK(`${R1}\trefs/tags/v1\n`) }],
    ["cat-file failing", { batch: () => EXIT(128) }],
    ["cat-file answering short", { batch: () => OK(`${R1} commit 1\n`) }],
    ["a remote tip that is not a commit", { batch: () => OK(`${R1} tree 10\n${R2} commit 1\n`) }],
    ["rev-list failing", { count: EXIT(128) }],
    ["rev-list garbled", { count: OK("lots\n") }],
  ];
  for (const [what, w] of unknownRows) {
    test(`${what}: unknown`, async () => {
      expect((await run(w)).state).toBe("unknown");
    });
  }

  test("a partial clone is refused before any object lookup", async () => {
    const log: Call[] = [];
    await run({ promisor: OK("remote.origin.promisor true\n") }, log);
    expect(log.map((c) => c.args[0])).toEqual(["rev-parse", "remote", "config"]);
  });

  test("parseRemoteHeads: distinct tips; any other line is null", () => {
    expect(parseRemoteHeads(`${R1}\trefs/heads/a\n${R1}\trefs/heads/b\n`)).toEqual([R1]);
    expect(parseRemoteHeads("")).toEqual([]);
    expect(parseRemoteHeads(`${R1}\tHEAD\n`)).toBeNull();
    expect(parseRemoteHeads(`${R1} refs/heads/a\n`)).toBeNull();
  });

  test("parseWorktreeHeads: every HEAD, unborn and bare skipped, any broken record null", () => {
    expect(parseWorktreeHeads(`worktree /a\0HEAD ${LOCAL}\0branch refs/heads/main\0\0worktree /b\0HEAD ${WT}\0detached\0locked\0\0worktree /c\0HEAD ${ZERO}\0branch refs/heads/u\0\0`)).toEqual([LOCAL, WT]);
    expect(parseWorktreeHeads(`worktree /bare\0bare\0\0worktree /a\0HEAD ${LOCAL}\0detached\0\0`)).toEqual([LOCAL]);
    expect(parseWorktreeHeads(`worktree /a\0\0`)).toBeNull();
    expect(parseWorktreeHeads(`worktree /a\0HEAD ${LOCAL}\0HEAD ${WT}\0\0`)).toBeNull();
    expect(parseWorktreeHeads(`worktree /a\0bare\0HEAD ${LOCAL}\0\0`)).toBeNull();
  });
});
