import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import {
  selectBatchEntries,
  generateWikiDigest,
  parseLogEntries,
  BATCH_DIGEST_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  type LogEntry,
} from "./digest.ts";
import { changedPagesForEntry, blameOrigin, entryCommitFromLineLog } from "./digest-changed-pages.ts";
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

describe("entry header lines", () => {
  test("each entry records the 1-based line of its header", () => {
    const log = "# Log\n\n## [2026-11-01] update | Sync A\n\nbody\n\n## [2026-11-01] update | Sync B\nlast";
    const [a, b] = parseLogEntries(log);
    expect([a!.line, b!.line]).toEqual([3, 7]);
  });
});

describe("reading git's output", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  test("blameOrigin reads the commit and the line it sat on, and refuses an uncommitted line", () => {
    expect(blameOrigin(`${A} 3 21 1\nauthor x\n\t## [2026-11-01] update | S`)).toEqual({ sha: A, line: 3 });
    expect(blameOrigin(`${"0".repeat(40)} 21 21 1\n\t## x`)).toBeNull();
    expect(blameOrigin("")).toBeNull();
  });
  const block = (sha: string, removed: string | null, added: string) =>
    `\x01${sha}\n\ndiff --git a/log.md b/log.md\n--- a/log.md\n+++ b/log.md\n@@ -3,1 +3,1 @@\n${removed === null ? "" : `-${removed}\n`}+${added}\n`;
  test("an edit keeping the date and kind is walked past; an addition stops the walk", () => {
    const out =
      block(A, "## [2026-11-01] update | Sync of [[Old]]", "## [2026-11-01] update | Sync of [[New]]") +
      block(B, null, "## [2026-11-01] update | Sync of [[Old]]");
    expect(entryCommitFromLineLog(out)).toBe(B);
  });
  test("a header written over another entry's header, or over a non-header line, stops the walk", () => {
    expect(entryCommitFromLineLog(block(A, "## [2026-11-01] lint | Helsesjekk", "## [2026-11-01] update | Helfo") + block(B, null, "## [2026-11-01] lint | Helsesjekk"))).toBe(A);
    expect(entryCommitFromLineLog(block(A, "## [2026-10-31] update | S", "## [2026-11-01] update | S") + block(B, null, "x"))).toBe(A);
    expect(entryCommitFromLineLog(block(A, "plain text", "## [2026-11-01] update | S") + block(B, null, "plain text"))).toBe(A);
  });
  test("sha256 repositories: 64-hex commits are read", () => {
    const H = "d".repeat(64);
    const G = "e".repeat(64);
    expect(blameOrigin(`${H} 3 21 1\nauthor x\n\t## [2026-11-01] update | S`)).toEqual({ sha: H, line: 3 });
    expect(entryCommitFromLineLog(block(H, "## [2026-11-01] update | A", "## [2026-11-01] update | B") + block(G, null, "## [2026-11-01] update | A"))).toBe(G);
  });

  test("a walk that never stops takes the oldest commit; no commit is null", () => {
    const keep = (sha: string) => block(sha, "## [2026-11-01] update | S", "## [2026-11-01] update | S2");
    expect(entryCommitFromLineLog(keep(A) + keep(B) + keep(C))).toBe(C);
    expect(entryCommitFromLineLog("")).toBeNull();
  });
});

// ── git-backed: a wiki in a subdirectory of its repo ──────────────────────────

/** Each git call one minute after the last, so commits in a test never share a
 *  committer second (a tie rule that reads commit times needs them apart). */
let gitClock = Date.parse("2026-11-01T08:00:00Z") / 1000;

