/**
 * `pushed=` against real git: a worktree record is only trusted to be that
 * worktree when the records and the git dirs are in bijection inside one
 * repository (verify pass on PR #850, finding 1). Each row put a directory at a
 * recorded path that is not the recorded worktree, while the recorded
 * worktree's index held a staged file; each answered `ok` before. Origin is a
 * bare `skills.git`; every repo is under a temp dir.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realGit } from "../decision-triage/git.ts";
import { probePushed, type ProbeDeps, type ProbeResult } from "./probes.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

const MISPLACED: ProbeResult = { state: "unknown", why: "a worktree of skills is not where git recorded it" };

/** origin, a work clone that pushed `f`, and linked worktree `w2` on pushed branch `side` with a file staged in its index. */
function fixture() {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-pushed-identity-")));
  const remote = path.join(base, "skills.git");
  const work = path.join(base, "work");
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  sh(work, "add", "f");
  sh(work, "commit", "-q", "-m", "one");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  const w2 = path.join(base, "w2");
  sh(work, "worktree", "add", "-q", "-b", "side", w2);
  sh(w2, "push", "-q", "origin", "side");
  writeFileSync(path.join(w2, "staged"), "s\n");
  sh(w2, "add", "staged");
  return { base, remote, work, w2 };
}

const pushed = (clone: string) => {
  const deps: ProbeDeps = {
    git: realGit,
    roots: { dirs: [], named: new Map([["skills", clone]]) },
    readEnvFile: async () => ({ missing: true }),
    processHasEnv: () => false,
    appliedMigrations: async () => new Set(),
  };
  return probePushed("skills", deps);
};

describe("pushed, real git: a worktree record is that worktree", () => {
  test("precondition: the staged file in w2 reads not-yet", async () => {
    const { work } = fixture();
    expect(await pushed(work)).toEqual({ state: "not-yet", why: "skills has uncommitted changes in another worktree (on side): commit and push" });
  });

  test("(i) w2 replaced by a fresh clone of origin, its record's index still holding the staged file: unknown", async () => {
    const { base, remote, work, w2 } = fixture();
    rmSync(w2, { recursive: true, force: true });
    sh(base, "clone", "-q", remote, w2);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(i) w2 replaced by a linked worktree of another repository, recorded there at w2's path: unknown", async () => {
    const { base, remote, work, w2 } = fixture();
    const elsewhere = path.join(base, "elsewhere");
    sh(base, "clone", "-q", remote, elsewhere);
    rmSync(w2, { recursive: true, force: true });
    sh(elsewhere, "worktree", "add", "-q", "--detach", w2);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(ii) w2's worktree config moves its working tree elsewhere: unknown", async () => {
    const { base, work, w2 } = fixture();
    const other = path.join(base, "other-tree");
    mkdirSync(other);
    writeFileSync(path.join(other, "f"), "one\n");
    writeFileSync(path.join(other, "staged"), "s\n");
    sh(work, "config", "extensions.worktreeConfig", "true");
    sh(w2, "config", "--worktree", "core.worktree", other);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(iii) a second record whose path is a symlink to w2: the two resolve to one directory, unknown", async () => {
    const { base, work, w2 } = fixture();
    const w3 = path.join(base, "w3");
    sh(work, "worktree", "add", "-q", "-b", "third", w3);
    sh(w3, "push", "-q", "origin", "third");
    // The staged file moves to w3's index; w2 is clean.
    sh(w2, "reset", "-q");
    writeFileSync(path.join(w3, "staged"), "s\n");
    sh(w3, "add", "staged");
    rmSync(w3, { recursive: true, force: true });
    symlinkSync(w2, w3);
    expect(await pushed(work)).toEqual({ state: "unknown", why: "two worktrees of skills resolve to one directory" });
  });

  test("(iv) w2 replaced by another worktree of this repo whose record git no longer lists: unknown", async () => {
    const { base, work, w2 } = fixture();
    const w3 = path.join(base, "w3");
    sh(work, "worktree", "add", "-q", "-b", "third", w3);
    sh(w3, "push", "-q", "origin", "third");
    // w3's record loses its back-link, so git lists only main and w2; then w3's clean directory takes w2's place.
    unlinkSync(path.join(work, ".git", "worktrees", "w3", "gitdir"));
    rmSync(w2, { recursive: true, force: true });
    renameSync(w3, w2);
    expect(sh(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(2);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(iv) two worktrees that swapped directories: unknown", async () => {
    const { base, work, w2 } = fixture();
    const w3 = path.join(base, "w3");
    sh(work, "worktree", "add", "-q", "-b", "third", w3);
    sh(w3, "push", "-q", "origin", "third");
    renameSync(w2, `${w2}-tmp`);
    renameSync(w3, w2);
    renameSync(`${w2}-tmp`, w3);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("a clean worktree recorded with --relative-paths: ok", async () => {
    const { base, work, w2 } = fixture();
    sh(w2, "reset", "-q");
    const rel = path.join(base, "rel");
    sh(work, "worktree", "add", "-q", "--relative-paths", "-b", "rel", rel);
    sh(rel, "push", "-q", "origin", "rel");
    expect((await pushed(work)).state).toBe("ok");
  });
});
