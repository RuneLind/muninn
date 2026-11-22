import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, writeFile, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWikiCommitter } from "./wiki-committer.ts";
import { wikiDirtyStat, __resetForTest } from "../wiki/commit.ts";
import type { Watcher } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import { testTempDir } from "../test/temp-dir.ts";

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
  const repo = await testTempDir(path.join(base, "repo-"));
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
    base = await testTempDir(path.join(tmpdir(), "wiki-committer-"));
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
    const loose = await testTempDir(path.join(base, "loose-"));
    const alerts = await checkWikiCommitter(watcher, botConfig(loose));
    expect(alerts).toHaveLength(0);
  });
});

describe("wikiDirtyStat (Index-card badge endpoint logic)", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    base = await testTempDir(path.join(tmpdir(), "wiki-dirty-"));
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
    const loose = await testTempDir(path.join(base, "loose-"));
    const stat = await wikiDirtyStat(loose);
    expect(stat.dirtyCount).toBe(0);
    expect(stat.oldestDirtyMtimeMs).toBeNull();
  });
});

// F37 (arch review 2026-11-16): the sweeper's only guard against a half-finished
// git operation was the sync ledger's `blocked` state, which lives in memory — a
// fresh process has none. Each case puts the repo in one state, adds an untracked
// wiki page a sweep WOULD commit, and runs the sweeper with a cold ledger.
describe("checkWikiCommitter — stands down while a git operation is in progress (F37)", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    base = await testTempDir(path.join(tmpdir(), "wiki-committer-f37-"));
  });
  afterEach(async () => {
    __resetForTest();
    await rm(base, { recursive: true, force: true });
  });

  const PAGE = (wikiDir: string) => path.join(wikiDir, "concepts", "Old.md");
  const FRESH = "data/wiki/concepts/Fresh.md";

  /** `other` and `main` both edit Old.md, so replaying one over the other conflicts. */
  async function divergedRepo(): Promise<{ repo: string; wikiDir: string; otherSha: string }> {
    const r = await makeRepo(base);
    await git(r.repo, ["checkout", "-q", "-b", "other"]);
    await writeFile(PAGE(r.wikiDir), "# Old\nfrom other\n");
    await git(r.repo, ["commit", "-q", "-am", "other"]);
    const otherSha = (await git(r.repo, ["rev-parse", "HEAD"])).out;
    await git(r.repo, ["checkout", "-q", "main"]);
    await writeFile(PAGE(r.wikiDir), "# Old\nfrom main\n");
    await git(r.repo, ["commit", "-q", "-am", "main"]);
    return { ...r, otherSha };
  }

  async function touchLock(repo: string, offsetMs: number): Promise<void> {
    const lock = path.join(repo, ".git", "index.lock");
    await writeFile(lock, "");
    const t = new Date(Date.now() + offsetMs);
    await utimes(lock, t, t);
  }

  type Case = {
    name: string;
    setup: () => Promise<{ repo: string; wikiDir: string }>;
    /** Whether the stand-down raises the first-day alert (a stale or future-dated lock). */
    alert: boolean;
  };
  const cases: Case[] = [
    {
      name: "merge conflict (MERGE_HEAD + unmerged page)",
      alert: false,
      setup: async () => {
        const r = await divergedRepo();
        expect((await git(r.repo, ["merge", "other"])).code).not.toBe(0);
        return r;
      },
    },
    {
      name: "rebase stopped on a conflict",
      alert: false,
      setup: async () => {
        const r = await divergedRepo();
        expect((await git(r.repo, ["rebase", "other"])).code).not.toBe(0);
        return r;
      },
    },
    {
      name: "`git am` stopped on a patch that does not apply",
      alert: false,
      setup: async () => {
        const r = await divergedRepo();
        const patch = path.join(base, "other.patch");
        await writeFile(patch, (await git(r.repo, ["format-patch", "-1", "--stdout", r.otherSha])).out + "\n");
        expect((await git(r.repo, ["am", patch])).code).not.toBe(0);
        return r;
      },
    },
    {
      name: "cherry-pick conflict",
      alert: false,
      setup: async () => {
        const r = await divergedRepo();
        expect((await git(r.repo, ["cherry-pick", r.otherSha])).code).not.toBe(0);
        return r;
      },
    },
    {
      name: "stash-pop conflict (unmerged paths, no .git marker)",
      alert: false,
      setup: async () => {
        const r = await makeRepo(base);
        await writeFile(PAGE(r.wikiDir), "# Old\nstashed\n");
        await git(r.repo, ["stash", "push", "-q"]);
        await writeFile(PAGE(r.wikiDir), "# Old\ncommitted\n");
        await git(r.repo, ["commit", "-q", "-am", "c"]);
        expect((await git(r.repo, ["stash", "pop", "-q"])).code).not.toBe(0);
        return r;
      },
    },
    {
      name: "`git revert --no-commit` (REVERT_HEAD, the revert staged)",
      alert: false,
      setup: async () => {
        const r = await makeRepo(base);
        await writeFile(PAGE(r.wikiDir), "# Old\nedit\n");
        await git(r.repo, ["commit", "-q", "-am", "edit"]);
        expect((await git(r.repo, ["revert", "--no-commit", "HEAD"])).code).toBe(0);
        return r;
      },
    },
    {
      name: "a two-commit revert paused after its first conflict was resolved and committed (sequencer)",
      alert: false,
      setup: async () => {
        const r = await makeRepo(base);
        await writeFile(PAGE(r.wikiDir), "# Old\none\n");
        await git(r.repo, ["commit", "-q", "-am", "one"]);
        await writeFile(PAGE(r.wikiDir), "# Old\ntwo\n");
        await git(r.repo, ["commit", "-q", "-am", "two"]);
        // Reverting `one` before `two` conflicts on the page.
        expect((await git(r.repo, ["revert", "--no-edit", "HEAD~1", "HEAD"])).code).not.toBe(0);
        await writeFile(PAGE(r.wikiDir), "# Old\n");
        await git(r.repo, ["add", "-A"]);
        expect((await git(r.repo, ["-c", "core.editor=true", "commit", "-q", "--no-edit"])).code).toBe(0);
        return r;
      },
    },
    {
      name: "bisect in progress",
      alert: false,
      setup: async () => {
        const r = await makeRepo(base);
        await writeFile(PAGE(r.wikiDir), "# Old\nb\n");
        await git(r.repo, ["commit", "-q", "-am", "b"]);
        // Started with no revisions: HEAD stays on main, only BISECT_LOG says so.
        expect((await git(r.repo, ["bisect", "start"])).code).toBe(0);
        return r;
      },
    },
    {
      name: "a FRESH index.lock (a live git process) — transient, skipped",
      alert: false,
      setup: async () => {
        const r = await makeRepo(base);
        await touchLock(r.repo, 0);
        return r;
      },
    },
    {
      name: "an OLD index.lock (a crash leftover) — blocked, first-day alert",
      alert: true,
      setup: async () => {
        const r = await makeRepo(base);
        await touchLock(r.repo, -60 * 60 * 1000);
        return r;
      },
    },
    {
      name: "a FUTURE-dated index.lock — blocked, not transient forever",
      alert: true,
      setup: async () => {
        const r = await makeRepo(base);
        await touchLock(r.repo, 60 * 60 * 1000);
        return r;
      },
    },
    {
      name: "a linked worktree whose own merge is in progress",
      alert: false,
      setup: async () => {
        const r = await divergedRepo();
        // The main checkout moves off `main`, so a linked worktree can hold it.
        await git(r.repo, ["checkout", "-q", "other"]);
        const linked = path.join(base, "linked");
        expect((await git(r.repo, ["worktree", "add", "-q", linked, "main"])).code).toBe(0);
        expect((await git(linked, ["merge", "other"])).code).not.toBe(0);
        return { repo: linked, wikiDir: path.join(linked, "data", "wiki") };
      },
    },
  ];

  for (const c of cases) {
    test(`${c.name} → no commit, nothing staged by the sweeper`, async () => {
      const { repo, wikiDir } = await c.setup();
      await writeFile(path.join(repo, FRESH), "# Fresh\n");
      const head = (await git(repo, ["rev-parse", "HEAD"])).out;
      const before = (await git(repo, ["status", "--porcelain"])).out;

      const alerts = (await checkWikiCommitter(watcher, botConfig(wikiDir))).filter((a) => a.source === "wiki-committer");

      expect((await git(repo, ["rev-parse", "HEAD"])).out).toBe(head);
      expect((await git(repo, ["status", "--porcelain"])).out).toBe(before);
      if (c.alert) {
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.summary).toContain("Wiki sweep stood down: ");
        expect(alerts[0]!.summary).toContain("index.lock");
      } else {
        expect(alerts).toEqual([]);
      }
    });
  }

  test("a clean repo with a cold ledger still sweeps", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(repo, FRESH), "# Fresh\n");
    const alerts = await checkWikiCommitter(watcher, botConfig(wikiDir));
    expect(alerts.map((a) => a.summary)).toEqual(["Swept 1 uncommitted wiki file into a [sweep] commit"]);
    expect((await git(repo, ["log", "--format=%s", "-1"])).out).toBe("[sweep] daily wiki sweep: 1 files");
  });

  test("a clean LINKED worktree sweeps too: the check reads that worktree's own git dir", async () => {
    const r = await makeRepo(base);
    await git(r.repo, ["checkout", "-q", "-b", "parked"]);
    // A merge in progress in the MAIN checkout is not the linked worktree's.
    const linked = path.join(base, "linked-clean");
    expect((await git(r.repo, ["worktree", "add", "-q", linked, "main"])).code).toBe(0);
    await writeFile(path.join(linked, FRESH), "# Fresh\n");
    const alerts = await checkWikiCommitter(watcher, botConfig(path.join(linked, "data", "wiki")));
    expect(alerts).toHaveLength(1);
    expect((await git(linked, ["log", "--format=%s", "-1"])).out).toBe("[sweep] daily wiki sweep: 1 files");
  });
});
