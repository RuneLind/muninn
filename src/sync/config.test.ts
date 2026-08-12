import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { parseSyncRepos, syncCoversToplevel, type SyncRepo } from "./config.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../");

function wiki(name: string, root: string, collections?: string[]): WikiRegistryEntry {
  return { name, root, source: "extra", ...(collections ? { collections } : {}) };
}

describe("parseSyncRepos", () => {
  test("parses the documented three-mode example", () => {
    const wikis = [wiki("mimir", path.resolve(REPO_ROOT, "../mimir"), ["mimir"])];
    const { repos, warnings } = parseSyncRepos(
      "mimir=../mimir:wiki,claude-skills=~/.claude/skills:plain,muninn=.:status-only",
      wikis,
    );
    expect(warnings).toEqual([]);
    expect(repos.map((r) => [r.name, r.mode])).toEqual([
      ["mimir", "wiki"],
      ["claude-skills", "plain"],
      ["muninn", "status-only"],
    ]);
    // Same resolution the wiki registry uses: `~` expanded, relative resolved
    // against the muninn repo root.
    expect(repos[1]!.path).toBe(path.join(homedir(), ".claude/skills"));
    expect(repos[2]!.path).toBe(REPO_ROOT);
    // The wiki entry carries the REGISTRY's root string + collections, so the
    // write-lock key and the reindex kick both come from one source.
    expect(repos[0]!.wikiRoot).toBe(wikis[0]!.root);
    expect(repos[0]!.wikiName).toBe("mimir");
    expect(repos[0]!.collections).toEqual(["mimir"]);
  });

  test("an unset / blank env yields nothing, quietly", () => {
    expect(parseSyncRepos(undefined, []).repos).toEqual([]);
    expect(parseSyncRepos("   ", []).repos).toEqual([]);
    expect(parseSyncRepos(" , ,", []).warnings).toEqual([]);
  });

  test("wiki mode REQUIRES a registered wiki root — an unmatched path is dropped, not downgraded", () => {
    // Silently downgrading to `plain` would leave the machine committing nothing
    // while the card claimed the repo was covered.
    const { repos, warnings } = parseSyncRepos("notes=/tmp/nowhere-wiki:wiki", []);
    expect(repos).toEqual([]);
    expect(warnings[0]).toContain("needs a REGISTERED wiki root");
  });

  test("wiki mode matches through a trailing slash and a symlinked prefix", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "sync-cfg-"));
    try {
      const root = path.join(base, "vault");
      await mkdir(root, { recursive: true });
      // macOS /tmp is a symlink to /private/tmp — the registry may hold either
      // spelling and the two must still match.
      const { repos, warnings } = parseSyncRepos(`v=${root}/:wiki`, [wiki("v", root)]);
      expect(warnings).toEqual([]);
      expect(repos).toHaveLength(1);
      expect(repos[0]!.wikiName).toBe("v");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a nested wiki root (huginn-jarvis shape) resolves against its own path, not the toplevel", () => {
    const root = "/repos/huginn-jarvis/data/wiki";
    const { repos } = parseSyncRepos(`jarvis=${root}:wiki`, [wiki("jarvis", root)]);
    expect(repos[0]!.path).toBe(root);
    expect(repos[0]!.wikiRoot).toBe(root);
  });

  test("malformed, unknown-mode and duplicate entries are dropped with a reason", () => {
    const { repos, warnings } = parseSyncRepos(
      "noequals,missingmode=/a/b,bad=/a/b:sideways,ok=/a/b:plain,ok=/c/d:plain",
      [],
    );
    expect(repos.map((r) => r.name)).toEqual(["ok"]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("malformed");
    expect(warnings[1]).toContain("malformed");
    expect(warnings[2]).toContain('unknown mode "sideways"');
    expect(warnings[3]).toContain("duplicate name");
  });

  test("a colon-carrying path keeps its colons — the mode is the LAST segment", () => {
    const { repos } = parseSyncRepos("odd=/a/b:c/d:plain", []);
    expect(repos[0]!.path).toBe("/a/b:c/d");
    expect(repos[0]!.mode).toBe("plain");
  });

  test("whitespace around every part is tolerated", () => {
    const { repos, warnings } = parseSyncRepos("  x = /a/b : plain  ", []);
    expect(warnings).toEqual([]);
    expect(repos[0]).toMatchObject({ name: "x", path: "/a/b", mode: "plain" });
  });

  test("a collection-less wiki carries no collections field (⇒ no reindex kick)", () => {
    const { repos } = parseSyncRepos("v=/w:wiki", [wiki("v", "/w")]);
    expect(repos[0]!.collections).toBeUndefined();
  });
});

describe("syncCoversToplevel (sweeper subsumption)", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "sync-subsume-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  }

  test("a wiki-mode entry covers its repo — including a wiki nested below the toplevel", async () => {
    const repo = path.join(base, "repo");
    const wikiDir = path.join(repo, "data", "wiki");
    await mkdir(wikiDir, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    const top = repo;

    const covered: SyncRepo[] = [
      { name: "jarvis", path: wikiDir, mode: "wiki", wikiName: "jarvis", wikiRoot: wikiDir },
    ];
    expect(await syncCoversToplevel(top, covered)).toBe(true);
  });

  test("a plain / status-only entry does NOT subsume the sweeper", async () => {
    const repo = path.join(base, "repo2");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    expect(
      await syncCoversToplevel(repo, [{ name: "r", path: repo, mode: "plain" }]),
    ).toBe(false);
    expect(
      await syncCoversToplevel(repo, [{ name: "r", path: repo, mode: "status-only" }]),
    ).toBe(false);
  });

  test("an unrelated repo is not covered", async () => {
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await git(a, ["init", "-b", "main"]);
    await git(b, ["init", "-b", "main"]);
    expect(
      await syncCoversToplevel(b, [{ name: "a", path: a, mode: "wiki", wikiRoot: a }]),
    ).toBe(false);
  });

  test("no configured repos ⇒ the sweeper keeps working exactly as before", async () => {
    const repo = path.join(base, "repo3");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    expect(await syncCoversToplevel(repo, [])).toBe(false);
  });
});
