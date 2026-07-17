import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  parseFrontmatter,
  splitInlineArray,
  extractWikilinks,
  extractMarkdownLinks,
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

  test("strips #anchor fragments; skips bare [[#anchor]] self-references", () => {
    const links = extractWikilinks(
      "See [[Claude Code#Hooks]] and [[Claude Code]] plus [[#local-section]].",
    );
    expect(links).toEqual(["Claude Code"]);
  });

  test("drops backslash escapes so targets match the page name", () => {
    expect(extractWikilinks("Escaped [[Claude Code\\]] here.")).toEqual(["Claude Code"]);
  });
});

describe("extractMarkdownLinks", () => {
  test("extracts relative .md targets, decodes %20, strips #anchors, dedupes", () => {
    const links = extractMarkdownLinks(
      [
        "See [overview](overview.md) and [sub](sub/page.md#section).",
        "Also [parent](../repos/muninn.md) and [encoded](my%20notes.md).",
        "Repeat [again](overview.md).",
      ].join("\n"),
    );
    expect(links).toEqual([
      "overview.md",
      "sub/page.md",
      "../repos/muninn.md",
      "my notes.md",
    ]);
  });

  test("ignores http/https, mailto, absolute paths, images, and non-page extensions", () => {
    const links = extractMarkdownLinks(
      [
        "[web](https://example.com/x.md)",
        "[http](http://example.com/y.md)",
        "[mail](mailto:me@example.com)",
        "[abs](/etc/passwd.md)",
        "![img](diagram.png)",
        "![mdimg](fake.md)",
        "![htmlimg](fake.html)",
        "[png](diagram.png)",
        "[anchor](#local-section)",
        "[real](kept.md)",
      ].join("\n"),
    );
    expect(links).toEqual(["kept.md"]);
  });

  test("extracts relative .html targets (explainer links), with anchors/%-encoding/titles handled", () => {
    const links = extractMarkdownLinks(
      [
        "[explainer](../blogs/deep-dive.html)",
        "[anchored](../blogs/deep-dive.html#section)",
        "[encoded](../blogs/deep%20dive.html)",
        '[titled](../blogs/other.html "Other explainer")',
      ].join("\n"),
    );
    expect(links).toEqual([
      "../blogs/deep-dive.html",
      "../blogs/deep dive.html",
      "../blogs/other.html",
    ]);
  });

  test("is case-insensitive on the .md and .html extensions", () => {
    expect(extractMarkdownLinks("[x](Notes.MD)")).toEqual(["Notes.MD"]);
    expect(extractMarkdownLinks("[x](Deep.HTML)")).toEqual(["Deep.HTML"]);
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

  test("resolves path-form wikilinks root-relative with .md implied", async () => {
    await Bun.write(
      path.join(root, "flows/Aarsavregning.md"),
      "See [[concepts/Harness Engineering]] and [[sources/Own the Folder.md]] and [[flows/missing]].",
    );
    const index = await buildWikiIndex(root);
    // resolve(): path form finds the page a bare stem lookup also finds…
    expect(index.resolve("concepts/Harness Engineering")?.relPath).toBe(
      "concepts/Harness Engineering.md",
    );
    // …with or without the .md suffix, but a missing path stays unresolved.
    expect(index.resolve("sources/Own the Folder.md")?.name).toBe("Own the Folder");
    expect(index.resolve("flows/missing")).toBeUndefined();
    // Both resolved targets join the outgoing graph for the linking page.
    expect(index.outgoing.get("flows/aarsavregning.md")).toEqual([
      "concepts/harness engineering.md",
      "sources/own the folder.md",
    ]);
    expect(index.backlinks.get("concepts/harness engineering.md")).toContain(
      "flows/aarsavregning.md",
    );
  });

  test("stamps every markdown page with its file mtime", async () => {
    const before = Date.now();
    const index = await buildWikiIndex(root);
    // `index.md` carries no frontmatter — mtime is its ONLY recency signal, and
    // without it the reader's "Recently updated" sort has nothing to rank it by.
    const idx = index.resolve("index")!;
    expect(idx.created).toBeUndefined();
    expect(idx.updated).toBeUndefined();
    expect(idx.mtimeMs).toBeGreaterThan(before - 60_000);
    // A frontmatter page keeps both signals.
    const harness = index.resolve("harness engineering")!;
    expect(harness.updated).toBe("2026-06-19");
    expect(harness.mtimeMs).toBeGreaterThan(before - 60_000);
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

  test("resolves aliases and builds backlinks both ways (relPath-keyed)", async () => {
    const index = await buildWikiIndex(root);
    // alias resolution: [[Harness Engineer]] → Harness Engineering
    expect(index.outgoing.get("sources/own the folder.md")).toEqual([
      "concepts/harness engineering.md",
    ]);
    // backlinks include alias-based and title-cased links
    expect(index.backlinks.get("concepts/harness engineering.md")).toEqual([
      "index.md",
      "sources/own the folder.md",
    ]);
    expect(index.backlinks.get("sources/own the folder.md")).toEqual([
      "concepts/harness engineering.md",
    ]);
    // unresolved targets are dropped from outgoing
    expect(index.outgoing.get("concepts/harness engineering.md")).toEqual([
      "sources/own the folder.md",
    ]);
    // graph values round-trip back to pages via resolveRelPath
    expect(index.resolveRelPath("concepts/harness engineering.md")!.title).toBe(
      "Harness Engineering",
    );
  });

  test("same-stem pages keep distinct link sets; cross-links count, self-links don't", async () => {
    // Same stem in the AI root and life/ subtree — with a relPath-keyed graph
    // BOTH pages keep their own outgoing edges and their own backlink counts.
    await Bun.write(
      path.join(root, "concepts/Chronotypes.md"),
      "---\ntype: concept\n---\n\nAI take on [[Harness Engineering]].",
    );
    await Bun.write(
      path.join(root, "life/sources/Chronotypes.md"),
      [
        "---",
        "type: source",
        "---",
        "",
        "Life take on [[Creatine]].",
        "Cross-link to the same-stem AI page: [ai take](../../concepts/Chronotypes.md).",
        "A real self-link: [me](Chronotypes.md).", // must stay excluded
      ].join("\n"),
    );
    const index = await buildWikiIndex(root);
    // Winner (first-registered stem) keeps its own links…
    expect(index.outgoing.get("concepts/chronotypes.md")).toEqual([
      "concepts/harness engineering.md",
    ]);
    // …and the stem-collision loser now keeps ITS links too, including the
    // legitimate markdown cross-link to the same-stem page — but not the self-link.
    expect(index.outgoing.get("life/sources/chronotypes.md")!.slice().sort()).toEqual([
      "concepts/chronotypes.md",
      "life/sources/creatine.md",
    ]);
    // Distinct backlink sets per relPath — no merged counts.
    expect(index.backlinks.get("concepts/chronotypes.md")).toEqual([
      "life/sources/chronotypes.md",
    ]);
    expect(index.backlinks.get("life/sources/chronotypes.md") ?? []).toEqual([]);
    expect(index.backlinks.get("life/sources/creatine.md")).toEqual([
      "life/sources/chronotypes.md",
    ]);
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
    expect(index.outgoing.get("blogs/deep dive.html")).toEqual([]);
    expect(index.backlinks.get("blogs/deep dive.html") ?? []).toEqual([]);
  });

  test("markdown .html links backlink standalone explainers (anchor/%-encoded/title/missing/image variants)", async () => {
    await mkdir(path.join(root, "blogs"), { recursive: true });
    await Bun.write(
      path.join(root, "blogs/deep-dive.html"),
      "<!doctype html><html><head><title>Deep Dive</title></head><body>Hi</body></html>",
    );
    await Bun.write(
      path.join(root, "blogs/spaced name.html"),
      "<!doctype html><html><head><title>Spaced</title></head><body>Hi</body></html>",
    );
    await Bun.write(
      path.join(root, "concepts/Linker.md"),
      [
        "---",
        "type: concept",
        "---",
        "",
        "Plain [a](../blogs/deep-dive.html).",
        "Anchored [b](../blogs/deep-dive.html#section).",
        "Titled [c](../blogs/deep-dive.html \"A title\").",
        "Encoded [d](../blogs/spaced%20name.html).",
        "Missing [e](../blogs/nonexistent.html).",
        "As image ![f](../blogs/deep-dive.html).",
      ].join("\n"),
    );
    const index = await buildWikiIndex(root);

    // The linking md page's outgoing set contains both real explainers, deduped
    // across the anchor/title variants; the image and the missing target drop.
    expect(index.outgoing.get("concepts/linker.md")!.slice().sort()).toEqual([
      "blogs/deep-dive.html",
      "blogs/spaced name.html",
    ]);
    // Each explainer gains the backlink (its "Linked from" / connection count).
    expect(index.backlinks.get("blogs/deep-dive.html")).toEqual(["concepts/linker.md"]);
    expect(index.backlinks.get("blogs/spaced name.html")).toEqual(["concepts/linker.md"]);
    // A link to a nonexistent explainer is silently dropped — never in the graph.
    expect(index.backlinks.get("blogs/nonexistent.html")).toBeUndefined();
    // Explainers still emit no outgoing links of their own.
    expect(index.outgoing.get("blogs/deep-dive.html")).toEqual([]);
  });

  test("a .html link to a SHADOWED explainer (same-stem .md wins) produces no backlink", async () => {
    await mkdir(path.join(root, "blogs"), { recursive: true });
    // Same stem in both a markdown page and an explainer — the .md wins and the
    // .html is dropped from the index, though it still exists on disk.
    await Bun.write(
      path.join(root, "concepts/Genesis.md"),
      "---\ntype: concept\n---\n\nThe canonical page.",
    );
    await Bun.write(
      path.join(root, "blogs/genesis.html"),
      "<!doctype html><html><head><title>Genesis</title></head><body>Mirror</body></html>",
    );
    await Bun.write(
      path.join(root, "sources/Refers.md"),
      "---\ntype: source\n---\n\nSee [mirror](../blogs/genesis.html).",
    );
    const index = await buildWikiIndex(root);
    // The shadowed explainer is not in the index → the link resolves to nothing,
    // no crash, no backlink, no outgoing edge from the linking page.
    expect(index.pages.some((p) => p.relPath === "blogs/genesis.html")).toBe(false);
    expect(index.backlinks.get("blogs/genesis.html")).toBeUndefined();
    expect(index.outgoing.get("sources/refers.md")).toEqual([]);
  });

  test("sniffs <meta keywords>/<meta description> for explainers: present/absent/malformed/order/beyond-prefix/headless", async () => {
    await mkdir(path.join(root, "blogs"), { recursive: true });

    // Present: keywords → kebab-lowercased tags; description → description field.
    await Bun.write(
      path.join(root, "blogs/present.html"),
      '<!doctype html><html><head><title>Present</title>' +
        '<meta name="keywords" content="Corrective RAG, Retrieval, Wiki Gardener">' +
        '<meta name="description" content="A deep dive into corrective retrieval.">' +
        "</head><body>Hi</body></html>",
    );

    // Absent: no meta at all → tags [] + description undefined.
    await Bun.write(
      path.join(root, "blogs/absent.html"),
      "<!doctype html><html><head><title>Absent</title></head><body>Hi</body></html>",
    );

    // Malformed: unclosed quote on keywords + empty description content → both ignored.
    await Bun.write(
      path.join(root, "blogs/malformed.html"),
      '<!doctype html><html><head><title>Malformed</title>' +
        '<meta name="keywords" content="broken, unclosed>' +
        '<meta name="description" content="">' +
        "</head><body>Hi</body></html>",
    );

    // Attribute order reversed (content before name), single quotes, mixed case.
    await Bun.write(
      path.join(root, "blogs/reversed.html"),
      "<!doctype html><html><head><title>Reversed</title>" +
        "<META CONTENT='Alpha Beta, Gamma' NAME='Keywords'>" +
        "<meta content='Reversed order works.' name='description'>" +
        "</head><body>Hi</body></html>",
    );

    // Meta beyond the 4096-byte sniff prefix must be ignored.
    const pad = "<!-- " + "x".repeat(4200) + " -->";
    await Bun.write(
      path.join(root, "blogs/beyond.html"),
      "<title>Beyond</title>" +
        pad +
        '<meta name="keywords" content="too, late">' +
        '<meta name="description" content="Past the prefix, ignored.">',
    );

    // Headless fragment: meta prepended ABOVE <title>, no <head> element.
    await Bun.write(
      path.join(root, "blogs/headless.html"),
      '<meta name="keywords" content="Fragment Tag">' +
        '<meta name="description" content="Headless fragment description.">' +
        "<title>Headless</title><h1>Body</h1>",
    );

    const index = await buildWikiIndex(root);

    const present = index.resolve("present")!;
    expect(present.tags).toEqual(["corrective-rag", "retrieval", "wiki-gardener"]);
    expect(present.description).toBe("A deep dive into corrective retrieval.");

    const absent = index.resolve("absent")!;
    expect(absent.tags).toEqual([]);
    expect(absent.description).toBeUndefined();

    const malformed = index.resolve("malformed")!;
    expect(malformed.tags).toEqual([]);
    expect(malformed.description).toBeUndefined();

    const reversed = index.resolve("reversed")!;
    expect(reversed.tags).toEqual(["alpha-beta", "gamma"]);
    expect(reversed.description).toBe("Reversed order works.");

    const beyond = index.resolve("beyond")!;
    expect(beyond.tags).toEqual([]);
    expect(beyond.description).toBeUndefined();

    const headless = index.resolve("headless")!;
    expect(headless.title).toBe("Headless");
    expect(headless.tags).toEqual(["fragment-tag"]);
    expect(headless.description).toBe("Headless fragment description.");
  });

  test("relative markdown links join the graph: same dir, ../ traversal, #anchor, %20, dedupe, out-of-root ignored", async () => {
    await mkdir(path.join(root, "repos"), { recursive: true });
    await Bun.write(path.join(root, "repos/muninn.md"), "---\ntype: note\n---\n\nMuninn repo.");
    await Bun.write(path.join(root, "repos/huginn.md"), "---\ntype: note\n---\n\nHuginn repo.");
    await Bun.write(
      path.join(root, "repos/overview.md"),
      [
        "---",
        "type: note",
        "---",
        "",
        "Links to [muninn](muninn.md) and [huginn](huginn.md#search).", // same dir + anchor
        "Up to [index](../index.md).", // ../ traversal, resolves to root index.md
        "Escapes [outside](../../../etc/passwd.md).", // out of root — ignored
        "Encoded [own](../sources/Own%20the%20Folder.md).", // %20 decode → "Own the Folder"
        "And a wikilink [[Muninn]] to the same page.", // dedupe with [muninn](muninn.md)
      ].join("\n"),
    );
    const index = await buildWikiIndex(root);
    const out = index.outgoing.get("repos/overview.md")!;
    expect(out.slice().sort()).toEqual([
      "index.md",
      "repos/huginn.md",
      "repos/muninn.md",
      "sources/own the folder.md",
    ]);
    // [[Muninn]] + [muninn](muninn.md) collapse to a single edge.
    expect(out.filter((rp) => rp === "repos/muninn.md").length).toBe(1);
    // Backlinks recorded on the targets.
    expect(index.backlinks.get("repos/muninn.md")).toContain("repos/overview.md");
    expect(index.backlinks.get("index.md")).toContain("repos/overview.md");
    // The out-of-root target never created a phantom page or edge.
    expect(index.resolve("passwd")).toBeUndefined();
  });

  test("[[Page#Section]] resolves to the page and records a backlink", async () => {
    await Bun.write(
      path.join(root, "concepts/Anchor Linker.md"),
      "---\ntype: concept\n---\n\nDeep link to [[Harness Engineering#Origins]] only.",
    );
    const index = await buildWikiIndex(root);
    // The anchor link joins the outgoing graph as an edge to the page itself…
    expect(index.outgoing.get("concepts/anchor linker.md")).toEqual([
      "concepts/harness engineering.md",
    ]);
    // …and the target gains the backlink (an anchor-only-referenced page is not
    // an orphan).
    expect(index.backlinks.get("concepts/harness engineering.md")).toContain(
      "concepts/anchor linker.md",
    );
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

  test(".wiki-reader.json typeMap: folder → custom type, honored frontmatter, standard fallback", async () => {
    await mkdir(path.join(root, "projects/muninn"), { recursive: true });
    await mkdir(path.join(root, "plans"), { recursive: true });
    await mkdir(path.join(root, "flows"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({
        typeMap: { projects: "subsystem", plans: "plan", flows: "concept", reading: "source" },
        typeLabels: { subsystem: "Subsystems", plan: "Plans" },
      }),
    );
    // No frontmatter type — resolved from the first path segment via typeMap.
    await Bun.write(path.join(root, "projects/muninn/wiki-gardener.md"), "# Gardener\n\nBody.");
    await Bun.write(path.join(root, "plans/some-plan.md"), "# Plan\n\nBody.");
    // A folder mapped to a STANDARD type.
    await Bun.write(path.join(root, "flows/a-flow.md"), "# Flow\n\nBody.");
    // Explicit frontmatter type declared in the config is honored as authored,
    // even though the folder would map it elsewhere.
    await Bun.write(
      path.join(root, "projects/muninn/note-page.md"),
      "---\ntype: plan\n---\n\nAuthored as a plan though it lives under projects/.",
    );
    // A folder with no typeMap entry AND no standard-folder name → note.
    await mkdir(path.join(root, "misc"), { recursive: true });
    await Bun.write(path.join(root, "misc/loose.md"), "# Loose\n\nBody.");

    const index = await buildWikiIndex(root);
    expect(index.readerConfig?.typeMap.projects).toBe("subsystem");
    expect(index.resolve("wiki-gardener")!.type).toBe("subsystem");
    expect(index.resolve("some-plan")!.type).toBe("plan");
    expect(index.resolve("a-flow")!.type).toBe("concept"); // typeMap → standard type
    expect(index.resolve("note-page")!.type).toBe("plan"); // explicit frontmatter honored
    expect(index.resolve("loose")!.type).toBe("note"); // unmapped, non-standard folder

    // The built-in standard-folder fallback still works alongside the config
    // (beforeEach's concepts/ + sources/ pages carry no typeMap entry).
    expect(index.resolve("harness engineering")!.type).toBe("concept");
    expect(index.resolve("Creatine")!.type).toBe("source");
  });

  test(".wiki-reader.json malformed JSON degrades to standard behavior (never offline)", async () => {
    await mkdir(path.join(root, "projects"), { recursive: true });
    await Bun.write(path.join(root, ".wiki-reader.json"), "{ not valid json ]");
    await Bun.write(path.join(root, "projects/x.md"), "# X\n\nBody.");
    const index = await buildWikiIndex(root);
    expect(index.readerConfig).toBeNull();
    // No custom mapping → the standard-folder fallback applies (projects isn't a
    // standard folder) → note. The wiki stays fully browsable.
    expect(index.resolve("x")!.type).toBe("note");
    expect(index.pages.length).toBeGreaterThan(0);
  });

  test(".wiki-reader.json with a non-object typeMap keeps the valid half", async () => {
    await mkdir(path.join(root, "plans"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ typeMap: "oops", typeLabels: { plan: "Plans" } }),
    );
    await Bun.write(path.join(root, "plans/p.md"), "# P\n\nBody.");
    const index = await buildWikiIndex(root);
    // typeMap dropped (not a string map) but typeLabels kept — an explicit `plan`
    // frontmatter type is still honored via the typeLabels declaration.
    expect(index.readerConfig?.typeMap).toEqual({});
    expect(index.readerConfig?.typeLabels.plan).toBe("Plans");
    expect(index.resolve("p")!.type).toBe("note"); // no typeMap → plans/ isn't standard
  });

  test("no .wiki-reader.json ⇒ readerConfig null, unchanged five-type behavior", async () => {
    const index = await buildWikiIndex(root);
    expect(index.readerConfig).toBeNull();
    expect(index.resolve("harness engineering")!.type).toBe("concept");
    expect(index.resolve("index")!.type).toBe("note");
  });

  test("native .mdx pilot: discovered, frontmatter tags/type, outgoing links AND backlinks", async () => {
    await mkdir(path.join(root, "blogs/src"), { recursive: true });
    // A native .mdx page with frontmatter (title/tags), a component (Callout), a
    // wikilink out to an existing .md page, and a code fence.
    await Bun.write(
      path.join(root, "blogs/src/drain-saga.mdx"),
      [
        "---",
        'title: "The Drain Saga"',
        "tags: [muninn, tracing]",
        "---",
        "",
        "# The Drain Saga",
        "",
        '<Callout tone="info" title="Note">',
        "Links to [[Harness Engineering]] inside a component body.",
        "</Callout>",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    // A .md fixture that links TO the .mdx page by relative path — proves the
    // .mdx page is a first-class backlink target.
    await Bun.write(
      path.join(root, "concepts/Refers To Mdx.md"),
      "---\ntype: concept\n---\n\nSee [saga](../blogs/src/drain-saga.mdx).",
    );
    const index = await buildWikiIndex(root);

    // Discovered with the .mdx stripped off the stem.
    const saga = index.resolve("drain-saga")!;
    expect(saga).toBeDefined();
    expect(saga.relPath).toBe("blogs/src/drain-saga.mdx");
    expect(saga.title).toBe("The Drain Saga");
    // Frontmatter tags become chips; type is NOT explainer (renders inline).
    expect(saga.tags).toEqual(["muninn", "tracing"]);
    expect(saga.type).not.toBe("explainer");

    // Outgoing: the wikilink INSIDE the component body counts (we do not strip
    // component tags before link extraction).
    expect(index.outgoing.get("blogs/src/drain-saga.mdx")).toEqual([
      "concepts/harness engineering.md",
    ]);
    // Backlink: the .md page's relative link resolves onto the .mdx page.
    expect(index.backlinks.get("blogs/src/drain-saga.mdx")).toEqual([
      "concepts/refers to mdx.md",
    ]);
    // A path-form wikilink with the extension implied finds the .mdx page.
    expect(index.resolve("blogs/src/drain-saga")?.relPath).toBe("blogs/src/drain-saga.mdx");
  });

  test("stem-collision precedence .md > .mdx > .html: one listed page, losers dropped, warn logged", async () => {
    // Capture wiki-store warnings via a logtape sink (the logger is a silent
    // no-op unless configured, so we wire a capture sink for this case).
    const warnings: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => warnings.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await mkdir(path.join(root, "blogs/src"), { recursive: true });
      // Same stem "collide" across all three extensions in different folders.
      await Bun.write(path.join(root, "concepts/Collide.md"), "---\ntype: concept\n---\n\nThe winner.");
      await Bun.write(path.join(root, "blogs/src/Collide.mdx"), "---\ntitle: Collide\n---\n\nMdx loser.");
      await Bun.write(
        path.join(root, "blogs/Collide.html"),
        "<!doctype html><html><head><title>Collide</title></head><body>Html loser.</body></html>",
      );
      const index = await buildWikiIndex(root);

      // Exactly ONE page named "collide" survives — the .md — and the .mdx + .html
      // are absent from `pages` entirely (still on disk).
      const collidePages = index.pages.filter((p) => p.name.toLowerCase() === "collide");
      expect(collidePages.length).toBe(1);
      expect(collidePages[0]!.relPath).toBe("concepts/Collide.md");
      expect(index.pages.some((p) => p.relPath === "blogs/src/Collide.mdx")).toBe(false);
      expect(index.pages.some((p) => p.relPath === "blogs/Collide.html")).toBe(false);
      // resolve() points only at the .md winner.
      expect(index.resolve("collide")!.relPath).toBe("concepts/Collide.md");
    } finally {
      await reset();
    }
    // A shadowed page is an authoring mistake worth surfacing — logged at warn.
    const shadowWarns = warnings.filter(
      (r) => r.level === "warning" && r.rawMessage.includes("shadowed"),
    );
    expect(shadowWarns.length).toBe(2); // the .mdx and the .html loser
  });

  test("stem-collision: .mdx wins over .html when no .md exists", async () => {
    await mkdir(path.join(root, "blogs/src"), { recursive: true });
    await Bun.write(path.join(root, "blogs/src/OnlyMdx.mdx"), "---\ntitle: OnlyMdx\n---\n\nNative page.");
    await Bun.write(
      path.join(root, "blogs/OnlyMdx.html"),
      "<!doctype html><html><head><title>OnlyMdx</title></head><body>Compiled.</body></html>",
    );
    const index = await buildWikiIndex(root);
    const survivor = index.pages.filter((p) => p.name.toLowerCase() === "onlymdx");
    expect(survivor.length).toBe(1);
    expect(survivor[0]!.relPath).toBe("blogs/src/OnlyMdx.mdx");
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
