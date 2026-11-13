/**
 * `pushed=` against real git: an origin that reads one repo and pushes to
 * another, or that is not a network address (PR #850 round 3, the class check
 * on `refuseSplitOrigin`, and round 4). Each red row answered `ok` over a
 * commit no other repo holds, or over a push that goes elsewhere. Every repo
 * and the uploadpack scripts live under the test's own temp dir.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { hermeticGit, networkOrigin } from "../../test/hermetic-git.ts";
import type { GitRun } from "../decision-triage/git.ts";
import { probePushed, type ProbeDeps } from "./probes.ts";

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

/** Probes `clone`; by default its origin reads as a network url (the fixtures' origins are local bares). */
const pushed = (clone: string, git: GitRun = networkOrigin()) =>
  probePushed("skills", {
    git,
    roots: { dirs: [], named: new Map([["skills", clone]]) },
    readEnvFile: async () => ({ missing: true }),
    processHasEnv: () => false,
    appliedMigrations: async () => new Set(),
  } satisfies ProbeDeps);

const LOCAL = "skills's origin is not a network address: muninn cannot prove it is another repository";
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

  test("remote.origin.x.uploadpack (a remote named origin.x) is not returned by the origin read: still ok", async () => {
    const { base, work } = fixture();
    sh(work, "config", "remote.origin.x.uploadpack", uploadpackServing(base, work));
    // Were the key returned, the allowlist would refuse `x.uploadpack`.
    expect((await pushed(work)).state).toBe("ok");
  });

  test("core.sshCommand with an ssh origin: unknown; with an https origin: ignored", async () => {
    const { work } = fixture();
    sh(work, "config", "core.sshCommand", "ssh -i elsewhere");
    expect(await pushed(work, networkOrigin("ssh://example.invalid/skills.git"))).toEqual({ state: "unknown", why: "skills sets core.sshCommand: muninn's read may reach another host than a push" });
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

describe("pushed, real git: an origin that is not a network address (PR #850 round 4)", () => {
  /** The clone with an unpushed commit, and an origin (named `skills.git`, so the repo lookup passes) that lists the clone's own branches. */
  const unpushedReadingSelf = async (setOrigin: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture();
    const tip = commit(f.work, "two");
    setOrigin(f);
    // The precondition: ls-remote lists the unpushed tip, the real origin lacks it.
    expect(sh(f.work, "ls-remote", "--heads", "origin")).toContain(tip);
    expect(sh(f.remote, "rev-parse", "main")).not.toBe(tip);
    return pushed(f.work, hermeticGit);
  };
  const gitfile = (base: string, work: string) => {
    mkdirSync(path.join(base, "gitfile"));
    const file = path.join(base, "gitfile", "skills.git");
    writeFileSync(file, `gitdir: ${path.join(work, ".git")}\n`);
    return file;
  };

  test("(a) origin's url a gitfile pointing at the clone: unknown", async () => {
    const r = await unpushedReadingSelf(({ base, work }) => sh(work, "remote", "set-url", "origin", gitfile(base, work)));
    expect(r).toEqual({ state: "unknown", why: LOCAL });
  });

  test("(b) url.<gitfile>.insteadOf rewriting origin onto the clone: unknown", async () => {
    const r = await unpushedReadingSelf(({ base, remote, work }) => sh(work, "config", `url.${gitfile(base, work)}.insteadOf`, remote));
    expect(r).toEqual({ state: "unknown", why: LOCAL });
  });

  test("(c) origin's url a bundle of the clone: unknown", async () => {
    const r = await unpushedReadingSelf(({ base, work }) => {
      mkdirSync(path.join(base, "bundle"));
      const bundle = path.join(base, "bundle", "skills.git");
      sh(work, "bundle", "create", "-q", bundle, "--all");
      sh(work, "remote", "set-url", "origin", bundle);
    });
    expect(r).toEqual({ state: "unknown", why: LOCAL });
  });

  test("(d) a separate bare whose refs and objects are symlinks into the clone: unknown", async () => {
    const r = await unpushedReadingSelf(({ base, work }) => {
      const bare = path.join(base, "linked", "skills.git");
      sh(base, "init", "-q", "--bare", "-b", "main", bare);
      for (const d of ["refs", "objects"]) {
        rmSync(path.join(bare, d), { recursive: true });
        symlinkSync(path.join(work, ".git", d), path.join(bare, d));
      }
      sh(work, "remote", "set-url", "origin", bare);
    });
    expect(r).toEqual({ state: "unknown", why: LOCAL });
  });

  test("(e) an honest local bare origin, pushed and clean: unknown, the rule itself", async () => {
    const { work } = fixture();
    expect(await pushed(work, hermeticGit)).toEqual({ state: "unknown", why: LOCAL });
  });
});
