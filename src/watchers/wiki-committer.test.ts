import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWikiCommitter } from "./wiki-committer.ts";
import { wikiDirtyStat, __resetForTest } from "../wiki/commit.ts";
import type { Watcher } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";

/** Run `git -C <cwd> <args…>` in a fixture repo, returning trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  return { code, out };
}

/**
 * Fixture repo with the wiki nested at repo/data/wiki (the real huginn-jarvis
 * layout) and one initial commit carrying a tracked wiki page + a root README.
 * Returns { repo, wikiDir }.
 */
async function makeRepo(base: string): Promise<{ repo: string; wikiDir: string }> {
  const repo = await mkdtemp(path.join(base, "repo-"));
  const wikiDir = path.join(repo, "data", "wiki");
  await mkdir(path.join(wikiDir, "concepts"), { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "a@b.c"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(repo, "README.md"), "root\n");
  await writeFile(path.join(wikiDir, "concepts", "Old.md"), "# Old\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, wikiDir };
}

/** Minimal BotConfig for the sweeper — only name/dir/wikiDir/push are read. */
function botConfig(wikiDir: string): BotConfig {
  return {
    name: "jarvis",
    dir: path.dirname(wikiDir),
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    wikiDir,
    wikiAutoCommit: { push: false },
  } as unknown as BotConfig;
}

const watcher = { type: "wiki-committer", config: {} } as unknown as Watcher;

describe("checkWikiCommitter (sweep core)", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    base = await mkdtemp(path.join(tmpdir(), "wiki-committer-"));
  });
  afterEach(async () => {
    __resetForTest();
    await rm(base, { recursive: true, force: true });
  });

  test("commits a modified + untracked + deleted file in ONE [sweep] commit; tree clean", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    // First, commit a page we will later delete (a tracked deletion needs a
    // committed baseline).
    await mkdir(path.join(wikiDir, "entities"), { recursive: true });
    await writeFile(path.join(wikiDir, "entities", "Gone.md"), "# Gone\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "add Gone"]);
    // Now dirty three ways: (1) modify a tracked page, (2) add an untracked new
    // page, (3) delete a tracked page.
    await writeFile(path.join(wikiDir, "concepts", "Old.md"), "# Old\nchanged\n");
    await writeFile(path.join(wikiDir, "concepts", "New.md"), "# New\n");
    await unlink(path.join(wikiDir, "entities", "Gone.md"));

    const alerts = await checkWikiCommitter(watcher, botConfig(wikiDir));

    // One low-urgency sweep alert naming the count.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.source).toBe("wiki-committer");
    expect(alerts[0]!.summary).toContain("3 uncommitted wiki files");

    // Exactly one new commit with the [sweep] subject and the exact literal.
    const subject = await git(repo, ["log", "--format=%s", "-1"]);
    expect(subject.out).toBe("[sweep] daily wiki sweep: 3 files");

    // The commit lists all three files (body) and records the deletion.
    const body = await git(repo, ["log", "--format=%b", "-1"]);
    expect(body.out).toContain("- concepts/Old.md");
    expect(body.out).toContain("- concepts/New.md");
    expect(body.out).toContain("- entities/Gone.md");

    // The tracked deletion is recorded as a delete, the new file as an add.
    const nameStatus = await git(repo, ["show", "--name-status", "--format=", "HEAD"]);
    expect(nameStatus.out).toContain("D\tdata/wiki/entities/Gone.md");
    expect(nameStatus.out).toContain("A\tdata/wiki/concepts/New.md");
    expect(nameStatus.out).toContain("M\tdata/wiki/concepts/Old.md");

    // Working tree is clean afterward.
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status.out).toBe("");
  });

  test("off the default branch → no-op (no commit, dirt preserved)", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(wikiDir, "concepts", "New.md"), "# New\n");

    const alerts = await checkWikiCommitter(watcher, botConfig(wikiDir));

    expect(alerts).toHaveLength(0);
    // No new commit; the untracked file is still dirty.
    const subject = await git(repo, ["log", "--format=%s", "-1"]);
    expect(subject.out).toBe("init");
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status.out).toContain("data/wiki/concepts/New.md");
  });

  test("clean wiki subtree → no-op, no alert", async () => {
    const { wikiDir } = await makeRepo(base);
    const alerts = await checkWikiCommitter(watcher, botConfig(wikiDir));
    expect(alerts).toHaveLength(0);
  });

  test("dirt OUTSIDE the wiki subtree is never swept", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    // Dirty a file outside data/wiki and a legit wiki page.
    await writeFile(path.join(repo, "README.md"), "root changed\n");
    await writeFile(path.join(wikiDir, "concepts", "New.md"), "# New\n");

    const alerts = await checkWikiCommitter(watcher, botConfig(wikiDir));
    expect(alerts).toHaveLength(1);

    // Only the wiki page was committed.
    const names = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("data/wiki/concepts/New.md");
    // README stays dirty (untouched).
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status.out).toContain("README.md");
    expect(status.out).not.toContain("data/wiki");
  });

  test("no wikiDir → returns [] (skip)", async () => {
    const cfg = { name: "jarvis", dir: "/tmp" } as unknown as BotConfig;
    const alerts = await checkWikiCommitter(watcher, cfg);
    expect(alerts).toHaveLength(0);
  });

  test("wikiDir outside any git repo → no-op", async () => {
    const loose = await mkdtemp(path.join(base, "loose-"));
    const alerts = await checkWikiCommitter(watcher, botConfig(loose));
    expect(alerts).toHaveLength(0);
  });
});

describe("wikiDirtyStat (Index-card badge endpoint logic)", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    base = await mkdtemp(path.join(tmpdir(), "wiki-dirty-"));
  });
  afterEach(async () => {
    __resetForTest();
    await rm(base, { recursive: true, force: true });
  });

  test("dirty wiki → N + oldest dirty mtime", async () => {
    const { wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "A.md"), "# A\n");
    await writeFile(path.join(wikiDir, "concepts", "B.md"), "# B\n");

    const before = Date.now();
    const stat = await wikiDirtyStat(wikiDir);
    const after = Date.now();

    expect(stat.dirtyCount).toBe(2);
    expect(typeof stat.oldestDirtyMtimeMs).toBe("number");
    // Freshly-written files: oldest mtime is within the test window (allow slack).
    expect(stat.oldestDirtyMtimeMs!).toBeLessThanOrEqual(after + 2000);
    expect(stat.oldestDirtyMtimeMs!).toBeGreaterThan(before - 60_000);
  });

  test("clean wiki → 0 / null", async () => {
    const { wikiDir } = await makeRepo(base);
    const stat = await wikiDirtyStat(wikiDir);
    expect(stat.dirtyCount).toBe(0);
    expect(stat.oldestDirtyMtimeMs).toBeNull();
  });

  test("non-repo dir → 0 / null (never throws)", async () => {
    const loose = await mkdtemp(path.join(base, "loose-"));
    const stat = await wikiDirtyStat(loose);
    expect(stat.dirtyCount).toBe(0);
    expect(stat.oldestDirtyMtimeMs).toBeNull();
  });
});
