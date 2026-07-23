import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendBlockToPage, spliceSentinelBlock, type AppendBlockOptions } from "./append-block.ts";
import { buildFactcheckBlock, FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";
import { commitWikiChange, __resetForTest } from "./commit.ts";
import { sha256 } from "../gardener/util.ts";

const BLOCK = buildFactcheckBlock("Overall: mostly accurate.\n\n✅ **Claim A**\nReasoning.", "2026-07-22");

/** In-memory filesystem + reindex spy backing the injectable seams. */
function makeDeps(
  files: Record<string, string>,
  overrides: Partial<AppendBlockOptions> = {},
): { opts: AppendBlockOptions; files: Record<string, string>; reindexed: string[] } {
  const reindexed: string[] = [];
  const opts: AppendBlockOptions = {
    wikiDir: "/wiki",
    relPath: "analyses/page.md",
    block: BLOCK,
    baseHash: sha256(files["/wiki/analyses/page.md"] ?? ""),
    collections: ["wiki"],
    logTitle: "Page Title",
    now: () => Date.UTC(2026, 6, 22, 12, 0, 0),
    readFile: async (p) => (p in files ? files[p]! : null),
    writeFile: async (p, content) => { files[p] = content; },
    refreshIndex: async () => {},
    reindex: async (c) => { reindexed.push(c); },
    ...overrides,
  };
  return { opts, files, reindexed };
}

test("spliceSentinelBlock appends at end of file when no block and no ## Sources", () => {
  const out = spliceSentinelBlock("# Title\n\nBody text.\n", BLOCK);
  expect(out).toContain("Body text.");
  expect(out.indexOf(FACTCHECK_SENTINEL_START)).toBeGreaterThan(out.indexOf("Body text."));
  expect((out.match(/factcheck:start/g) ?? []).length).toBe(1);
});

test("spliceSentinelBlock inserts before a trailing ## Sources section", () => {
  const content = "# Title\n\nBody.\n\n## Sources\n\n- https://example.com\n";
  const out = spliceSentinelBlock(content, BLOCK);
  const blockAt = out.indexOf(FACTCHECK_SENTINEL_START);
  const sourcesAt = out.indexOf("## Sources");
  expect(blockAt).toBeGreaterThan(0);
  expect(blockAt).toBeLessThan(sourcesAt); // block sits ABOVE Sources
  expect(out).toContain("- https://example.com");
});

test("spliceSentinelBlock replaces an existing block in place (exactly one pair)", () => {
  const oldBlock = buildFactcheckBlock("Stale verdict.", "2026-01-01");
  const content = `# Title\n\nBody.\n\n${oldBlock}\n\n## Sources\n\n- url\n`;
  const out = spliceSentinelBlock(content, BLOCK);
  expect((out.match(/factcheck:start/g) ?? []).length).toBe(1);
  expect((out.match(/factcheck:end/g) ?? []).length).toBe(1);
  expect(out).not.toContain("Stale verdict.");
  expect(out).toContain("Claim A");
  // Sources + body preserved, block still above Sources.
  expect(out.indexOf(FACTCHECK_SENTINEL_START)).toBeLessThan(out.indexOf("## Sources"));
});

test("appendBlockToPage writes, logs, and reindexes on a matching baseHash", async () => {
  const files: Record<string, string> = { "/wiki/analyses/page.md": "# Page\n\nBody.\n" };
  const { opts, reindexed } = makeDeps(files);
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("written");
  expect(files["/wiki/analyses/page.md"]).toContain("factcheck:start");
  expect(files["/wiki/log.md"]).toContain("factcheck | Page Title");
  expect(reindexed).toEqual(["wiki"]);
});

test("appendBlockToPage rejects a stale baseHash (page changed since check) with no write", async () => {
  const files: Record<string, string> = { "/wiki/analyses/page.md": "# Page\n\nBody.\n" };
  const { opts, reindexed } = makeDeps(files, { baseHash: "deadbeef" });
  const before = files["/wiki/analyses/page.md"];
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("stale");
  expect(files["/wiki/analyses/page.md"]).toBe(before); // untouched
  expect(files["/wiki/log.md"]).toBeUndefined();
  expect(reindexed).toEqual([]);
});

test("appendBlockToPage reports stale when the target file vanished", async () => {
  const files: Record<string, string> = {}; // no page on disk
  const { opts } = makeDeps(files, { baseHash: "anything" });
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("stale");
});

test("appendBlockToPage rejects a path-escaping relPath (confinement) with no write", async () => {
  const files: Record<string, string> = { "/wiki/analyses/page.md": "# Page\n\nBody.\n" };
  const { opts, reindexed } = makeDeps(files, { relPath: "../escape.md" });
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("error");
  expect(reindexed).toEqual([]);
});

test("appendBlockToPage skips reindex when collections is empty (still writes + logs)", async () => {
  const files: Record<string, string> = { "/wiki/analyses/page.md": "# Page\n\nBody.\n" };
  const { opts, reindexed } = makeDeps(files, { collections: [] });
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("written");
  expect(files["/wiki/analyses/page.md"]).toContain("factcheck:start");
  expect(files["/wiki/log.md"]).toContain("factcheck | Page Title");
  expect(reindexed).toEqual([]);
});

test("appendBlockToPage invokes the commit seam with [page, log.md] and the fact-check message", async () => {
  const files: Record<string, string> = { "/wiki/analyses/page.md": "# Page\n\nBody.\n" };
  const commits: { paths: string[]; message: string }[] = [];
  const { opts } = makeDeps(files, {
    commit: async (paths, message) => {
      commits.push({ paths, message });
    },
  });
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("written");
  expect(commits).toHaveLength(1);
  expect(commits[0]!.paths).toEqual(["analyses/page.md", "log.md"]);
  expect(commits[0]!.message).toBe("[fact-check] annotate: analyses/page.md");
});

test("appendBlockToPage does NOT commit on a stale baseHash (no write, no commit)", async () => {
  const files: Record<string, string> = { "/wiki/analyses/page.md": "# Page\n\nBody.\n" };
  let commitCalls = 0;
  const { opts } = makeDeps(files, { baseHash: "deadbeef", commit: async () => { commitCalls++; } });
  const res = await appendBlockToPage(opts);
  expect(res.outcome).toBe("stale");
  expect(commitCalls).toBe(0);
});

test("appendBlockToPage produces exactly one [fact-check] commit (page + log.md), tree clean", async () => {
  __resetForTest();
  const base = await mkdtemp(path.join(tmpdir(), "factcheck-append-"));
  try {
    // Fixture repo with the wiki nested at data/wiki (huginn-jarvis layout).
    const repo = await mkdtemp(path.join(base, "repo-"));
    const wikiDir = path.join(repo, "data", "wiki");
    await mkdir(path.join(wikiDir, "analyses"), { recursive: true });
    const relPath = "analyses/page.md";
    const abs = path.join(wikiDir, relPath);
    const initial = "# Page\n\nBody prose.\n";
    await writeFile(abs, initial);
    const git = async (args: string[]) => {
      const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return out;
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "a@b.c"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "init"]);

    const res = await appendBlockToPage({
      wikiDir,
      relPath,
      block: BLOCK,
      baseHash: sha256(initial),
      collections: [],
      logTitle: "Page Title",
      now: () => Date.UTC(2026, 6, 22, 12, 0, 0),
      readFile: async (p) => {
        try {
          return await Bun.file(p).text();
        } catch {
          return null;
        }
      },
      writeFile: async (p, content) => {
        await Bun.write(p, content);
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      commit: (paths, message) => commitWikiChange(wikiDir, paths, message, { push: false }),
    });
    expect(res.outcome).toBe("written");

    // Exactly one new commit, on top of init, with the fact-check message.
    const subjects = (await git(["log", "--format=%s"])).split("\n");
    expect(subjects).toEqual(["[fact-check] annotate: analyses/page.md", "init"]);
    // It carries the page AND log.md (repo-relative under data/wiki).
    const names = (await git(["show", "--name-only", "--format=", "HEAD"])).split("\n").sort();
    expect(names).toEqual(["data/wiki/analyses/page.md", "data/wiki/log.md"]);
    // Tree clean afterward.
    expect(await git(["status", "--porcelain"])).toBe("");
  } finally {
    __resetForTest();
    await rm(base, { recursive: true, force: true });
  }
});

test("buildFactcheckBlock blockquotes every line and wraps in sentinels", () => {
  const block = buildFactcheckBlock("Line one.\n\nLine two.", "2026-07-22");
  expect(block.startsWith(FACTCHECK_SENTINEL_START)).toBe(true);
  expect(block.endsWith(FACTCHECK_SENTINEL_END)).toBe(true);
  expect(block).toContain("> [!factcheck] Fact check (2026-07-22)");
  expect(block).toContain("> Line one.");
  expect(block).toContain("> Line two.");
  // Blank line kept as a bare `>` so it stays one blockquote.
  expect(block).toContain("\n>\n");
});

test("buildFactcheckBlock neutralizes embedded sentinel strings in the answer", () => {
  const hostile = `Quoting the docs: ${FACTCHECK_SENTINEL_END} and ${FACTCHECK_SENTINEL_START} appear literally.`;
  const block = buildFactcheckBlock(hostile, "2026-07-22");
  // Exactly one sentinel pair — the wrapper's own — so strip/replace can never
  // stop early at an embedded end-sentinel and strand prose outside the block.
  expect(block.split(FACTCHECK_SENTINEL_START).length - 1).toBe(1);
  expect(block.split(FACTCHECK_SENTINEL_END).length - 1).toBe(1);
  expect(block).toContain("factcheck:end");
});

test("buildFactcheckBlock demotes ### claim headings to bold inside the callout", () => {
  const structured = "Overall fine.\n\n### ✅ Claim 1/2 — First\n\nReasoning.\n\n### ❌ Claim 2/2 — Second\n\nMore.";
  const block = buildFactcheckBlock(structured, "2026-07-22");
  expect(block).not.toContain("###");
  expect(block).toContain("> **✅ Claim 1/2 — First**");
  expect(block).toContain("> **❌ Claim 2/2 — Second**");
});
