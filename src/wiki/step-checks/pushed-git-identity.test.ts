/**
 * `pushed=` against real git: a worktree record is only trusted to be that
 * worktree when its directory's git dir is in cell 1 or 2 of
 * `refuseMisplacedWorktrees` (verify passes on PR #850). Each refusal row puts
 * a directory or git dir at a recorded path that is not the recorded worktree's,
 * while the record's index held a staged file or an unpushed commit sat at the
 * path; each answered `ok` before, except the cell-2 row, which pins the
 * back-link. Origin is a bare `skills.git`; every repo is under a temp dir.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

  /** A copy of w2's admin dir at `copy`, with an absolute `commondir`, and w2's `.git` file pointed at it. */
  const redirectW2 = (work: string, w2: string, copy: string) => {
    // Copied beside `work` first: a copy into the admin dir itself would recurse.
    const tmp = path.join(path.dirname(work), "admin-copy.tmp");
    cpSync(path.join(work, ".git", "worktrees", "w2"), tmp, { recursive: true });
    mkdirSync(path.dirname(copy), { recursive: true });
    renameSync(tmp, copy);
    writeFileSync(path.join(copy, "commondir"), `${path.join(work, ".git")}\n`);
    writeFileSync(path.join(w2, ".git"), `gitdir: ${copy}\n`);
  };
  const listedPaths = (work: string) => sh(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));

  test("(cell 3) repro A: w2's git dir a copy outside the common dir, the record's own index still staged: unknown", async () => {
    const { base, work, w2 } = fixture();
    redirectW2(work, w2, path.join(base, "xadmin"));
    sh(w2, "reset", "-q");
    // git lists nothing new and prunes nothing; the record's own index still holds the staged file.
    expect(listedPaths(work)).toEqual([`worktree ${work}`, `worktree ${w2}`]);
    expect(sh(work, "worktree", "prune", "--dry-run", "-v")).toBe("");
    expect(sh(work, "--git-dir", path.join(work, ".git", "worktrees", "w2"), "ls-files")).toContain("staged");
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(cell 3) repro B: w2's git dir nested inside its admin dir, an unpushed commit checked out at w2: unknown", async () => {
    const { work, w2 } = fixture();
    redirectW2(work, w2, path.join(work, ".git", "worktrees", "w2", "inner"));
    sh(w2, "checkout", "-q", "--detach");
    writeFileSync(path.join(w2, "new"), "n\n");
    sh(w2, "add", "new");
    sh(w2, "commit", "-q", "-m", "unpushed");
    // The listing still carries the record's HEAD (pushed `side`), not the commit checked out at w2.
    const listedHead = sh(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("HEAD "))[1];
    expect(listedHead).toBe(`HEAD ${sh(work, "rev-parse", "side")}`);
    expect(sh(w2, "rev-parse", "HEAD")).not.toBe(sh(work, "rev-parse", "side"));
    expect(listedPaths(work)).toEqual([`worktree ${work}`, `worktree ${w2}`]);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(cell 3) w2's git dir under a plain directory inside worktrees/, deeper than a direct child: unknown", async () => {
    const { work, w2 } = fixture();
    redirectW2(work, w2, path.join(work, ".git", "worktrees", "holder", "w2copy"));
    sh(w2, "reset", "-q");
    expect(listedPaths(work)).toEqual([`worktree ${work}`, `worktree ${w2}`]);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  test("(cell 2) a direct child of worktrees/ git does not list (its gitdir file garbled) standing at w2's path: unknown", async () => {
    const { base, work, w2 } = fixture();
    const w3 = path.join(base, "w3");
    sh(work, "worktree", "add", "-q", "-b", "third", w3);
    sh(w3, "push", "-q", "origin", "third");
    // An empty gitdir file: git drops w3 from the listing; then w3's clean directory takes w2's place.
    writeFileSync(path.join(work, ".git", "worktrees", "w3", "gitdir"), "");
    rmSync(w2, { recursive: true, force: true });
    renameSync(w3, w2);
    expect(listedPaths(work)).toEqual([`worktree ${work}`, `worktree ${w2}`]);
    expect(await pushed(work)).toEqual(MISPLACED);
  });

  describe("healthy setups stay ok (cells 1 and 2)", () => {
    test("plain worktree add, probed from main and from the linked worktree; then locked; then moved; then repaired", async () => {
      const { base, work, w2 } = fixture();
      sh(w2, "reset", "-q");
      expect((await pushed(work)).state).toBe("ok");
      expect((await pushed(w2)).state).toBe("ok");
      sh(work, "worktree", "lock", w2);
      expect((await pushed(work)).state).toBe("ok");
      sh(work, "worktree", "unlock", w2);
      const moved = path.join(base, "moved");
      sh(work, "worktree", "move", w2, moved);
      expect((await pushed(work)).state).toBe("ok");
      expect((await pushed(moved)).state).toBe("ok");
      // Moved by hand, then `repair` run from the worktree rewrites both links.
      const byHand = path.join(base, "by-hand");
      renameSync(moved, byHand);
      sh(byHand, "worktree", "repair");
      expect((await pushed(work)).state).toBe("ok");
      expect((await pushed(byHand)).state).toBe("ok");
    });

    test("under a symlinked parent directory, probed through the link: ok", async () => {
      const { base, work, w2 } = fixture();
      sh(w2, "reset", "-q");
      const link = path.join(path.dirname(base), `${path.basename(base)}-link`);
      symlinkSync(base, link);
      try {
        expect((await pushed(path.join(link, "work"))).state).toBe("ok");
        expect((await pushed(path.join(link, "w2"))).state).toBe("ok");
        // A worktree added through the link records the link's spelling.
        const viaLink = path.join(link, "w3");
        sh(path.join(link, "work"), "worktree", "add", "-q", "-b", "third", viaLink);
        sh(viaLink, "push", "-q", "origin", "third");
        expect((await pushed(path.join(link, "work"))).state).toBe("ok");
      } finally {
        unlinkSync(link);
      }
    });

    test("a bare main repository with linked worktrees, probed from each: ok", async () => {
      const { base, remote } = fixture();
      const bare = path.join(base, "main.git");
      sh(base, "clone", "-q", "--bare", remote, bare);
      sh(bare, "config", "remote.origin.url", remote);
      const a = path.join(base, "a");
      const b = path.join(base, "b");
      sh(bare, "worktree", "add", "-q", a, "main");
      sh(bare, "worktree", "add", "-q", b, "side");
      expect((await pushed(a)).state).toBe("ok");
      expect((await pushed(b)).state).toBe("ok");
    });
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
