/**
 * `pushed=`'s truth table over a fake git: every `unknown` and `not-yet` path,
 * what each call carries (switches, stdin), and the `why` sentences. The same
 * rows against real git on throwaway repos are in `pushed-git*.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { GitResult, GitRun } from "../decision-triage/git.ts";
import { CHECKOUT_GIT_ENV, PUSHED_MAX_WORKTREES, parseRemoteHeads, parseWorktreeHeads, parseWorktreeList, probePushed, type ProbeDeps, type ProbeResult } from "./probes.ts";

const DIR = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-fake-")));
// A second worktree's directory: the probe resolves every listed worktree on disk.
const DIR2 = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-fake2-")));
const DIR3 = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-fake3-")));
// The git dirs the fake's rev-parse names: DIR's own, and linked admin dirs whose `gitdir` files point back at DIR2 and DIR3.
const COMMON = path.join(DIR, ".git");
const ADMIN2 = path.join(COMMON, "worktrees", "w2");
const ADMIN3 = path.join(COMMON, "worktrees", "w3");
for (const [admin, wt] of [
  [ADMIN2, DIR2],
  [ADMIN3, DIR3],
]) {
  mkdirSync(admin!, { recursive: true });
  writeFileSync(path.join(admin!, "gitdir"), `${wt}/.git\n`);
}
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
const WORKTREES = `worktree ${DIR}\0HEAD ${LOCAL}\0branch refs/heads/main\0\0`;
// One path per --git-path argument, none of which exists under DIR.
const gitPaths = (args: readonly string[]) => OK(args.filter((a, i) => args[i - 1] === "--git-path").map((f) => `.git/${f}\n`).join(""));

interface World {
  promisor?: GitResult;
  shallow?: GitResult;
  /** The origin config read: a fixed answer, or {@link cfg}'s, shaped by the call's own args. */
  origin?: GitResult | ((args: readonly string[]) => GitResult);
  /** `ls-remote --get-url origin`. */
  getUrl?: GitResult;
  gitPath?: (args: readonly string[]) => GitResult;
  index?: GitResult;
  status?: GitResult;
  filters?: GitResult;
  staged?: GitResult;
  readTree?: GitResult;
  head?: GitResult;
  branch?: GitResult;
  worktrees?: GitResult;
  heads?: GitResult;
  batch?: (stdin: string) => GitResult;
  count?: GitResult;
  source?: GitResult;
  /** `rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel`, per worktree directory. */
  identity?: (cwd: string) => GitResult;
}
interface Call {
  args: string[];
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}

/**
 * A `config --get-regexp` answer for `pairs`: git's `-z` form (`key\nvalue\0`, a
 * key with no value alone) when the call asks for it, else `key value\n`.
 */
const cfg =
  (...pairs: [string, string | null][]) =>
  (args: readonly string[]): GitResult =>
    OK(args.includes("-z") ? pairs.map(([k, v]) => (v === null ? `${k}\0` : `${k}\n${v}\0`)).join("") : pairs.map(([k, v]) => (v === null ? `${k}\n` : `${k} ${v}\n`)).join(""));

const IDENTITY = "rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel";
/** What real git says in DIR (the main worktree) and in DIR2 / DIR3 (linked ones). */
const identityOf = (cwd: string): GitResult => {
  if (cwd === DIR) return OK(`${COMMON}\n${COMMON}\n${DIR}\n`);
  if (cwd === DIR2) return OK(`${ADMIN2}\n${COMMON}\n${DIR2}\n`);
  if (cwd === DIR3) return OK(`${ADMIN3}\n${COMMON}\n${DIR3}\n`);
  return EXIT(128);
};

