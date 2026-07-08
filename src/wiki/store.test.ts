import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseFrontmatter,
  splitInlineArray,
  extractWikilinks,
  buildWikiIndex,
  getWikiIndex,
  readWikiPage,
  __resetWikiCacheForTest,
} from "./store.ts";

describe("parseFrontmatter", () => {
  test("parses scalars, quoted strings, and inline arrays", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "type: concept",
        'title: "Harness Engineering"',
        'aliases: ["Harness Engineering", "Harness Engineer"]',
        "tags: [agentic-coding, harness]",
        "created: 2026-05-30",
        "url: https://example.com/x",
        "---",
        "",
        "# Body",
      ].join("\n"),
    );
    expect(fm.type).toBe("concept");
    expect(fm.title).toBe("Harness Engineering");
    expect(fm.aliases).toEqual(["Harness Engineering", "Harness Engineer"]);
    expect(fm.tags).toEqual(["agentic-coding", "harness"]);
    expect(fm.created).toBe("2026-05-30");
    expect(fm.url).toBe("https://example.com/x");
  });

  test("returns {} without a frontmatter fence", () => {
    expect(parseFrontmatter("# Just a heading\n")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
  });

  test("handles quoted wikilinks with commas inside array items", () => {
    const fm = parseFrontmatter(
      ['---', 'sources: ["[[A, with comma]]", "[[B]]"]', "---", ""].join("\n"),
    );
    expect(fm.sources).toEqual(["[[A, with comma]]", "[[B]]"]);
  });
});

describe("splitInlineArray", () => {
  test("splits on top-level commas only", () => {
    expect(splitInlineArray('"a, b", c, \'d\'')).toEqual(["a, b", "c", "d"]);
    expect(splitInlineArray("")).toEqual([]);
  });
});

describe("extractWikilinks", () => {
  test("dedupes and strips labels", () => {
    const links = extractWikilinks(
      "See [[Claude Code]] and [[Claude Code|CC]] plus [[Skills System|skills]].",
    );
    expect(links).toEqual(["Claude Code", "Skills System"]);
  });
});

