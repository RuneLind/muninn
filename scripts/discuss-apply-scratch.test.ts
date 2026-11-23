/**
 * `scratchCopy` (`scripts/discuss-apply-scratch-copy.ts`): the copy Apply
 * writes and commits into must be a repository of its own whatever `--src` is.
 * A linked worktree's `.git` is a `gitdir:` pointer file; copied as it is, the
 * copy shared the source's config, objects, HEAD and index, so removing the
 * copy's remotes removed the source's. Throwaway repos only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onDefaultBranch } from "../src/wiki/commit.ts";
import { testTempDir } from "../src/test/temp-dir.ts";
import { scratchCopy } from "./discuss-apply-scratch-copy.ts";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();

let dir = "";
let main = "";
let worktree = "";

beforeAll(async () => {
  dir = await testTempDir(path.join(tmpdir(), "muninn-scratch-copy-"));
  main = path.join(dir, "a");
  worktree = path.join(dir, "w");
  git(dir, "init", "-q", "-b", "main", main);
  await Bun.write(path.join(main, "p.md"), "main page\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "one");
  git(main, "remote", "add", "origin", "https://example.invalid/wiki.git");
  git(main, "worktree", "add", "-q", "-b", "side", worktree);
  await Bun.write(path.join(worktree, "s.md"), "side page\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "side");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scratchCopy", () => {
  test("from a linked worktree: the source keeps its remote and the copy is a repository of its own", () => {
    expect(statSync(path.join(worktree, ".git")).isFile()).toBe(true);
    const dest = path.join(dir, "copy-of-w");
    scratchCopy(worktree, dest, ENV);
    expect(git(main, "remote")).toBe("origin");
    expect(git(dest, "remote")).toBe("");
    expect(statSync(path.join(dest, ".git")).isDirectory()).toBe(true);
    expect(realpathSync(git(dest, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(realpathSync(path.join(dest, ".git")));
    // The worktree's committed page comes along.
    expect(existsSync(path.join(dest, "s.md"))).toBe(true);
    // A commit in the copy lands in the copy only.
    const sideHead = git(main, "rev-parse", "side");
    git(dest, "commit", "-q", "--allow-empty", "-m", "applied");
    expect(git(main, "rev-parse", "side")).toBe(sideHead);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(sideHead);
  });

  test("from a worktree on a feature branch: the copy is on its default branch at the worktree's commit, so Apply commits there (fix round 2 batch 3)", async () => {
    const dest = path.join(dir, "copy-of-w-default");
    scratchCopy(worktree, dest, ENV);
    expect(git(dest, "branch", "--show-current")).toBe("main");
    expect(git(dest, "rev-parse", "HEAD")).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(await onDefaultBranch(dest)).toBe(true);
  });

  test("shares no object with the source: no alternates, no hard link (fix round 2 batch 3)", () => {
    const dest = path.join(dir, "copy-no-links");
    scratchCopy(main, dest, ENV);
    expect(existsSync(path.join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
    const files = (readdirSync(path.join(dest, ".git", "objects"), { recursive: true }) as string[]).map((f) => path.join(dest, ".git", "objects", f)).filter((f) => statSync(f).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(statSync(f).nlink).toBe(1);
  });

  test("a GIT_DIR in the environment: refused before any remote is removed, and no half-made copy is left (fix round 2 batch 3)", async () => {
    const victim = path.join(dir, "victim");
    git(dir, "init", "-q", "-b", "main", victim);
    await Bun.write(path.join(victim, "v.md"), "v\n");
    git(victim, "add", "-A");
    git(victim, "commit", "-q", "-m", "v");
    git(victim, "remote", "add", "origin", "https://example.invalid/victim.git");
    const dest = path.join(dir, "copy-under-git-dir");
    expect(() => scratchCopy(main, dest, { ...ENV, GIT_DIR: path.join(victim, ".git") })).toThrow(/git dir is/);
    expect(git(victim, "remote")).toBe("origin");
    expect(existsSync(dest)).toBe(false);
  });

  test("from a main checkout: the source keeps its remote, the copy has none", () => {
    const dest = path.join(dir, "copy-of-a");
    scratchCopy(main, dest, ENV);
    expect(git(main, "remote")).toBe("origin");
    expect(git(dest, "remote")).toBe("");
    expect(git(dest, "branch", "--show-current")).toBe("main");
  });

  test("refuses a destination that exists and a source that is not a repository root", async () => {
    expect(() => scratchCopy(main, worktree, ENV)).toThrow(/exists already/);
    const plain = path.join(dir, "plain");
    await Bun.write(path.join(plain, "x.md"), "x\n");
    expect(() => scratchCopy(plain, path.join(dir, "copy-of-plain"), ENV)).toThrow(/not the root of a git work tree/);
  });
});
