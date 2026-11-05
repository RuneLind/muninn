import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
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
