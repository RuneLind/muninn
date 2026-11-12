/**
 * `pushed=` against real git: review's findings 1–6 on PR #849, each a state
 * the first build answered `ok` (or a wrong `not-yet`) over. A file whose change
 * `status` does not show (assume-unchanged, skip-worktree, an fsmonitor that
 * reports nothing), a commit only another worktree's detached HEAD reaches,
 * a submodule, an operation in progress, an origin that pushes elsewhere.
 * Origin is a bare `skills.git`; every repo is under a temp dir.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realGit } from "../decision-triage/git.ts";
import { probePushed, type ProbeDeps } from "./probes.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

function fixture() {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-hidden-")));
  const remote = path.join(base, "skills.git");
  const work = path.join(base, "work");
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  writeFileSync(path.join(work, "g"), "one\n");
  sh(work, "add", "f", "g");
  sh(work, "commit", "-q", "-m", "one");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  return { base, remote, work };
}

const commit = (dir: string, text: string, file = "f") => {
  writeFileSync(path.join(dir, file), `${text}\n`);
  sh(dir, "commit", "-q", "-am", text);
  return sh(dir, "rev-parse", "HEAD");
};

const pushed = (clone: string, name = "skills") => {
  const deps: ProbeDeps = {
    git: realGit,
    roots: { dirs: [], named: new Map([[name, clone]]) },
    readEnvFile: async () => ({ missing: true }),
    processHasEnv: () => false,
    appliedMigrations: async () => new Set(),
  };
  return probePushed(name, deps);
};

describe("pushed, real git: what status does not show", () => {
  test("finding 1: an edited assume-unchanged file: unknown", async () => {
    const { work } = fixture();
    sh(work, "update-index", "--assume-unchanged", "f");
    writeFileSync(path.join(work, "f"), "edited\n");
    expect(sh(work, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "1 tracked file is marked assume-unchanged or skip-worktree in skills, so git does not show their changes" });
  });

  test("finding 1: an edited skip-worktree file: unknown", async () => {
    const { work } = fixture();
    sh(work, "update-index", "--skip-worktree", "g");
    writeFileSync(path.join(work, "g"), "edited\n");
    expect(sh(work, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect((await pushed(work)).state).toBe("unknown");
  });

  test("finding 2: an fsmonitor hook that reports nothing hides an edit from status; the probe still sees it: not-yet", async () => {
    const { base, work } = fixture();
    const hook = path.join(base, "fsmonitor-hook");
    writeFileSync(hook, "#!/bin/sh\nprintf 'token\\0'\n");
    chmodSync(hook, 0o755);
    sh(work, "config", "core.fsmonitor", hook);
    sh(work, "config", "core.fsmonitorHookVersion", "2");
    // Write the fsmonitor extension into the index, then edit behind its back.
    sh(work, "update-index", "--fsmonitor");
    sh(work, "status");
    writeFileSync(path.join(work, "f"), "edited, and longer\n");
    expect(sh(work, "--no-optional-locks", "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "skills has uncommitted changes: commit and push" });
  });
});

describe("pushed, real git: other worktrees", () => {
  test("finding 3: a commit only a linked worktree's detached HEAD reaches, probing the main worktree: not-yet", async () => {
    const { base, work } = fixture();
    const linked = path.join(base, "linked");
    sh(work, "worktree", "add", "-q", "--detach", linked);
    const c = commit(linked, "detached elsewhere");
    expect(await pushed(work)).toEqual({ state: "not-yet", why: `1 commit in skills is on no origin branch (on a worktree's HEAD ${c.slice(0, 7)}): push` });
  });

  test("finding 3: a commit only the main worktree's detached HEAD reaches, probing a linked worktree: not-yet", async () => {
    const { base, work } = fixture();
    const linked = path.join(base, "linked");
    sh(work, "worktree", "add", "-q", "-b", "side", linked);
    sh(linked, "push", "-q", "origin", "side");
    sh(work, "checkout", "-q", "--detach");
    commit(work, "detached in main");
    expect((await pushed(linked)).state).toBe("not-yet");
  });
});

describe("pushed, real git: submodules, operations, origin", () => {
  test("finding 4: a submodule whose new commit is pushed nowhere, its gitlink pushed: unknown", async () => {
    const { base, work } = fixture();
    const subRemote = path.join(base, "sub.git");
    const seed = path.join(base, "seed");
    sh(base, "init", "-q", "--bare", "-b", "main", subRemote);
    sh(base, "clone", "-q", subRemote, seed);
    writeFileSync(path.join(seed, "s"), "one\n");
    sh(seed, "add", "s");
    sh(seed, "commit", "-q", "-m", "s");
    sh(seed, "push", "-q", "origin", "HEAD:main");
    sh(work, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subRemote, "sub");
    sh(work, "commit", "-q", "-m", "add sub");
    commit(path.join(work, "sub"), "unpushed in sub", "s");
    sh(work, "commit", "-q", "-am", "bump sub");
    sh(work, "push", "-q", "origin", "HEAD:main");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "skills has submodules: muninn does not check their commits" });
  });

  test("finding 5: a merge in progress with nothing to show in status: unknown", async () => {
    const { work } = fixture();
    sh(work, "checkout", "-q", "-b", "other");
    commit(work, "other");
    sh(work, "push", "-q", "origin", "other");
    sh(work, "checkout", "-q", "main");
    sh(work, "merge", "-q", "-s", "ours", "--no-commit", "other");
    expect(sh(work, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "skills has a merge in progress" });
  });

  test("finding 6: a pushurl elsewhere, after a push that went there: unknown, not not-yet", async () => {
    const { base, work } = fixture();
    const elsewhere = path.join(base, "elsewhere.git");
    sh(base, "clone", "-q", "--bare", path.join(base, "skills.git"), elsewhere);
    sh(work, "remote", "set-url", "--push", "origin", elsewhere);
    commit(work, "two");
    sh(work, "push", "-q", "origin", "HEAD:main");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "skills's origin pushes to another URL than the one muninn reads" });
  });

  test("finding A (round 2): remote.pushDefault, a branch pushRemote or an origin push refspec, after a push that went there: unknown, not not-yet", async () => {
    const { base, work } = fixture();
    const fork = path.join(base, "fork.git");
    sh(base, "clone", "-q", "--bare", path.join(base, "skills.git"), fork);
    sh(work, "remote", "add", "fork", fork);
    commit(work, "two");
    sh(work, "config", "remote.pushDefault", "fork");
    sh(work, "push", "-q");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "skills's remote.pushDefault names a remote other than origin" });
    sh(work, "config", "--unset", "remote.pushDefault");
    sh(work, "config", "branch.main.pushRemote", "fork");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "a branch of skills pushes to a remote other than origin" });
    sh(work, "config", "--unset", "branch.main.pushRemote");
    sh(work, "config", "remote.origin.push", "refs/heads/*:refs/heads/mirror/*");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "skills's origin has a push refspec: muninn does not check where it sends commits" });
  });

  test("finding B (round 2): an origin branch pointing at a tree: unknown, saying so", async () => {
    const { remote, work } = fixture();
    // update-ref refuses a non-commit under refs/heads; a loose ref file does not.
    writeFileSync(path.join(remote, "refs", "heads", "treeish"), `${sh(work, "rev-parse", "HEAD^{tree}")}\n`);
    expect(await pushed(work)).toEqual({ state: "unknown", why: "an origin branch points at an object that is not a commit" });
  });
});
