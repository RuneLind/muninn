import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { cardTokens, cutLine, defaultBranch, findRepo, isSafeRepoName, originBasename, parseRepoRoots, realGit, resolveRepo } from "./git.ts";
import { commitAt, git, pushMain, repoWithOrigin, write } from "./test-repo.ts";

const temp = () => testTempDirSync(path.join(tmpdir(), "triage-git-"));

describe("what page text may hand git", () => {
  test("a token is a backticked string of the allowed characters, Norwegian letters included", () => {
    const body = "`src/a.ts` `beløpÆøå_id` `pkg:tool` `-rf` `--output=/tmp/x` `:(glob)**` `a b` `$(touch x)` `" + "x".repeat(121) + "`";
    expect(cardTokens(body)).toEqual(["src/a.ts", "beløpÆøå_id", "pkg:tool"]);
  });

  test("at most 8 tokens, first ones first, no repeats", () => {
    const tokens = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(cardTokens(["t0", ...tokens].map((t) => `\`${t}\``).join(" "))).toEqual(tokens.slice(0, 8));
  });

  test("a repo name is one safe path part", () => {
    for (const bad of ["..", ".", "a/b", "../evil", "a b", "", "$(x)"]) expect(isSafeRepoName(bad)).toBe(false);
    for (const good of ["muninn", "some-repo", "a.b_c"]) expect(isSafeRepoName(good)).toBe(true);
  });

  test("a hostile repo name resolves to nothing and touches no folder outside the roots", async () => {
    const root = temp();
    mkdirSync(path.join(root, "src"));
    const outside = path.join(root, "outside");
    repoWithOrigin(outside, path.join(root, "bare"), "outside");
    const roots = parseRepoRoots(path.join(root, "src"));
    expect(await findRepo("../outside", roots, realGit)).toEqual({ reason: "not a repo name" });
    expect(await findRepo("..", roots, realGit)).toEqual({ reason: "not a repo name" });
  });

  test("a hostile token searched for stays a literal: no flag, no pathspec magic, no file written", async () => {
    const root = temp();
    const dir = path.join(root, "code");
    repoWithOrigin(dir, path.join(root, "bare"), "code");
    write(dir, "a.txt", "plain :(glob)x line\nGIT_DIR is here\n");
    commitAt(dir, "2026-10-01T10:00:00Z", "first");
    pushMain(dir);
    const hit = await realGit(dir, ["grep", "-I", "-n", "-F", "-e", ":(glob)x", "refs/remotes/origin/main", "--"]);
    expect(hit.stdout).toContain("a.txt:1:");
    // Pathspec magic after `--` is a literal path under --literal-pathspecs: no match.
    const magic = await realGit(dir, ["log", "-1", "--format=%h", "refs/remotes/origin/main", "--", ":(glob)**"]);
    expect(magic.stdout.trim()).toBe("");
    const out = path.join(root, "pwned");
    const flag = await realGit(dir, ["grep", "-I", "-F", "-e", `--output=${out}`, "refs/remotes/origin/main", "--"]);
    expect(flag.stdout).toBe("");
    expect(existsSync(out)).toBe(false);
  });

  test("a case-folded clone counts as not found: the origin's basename must match exactly", async () => {
    const root = temp();
    const clones = path.join(root, "src");
    // The folder as a case-folding disk would open it, the origin of an unrelated repo.
    repoWithOrigin(path.join(clones, "tools"), path.join(root, "bare"), "Tools");
    const found = await findRepo("tools", parseRepoRoots(clones), realGit);
    expect(found).toEqual({ reason: "origin names another repo" });
  });

  test("name=path reaches a repo elsewhere, and still must match; a folder inside a repo is not one", async () => {
    const root = temp();
    const dir = path.join(root, "elsewhere", "folder");
    repoWithOrigin(dir, path.join(root, "bare"), "tools");
    expect(await findRepo("tools", parseRepoRoots(`tools=${dir}`), realGit)).toEqual({ dir: expect.any(String) });
    expect(await findRepo("other", parseRepoRoots(`other=${dir}`), realGit)).toEqual({ reason: "origin names another repo" });
    mkdirSync(path.join(dir, "tools"));
    expect(await findRepo("tools", parseRepoRoots(dir), realGit)).toEqual({ reason: "the folder is not a repo's root" });
  });
});

