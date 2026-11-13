/**
 * `pushed=` against real git: an origin that reads one repo and pushes to
 * another, or reads the probed checkout itself (PR #850 round 3, the class
 * check on `refuseSplitOrigin`). Each red row answered `ok` over a commit no
 * other repo holds, or over a push that goes elsewhere. Every repo and the
 * uploadpack scripts live under the test's own temp dir.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realGit, type GitRun } from "../decision-triage/git.ts";
import { probePushed, type ProbeDeps } from "./probes.ts";

// The probe reads every config scope; a runner's global git-lfs filter would answer every row `unknown`.
const hermeticGit: GitRun = (cwd, args, opts) => realGit(cwd, args, { ...opts, env: { ...opts?.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/** origin `skills.git` with one commit on main, and a work clone that pushed it, itself named `skills` so an origin resolving to it still passes the repo lookup. */
function fixture() {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-origin-")));
  const remote = path.join(base, "skills.git");
  const work = path.join(base, "clone", "skills");
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  sh(work, "add", "f");
  sh(work, "commit", "-q", "-m", "one");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  return { base, remote, work };
}

const commit = (dir: string, text: string) => {
  writeFileSync(path.join(dir, "f"), `${text}\n`);
  sh(dir, "commit", "-q", "-am", text);
  return sh(dir, "rev-parse", "HEAD");
};

/** An uploadpack program in `base` that serves `repo` whatever path git asks for. */
function uploadpackServing(base: string, repo: string) {
  const script = path.join(base, `serve-${path.basename(path.dirname(repo))}-${path.basename(repo)}.sh`);
  writeFileSync(script, `#!/bin/sh\nexec git upload-pack "${repo}"\n`);
  chmodSync(script, 0o755);
  return script;
}

const pushed = (clone: string) =>
  probePushed("skills", {
    git: hermeticGit,
    roots: { dirs: [], named: new Map([["skills", clone]]) },
    readEnvFile: async () => ({ missing: true }),
    processHasEnv: () => false,
    appliedMigrations: async () => new Set(),
  } satisfies ProbeDeps);

const SELF = "skills's origin is this checkout itself: muninn cannot prove another repo has its commits";
const SPLIT = "skills's origin pushes to another URL than the one muninn reads";

describe("pushed, real git: an origin that reads elsewhere than it pushes", () => {
  test("uploadpack serving a mirror that has the unpushed commit, url's repo lacking it: unknown", async () => {
    const { base, remote, work } = fixture();
    const tip = commit(work, "two");
    const mirror = path.join(base, "mirror.git");
    sh(base, "clone", "-q", "--bare", work, mirror);
    sh(work, "config", "remote.origin.uploadpack", uploadpackServing(base, mirror));
    // The precondition: ls-remote reads the mirror, a push would go to url's repo, which lacks the commit.
    expect(sh(work, "ls-remote", "--heads", "origin")).toContain(tip);
    expect(sh(remote, "rev-parse", "main")).not.toBe(tip);
    expect(await pushed(work)).toEqual({ state: "unknown", why: "skills's origin has a uploadpack setting: muninn cannot prove where its commits go" });
  });

  test("uploadpack serving the clone itself: unknown", async () => {
    const { base, work } = fixture();
    commit(work, "two");
    sh(work, "config", "remote.origin.uploadpack", uploadpackServing(base, work));
    expect((await pushed(work)).state).toBe("unknown");
  });

  test("url.<clone>.insteadOf rewriting origin's url onto the clone itself: unknown", async () => {
    const { remote, work } = fixture();
    const tip = commit(work, "two");
    sh(work, "config", `url.${work}.insteadOf`, remote);
    expect(sh(work, "ls-remote", "--get-url", "origin")).toBe(work);
    expect(sh(work, "ls-remote", "--heads", "origin")).toContain(tip);
    expect(await pushed(work)).toEqual({ state: "unknown", why: SELF });
  });

  test("origin's url naming another worktree of the clone: unknown", async () => {
    const { base, work } = fixture();
    const linked = path.join(base, "linked", "skills");
    sh(work, "worktree", "add", "-q", "--detach", linked);
    commit(work, "two");
    sh(work, "remote", "set-url", "origin", linked);
    expect(await pushed(work)).toEqual({ state: "unknown", why: SELF });
  });

  test("an empty pushInsteadOf rewrites every push url: unknown", async () => {
    const { base, remote, work } = fixture();
    sh(work, "config", `url.${path.join(base, "elsewhere")}.pushInsteadOf`, "");
    // git's own rule: an empty prefix matches every url.
    expect(sh(work, "remote", "get-url", "--push", "origin")).toBe(`${path.join(base, "elsewhere")}${remote}`);
    expect(await pushed(work)).toEqual({ state: "unknown", why: SPLIT });
  });

  test("a pushInsteadOf whose url base holds a space: unknown", async () => {
    const { base, remote, work } = fixture();
    const elsewhere = path.join(base, "else where");
    sh(work, "config", `url.${elsewhere}/.pushInsteadOf`, `${path.dirname(remote)}/`);
    expect(sh(work, "remote", "get-url", "--push", "origin")).toBe(`${elsewhere}/skills.git`);
    expect(await pushed(work)).toEqual({ state: "unknown", why: SPLIT });
  });

  test("allowed origin keys (fetch, prune, tagOpt) on a pushed, clean clone: still ok", async () => {
    const { work } = fixture();
    sh(work, "config", "remote.origin.prune", "true");
    sh(work, "config", "remote.origin.tagOpt", "--no-tags");
    expect(sh(work, "config", "--get-regexp", "^remote\\.origin\\.")).toContain("remote.origin.fetch");
    expect((await pushed(work)).state).toBe("ok");
  });

  test("an insteadOf onto another bare answers truthfully: ok when pushed, not-yet when not", async () => {
    const { work, remote } = fixture();
    const alias = "/nowhere/skills.git";
    sh(work, "remote", "set-url", "origin", alias);
    sh(work, "config", `url.${remote}.insteadOf`, alias);
    expect((await pushed(work)).state).toBe("ok");
    commit(work, "two");
    expect((await pushed(work)).state).toBe("not-yet");
  });
});