function git(cwd: string, ...args: string[]): void {
  const at = `${(gitClock += 60)} +0000`;
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
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

  /** The header line of the entry whose header is `header`, in the current log. */
  async function lineOf(header: string): Promise<number> {
    const entry = parseLogEntries(await Bun.file(path.join(root, "log.md")).text()).find(
      (x) => `## [${x.date}] ${x.kind} | ${x.title}` === header,
    )!;
    return entry.line!;
  }

  test("each entry lists only its own commit's pages, wiki-relative, meta files left out", async () => {
    const index = await buildWikiIndex(root);
    const a = (await changedPagesForEntry(root, await lineOf(SYNC_A), index.resolveRelPath))!;
    expect(a).toHaveLength(28);
    expect(a.some((p) => p.relPath === "concepts/Side 7 æ.md")).toBe(true);
    expect(a.some((p) => p.relPath === "index.md" || p.relPath.includes("outside"))).toBe(false);
    const b = (await changedPagesForEntry(root, await lineOf(SYNC_B), index.resolveRelPath))!;
    expect(b.map((p) => p.relPath).sort()).toEqual(["concepts/Ny.md", "concepts/Side 0 æ.md"]);
  });

  test("an uncommitted entry or a root outside git has no list", async () => {
    const log = await Bun.file(path.join(root, "log.md")).text();
    await Bun.write(path.join(root, "log.md"), log.replace("# Log\n\n", "# Log\n\n## [2026-11-02] update | Not committed\n\nNew body\n\n"));
    const index = await buildWikiIndex(root);
    expect(await changedPagesForEntry(root, await lineOf("## [2026-11-02] update | Not committed"), index.resolveRelPath)).toBeNull();
    const bare = await testTempDir(path.join(tmpdir(), "wiki-batch-nogit-"));
    try {
      await Bun.write(path.join(bare, "log.md"), log);
      expect(await changedPagesForEntry(bare, 3, index.resolveRelPath)).toBeNull();
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

// ── which commit an entry belongs to (fix round 1) ────────────────────────────

describe("an entry's commit is the one that wrote its lines", () => {
  let repo: string;
  let root: string;

  beforeEach(async () => {
    repo = await testTempDir(path.join(tmpdir(), "wiki-batch-blame-"));
    root = path.join(repo, "wiki");
    await mkdir(path.join(root, "c"), { recursive: true });
    await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ whatsNew: { mode: "batch" } }));
    git(repo, "init", "-q");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function commit(files: Record<string, string>, msg: string): Promise<void> {
    for (const [rel, text] of Object.entries(files)) await Bun.write(path.join(root, rel), text);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", msg);
  }

  async function syncsOf(): Promise<[string, string[] | undefined][]> {
    const index = await buildWikiIndex(root);
    const d = (await generateWikiDigest(root, index, {} as Config, { name: "melosys" } as BotConfig, {
      now: NOW,
      oneShot: async () => ({ result: "### A\n- x" }) as ClaudeExecResult,
    }))!;
    return d.syncs!.map((s) => [s.title, s.pages?.map((p) => p.relPath)]);
  }

  test("a header that is a prefix of an older header gets its own commit", async () => {
    await commit({ "c/a.md": "# a\n", "log.md": "# Log\n\n## [2026-11-01] update | Sync del 2\n\nA body\n\n## [2026-10-20] note | Older\n" }, "1");
    await commit(
      { "c/b.md": "# b\n", "log.md": "# Log\n\n## [2026-11-01] update | Sync\n\nB body\n\n## [2026-11-01] update | Sync del 2\n\nA body\n\n## [2026-10-20] note | Older\n" },
      "2",
    );
    expect(await syncsOf()).toEqual([
      ["Sync", ["c/b.md"]],
      ["Sync del 2", ["c/a.md"]],
    ]);
  });

  test("two entries with the same header each get their own commit", async () => {
    // Byte-identical entries: git's diff decides which copy is the new one, so
    // only "one each" is pinned, not which copy gets which.
    const entry = "## [2026-11-01] update | Confluence sync\n\nsame body\n\n";
    await commit({ "c/a.md": "# a\n", "log.md": `# Log\n\n${entry}## [2026-10-20] note | Older\n` }, "1");
    await commit({ "c/b.md": "# b\n", "log.md": `# Log\n\n${entry}${entry}## [2026-10-20] note | Older\n` }, "2");
    const pages = (await syncsOf()).map(([, p]) => p!.join(",")).sort();
    expect(pages).toEqual(["c/a.md", "c/b.md"]);
  });

  test("an entry written over another entry's header is the overwriting commit's, even when the body lines tie", async () => {
    // huginn-nav 2026-05-11: the Helfo entry's commit replaced the lint
    // entry's header line, so the lint body sits under the Helfo header.
    const lint = "Lint linje 1.\nLint linje 2.\nLint linje 3.\nLint linje 4.\n";
    await commit({ "c/a.md": "# a\n", "log.md": `# Log\n\n## [2026-11-01] lint | Helsesjekk\n\n${lint}\n## [2026-10-20] note | Older\n` }, "lint");
    await commit(
      { "c/b.md": "# b\n", "log.md": `# Log\n\n## [2026-11-01] update | [[Helfo]] bekreftet\n\nHelfo 1.\nHelfo 2.\nHelfo 3.\n\n${lint}\n## [2026-10-20] note | Older\n` },
      "helfo",
    );
    expect(await syncsOf()).toEqual([["[[Helfo]] bekreftet", ["c/b.md"]]]);
  });

  test("a rename sweep that rewrites most of the entry's lines still loses to the sync", async () => {
    const tail = "\n- [[Other]] ny\n\n## [2026-10-20] note | Older\n";
    await commit(
      { "c/a.md": "# a\n", "log.md": `# Log\n\n## [2026-11-01] update | Sync of [[Old]]\n\n- [[Old]] oppdatert\n- [[Old]]/sub oppdatert${tail}` },
      "sync",
    );
    await commit(
      { "c/z.md": "# z\n", "log.md": `# Log\n\n## [2026-11-01] update | Sync of [[New]]\n\n- [[New]] oppdatert\n- [[New]]/sub oppdatert${tail}` },
      "rename sweep",
    );
    expect(await syncsOf()).toEqual([["Sync of [[New]]", ["c/a.md"]]]);
  });

  test("a sha256 repository lists the entry's pages", async () => {
    await rm(path.join(repo, ".git"), { recursive: true, force: true });
    git(repo, "init", "-q", "--object-format=sha256");
    await commit({ "c/a.md": "# a\n", "log.md": "# Log\n\n## [2026-11-01] update | Sync\n\nBody.\n\n## [2026-10-20] note | Older\n" }, "sync");
    expect(await syncsOf()).toEqual([["Sync", ["c/a.md"]]]);
  });

  test("an entry written while resolving a merge lists the pages the merge brought in", async () => {
    await commit({ "c/base.md": "# base\n", "log.md": "# Log\n\n## [2026-10-20] note | Older\n" }, "base");
    git(repo, "checkout", "-q", "-b", "side");
    await commit({ "c/b.md": "# b\n", "c/b2.md": "# b2\n" }, "side pages");
    git(repo, "checkout", "-q", "-");
    await commit({ "c/m.md": "# m\n" }, "main page");
    git(repo, "-c", "core.editor=true", "merge", "-q", "--no-ff", "--no-commit", "side");
    await Bun.write(path.join(root, "log.md"), "# Log\n\n## [2026-11-01] update | Merged sync\n\nBody.\n\n## [2026-10-20] note | Older\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "merge side");
    expect(await syncsOf()).toEqual([["Merged sync", ["c/b.md", "c/b2.md"]]]);
  });

  test("a header edited later still maps to the commit that wrote the entry", async () => {
    const body = "\n\nSide A er skrevet.\nTo kilder lest.\n\n## [2026-10-20] note | Older\n";
    await commit({ "c/a.md": "# a\n", "log.md": `# Log\n\n## [2026-11-01] update | Sync of [[Old]]${body}` }, "sync");
    await commit({ "c/z.md": "# z\n", "log.md": `# Log\n\n## [2026-11-01] update | Sync of [[New]]${body}` }, "rename sweep");
    expect(await syncsOf()).toEqual([["Sync of [[New]]", ["c/a.md"]]]);
  });
});
