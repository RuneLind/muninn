/**
 * `checkout=` (and `pushed=`'s repo lookup) against real git on throwaway
 * repos: the three paths that answered `ok` without proof. A named roots entry
 * that is not the repo fell through to another clone; a `pull --rebase`
 * stopped on a conflict left HEAD on origin's tip; a local origin was believed.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { hermeticGit, networkOrigin } from "../../test/hermetic-git.ts";
import type { RepoRoots } from "../decision-triage/git.ts";
import { probeCheckout, probePushed, type ProbeDeps } from "./probes.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
/** Exit code of a git command expected to fail (a stopped pull or merge). */
const shCode = (cwd: string, ...args: string[]) => {
  try {
    sh(cwd, ...args);
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
};
const NETWORK = networkOrigin("https://example.invalid/muninn.git");

const commit = (dir: string, text: string) => {
  writeFileSync(path.join(dir, "f"), `${text}\n`);
  sh(dir, "commit", "-q", "-am", text);
  return sh(dir, "rev-parse", "HEAD");
};

/** A bare `<name>.git` with one commit on main, the work clone that pushed it, and an up-to-date clone at `<base>/<name>`. */
function fixture(base: string, name = "muninn") {
  const remote = path.join(base, `${name}.git`);
  const work = path.join(base, `${name}-work`);
  const clone = path.join(base, name);
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  sh(work, "add", "f");
  sh(work, "commit", "-q", "-m", "one");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  sh(base, "clone", "-q", remote, clone);
  return { remote, work, clone };
}

const newBase = () => realpathSync(testTempDirSync(path.join(tmpdir(), "step-checkout-git-")));

const depsWith = (roots: RepoRoots, git = NETWORK): ProbeDeps => ({
  git,
  roots,
  readEnvFile: async () => ({ missing: true }),
  processHasEnv: () => false,
  appliedMigrations: async () => new Set(),
});

describe("R1: a named roots entry is the only candidate", () => {
  for (const [kind, probe] of [["checkout", probeCheckout], ["pushed", probePushed]] as const) {
    test(`${kind}: the named folder is gone, an up-to-date clone sits under a root dir: unknown, never that other clone's ok`, async () => {
      const base = newBase();
      const { clone } = fixture(base);
      const roots: RepoRoots = { dirs: [base], named: new Map([["muninn", path.join(base, "gone")]]) };
      // The precondition: the clone under the root dir is the repo, up to date.
      expect((await probe("muninn", depsWith({ dirs: [base], named: new Map() }))).state).toBe("ok");
      expect(existsSync(path.join(base, "gone"))).toBe(false);
      expect(existsSync(clone)).toBe(true);
      expect(await probe("muninn", depsWith(roots))).toEqual({ state: "unknown", why: "muninn's entry in the repo roots is not that repo: no such folder under the roots" });
    });

    test(`${kind}: the named folder is a repo whose origin names another repo: unknown, never the fall-through clone's ok`, async () => {
      const base = newBase();
      fixture(base);
      const { clone: other } = fixture(base, "other");
      const roots: RepoRoots = { dirs: [base], named: new Map([["muninn", other]]) };
      expect(await probe("muninn", depsWith(roots))).toEqual({ state: "unknown", why: "muninn's entry in the repo roots is not that repo: origin names another repo" });
    });
  }

  for (const [kind, probe] of [["checkout", probeCheckout], ["pushed", probePushed]] as const) {
    test(`${kind}: a roots key naming the repo in another letter case: unknown, never the root dir's clone`, async () => {
      const base = newBase();
      fixture(base);
      const roots: RepoRoots = { dirs: [base], named: new Map([["Muninn", path.join(base, "gone")]]) };
      expect(await probe("muninn", depsWith(roots))).toEqual({ state: "unknown", why: "the repo roots name muninn in another letter case: muninn cannot tell whether that entry is this repo" });
    });

    test(`${kind}: an exact key beside a letter-case variant: the exact entry wins`, async () => {
      const base = newBase();
      const { clone } = fixture(base);
      const roots: RepoRoots = { dirs: [], named: new Map([["muninn", clone], ["Muninn", path.join(base, "gone")]]) };
      expect((await probe("muninn", depsWith(roots))).state).toBe("ok");
    });

    test(`${kind}: a key that is another name: the root dirs are still searched`, async () => {
      const base = newBase();
      fixture(base);
      const roots: RepoRoots = { dirs: [base], named: new Map([["muninn-old", path.join(base, "gone")]]) };
      expect((await probe("muninn", depsWith(roots))).state).toBe("ok");
    });
  }

  test("no named entry for the name: the clone under a root dir is still found", async () => {
    const base = newBase();
    fixture(base);
    const roots: RepoRoots = { dirs: [base], named: new Map([["other", path.join(base, "gone")]]) };
    expect((await probeCheckout("muninn", depsWith(roots))).state).toBe("ok");
    expect((await probePushed("muninn", depsWith(roots))).state).toBe("ok");
    // And a name with neither keeps the old why.
    expect((await probeCheckout("huginn", depsWith(roots))).why).toBe("huginn not found under the repo roots: no such folder under the roots");
  });
});

describe("R2: an operation in progress is unknown", () => {
  test("a pull --rebase stopped on a conflict, HEAD already on origin's tip: unknown", async () => {
    const base = newBase();
    const { work, clone } = fixture(base);
    const tip = commit(work, "two from origin");
    sh(work, "push", "-q", "origin", "HEAD:main");
    commit(clone, "two here");
    expect(shCode(clone, "pull", "-q", "--rebase", "origin", "main")).not.toBe(0);
    // The precondition the old ok needed: a rebase is stopped and HEAD contains origin's tip.
    const gitDir = path.join(clone, ".git");
    expect(existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"))).toBe(true);
    expect(shCode(clone, "merge-base", "--is-ancestor", tip, "HEAD")).toBe(0);
    expect(await probeCheckout("muninn", depsWith({ dirs: [], named: new Map([["muninn", clone]]) }))).toEqual({ state: "unknown", why: "muninn has a rebase in progress" });
  });

  test("a merge stopped on a conflict, HEAD ahead of origin's tip: unknown", async () => {
    const base = newBase();
    const { clone } = fixture(base);
    const tip = sh(clone, "rev-parse", "HEAD");
    sh(clone, "checkout", "-q", "-b", "side");
    commit(clone, "side");
    sh(clone, "checkout", "-q", "main");
    commit(clone, "main here");
    expect(shCode(clone, "merge", "-q", "side")).not.toBe(0);
    expect(existsSync(path.join(clone, ".git", "MERGE_HEAD"))).toBe(true);
    expect(shCode(clone, "merge-base", "--is-ancestor", tip, "HEAD")).toBe(0);
    expect(await probeCheckout("muninn", depsWith({ dirs: [], named: new Map([["muninn", clone]]) }))).toEqual({ state: "unknown", why: "muninn has a merge in progress" });
  });
});

describe("R3: an origin that is not a network address is unknown", () => {
  test("an up-to-date clone of a local bare: unknown; the same clone with a network URL: ok", async () => {
    const base = newBase();
    const { clone } = fixture(base);
    const roots: RepoRoots = { dirs: [], named: new Map([["muninn", clone]]) };
    expect(await probeCheckout("muninn", depsWith(roots, hermeticGit))).toEqual({ state: "unknown", why: "muninn's origin is not a network address: muninn cannot prove it is another repository" });
    expect((await probeCheckout("muninn", depsWith(roots, NETWORK))).state).toBe("ok");
  });
});
