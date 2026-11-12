/**
 * `pushed=` against real git: review's findings on PR #850. A same-size edit
 * the repo's stat-trust config hides from `status`, a dirty file in another
 * worktree, and a content filter git would run while comparing. Each answered
 * `ok` before. Origin is a bare `skills.git`; every repo is under a temp dir.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realGit } from "../decision-triage/git.ts";
import { probePushed, type ProbeDeps } from "./probes.ts";

// The probe's worktree cap (`PUSHED_MAX_WORKTREES`), spelled here so this file loads against a build without it.
const PUSHED_MAX_WORKTREES = 12;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

function fixture() {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-content-")));
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

/**
 * Every file under `dir`, with a hash of its bytes: what a read-only probe must
 * leave as it found it. Not mtimes: any read of a split index freshens its
 * shared index's mtime (measured, git 2.54), as the probe's index reads did before.
 */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

const OLD = new Date("2020-01-01T00:00:00Z");

/** Stat cache trusted under `config`, then `f` rewritten to the same size with its mtime put back. */
function hiddenEdit(work: string, config: [string, string]) {
  utimesSync(path.join(work, "f"), OLD, OLD);
  utimesSync(path.join(work, "g"), OLD, OLD);
  sh(work, "config", ...config);
  sh(work, "update-index", "--refresh");
  writeFileSync(path.join(work, "f"), "two\n");
  utimesSync(path.join(work, "f"), OLD, OLD);
}

describe("pushed, real git: content, not the stat cache", () => {
  for (const config of [
    ["core.trustctime", "false"],
    ["core.checkStat", "minimal"],
  ] as [string, string][]) {
    test(`finding 1: ${config.join("=")} and a same-size edit with its mtime restored: not-yet, and the git dir is untouched`, async () => {
      const { work } = fixture();
      // A split index: a scratch index written without `core.splitIndex=false` would leave a shared index in the git dir.
      sh(work, "config", "core.splitIndex", "true");
      sh(work, "update-index", "--split-index");
      hiddenEdit(work, config);
      expect(sh(work, "--no-optional-locks", "status", "--porcelain", "--untracked-files=no")).toBe("");
      const before = snapshot(path.join(work, ".git"));
      expect(await pushed(work)).toEqual({ state: "not-yet", why: "skills has uncommitted changes: commit and push" });
      expect(snapshot(path.join(work, ".git"))).toBe(before);
    });
  }

  test("finding 1: a clean tree under core.autocrlf and an eol attribute still reads clean: ok", async () => {
    const { work } = fixture();
    sh(work, "config", "core.autocrlf", "true");
    writeFileSync(path.join(work, ".gitattributes"), "*.txt text eol=crlf\n");
    writeFileSync(path.join(work, "x.txt"), "a\r\nb\r\n");
    writeFileSync(path.join(work, "w"), "c\r\nd\r\n");
    sh(work, "add", ".gitattributes", "x.txt", "w");
    sh(work, "commit", "-q", "-m", "eol");
    sh(work, "push", "-q", "origin", "HEAD:main");
    expect((await pushed(work)).state).toBe("ok");
  });
});

describe("pushed, real git: every worktree", () => {
  const linked = (base: string, work: string) => {
    const wt = path.join(base, "wt2");
    sh(work, "worktree", "add", "-q", "-b", "side", wt);
    sh(wt, "push", "-q", "origin", "side");
    return wt;
  };

  test("finding 2: a modified tracked file in another worktree: not-yet, naming it", async () => {
    const { base, work } = fixture();
    const wt = linked(base, work);
    writeFileSync(path.join(wt, "f"), "y\n", { flag: "a" });
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "skills has uncommitted changes in another worktree (on side): commit and push" });
  });

  test("finding 2: a staged file in another worktree: not-yet", async () => {
    const { base, work } = fixture();
    const wt = linked(base, work);
    writeFileSync(path.join(wt, "new"), "n\n");
    sh(wt, "add", "new");
    expect((await pushed(work)).state).toBe("not-yet");
  });

  test("finding 2: a merge in progress in another worktree: unknown", async () => {
    const { base, work } = fixture();
    const wt = linked(base, work);
    sh(work, "checkout", "-q", "-b", "other");
    writeFileSync(path.join(work, "f"), "other\n");
    sh(work, "commit", "-q", "-am", "other");
    sh(work, "push", "-q", "origin", "other");
    sh(wt, "merge", "-q", "-s", "ours", "--no-commit", "other");
    expect(await pushed(work)).toEqual({ state: "unknown", why: "another worktree of skills has a merge in progress" });
  });

  test("finding 2: a worktree whose directory is gone: unknown", async () => {
    const { base, work } = fixture();
    const wt = linked(base, work);
    renameSync(wt, `${wt}-moved`);
    expect(await pushed(work)).toEqual({ state: "unknown", why: "a worktree of skills is missing its directory: muninn cannot check it" });
  });

  test(`finding 2: more than ${PUSHED_MAX_WORKTREES} worktrees: unknown`, async () => {
    const { base, work } = fixture();
    for (let i = 0; i < PUSHED_MAX_WORKTREES; i++) sh(work, "worktree", "add", "-q", "--detach", path.join(base, `w${i}`));
    expect(await pushed(work)).toEqual({ state: "unknown", why: `skills has over ${PUSHED_MAX_WORKTREES} worktrees: muninn does not check them all` });
  });
});

describe("pushed, real git: content filters", () => {
  for (const kind of ["clean", "process"]) {
    test(`finding 3: a configured filter.<x>.${kind} on an attributed, stat-dirty path: unknown, and the filter never runs`, async () => {
      const { base, work } = fixture();
      const ran = path.join(base, "filter-ran");
      sh(work, "config", `filter.mark.${kind}`, kind === "clean" ? `sh -c 'touch ${ran}; cat'` : `sh -c 'touch ${ran}; exit 1'`);
      writeFileSync(path.join(work, ".gitattributes"), "f filter=mark\n");
      sh(work, "-c", `filter.mark.${kind}=cat`, "add", ".gitattributes");
      sh(work, "-c", `filter.mark.${kind}=cat`, "commit", "-q", "-m", "attr");
      sh(work, "push", "-q", "origin", "HEAD:main");
      // Stat-dirty, so a comparison would read f through the filter.
      utimesSync(path.join(work, "f"), OLD, OLD);
      expect(existsSync(ran)).toBe(false);
      expect(await pushed(work)).toEqual({ state: "unknown", why: "git's config for skills names a content filter command: muninn does not run it" });
      expect(existsSync(ran)).toBe(false);
    });
  }

  test("finding 2 (verify pass): a filter only in the user's global config, used by no attribute: unknown, and the why does not blame the repo", async () => {
    const { base, work } = fixture();
    const global = path.join(base, "global-gitconfig");
    writeFileSync(global, "[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n");
    const git: ProbeDeps["git"] = (cwd, args, opts) => realGit(cwd, args, { ...opts, env: { ...opts?.env, GIT_CONFIG_GLOBAL: global } });
    const deps: ProbeDeps = { git, roots: { dirs: [], named: new Map([["skills", work]]) }, readEnvFile: async () => ({ missing: true }), processHasEnv: () => false, appliedMigrations: async () => new Set() };
    expect(await probePushed("skills", deps)).toEqual({ state: "unknown", why: "git's config for skills names a content filter command: muninn does not run it" });
  });
});