/** One repo `skills` at {@link DIR}; records argv, env and stdin of every call. */
function pushedGit(w: World, log: Call[] = []): GitRun {
  return async (cwd, args, opts) => {
    log.push({ args: [...args], env: opts?.env, stdin: opts?.stdin });
    const a = args.join(" ").replace(/^-c core\.fsmonitor=false /, "").replace(/^-c core\.splitIndex=false /, "");
    if (a === "rev-parse --show-toplevel") return OK(`${DIR}\n`);
    if (a === IDENTITY) return (w.identity ?? identityOf)(cwd);
    if (a === "remote get-url origin") return OK(`${URL}\n`);
    if (a.startsWith("config --get-regexp") && a.includes("promisor")) return w.promisor ?? EXIT(1);
    if (/^config (-z )?--get-regexp/.test(a) && a.includes("pushinsteadof")) return typeof w.origin === "function" ? w.origin(args) : (w.origin ?? cfg(["remote.origin.url", URL])(args));
    if (a === "ls-remote --get-url origin") return w.getUrl ?? OK(`${URL}\n`);
    if (a === "rev-parse --is-shallow-repository") return w.shallow ?? OK("false\n");
    if (a.startsWith("rev-parse --git-path")) return (w.gitPath ?? gitPaths)(args);
    if (a.startsWith("config --get-regexp ^filter")) return w.filters ?? EXIT(1);
    if (a === "ls-files -v -s -z") return w.index ?? OK(INDEX);
    if (a === "diff-index --cached --quiet HEAD") return w.staged ?? OK("");
    if (a === "read-tree HEAD") return w.readTree ?? OK("");
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
    expect(await run()).toEqual({ state: "ok", why: "every commit on skills's branches and worktree HEADs is on an origin branch, and no tracked file is modified or staged in its worktree" });
  });

  test("every call carries the lookup switches; tips and worktree HEADs go on stdin; refs/remotes is never read", async () => {
    const log: Call[] = [];
    await run({ worktrees: OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0detached\0\0`) }, log);
    expect(log.every((c) => Object.entries(CHECKOUT_GIT_ENV).every(([k, v]) => c.env?.[k] === v))).toBe(true);
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
    expect(await run({ count: OK("2\n"), source: OK(`${WT}\n`), worktrees: OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0detached\0\0`) })).toEqual({
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
    // `ls-remote --get-url` reads config only; no other ls-remote runs.
    expect(log.some((c) => c.args[0] === "ls-remote" && !c.args.includes("--get-url"))).toBe(false);
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
    const url: [string, string] = ["remote.origin.url", URL];
    expect(await run({ origin: cfg(url, ["remote.origin.pushurl", "git@elsewhere:x/skills.git"]) })).toEqual({ state: "unknown", why: split });
    expect(await run({ origin: cfg(url, ["remote.origin.url", "git@b:x/skills.git"]) })).toEqual({ state: "unknown", why: "skills's origin has 2 URLs" });
    expect(await run({ origin: cfg(url, ["url.git@elsewhere:.pushinsteadof", "git@github.com:"]) })).toEqual({ state: "unknown", why: split });
    // A pushInsteadOf that does not match origin's url changes nothing.
    expect((await run({ origin: cfg(url, ["url.x.pushinsteadof", "https://gitlab.com/"]) })).state).toBe("ok");
    expect(await run({ origin: EXIT(1) })).toEqual({ state: "unknown", why: "skills has no origin" });
  });

  test("finding A (PR #850 round 2): a push default, a branch pushRemote or a push refspec sending pushes past origin's branches: unknown", async () => {
    const at = (...extra: [string, string][]) => run({ origin: cfg(["remote.origin.url", URL], ...extra) });
    expect(await at(["remote.pushdefault", "fork"])).toEqual({ state: "unknown", why: "skills's remote.pushDefault names a remote other than origin" });
    expect(await at(["branch.wip.pushremote", "fork"])).toEqual({ state: "unknown", why: "a branch of skills pushes to a remote other than origin" });
    expect(await at(["remote.origin.push", "refs/heads/*:refs/heads/mirror/*"])).toEqual({ state: "unknown", why: "skills's origin has a push refspec: muninn does not check where it sends commits" });
    // Naming origin itself changes nothing.
    expect((await at(["remote.pushdefault", "origin"], ["branch.main.pushremote", "origin"])).state).toBe("ok");
  });

  test("finding C (PR #850 round 2): an origin config read that failed or timed out after printing the url line: unknown, never ok", async () => {
    const partial = `remote.origin.url ${URL}\n`;
    expect(await run({ origin: { ok: false, stdout: partial, exitCode: 128, stderr: "fatal: bad config line" } })).toEqual({ state: "unknown", why: "git config failed on skills" });
    expect(await run({ origin: { ok: false, stdout: partial, timedOut: true } })).toEqual({ state: "unknown", why: "git config timed out on skills" });
  });

  test("finding B (PR #850 round 2): the cat-file and ls-files whys say what happened", async () => {
    expect(await run({ batch: () => OK(`${R1} tree 10\n${R2} commit 1\n`) })).toEqual({ state: "unknown", why: "an origin branch points at an object that is not a commit" });
    expect(await run({ batch: () => OK(`${R1} commit 1\n`) })).toEqual({ state: "unknown", why: "git cat-file gave an answer muninn cannot read on skills" });
    expect(await run({ batch: () => EXIT(128) })).toEqual({ state: "unknown", why: "git cat-file failed on skills" });
    expect(await run({ index: { ok: true, stdout: INDEX, capped: true } })).toEqual({ state: "unknown", why: "skills has too many tracked files for muninn to read" });
    expect(await run({ index: TIMED_OUT })).toEqual({ state: "unknown", why: "git ls-files timed out on skills" });
  });

  test("finding C (PR #850 round 2): only a plain branch name reaches the not-yet sentence", async () => {
    expect(await run({ count: OK("1\n"), source: OK("a/b-c.d\n") })).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch (on a/b-c.d): push" });
    // A name outside the filter is left out; the count still stands.
    expect(await run({ count: OK("1\n"), source: OK("wip+x\n") })).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch: push" });
  });

  test("findings 1-3 (PR #850): filter config, staged index, scratch index and worktree list rows", async () => {
    expect(await run({ filters: OK("filter.lfs.clean git-lfs clean -- %f\n") })).toEqual({ state: "unknown", why: "git's config for skills names a content filter command: muninn does not run it" });
    expect(await run({ filters: EXIT(128) })).toEqual({ state: "unknown", why: "git config failed on skills" });
    expect(await run({ staged: EXIT(1) })).toEqual({ state: "not-yet", why: "skills has uncommitted changes: commit and push" });
    expect(await run({ staged: EXIT(128) })).toEqual({ state: "unknown", why: "git diff-index failed on skills" });
    expect(await run({ readTree: EXIT(128) })).toEqual({ state: "unknown", why: "git read-tree failed on skills" });
    expect(await run({ worktrees: OK(`worktree ${DIR2}\0HEAD ${LOCAL}\0branch refs/heads/main\0\0`) })).toEqual({ state: "unknown", why: "git worktree list does not name skills's own worktree once" });
    expect(await run({ worktrees: OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${ZERO}\0branch refs/heads/u\0\0`) })).toEqual({ state: "unknown", why: "another worktree of skills has no commit yet" });
    expect(await run({ worktrees: OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0branch refs/heads/side\0\0`) })).toEqual({
      state: "ok",
      why: "every commit on skills's branches and worktree HEADs is on an origin branch, and no tracked file is modified or staged in any of its 2 worktrees",
    });
  });

  test("finding 1 (PR #850): read-tree and status share one scratch index outside the repo, removed afterwards", async () => {
    const log: Call[] = [];
    await run({}, log);
    const read = log.find((c) => c.args.includes("read-tree"))!;
    const status = log.find((c) => c.args.includes("status"))!;
    const index = read.env!.GIT_INDEX_FILE!;
    expect(path.isAbsolute(index) && !index.startsWith(DIR)).toBe(true);
    expect(status.env!.GIT_INDEX_FILE).toBe(index);
    expect(read.args).toEqual(["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false", "read-tree", "HEAD"]);
    expect(existsSync(path.dirname(index))).toBe(false);
  });

  test("parseWorktreeList (PR #850): path, branch and prunable per record", () => {
    expect(parseWorktreeList(`worktree /a\0HEAD ${LOCAL}\0branch refs/heads/main\0\0worktree /b\0HEAD ${WT}\0detached\0prunable gitdir file points to non-existent location\0\0worktree /c\0bare\0\0`)).toEqual([
      { path: "/a", head: LOCAL, branch: "main", prunable: false },
      { path: "/b", head: WT, branch: null, prunable: true },
      { path: "/c", head: null, branch: null, prunable: false },
    ]);
  });

  describe("finding 1 (verify pass on PR #850): each record's directory is the worktree git listed", () => {
    const TWO = OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0branch refs/heads/side\0\0`);
    const THREE = OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0branch refs/heads/side\0\0worktree ${DIR3}\0HEAD ${WT}\0detached\0\0`);
    const MISPLACED: ProbeResult = { state: "unknown", why: "a worktree of skills is not where git recorded it" };
    /** `identityOf`, with `cwd`'s answer replaced. */
    const at = (dir: string, res: GitResult) => (cwd: string) => (cwd === dir ? res : identityOf(cwd));
    const answer = (...lines: string[]) => OK(lines.map((l) => `${l}\n`).join(""));

    test("three consistent records: ok, every record asked once, before any cleanliness check", async () => {
      const log: Call[] = [];
      expect((await run({ worktrees: THREE }, log)).state).toBe("ok");
      const asked = log.flatMap((c, i) => (c.args.join(" ") === IDENTITY ? [i] : []));
      expect(asked.length).toBe(3);
      const firstCheck = log.findIndex((c) => c.args[0] === "rev-parse" && c.args[1] === "--git-path");
      expect(Math.max(...asked)).toBeLessThan(firstCheck);
    });

    test("rev-parse failing, timing out, capped or answering a shape muninn cannot read: unknown, saying which", async () => {
      expect(await run({ worktrees: TWO, identity: at(DIR, EXIT(128)) })).toEqual({ state: "unknown", why: "git rev-parse failed on skills" });
      expect(await run({ worktrees: TWO, identity: at(DIR2, TIMED_OUT) })).toEqual({ state: "unknown", why: "git rev-parse timed out on another worktree of skills" });
      expect(await run({ worktrees: TWO, identity: at(DIR2, EXIT(128)) })).toEqual({ state: "unknown", why: "git rev-parse failed on another worktree of skills" });
      const garbled: ProbeResult = { state: "unknown", why: "git rev-parse gave an answer muninn cannot read on another worktree of skills" };
      expect(await run({ worktrees: TWO, identity: at(DIR2, { ok: true, stdout: `${ADMIN2}\n${COMMON}\n${DIR2}\n`, exitCode: 0, capped: true }) })).toEqual(garbled);
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(ADMIN2, COMMON)) })).toEqual(garbled);
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(ADMIN2, COMMON, DIR2, DIR2)) })).toEqual(garbled);
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(".git/worktrees/w2", COMMON, DIR2)) })).toEqual(garbled);
      // Two failures: the probed worktree's is the one named, wherever it is listed.
      const twoFail = OK(`worktree ${DIR2}\0HEAD ${WT}\0branch refs/heads/side\0\0worktree ${DIR}\0HEAD ${LOCAL}\0branch refs/heads/main\0\0`);
      expect(await run({ worktrees: twoFail, identity: (cwd) => (cwd === DIR ? TIMED_OUT : EXIT(128)) })).toEqual({ state: "unknown", why: "git rev-parse timed out on skills" });
    });

    test("(i) another repository's common dir, or one that does not resolve: unknown", async () => {
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(ADMIN2, path.join(DIR2, ".git"), DIR2)) })).toEqual(MISPLACED);
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(ADMIN2, path.join(DIR, "nowhere"), DIR2)) })).toEqual(MISPLACED);
    });

    test("(i) under a bare main record, a common dir that resolves for no record: unknown", async () => {
      const admin1 = path.join(COMMON, "worktrees", "w1");
      mkdirSync(admin1, { recursive: true });
      writeFileSync(path.join(admin1, "gitdir"), `${DIR}/.git\n`);
      const bareMain = OK(`worktree /bare\0bare\0\0worktree ${DIR}\0HEAD ${LOCAL}\0branch refs/heads/main\0\0worktree ${DIR2}\0HEAD ${WT}\0detached\0\0`);
      const gone = path.join(DIR, "no-such-common");
      expect(await run({ worktrees: bareMain, identity: (cwd) => (cwd === DIR ? answer(admin1, gone, DIR) : answer(ADMIN2, gone, DIR2)) })).toEqual(MISPLACED);
    });

    test("a git dir that does not resolve: unknown", async () => {
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(path.join(COMMON, "worktrees", "gone"), COMMON, DIR2)) })).toEqual(MISPLACED);
    });

    test("(ii) a toplevel that is not the recorded directory: unknown", async () => {
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(ADMIN2, COMMON, DIR3)) })).toEqual(MISPLACED);
      expect(await run({ worktrees: TWO, identity: at(DIR, answer(COMMON, COMMON, DIR2)) })).toEqual(MISPLACED);
    });

    test("(iii) two records on one directory, or two directories on one git dir: unknown", async () => {
      // DIR3 recorded twice: both records resolve to it.
      expect(await run({ worktrees: OK(`${WORKTREES}worktree ${DIR3}\0HEAD ${WT}\0detached\0\0worktree ${DIR3}\0HEAD ${WT}\0detached\0\0`) })).toEqual({
        state: "unknown",
        why: "two worktrees of skills resolve to one directory",
      });
      expect(await run({ worktrees: THREE, identity: at(DIR3, answer(ADMIN2, COMMON, DIR3)) })).toEqual({ state: "unknown", why: "two worktrees of skills share one git dir" });
    });

    test("(iv) a git dir whose record does not name this directory: unknown", async () => {
      // The main worktree's directory answering a linked git dir.
      expect(await run({ worktrees: TWO, identity: at(DIR, answer(ADMIN3, COMMON, DIR)) })).toEqual(MISPLACED);
      // A linked record's directory answering the common dir, under a bare main record (so no other record holds it).
      const admin1 = path.join(COMMON, "worktrees", "w1");
      mkdirSync(admin1, { recursive: true });
      writeFileSync(path.join(admin1, "gitdir"), `${DIR}/.git\n`);
      const bareMain = OK(`worktree /bare\0bare\0\0worktree ${DIR}\0HEAD ${LOCAL}\0branch refs/heads/main\0\0worktree ${DIR2}\0HEAD ${WT}\0detached\0\0`);
      const linkedOnly = (cwd: string) => (cwd === DIR ? answer(admin1, COMMON, DIR) : cwd === DIR2 ? answer(COMMON, COMMON, DIR2) : identityOf(cwd));
      expect(await run({ worktrees: bareMain, identity: linkedOnly })).toEqual(MISPLACED);
      // Even when the common dir holds a `gitdir` file naming that directory.
      writeFileSync(path.join(COMMON, "gitdir"), `${DIR2}/.git\n`);
      try {
        expect(await run({ worktrees: bareMain, identity: linkedOnly })).toEqual(MISPLACED);
      } finally {
        rmSync(path.join(COMMON, "gitdir"));
      }
      // The same pair with DIR2 answering its own linked git dir is consistent.
      expect((await run({ worktrees: bareMain, identity: (cwd) => (cwd === DIR ? answer(admin1, COMMON, DIR) : identityOf(cwd)) })).state).toBe("ok");
      // A linked git dir whose `gitdir` names another directory (DIR3's admin dir, from DIR2).
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(ADMIN3, COMMON, DIR2)) })).toEqual(MISPLACED);
      // A linked git dir with no `gitdir` file, and one whose `gitdir` does not end in /.git.
      const bare = path.join(COMMON, "worktrees", "nofile");
      mkdirSync(bare, { recursive: true });
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(bare, COMMON, DIR2)) })).toEqual(MISPLACED);
      const odd = path.join(COMMON, "worktrees", "odd");
      mkdirSync(odd, { recursive: true });
      writeFileSync(path.join(odd, "gitdir"), `${DIR2}/notgit\n`);
      expect(await run({ worktrees: TWO, identity: at(DIR2, answer(odd, COMMON, DIR2)) })).toEqual(MISPLACED);
    });

    test("(iv) a relative `gitdir` resolves against the git dir that holds it: ok", async () => {
      const rel = path.join(COMMON, "worktrees", "rel");
      mkdirSync(rel, { recursive: true });
      writeFileSync(path.join(rel, "gitdir"), `${path.relative(rel, DIR2)}/.git\n`);
      expect((await run({ worktrees: TWO, identity: at(DIR2, answer(rel, COMMON, DIR2)) })).state).toBe("ok");
    });

    describe("the three cells of a record's git dir G", () => {
      /** A git dir at `gitDir` whose `gitdir` file names DIR2, so only WHERE it is can refuse it. */
      const backLinked = (gitDir: string) => {
        mkdirSync(gitDir, { recursive: true });
        writeFileSync(path.join(gitDir, "gitdir"), `${DIR2}/.git\n`);
        return gitDir;
      };
      const outside = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-outside-")));

      test("cell 1: G is the common dir only for the main record, and the main record's G is the common dir", async () => {
        expect((await run({ worktrees: TWO })).state).toBe("ok");
        expect(await run({ worktrees: TWO, identity: at(DIR, answer(ADMIN3, COMMON, DIR)) })).toEqual(MISPLACED);
        expect(await run({ worktrees: TWO, identity: at(DIR2, answer(COMMON, COMMON, DIR2)) })).toEqual({ state: "unknown", why: "two worktrees of skills share one git dir" });
        // The main record answering a direct child of worktrees/ that names it back: still not cell 1.
        const mainAdmin = path.join(COMMON, "worktrees", "main-copy");
        mkdirSync(mainAdmin, { recursive: true });
        writeFileSync(path.join(mainAdmin, "gitdir"), `${DIR}/.git\n`);
        expect(await run({ worktrees: TWO, identity: at(DIR, answer(mainAdmin, COMMON, DIR)) })).toEqual(MISPLACED);
      });

      test("cell 2: a direct child of <common>/worktrees naming the record's directory: ok", async () => {
        expect((await run({ worktrees: TWO, identity: at(DIR2, answer(backLinked(path.join(COMMON, "worktrees", "direct")), COMMON, DIR2)) })).state).toBe("ok");
      });

      test("cell 3: outside the common dir, though its gitdir file names the record's directory: unknown", async () => {
        expect(await run({ worktrees: TWO, identity: at(DIR2, answer(backLinked(path.join(outside, "xadmin")), COMMON, DIR2)) })).toEqual(MISPLACED);
      });

      test("cell 3: nested deeper than a direct child of <common>/worktrees: unknown", async () => {
        expect(await run({ worktrees: TWO, identity: at(DIR2, answer(backLinked(path.join(ADMIN2, "inner")), COMMON, DIR2)) })).toEqual(MISPLACED);
        expect(await run({ worktrees: TWO, identity: at(DIR2, answer(backLinked(path.join(COMMON, "worktrees", "holder", "copy")), COMMON, DIR2)) })).toEqual(MISPLACED);
      });

      test("cell 3: <common>/worktrees itself, a sibling sharing its prefix, a direct child of the common dir, the common dir's parent: unknown", async () => {
        const admins = path.join(COMMON, "worktrees");
        writeFileSync(path.join(admins, "gitdir"), `${DIR2}/.git\n`);
        try {
          expect(await run({ worktrees: TWO, identity: at(DIR2, answer(admins, COMMON, DIR2)) })).toEqual(MISPLACED);
        } finally {
          rmSync(path.join(admins, "gitdir"));
        }
        expect(await run({ worktrees: TWO, identity: at(DIR2, answer(backLinked(path.join(COMMON, "worktrees-x", "w2")), COMMON, DIR2)) })).toEqual(MISPLACED);
        expect(await run({ worktrees: TWO, identity: at(DIR2, answer(backLinked(path.join(COMMON, "w2")), COMMON, DIR2)) })).toEqual(MISPLACED);
        // The common dir's parent is the main worktree's directory: its own gitdir file names DIR2.
        writeFileSync(path.join(DIR, "gitdir"), `${DIR2}/.git\n`);
        try {
          expect(await run({ worktrees: TWO, identity: at(DIR2, answer(DIR, COMMON, DIR2)) })).toEqual(MISPLACED);
        } finally {
          rmSync(path.join(DIR, "gitdir"));
        }
      });

      test("cell 3 under a bare main record: a linked G outside the bare repo's worktrees/: unknown", async () => {
        const admin1 = path.join(COMMON, "worktrees", "w1");
        mkdirSync(admin1, { recursive: true });
        writeFileSync(path.join(admin1, "gitdir"), `${DIR}/.git\n`);
        const bareMain = OK(`worktree /bare\0bare\0\0worktree ${DIR}\0HEAD ${LOCAL}\0branch refs/heads/main\0\0worktree ${DIR2}\0HEAD ${WT}\0detached\0\0`);
        const linked = (g2: string) => (cwd: string) => (cwd === DIR ? answer(admin1, COMMON, DIR) : cwd === DIR2 ? answer(g2, COMMON, DIR2) : identityOf(cwd));
        expect((await run({ worktrees: bareMain, identity: linked(ADMIN2) })).state).toBe("ok");
        expect(await run({ worktrees: bareMain, identity: linked(backLinked(path.join(outside, "bare-x"))) })).toEqual(MISPLACED);
      });
    });
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
    ["a worktree record both bare and with a HEAD", { worktrees: OK(`worktree ${DIR}\0bare\0HEAD ${LOCAL}\0branch refs/heads/main\0\0`) }],
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

  describe("guards no row pinned before (PR #850 tests batch)", () => {
    const MISSING: ProbeResult = { state: "unknown", why: "a worktree of skills is missing its directory: muninn cannot check it" };

    test("a record git marks prunable, though its directory exists: unknown", async () => {
      expect(await run({ worktrees: OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0detached\0prunable gitdir file points to non-existent location\0\0`) })).toEqual(MISSING);
    });

    test("a record whose path does not resolve, not marked prunable: unknown", async () => {
      expect(await run({ worktrees: OK(`${WORKTREES}worktree ${path.join(DIR2, "no-such-dir")}\0HEAD ${WT}\0detached\0\0`) })).toEqual(MISSING);
    });

    test(`worktree cap: ${PUSHED_MAX_WORKTREES} records are checked, ${PUSHED_MAX_WORKTREES + 1} are unknown`, async () => {
      // Linked worktrees beyond DIR2/DIR3, each with an admin dir naming it back.
      const extra = Array.from({ length: PUSHED_MAX_WORKTREES }, (_, i) => {
        const dir = realpathSync(testTempDirSync(path.join(tmpdir(), `step-pushed-cap${i}-`)));
        const admin = path.join(COMMON, "worktrees", `cap${i}`);
        mkdirSync(admin, { recursive: true });
        writeFileSync(path.join(admin, "gitdir"), `${dir}/.git\n`);
        return { dir, admin };
      });
      const identity = (cwd: string) => {
        const e = extra.find((x) => x.dir === cwd);
        return e ? OK(`${e.admin}\n${COMMON}\n${e.dir}\n`) : identityOf(cwd);
      };
      const list = (n: number) => OK(WORKTREES + extra.slice(0, n - 1).map((e) => `worktree ${e.dir}\0HEAD ${WT}\0detached\0\0`).join(""));
      expect(await run({ worktrees: list(PUSHED_MAX_WORKTREES), identity })).toEqual({
        state: "ok",
        why: `every commit on skills's branches and worktree HEADs is on an origin branch, and no tracked file is modified or staged in any of its ${PUSHED_MAX_WORKTREES} worktrees`,
      });
      expect(await run({ worktrees: list(PUSHED_MAX_WORKTREES + 1), identity })).toEqual({ state: "unknown", why: `skills has over ${PUSHED_MAX_WORKTREES} worktrees: muninn does not check them all` });
    });

    test("the probed directory recorded twice: unknown, before the one-directory check", async () => {
      expect(await run({ worktrees: OK(`${WORKTREES}worktree ${DIR}\0HEAD ${LOCAL}\0detached\0\0`) })).toEqual({ state: "unknown", why: "git worktree list does not name skills's own worktree once" });
    });

    test("filter config timing out, or exiting 1 with stderr: unknown, saying which", async () => {
      expect(await run({ filters: TIMED_OUT })).toEqual({ state: "unknown", why: "git config timed out on skills" });
      // A timed-out answer never reads as «no such key», whatever exit code it carries.
      expect(await run({ filters: { ok: false, stdout: "", exitCode: 1, timedOut: true } })).toEqual({ state: "unknown", why: "git config timed out on skills" });
      expect(await run({ filters: { ok: false, stdout: "", exitCode: 1, stderr: "error: bad config line 3" } })).toEqual({ state: "unknown", why: "git config failed on skills" });
    });

    test("cat-file capped or timing out: unknown, each with its own why", async () => {
      expect(await run({ batch: () => ({ ok: true, stdout: `${R1} commit 1\n${R2} commit 1\n`, capped: true }) })).toEqual({ state: "unknown", why: "git cat-file gave an answer muninn cannot read on skills" });
      expect(await run({ batch: () => TIMED_OUT })).toEqual({ state: "unknown", why: "git cat-file timed out on skills" });
    });

    test("a branch name of 100 chars reaches a why, one of 101 does not: the --source name and another worktree's branch", async () => {
      const b100 = "b".repeat(100);
      const b101 = "b".repeat(101);
      expect(await run({ count: OK("1\n"), source: OK(`${b100}\n`) })).toEqual({ state: "not-yet", why: `1 commit in skills is on no origin branch (on ${b100}): push` });
      expect(await run({ count: OK("1\n"), source: OK(`${b101}\n`) })).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch: push" });
      // A staged file in DIR2 only.
      const dirtyIn2 = (branch: string): GitRun => {
        const base = pushedGit({ worktrees: OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0branch refs/heads/${branch}\0\0`) });
        return (cwd, args, opts) => (cwd === DIR2 && args.includes("diff-index") ? Promise.resolve(EXIT(1)) : base(cwd, args, opts));
      };
      expect(await probePushed("skills", deps(dirtyIn2(b100)))).toEqual({ state: "not-yet", why: `skills has uncommitted changes in another worktree (on ${b100}): commit and push` });
      expect(await probePushed("skills", deps(dirtyIn2(b101)))).toEqual({ state: "not-yet", why: "skills has uncommitted changes in another worktree: commit and push" });
    });

    test("a linked git dir's gitdir file is compared by realpath: a symlinked spelling of the directory matches, another directory does not", async () => {
      const links = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-links-")));
      const viaLink = path.join(links, "dir2-link");
      symlinkSync(DIR2, viaLink);
      const admin = path.join(COMMON, "worktrees", "via-link");
      mkdirSync(admin, { recursive: true });
      writeFileSync(path.join(admin, "gitdir"), `${viaLink}/.git\n`);
      const TWO = OK(`${WORKTREES}worktree ${DIR2}\0HEAD ${WT}\0branch refs/heads/side\0\0`);
      const at = (g: string) => (cwd: string) => (cwd === DIR2 ? OK(`${g}\n${COMMON}\n${DIR2}\n`) : identityOf(cwd));
      expect((await run({ worktrees: TWO, identity: at(admin) })).state).toBe("ok");
      const other = path.join(COMMON, "worktrees", "via-other");
      mkdirSync(other, { recursive: true });
      writeFileSync(path.join(other, "gitdir"), `${DIR3}/.git\n`);
      expect(await run({ worktrees: TWO, identity: at(other) })).toEqual({ state: "unknown", why: "a worktree of skills is not where git recorded it" });
    });
  });
});

describe("pushed: origin reads where it pushes (PR #850 round 3, the class check)", () => {
  const url: [string, string] = ["remote.origin.url", URL];
  const split = "skills's origin pushes to another URL than the one muninn reads";

  test("remote.origin.* is an allowlist: any other key is unknown, named when it is a plain word", async () => {
    for (const key of ["uploadpack", "receivepack", "vcs", "proxy", "proxyauthmethod", "mirror", "serveroption", "somethingnew"]) {
      expect(await run({ origin: cfg(url, [`remote.origin.${key}`, "x"]) })).toEqual({ state: "unknown", why: `skills's origin has a ${key} setting: muninn cannot prove where its commits go` });
    }
    // A key name that is not a plain lower-case word stays out of the sentence; a valueless key is refused too.
    for (const key of ["gh-resolved", "x2"]) {
      expect(await run({ origin: cfg(url, [`remote.origin.${key}`, "base"]) })).toEqual({ state: "unknown", why: "skills's origin has a setting muninn does not know: muninn cannot prove where its commits go" });
    }
    expect((await run({ origin: cfg(url, ["remote.origin.mirror", null]) })).state).toBe("unknown");
  });

  test("the allowed origin keys leave the answer ok", async () => {
    const allowed: [string, string][] = [
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["remote.origin.prune", "true"],
      ["remote.origin.prunetags", "true"],
      ["remote.origin.tagopt", "--no-tags"],
      ["remote.origin.skipdefaultupdate", "true"],
      ["remote.origin.skipfetchall", "true"],
      ["remote.origin.followremotehead", "warn"],
      ["remote.origin.partialclonefilter", "blob:none"],
      ["remote.origin.promisor", "false"],
    ];
    expect((await run({ origin: cfg(url, ...allowed) })).state).toBe("ok");
  });

  test("a pushInsteadOf matching by git's own rule: an empty prefix, a url base with a space, a key with no value", async () => {
    expect(await run({ origin: cfg(url, ["url.git@elsewhere:.pushinsteadof", ""]) })).toEqual({ state: "unknown", why: split });
    expect(await run({ origin: cfg(url, ["url.git@else where:.pushinsteadof", "git@github.com:"]) })).toEqual({ state: "unknown", why: split });
    expect(await run({ origin: cfg(url, ["url.x.pushinsteadof", null]) })).toEqual({ state: "unknown", why: split });
  });

  test("get-url must name a network origin by git's own grammar: every other url is unknown", async () => {
    for (const net of ["https://h/x", "http://h/x", "ssh://git@h/x.git", "git://h/x", "host:path", "user@host:path", "user@host:a/b", URL]) {
      expect((await run({ getUrl: OK(`${net}\n`) })).state).toBe("ok");
    }
    const local = "skills's origin is not a network address: muninn cannot prove it is another repository";
    for (const url of ["/abs/path", "../rel", ".", "file:///x", "file://localhost/x", "FILE:///x", "HTTPS://h/x", "https:///x", "ext::cmd", "foo://h/x", "~/x", "/a/b:c", "h::x", ":x", "file:///a/https://h/x"]) {
      expect(await run({ getUrl: OK(`${url}\n`) })).toEqual({ state: "unknown", why: local });
    }
    const cannot = "muninn cannot tell where skills's origin is";
    expect(await run({ getUrl: OK("\n") })).toEqual({ state: "unknown", why: cannot });
    expect(await run({ getUrl: OK("https://a/x\nhttps://b/x\n") })).toEqual({ state: "unknown", why: cannot });
    expect(await run({ getUrl: EXIT(128) })).toEqual({ state: "unknown", why: "git ls-remote failed on skills" });
  });

  test("core.sshCommand set in any scope with an ssh origin: unknown; with an https or git origin: ignored", async () => {
    const ssh = "skills sets core.sshCommand: muninn's read may reach another host than a push";
    for (const value of ["ssh -i k", "", null]) {
      for (const getUrl of [URL, "ssh://git@h/x.git", "ssh://h/https://x"]) {
        expect(await run({ origin: cfg(url, ["core.sshcommand", value]), getUrl: OK(`${getUrl}\n`) })).toEqual({ state: "unknown", why: ssh });
      }
    }
    for (const getUrl of ["https://h/x", "git://h/x"]) {
      expect((await run({ origin: cfg(url, ["core.sshcommand", "ssh -i k"]), getUrl: OK(`${getUrl}\n`) })).state).toBe("ok");
    }
  });
});
