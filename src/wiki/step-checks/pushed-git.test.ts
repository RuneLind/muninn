/**
 * `pushed=` against real git on throwaway repos: a bare `skills.git` as origin
 * and a work clone. Each row is one way the old probe (or a naive one) said
 * «pushed» falsely: a branch with no upstream, a detached HEAD, a stale or
 * rewound local `origin/*` ref, a replace ref or graft faking ancestry, a
 * partial clone that would fetch on lookup. Review's findings 1–6 (hidden
 * index entries, fsmonitor, other worktrees, submodules, operations in
 * progress, a split origin) are in `pushed-git-hidden.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { networkOrigin } from "../../test/hermetic-git.ts";
import { probePushed, type ProbeDeps } from "./probes.ts";


const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/** origin `skills.git` with one commit on main, a work clone that pushed it, and a second clone `other` for moving origin behind the work clone's back. */
function fixture() {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-")));
  const remote = path.join(base, "skills.git");
  const work = path.join(base, "work");
  const other = path.join(base, "other");
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(remote, "config", "uploadpack.allowFilter", "true");
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  sh(work, "add", "f");
  sh(work, "commit", "-q", "-m", "one");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  sh(base, "clone", "-q", remote, other);
  return { base, remote, work, other };
}

const commit = (dir: string, text: string) => {
  writeFileSync(path.join(dir, "f"), `${text}\n`);
  sh(dir, "commit", "-q", "-am", text);
  return sh(dir, "rev-parse", "HEAD");
};

const depsFor = (clone: string): ProbeDeps => ({
  git: networkOrigin(),
  roots: { dirs: [], named: new Map([["skills", clone]]) },
  readEnvFile: async () => ({ missing: true }),
  processHasEnv: () => false,
  appliedMigrations: async () => new Set(),
});
const pushed = (clone: string) => probePushed("skills", depsFor(clone));

describe("pushed, real git", () => {
  test("clean and pushed: ok", async () => {
    const { work } = fixture();
    expect((await pushed(work)).state).toBe("ok");
  });

  test("a commit on a branch with no upstream: not-yet, named by that branch", async () => {
    const { work } = fixture();
    sh(work, "checkout", "-q", "-b", "wip-x");
    commit(work, "wip");
    sh(work, "checkout", "-q", "main");
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch (on wip-x): push" });
  });

  test("finding C (round 2): a branch name git allows but the sentence filter does not: left out of the why", async () => {
    const { work } = fixture();
    sh(work, "checkout", "-q", "-b", "wip+x");
    commit(work, "wip");
    sh(work, "checkout", "-q", "main");
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch: push" });
  });

  test("a commit on a detached HEAD: not-yet", async () => {
    const { work } = fixture();
    sh(work, "checkout", "-q", "--detach");
    commit(work, "detached");
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "1 commit in skills is on no origin branch (on HEAD): push" });
  });

  test("the local origin/main is stale but origin has the commit (pushed from elsewhere, objects here): ok", async () => {
    const { work, other } = fixture();
    const c = commit(work, "two");
    // Push from the other clone after fetching the object there; the work clone's origin/main stays at one.
    sh(other, "fetch", "-q", work, `${c}:refs/heads/tmp`);
    sh(other, "push", "-q", "origin", `${c}:refs/heads/main`);
    expect(sh(work, "rev-parse", "origin/main")).not.toBe(c);
    expect((await pushed(work)).state).toBe("ok");
  });

  test("the local origin/main says pushed, but origin was rewound: not-yet", async () => {
    const { work, remote } = fixture();
    const first = sh(work, "rev-parse", "HEAD");
    commit(work, "two");
    sh(work, "push", "-q", "origin", "HEAD:main");
    sh(remote, "update-ref", "refs/heads/main", first);
    expect(sh(work, "status", "-sb")).not.toContain("ahead");
    expect((await pushed(work)).state).toBe("not-yet");
  });

  test("origin ahead with a tip missing here, and a local commit: unknown", async () => {
    const { work, other } = fixture();
    commit(other, "theirs");
    sh(other, "push", "-q", "origin", "HEAD:main");
    commit(work, "mine");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "origin has 1 branch tip skills does not have: fetch first" });
  });

  test("a blob:none partial clone: unknown, and nothing is fetched into it", async () => {
    const { base, remote, other } = fixture();
    const clone = path.join(base, "partial");
    sh(base, "clone", "-q", "--filter=blob:none", `file://${remote}`, clone);
    commit(other, "two");
    sh(other, "push", "-q", "origin", "HEAD:main");
    const objects = () => JSON.stringify([readdirSync(path.join(clone, ".git", "objects")).sort(), readdirSync(path.join(clone, ".git", "objects", "pack")).sort()]);
    const before = objects();
    expect(await pushed(clone)).toEqual({ state: "unknown", why: "skills is a partial clone: muninn does not look up objects it would have to fetch" });
    expect(objects()).toBe(before);
  });

  test("a shallow clone: unknown", async () => {
    const { base, remote, work } = fixture();
    commit(work, "two");
    sh(work, "push", "-q", "origin", "HEAD:main");
    const clone = path.join(base, "shallow");
    sh(base, "clone", "-q", "--depth=1", `file://${remote}`, clone);
    expect(await pushed(clone)).toEqual({ state: "unknown", why: "skills is a shallow clone: muninn cannot walk all of its history" });
  });

  test("origin's tip swapped by a replace ref for a fake commit whose parent is the unpushed one: never ok", async () => {
    const { work, other } = fixture();
    const theirs = commit(other, "theirs");
    sh(other, "push", "-q", "origin", "HEAD:main");
    sh(work, "fetch", "-q");
    sh(work, "checkout", "-q", "-b", "wip");
    const mine = commit(work, "mine");
    const fake = sh(work, "commit-tree", `${theirs}^{tree}`, "-p", mine, "-m", "fake");
    sh(work, "replace", theirs, fake);
    // The precondition: honouring the replace ref, git sees nothing unpushed.
    expect(sh(work, "rev-list", "--count", "--branches", "HEAD", `^${theirs}`)).toBe("0");
    expect((await pushed(work)).state).toBe("not-yet");
  });

  test("an info/grafts line making an unpushed root commit's history look pushed: never ok", async () => {
    const { work } = fixture();
    const tip = sh(work, "rev-parse", "HEAD");
    sh(work, "checkout", "-q", "--orphan", "lonely");
    sh(work, "commit", "-q", "-m", "orphan");
    const orphan = sh(work, "rev-parse", "HEAD");
    writeFileSync(path.join(work, ".git", "info", "grafts"), `${orphan} ${tip}\n`);
    expect((await pushed(work)).state).toBe("not-yet");
  });

  test("a modified tracked file: not-yet; an untracked file alone: still ok", async () => {
    const { work } = fixture();
    writeFileSync(path.join(work, "scratch.txt"), "untracked\n");
    expect((await pushed(work)).state).toBe("ok");
    writeFileSync(path.join(work, "f"), "edited\n");
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "skills has uncommitted changes: commit and push" });
    sh(work, "add", "f");
    expect((await pushed(work)).state).toBe("not-yet");
  });

  test("origin unreachable: unknown", async () => {
    const { work } = fixture();
    sh(work, "remote", "set-url", "origin", path.join(path.dirname(work), "gone", "skills.git"));
    expect((await pushed(work)).state).toBe("unknown");
  });
});