describe("the ref", () => {
  test("origin's default branch, never HEAD, and a failed fetch is a fact", async () => {
    const root = temp();
    const dir = path.join(root, "code");
    const bare = repoWithOrigin(dir, path.join(root, "bare"), "code");
    write(dir, "a.txt", "one\n");
    commitAt(dir, "2026-10-01T10:00:00Z", "on main");
    pushMain(dir);
    git(dir, "checkout", "-q", "-b", "old-feature");
    write(dir, "a.txt", "feature\n");
    commitAt(dir, "2026-10-02T10:00:00Z", "on a feature");
    expect(await defaultBranch(dir, realGit)).toBe("main");
    const ok = await resolveRepo("code", parseRepoRoots(path.dirname(dir)), realGit, { fetch: true });
    expect(ok.fact).toMatchObject({ repo: "code", found: true, ref: "origin/main", fetch: "ok" });
    expect(ok.fact.tipDate).toStartWith("2026-10-01");
    git(dir, "remote", "set-url", "origin", `${bare}-gone`);
    // The rename keeps the basename check honest: still "code.git-gone" is not "code".
    git(dir, "remote", "set-url", "origin", path.join(path.dirname(bare), "gone", "code.git"));
    const failed = await resolveRepo("code", parseRepoRoots(path.dirname(dir)), realGit, { fetch: true });
    expect(failed.fact.found).toBe(true);
    expect(typeof failed.fact.fetch).toBe("object");
  });
});

test("the runner stops at maxLines, and lines are cut at 300", async () => {
  const dir = temp();
  git(dir, "init", "-q");
  write(dir, "a.txt", `${Array.from({ length: 5000 }, (_, i) => `needle ${i}`).join("\n")}\n`);
  commitAt(dir, "2026-10-01T10:00:00Z", "many");
  const res = await realGit(dir, ["grep", "-n", "-F", "-e", "needle", "HEAD", "--"], { maxLines: 40 });
  expect(res.ok).toBe(true);
  expect(res.capped).toBe(true);
  expect(res.stdout.split("\n").length).toBe(40);
  expect(cutLine("x".repeat(400)).length).toBe(301);
});

test("originBasename takes ssh and https forms, with .git stripped once", () => {
  expect(originBasename("git@github.com:o/repo.git\n")).toBe("repo");
  expect(originBasename("https://github.com/o/repo")).toBe("repo");
  expect(originBasename("https://github.com/o/repo.git/")).toBe("repo");
  expect(originBasename("git@host:repo.git")).toBe("repo");
});

describe("the runner's bound holds whatever the child does", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });
  /** A `git` on PATH running `body`; `$PIDS` names a file for a child's pid. */
  function fakeGit(body: string) {
    const bin = temp();
    const pids = path.join(bin, "pids");
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nPIDS=${pids}\n${body}\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    return { bin, pids };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** The transport child: survives a kill of `git` alone, and holds both pipes. */
  const TRANSPORT = "sleep 8 &\necho $! > $PIDS";

  test("a child holding the pipes: back at the timeout, marked, and the child is gone", async () => {
    const { bin, pids } = fakeGit(`${TRANSPORT}\nwait`);
    const started = Date.now();
    const res = await realGit(bin, ["fetch", "origin"], { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    await Bun.sleep(50);
    expect(alive(Number(readFileSync(pids, "utf8").trim()))).toBe(false);
  });

  test("a child holding stderr after the cap: back at once with the lines it got", async () => {
    const { bin } = fakeGit(`${TRANSPORT}\nprintf 'a\\nb\\nc\\nd\\n'\nwait`);
    const started = Date.now();
    const res = await realGit(bin, ["grep", "x"], { maxLines: 2, timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res).toMatchObject({ ok: true, capped: true, stdout: "a\nb" });
    expect(res.timedOut).toBeUndefined();
  });

  test("the argv and the allowlisted environment stay as they were", async () => {
    const { bin } = fakeGit(`echo "$@"\nenv`);
    process.env.TRIAGE_TEST_SECRET = "s3cret";
    try {
      const res = await realGit(bin, ["status"]);
      expect(res.stdout).toStartWith("--no-pager --no-optional-locks --literal-pathspecs status\n");
      expect(res.stdout).toContain("GIT_TERMINAL_PROMPT=0");
      expect(res.stdout).not.toContain("s3cret");
    } finally {
      delete process.env.TRIAGE_TEST_SECRET;
    }
  });
});
