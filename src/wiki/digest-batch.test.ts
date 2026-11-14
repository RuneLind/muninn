import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import {
  selectBatchEntries,
  rawHeaderLine,
  generateWikiDigest,
  parseLogEntries,
  BATCH_DIGEST_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  type LogEntry,
} from "./digest.ts";
import { changedPagesForEntry } from "./digest-changed-pages.ts";
import { parseWhatsNewReaderConfig } from "./whats-new-config.ts";
import { buildWikiIndex, readWikiReaderConfig } from "./store.ts";
import { testTempDir } from "../test/temp-dir.ts";

const e = (date: string, kind: string, title: string, body = ""): LogEntry => ({ date, kind, title, body });
const NOW = () => Date.parse("2026-11-14T12:00:00Z");

describe("parseWhatsNewReaderConfig", () => {
  test("absent or mode-less is default, batch is batch", () => {
    expect(parseWhatsNewReaderConfig(undefined)).toEqual({ mode: "default" });
    expect(parseWhatsNewReaderConfig({})).toEqual({ mode: "default" });
    expect(parseWhatsNewReaderConfig({ mode: "batch" })).toEqual({ mode: "batch" });
  });
  test("a bad block or mode warns and reads as default", () => {
    expect(parseWhatsNewReaderConfig("batch").mode).toBe("default");
    expect(parseWhatsNewReaderConfig("batch").warning).toContain("not an object");
    expect(parseWhatsNewReaderConfig([]).warning).toBeTruthy();
    const bad = parseWhatsNewReaderConfig({ mode: "weekly" });
    expect(bad.mode).toBe("default");
    expect(bad.warning).toContain('"weekly"');
  });
  test("readWikiReaderConfig carries the mode", async () => {
    const root = await testTempDir(path.join(tmpdir(), "wiki-wn-config-"));
    try {
      await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ whatsNew: { mode: "batch" } }));
      expect((await readWikiReaderConfig(root))?.whatsNew).toEqual({ mode: "batch" });
      await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({}));
      expect((await readWikiReaderConfig(root))?.whatsNew).toEqual({ mode: "default" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("selectBatchEntries", () => {
  test("keeps the newest 3 syncs and the other entries since the oldest of them", () => {
    const sel = selectBatchEntries(
      [
        e("2026-10-01", "update", "s1"),
        e("2026-10-02", "note", "before"),
        e("2026-10-10", "update", "s2"),
        e("2026-10-12", "lint", "ctx"),
        e("2026-10-20", "update", "s3"),
        e("2026-11-04", "update", "s4"),
      ],
      { now: NOW },
    )!;
    expect(sel.syncs.map((x) => x.title)).toEqual(["s2", "s3", "s4"]);
    expect(sel.context.map((x) => x.title)).toEqual(["ctx"]);
  });

  test("a sync older than the window is not read; no sync in the window is null", () => {
    const sel = selectBatchEntries([e("2026-08-01", "update", "old"), e("2026-11-01", "update", "new")], { now: NOW })!;
    expect(sel.syncs.map((x) => x.title)).toEqual(["new"]);
    expect(selectBatchEntries([e("2026-11-01", "note", "n"), e("2026-08-01", "update", "old")], { now: NOW })).toBeNull();
    expect(selectBatchEntries([], { now: NOW })).toBeNull();
  });

  test("a newest-first log keeps two same-day syncs in the order they were written", () => {
    // huginn-nav prepends: the later of the two 10-31 syncs is above the earlier.
    const newestFirst = [
      e("2026-11-04", "update", "s3"),
      e("2026-10-31", "update", "later"),
      e("2026-10-31", "update", "earlier"),
      e("2026-10-30", "update", "dropped"),
    ];
    const sel = selectBatchEntries(newestFirst, { now: NOW })!;
    expect(sel.syncs.map((x) => x.title)).toEqual(["earlier", "later", "s3"]);
    const two = selectBatchEntries(newestFirst, { now: NOW, maxSyncs: 2 })!;
    expect(two.syncs.map((x) => x.title)).toEqual(["later", "s3"]);
  });

  test("over budget, context goes first, then the oldest syncs, then a lone sync is truncated", () => {
    const big = "x".repeat(400);
    const entries = [e("2026-11-01", "update", "s1", big), e("2026-11-02", "note", "ctx", big), e("2026-11-03", "update", "s2", big)];
    const noCtx = selectBatchEntries(entries, { now: NOW, maxBytes: 950 })!;
    expect(noCtx.syncs.map((x) => x.title)).toEqual(["s1", "s2"]);
    expect(noCtx.context).toEqual([]);
    const one = selectBatchEntries(entries, { now: NOW, maxBytes: 500 })!;
    expect(one.syncs.map((x) => x.title)).toEqual(["s2"]);
    expect(one.syncs[0]!.body).toBe(big);
    const cut = selectBatchEntries(entries, { now: NOW, maxBytes: 200 })!;
    expect(cut.syncs.map((x) => x.title)).toEqual(["s2"]);
    expect(cut.syncs[0]!.body).toContain("truncated");
  });
});

describe("rawHeaderLine", () => {
  test("returns the line as written, extra spacing included", () => {
    const log = "# Log\n\n##  [2026-11-01]  update |  Sync A\n\nbody\n\n## [2026-11-01] update | Sync B\n";
    const [a, b] = parseLogEntries(log);
    expect(rawHeaderLine(log, a!)).toBe("##  [2026-11-01]  update |  Sync A");
    expect(rawHeaderLine(log, b!)).toBe("## [2026-11-01] update | Sync B");
    expect(rawHeaderLine(log, e("2026-11-02", "update", "Sync B"))).toBeNull();
  });
});

// ── git-backed: a wiki in a subdirectory of its repo ──────────────────────────

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe("changed pages from git", () => {
  let repo: string;
  let root: string;
  const SYNC_A = "## [2026-11-01] update | Sync A";
  const SYNC_B = "## [2026-11-01] update | Sync B";
  // An older entry, so the newest-first order of the log can be read.
  const OLDER = "## [2026-10-20] note | Older";

  beforeEach(async () => {
    repo = await testTempDir(path.join(tmpdir(), "wiki-batch-git-"));
    root = path.join(repo, "wiki");
    await mkdir(path.join(root, "concepts"), { recursive: true });
    git(repo, "init", "-q");
    // Sync A: a 28-page sweep plus log.md, index.md and a file outside the wiki.
    for (let i = 0; i < 28; i++) await Bun.write(path.join(root, "concepts", `Side ${i} æ.md`), `# Side ${i}\n`);
    await Bun.write(path.join(root, "index.md"), "# Index\n");
    await Bun.write(path.join(repo, "outside.md"), "# Outside\n");
    await Bun.write(path.join(root, "log.md"), `# Log\n\n${SYNC_A}\n\nA body\n\n${OLDER}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "sync A");
    // Sync B the same day, its own commit: one new page and one page A touched.
    await Bun.write(path.join(root, "concepts", "Ny.md"), "# Ny\n");
    await Bun.write(path.join(root, "concepts", "Side 0 æ.md"), "# Side 0\n\nmore\n");
    await Bun.write(path.join(root, "log.md"), `# Log\n\n${SYNC_B}\n\nB body\n\n${SYNC_A}\n\nA body\n\n${OLDER}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "sync B");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("each entry lists only its own commit's pages, wiki-relative, meta files left out", async () => {
    const index = await buildWikiIndex(root);
    const a = (await changedPagesForEntry(root, SYNC_A, index.resolveRelPath))!;
    expect(a).toHaveLength(28);
    expect(a.some((p) => p.relPath === "concepts/Side 7 æ.md")).toBe(true);
    expect(a.some((p) => p.relPath === "index.md" || p.relPath.includes("outside"))).toBe(false);
    const b = (await changedPagesForEntry(root, SYNC_B, index.resolveRelPath))!;
    expect(b.map((p) => p.relPath).sort()).toEqual(["concepts/Ny.md", "concepts/Side 0 æ.md"]);
  });

  test("an uncommitted entry or a root outside git has no list", async () => {
    const index = await buildWikiIndex(root);
    expect(await changedPagesForEntry(root, "## [2026-11-02] update | Not committed", index.resolveRelPath)).toBeNull();
    const bare = await testTempDir(path.join(tmpdir(), "wiki-batch-nogit-"));
    try {
      expect(await changedPagesForEntry(bare, SYNC_A, index.resolveRelPath)).toBeNull();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("a batch wiki's digest uses the batch prompt and carries each sync's pages, newest first", async () => {
    await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ whatsNew: { mode: "batch" } }));
    const index = await buildWikiIndex(root);
    let system = "";
    let prompt = "";
    const d = (await generateWikiDigest(root, index, {} as Config, { name: "melosys" } as BotConfig, {
      now: NOW,
      oneShot: async (p, _c, _b, opts) => {
        prompt = p;
        system = opts?.systemPrompt ?? "";
        return { result: "### Area\n- changed `Ny`" } as ClaudeExecResult;
      },
    }))!;
    expect(system).toBe(BATCH_DIGEST_SYSTEM_PROMPT);
    expect(prompt).toContain("The newest syncs (2)");
    expect(d.bullets).toContain("[[Ny]]");
    expect(d.syncs!.map((s) => [s.title, s.pages?.length])).toEqual([
      ["Sync B", 2],
      ["Sync A", 28],
    ]);
  });

  test("a wiki without the key gets today's digest, with no syncs", async () => {
    const index = await buildWikiIndex(root);
    let system = "";
    const d = (await generateWikiDigest(root, index, {} as Config, { name: "melosys" } as BotConfig, {
      now: NOW,
      oneShot: async (_p, _c, _b, opts) => {
        system = opts?.systemPrompt ?? "";
        return { result: "- a" } as ClaudeExecResult;
      },
    }))!;
    expect(system).toBe(DIGEST_SYSTEM_PROMPT);
    expect(d.syncs).toBeUndefined();
  });

  test("a batch wiki with no sync in the window falls back to today's digest", async () => {
    await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ whatsNew: { mode: "batch" } }));
    await Bun.write(path.join(root, "log.md"), "# Log\n\n## [2026-11-01] note | Only a note\n");
    const index = await buildWikiIndex(root);
    let system = "";
    const d = (await generateWikiDigest(root, index, {} as Config, { name: "melosys" } as BotConfig, {
      now: NOW,
      oneShot: async (_p, _c, _b, opts) => {
        system = opts?.systemPrompt ?? "";
        return { result: "- a" } as ClaudeExecResult;
      },
    }))!;
    expect(system).toBe(DIGEST_SYSTEM_PROMPT);
    expect(d.syncs).toBeUndefined();
  });
});