describe("buildWikiIndex", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-test-"));
    const write = (rel: string, content: string) =>
      Bun.write(path.join(root, rel), content);
    await mkdir(path.join(root, "concepts"), { recursive: true });
    await mkdir(path.join(root, "sources"), { recursive: true });
    await mkdir(path.join(root, "life/sources"), { recursive: true });
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await write(
      "concepts/Harness Engineering.md",
      [
        "---",
        "type: concept",
        'title: "Harness Engineering"',
        'aliases: ["Harness Engineer"]',
        "tags: [harness]",
        "updated: 2026-06-19",
        "---",
        "",
        "Links to [[Own the Folder]] and [[Missing Page]].",
      ].join("\n"),
    );
    await write(
      "sources/Own the Folder.md",
      [
        "---",
        "type: source",
        'title: "Own the Folder Rent the Engine"',
        "url: https://youtube.com/watch?v=x",
        "---",
        "",
        "Cites [[Harness Engineer]] by alias.",
      ].join("\n"),
    );
    await write("life/sources/Creatine.md", "---\ntype: source\ntitle: Creatine\n---\n\nBody.");
    await write("index.md", "# Wiki Index\n\n- [[Harness Engineering]]");
    await write(".obsidian/ignored.md", "should not be indexed");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("indexes pages with type, domain, and skips dot-dirs", async () => {
    const index = await buildWikiIndex(root);
    expect(index.pages.length).toBe(4);
    const harness = index.resolve("harness engineering")!;
    expect(harness.type).toBe("concept");
    expect(harness.domain).toBe("ai");
    const creatine = index.resolve("Creatine")!;
    expect(creatine.domain).toBe("life");
    const idx = index.resolve("index")!;
    expect(idx.type).toBe("note");
  });

  test("resolves aliases and builds backlinks both ways", async () => {
    const index = await buildWikiIndex(root);
    // alias resolution: [[Harness Engineer]] → Harness Engineering
    expect(index.outgoing.get("Own the Folder")).toEqual(["Harness Engineering"]);
    // backlinks include alias-based and title-cased links
    expect(index.backlinks.get("Harness Engineering")).toEqual(["Own the Folder", "index"]);
    expect(index.backlinks.get("Own the Folder")).toEqual(["Harness Engineering"]);
    // unresolved targets are dropped from outgoing
    expect(index.outgoing.get("Harness Engineering")).toEqual(["Own the Folder"]);
  });

  test("duplicate stems don't clobber link attribution — winner keeps its own links", async () => {
    // Same stem in the AI root and life/ subtree; the root page registers
    // first (sorted relPath order) and must keep ITS outgoing links.
    await Bun.write(
      path.join(root, "concepts/Chronotypes.md"),
      "---\ntype: concept\n---\n\nAI take on [[Harness Engineering]].",
    );
    await Bun.write(
      path.join(root, "life/sources/Chronotypes.md"),
      "---\ntype: source\n---\n\nLife take on [[Creatine]].",
    );
    const index = await buildWikiIndex(root);
    const winner = index.resolve("Chronotypes")!;
    expect(winner.relPath).toBe("concepts/Chronotypes.md");
    expect(index.outgoing.get("Chronotypes")).toEqual(["Harness Engineering"]);
    // the life page's link must not leak into the winner's attribution
    expect(index.backlinks.get("Creatine") ?? []).toEqual([]);
  });

  test("indexes standalone HTML explainers: <title>, stem fallback, mtime dates, no link graph", async () => {
    await mkdir(path.join(root, "blogs"), { recursive: true });
    await Bun.write(
      path.join(root, "blogs/Deep Dive.html"),
      "<!doctype html><html><head><title>Deep Dive Explained</title></head><body><h1>Hi</h1></body></html>",
    );
    await Bun.write(
      path.join(root, "blogs/no-title.html"),
      "<!doctype html><html><body>No title element here</body></html>",
    );
    const index = await buildWikiIndex(root);
    // 4 markdown pages from beforeEach + 2 explainers.
    expect(index.pages.length).toBe(6);

    const titled = index.resolve("Deep Dive")!;
    expect(titled.type).toBe("explainer");
    expect(titled.title).toBe("Deep Dive Explained");
    expect(titled.domain).toBe("ai");
    expect(titled.relPath).toBe("blogs/Deep Dive.html");
    // mtime rendered as yyyy-mm-dd; created === updated (HTML has no frontmatter).
    expect(titled.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(titled.updated).toBe(titled.created!);
    expect(titled.tags).toEqual([]);

    // Falls back to the filename stem when there's no <title>.
    const untitled = index.resolve("no-title")!;
    expect(untitled.type).toBe("explainer");
    expect(untitled.title).toBe("no-title");

    // Explainers carry no wikilinks and are not link targets/sources.
    expect(index.outgoing.get("Deep Dive")).toEqual([]);
    expect(index.backlinks.get("Deep Dive") ?? []).toEqual([]);
  });

  test("readWikiPage returns raw markdown", async () => {
    const index = await buildWikiIndex(root);
    const md = await readWikiPage(index, index.resolve("index")!);
    expect(md).toContain("# Wiki Index");
  });

  test("getWikiIndex degrades to null on a missing dir", async () => {
    __resetWikiCacheForTest();
    const prev = process.env.WIKI_DIR;
    process.env.WIKI_DIR = path.join(root, "does-not-exist");
    try {
      expect(await getWikiIndex()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.WIKI_DIR;
      else process.env.WIKI_DIR = prev;
      __resetWikiCacheForTest();
    }
  });

  test("getWikiIndex isolates caches + degraded state per explicit root", async () => {
    __resetWikiCacheForTest();
    // A second, differently-shaped wiki root alongside the beforeEach `root`.
    const rootB = await mkdtemp(path.join(tmpdir(), "wiki-test-b-"));
    await mkdir(path.join(rootB, "concepts"), { recursive: true });
    await Bun.write(path.join(rootB, "concepts/Only In B.md"), "---\ntype: concept\n---\n\nB-only.");
    const missing = path.join(rootB, "does-not-exist");
    try {
      const a = await getWikiIndex({ root });
      const b = await getWikiIndex({ root: rootB });
      // Distinct indexes — no cross-contamination between roots.
      expect(a).not.toBe(b);
      expect(a!.root).toBe(root);
      expect(b!.root).toBe(rootB);
      expect(a!.pages.length).toBe(4);
      expect(b!.resolve("Only In B")).toBeDefined();
      expect(a!.resolve("Only In B")).toBeUndefined();
      expect(b!.resolve("index")).toBeUndefined();
      // A missing root degrades to null without disturbing the healthy caches.
      expect(await getWikiIndex({ root: missing })).toBeNull();
      expect(await getWikiIndex({ root })).toBe(a!);
      expect(await getWikiIndex({ root: rootB })).toBe(b!);
    } finally {
      await rm(rootB, { recursive: true, force: true });
      __resetWikiCacheForTest();
    }
  });

  test("getWikiIndex caches and refreshes via env-configured root", async () => {
    __resetWikiCacheForTest();
    const prev = process.env.WIKI_DIR;
    process.env.WIKI_DIR = root;
    try {
      const first = await getWikiIndex();
      expect(first?.pages.length).toBe(4);
      await Bun.write(path.join(root, "concepts/New Page.md"), "---\ntype: concept\n---\n\nX");
      // cached: same object until refresh
      const cached = await getWikiIndex();
      expect(cached).toBe(first!);
      const refreshed = await getWikiIndex({ refresh: true });
      expect(refreshed?.pages.length).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.WIKI_DIR;
      else process.env.WIKI_DIR = prev;
      __resetWikiCacheForTest();
    }
  });
});
