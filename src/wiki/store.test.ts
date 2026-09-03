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
  firstDanglingWikilinkOpen,
  isMarkdownWikiPath,
  buildWikiIndex,
  getWikiIndex,
  readWikiPage,
  extractPubDate,
  extractDesc,
  flattenWikiLinks,
  flattenLinks,
  deriveFolderLabels,
  stemDisplayTitle,
  resolveProject,
  collectKnownProjects,
  PLAN_STATUS_VALUES,
  __resetWikiCacheForTest,
  type WikiProjectRule,
} from "./store.ts";
import { SWEEP_THRESHOLD } from "./git-dates.ts";

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

  test("emits one nested level as parent.child, leaving the parent key dropped", () => {
    // The memory wiki's exact shape — note the trailing space after `metadata:`,
    // which is what the real generator writes.
    const fm = parseFrontmatter(
      [
        "---",
        "name: netgate-2100-bridge-project",
        'description: "Ongoing migration"',
        "metadata: ",
        "  node_type: memory",
        "  type: project",
        "  originSessionId: 59823514-1b43-4268-879b-e1adc39808ad",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    expect(fm["metadata.type"]).toBe("project");
    expect(fm["metadata.node_type"]).toBe("memory");
    expect(fm["metadata.originSessionId"]).toBe("59823514-1b43-4268-879b-e1adc39808ad");
    // The parent key's own emission is unchanged: a value-less key is still dropped.
    expect(fm.metadata).toBeUndefined();
    // Top-level keys are unaffected.
    expect(fm.name).toBe("netgate-2100-bridge-project");
    expect(fm.description).toBe("Ongoing migration");
  });

  test("a sources: block list stays invisible — no fm.sources, no sources.* key", () => {
    // The indented scalar-list spelling of a `sources:` block. `lint.ts`'s
    // missing-sources check reads `fm.sources`, so if the parent became truthy
    // (or the list items became children) that finding would silently retire.
    // huginn-nav's 117 pages carry the MAPPING spelling — see the test below.
    const fm = parseFrontmatter(
      [
        "---",
        "type: concept",
        "title: Kafka",
        "sources:",
        '  - "[[Kafka docs]]"',
        '  - "[[Confluent blog]]"',
        "updated: 2026-06-01",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    expect(fm.sources).toBeUndefined();
    expect(Object.keys(fm).some((k) => k.startsWith("sources."))).toBe(false);
    // The keys after the block still parse — the list did not swallow the fence.
    expect(fm.updated).toBe("2026-06-01");
    expect(fm.type).toBe("concept");
  });

  test("nesting is one level and scalar-only: depth 2 and inline arrays are ignored", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "metadata:",
        "  type: project",
        "  tags: [a, b]", // inline array — not a scalar
        "  nested:", // opens depth 2
        "    deep: value", // depth 2 — ignored
        "    deeper: [x]",
        "top: kept",
        "---",
        "",
      ].join("\n"),
    );
    expect(fm["metadata.type"]).toBe("project");
    expect(fm["metadata.tags"]).toBeUndefined();
    expect(fm["metadata.nested"]).toBeUndefined();
    expect(fm["metadata.nested.deep"]).toBeUndefined();
    expect(fm["nested.deep"]).toBeUndefined();
    expect(Object.keys(fm).some((k) => k.includes("deep"))).toBe(false);
    expect(fm.top).toBe("kept");
  });

  test("an indented list item turns the block into a list — no sibling scalar leaks out", () => {
    // Measured before the rule: `{"sources.extra": "leaked"}`. A `- item` did NOT
    // end the block (only an unindented non-key line did), so the scalar sibling
    // after it was emitted as a child of a key whose value is a list.
    const fm = parseFrontmatter(
      ["---", "sources:", "  - a", "  extra: leaked", "---", ""].join("\n"),
    );
    expect(fm["sources.extra"]).toBeUndefined();
    expect(Object.keys(fm).some((k) => k.startsWith("sources."))).toBe(false);
  });

  test("a list OF MAPPINGS leaks no last-wins child", () => {
    // Measured before the rule: `{"sources.url": "w"}` — the LAST mapping's url,
    // silently standing in for a list of them.
    const fm = parseFrontmatter(
      [
        "---",
        "sources:",
        "  - name: X",
        "    url: u",
        "  - name: Z",
        "    url: w",
        "---",
        "",
      ].join("\n"),
    );
    expect(Object.keys(fm).some((k) => k.startsWith("sources."))).toBe(false);
  });

  test("a metadata: list of mappings does not become metadata.type", () => {
    // Measured before the rule: `metadata.type: concept` — which CHANGES the
    // rendered page type, off a key the page does not carry.
    const fm = parseFrontmatter(
      ["---", "metadata:", "  - node: x", "    type: concept", "---", ""].join("\n"),
    );
    expect(fm["metadata.type"]).toBeUndefined();
    expect(Object.keys(fm).some((k) => k.startsWith("metadata."))).toBe(false);
  });

  test("huginn-nav's nested sources MAPPING stays invisible, and the fence survives it", () => {
    // The real shape on those 117 pages: a MAPPING (inline arrays + lists of flow
    // mappings), not the indented scalar list. `lint.ts`'s missing-sources check
    // reads `fm.sources`, so nothing here may become truthy.
    const fm = parseFrontmatter(
      [
        "---",
        "type: concept",
        "title: Prosessinstanser",
        "sources:",
        '  umbrella: ["[[Kilder — Confluence]]"]',
        "  confluence: []",
        "  jira:",
        '    - {key: "MELOSYS-4025", summary: "MDC for saksflyt"}',
        "  legal: []",
        "updated: 2026-05-11",
        "---",
        "",
      ].join("\n"),
    );
    expect(fm.sources).toBeUndefined();
    expect(Object.keys(fm).some((k) => k.startsWith("sources."))).toBe(false);
    expect(fm.updated).toBe("2026-05-11");
  });

  test("a comment line does not end the block, at column 0 or indented", () => {
    // Measured before the rule: `{}` — a column-0 `#` line read as an unindented
    // non-key and closed the block, dropping every child after it.
    const fm = parseFrontmatter(
      [
        "---",
        "metadata:",
        "# a column-0 comment",
        "  # an indented comment",
        "  type: project",
        "---",
        "",
      ].join("\n"),
    );
    expect(fm["metadata.type"]).toBe("project");
  });

  test("tabs are not indentation — a tab-led line is neither a child nor mis-measured", () => {
    const tabbed = parseFrontmatter(
      ["---", "metadata:", "\ttype: project", "---", ""].join("\n"),
    );
    expect(tabbed["metadata.type"]).toBeUndefined();
    // Mixed tab/space: the tab-led line used to set a 1-CHAR childIndent, which
    // then dropped every 2-space sibling under it as "depth ≥ 2".
    const mixed = parseFrontmatter(
      ["---", "metadata:", "\tnode_type: memory", "  type: project", "---", ""].join("\n"),
    );
    expect(mixed["metadata.node_type"]).toBeUndefined();
    expect(mixed["metadata.type"]).toBeUndefined();
  });

  test("scalars emitted BEFORE the list marker stay — the block is dropped forward", () => {
    // Landed-as-is: the rule is "emit nothing MORE for this block", not a
    // retroactive delete. 0 occurrences measured across the six roots.
    const fm = parseFrontmatter(
      ["---", "metadata:", "  type: project", "  - x", "  extra: leaked", "---", ""].join("\n"),
    );
    expect(fm["metadata.type"]).toBe("project");
    expect(fm["metadata.extra"]).toBeUndefined();
  });

  test("a nested block under a VALUED key is not collected", () => {
    // `metadata: inline` carries its own value, so the indented lines below it
    // are not children of an open block — they belong to a shape we don't parse.
    const fm = parseFrontmatter(
      ["---", "metadata: inline", "  type: project", "---", ""].join("\n"),
    );
    expect(fm.metadata).toBe("inline");
    expect(fm["metadata.type"]).toBeUndefined();
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

  test("an unclosed [[ never swallows the next line's link", () => {
    // A truncated index one-liner leaves a dangling `[[`. Without the newline
    // exclusion the match spans the break, yielding one phantom target AND
    // hiding the real link on the following line.
    const links = extractWikilinks(
      ["- [[Entry One]] — prose mentioning [[Cordis…", "- [[Entry Two]] — more prose."].join("\n"),
    );
    expect(links).toEqual(["Entry One", "Entry Two"]);
  });

  test("a piped link's alias does not span lines either", () => {
    const links = extractWikilinks(["Prose with [[Target|label…", "- [[Next Entry]] tail."].join("\n"));
    expect(links).toEqual(["Next Entry"]);
  });
});

describe("firstDanglingWikilinkOpen", () => {
  test("cleanly paired lines answer -1, whatever the shape", () => {
    expect(firstDanglingWikilinkOpen("")).toBe(-1);
    expect(firstDanglingWikilinkOpen("no links here at all")).toBe(-1);
    expect(firstDanglingWikilinkOpen("- [[One]] — prose")).toBe(-1);
    expect(firstDanglingWikilinkOpen("[[a]][[b]]")).toBe(-1);
    expect(firstDanglingWikilinkOpen("[[Target|the label]] tail")).toBe(-1);
    // A single `[` inside the piped LABEL is ordinary text — the `]]` is there and
    // no second opener intervenes.
    expect(firstDanglingWikilinkOpen("[[Target|label with a [ bracket]] tail")).toBe(-1);
    // `[[[Foo]]` is a link to a page named `[Foo` — self-contained, not dangling.
    expect(firstDanglingWikilinkOpen("[[[Foo]]")).toBe(-1);
  });

  test("branch 1 — no ]] follows the opener at all", () => {
    expect(firstDanglingWikilinkOpen("- [[One]] — cut at [[Two")).toBe(19);
    expect(firstDanglingWikilinkOpen("[[Unclosed")).toBe(0);
  });

  test("branch 2 — an opener whose ]] belongs to a nested one", () => {
    // `WIKILINK_RE` pairs the OUTER `[[` with that `]]`, yielding a phantom target
    // and swallowing the real `[[Bar]]` link. A bracket-pairing scan that ignored
    // the nesting would call this clean.
    const line = "[[Foo [[Bar]] baz";
    expect(firstDanglingWikilinkOpen(line)).toBe(0);
    expect(extractWikilinks(line)).toEqual(["Foo [[Bar"]);
  });

  test("reports the FIRST dangling opener, not the last — the lastIndexOf blind spot", () => {
    // The LAST opener closes normally, so a `lastIndexOf`-based predicate answers
    // "clean" while the middle one is the debris.
    const line = "- [[A]] — earlier unclosed [[Frag and later [[Beta]] end";
    expect(firstDanglingWikilinkOpen(line)).toBe(27);
    expect(line.slice(27, 33)).toBe("[[Frag");
    expect(extractWikilinks(line)).toEqual(["A", "Frag and later [[Beta"]);
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

describe("isMarkdownWikiPath", () => {
  test("splits markdown pages from standalone .html explainers", () => {
    expect(isMarkdownWikiPath("concepts/Foo.md")).toBe(true);
    expect(isMarkdownWikiPath("blogs/foo.mdx")).toBe(true);
    expect(isMarkdownWikiPath("blogs/foo.html")).toBe(false);
    // Not a suffix-anywhere test: the extension is what decides.
    expect(isMarkdownWikiPath("concepts/foo.md.html")).toBe(false);
    expect(isMarkdownWikiPath("concepts/mdx-notes.txt")).toBe(false);
  });

  test("folds case — defensive, and unreachable from either caller today", () => {
    // Stated because it is easy to read the fold as load-bearing and it is not:
    // `resolve()` lowercases its target before calling this, and `lint.ts`'s
    // `checkStemCollisions` passes a raw on-disk relPath that reached the index
    // through a case-SENSITIVE discovery glob (`**/*.{md,mdx,html}`), so an
    // uppercase extension is not a page at all (pinned in `lint.test.ts`). The fold
    // is kept — it is what makes the predicate answer the question its NAME asks,
    // for a caller that hands it an arbitrary path — and pinned here so a future
    // case-insensitive glob does not need it rediscovered.
    expect(isMarkdownWikiPath("concepts/Foo.MD")).toBe(true);
    expect(isMarkdownWikiPath("blogs/Foo.MDX")).toBe(true);
    expect(isMarkdownWikiPath("blogs/Foo.HTML")).toBe(false);
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

  test("blog .mdx page carries description + sanitized accent/accentDark in meta", async () => {
    // Mirror mimir: the `blogs/` folder maps to the `blog` type via .wiki-reader.json.
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ typeMap: { blogs: "blog" }, typeLabels: { blog: "Blogs" } }),
    );
    await Bun.write(
      path.join(root, "blogs/campaign-status.mdx"),
      [
        "---",
        'title: "Campaign Status"',
        'description: "How campaigns move through the pipeline & why <it> matters"',
        "accent: #6c63ff",
        "accentDark: #a5a0ff",
        "---",
        "",
        "# Campaign Status",
        "",
        "Body with a [[Harness Engineering]] link.",
      ].join("\n"),
    );
    const index = await buildWikiIndex(root);
    const blog = index.resolve("campaign-status")!;
    expect(blog.type).toBe("blog");
    expect(blog.description).toBe("How campaigns move through the pipeline & why <it> matters");
    expect(blog.accent).toBe("#6c63ff");
    expect(blog.accentDark).toBe("#a5a0ff");
    // The .mdx page joins the wikilink graph like any .md page.
    expect(index.outgoing.get("blogs/campaign-status.mdx")).toContain(
      "concepts/harness engineering.md",
    );
  });

  test("malformed accent frontmatter is dropped at parse time (never reaches meta)", async () => {
    await Bun.write(
      path.join(root, "blogs/bad-accent.mdx"),
      [
        "---",
        "type: blog",
        "title: Bad Accent",
        "accent: red;} body{display:none}", // CSS-injection attempt
        "accentDark: not-a-color",
        "---",
        "",
        "# Bad Accent",
      ].join("\n"),
    );
    const index = await buildWikiIndex(root);
    const bad = index.resolve("bad-accent")!;
    expect(bad.accent).toBeUndefined();
    expect(bad.accentDark).toBeUndefined();
  });

  test("a .md page without accent/description leaves the fields undefined", async () => {
    const index = await buildWikiIndex(root);
    const harness = index.resolve("harness engineering")!;
    expect(harness.accent).toBeUndefined();
    expect(harness.accentDark).toBeUndefined();
    expect(harness.description).toBeUndefined();
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

  test("nested metadata.type resolves the page type; a top-level type: still wins", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await Bun.write(
      path.join(root, "notes/nested-type.md"),
      ["---", "metadata: ", "  type: concept", "---", "", "Body."].join("\n"),
    );
    await Bun.write(
      path.join(root, "notes/both-types.md"),
      ["---", "type: entity", "metadata:", "  type: concept", "---", "", "Body."].join("\n"),
    );
    const index = await buildWikiIndex(root);
    // Without the nested read this page would be `note` (notes/ is not a standard folder).
    expect(index.resolve("nested-type")!.type).toBe("concept");
    // Fallback, not merge: the authored top-level value is the page's type.
    expect(index.resolve("both-types")!.type).toBe("entity");
  });

  test("an UNUSABLE top-level type: falls through to metadata.type", async () => {
    // Presence-based (`fm.type ?? fm["metadata.type"]`) reads a top-level key
    // that resolves to nothing as an answer and never looks at the nested one,
    // so all three of these rendered as `note` with the real type one key away.
    await mkdir(path.join(root, "notes"), { recursive: true });
    await Bun.write(
      path.join(root, "notes/empty-type.md"),
      ["---", 'type: ""', "metadata:", "  type: concept", "---", "", "Body."].join("\n"),
    );
    await Bun.write(
      path.join(root, "notes/bogus-type.md"),
      ["---", "type: bogus", "metadata:", "  type: concept", "---", "", "Body."].join("\n"),
    );
    await Bun.write(
      path.join(root, "notes/array-type.md"),
      ["---", "type: [a, b]", "metadata:", "  type: concept", "---", "", "Body."].join("\n"),
    );
    // Neither level usable ⇒ the folder fallback, exactly as before.
    await Bun.write(
      path.join(root, "notes/both-bogus.md"),
      ["---", "type: bogus", "metadata:", "  type: alsobogus", "---", "", "Body."].join("\n"),
    );
    const index = await buildWikiIndex(root);
    expect(index.resolve("empty-type")!.type).toBe("concept");
    expect(index.resolve("bogus-type")!.type).toBe("concept");
    expect(index.resolve("array-type")!.type).toBe("concept");
    expect(index.resolve("both-bogus")!.type).toBe("note");
  });

  test("a wiki-DECLARED top-level type is usable, so it still beats metadata.type", async () => {
    // The acceptance check is the whole one, not just the five standard types:
    // a value the wiki declares in typeMap/typeLabels is authored, and must not
    // be treated as unusable and overridden by the nested key.
    await mkdir(path.join(root, "notes"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ typeLabels: { plan: "Plans" } }),
    );
    await Bun.write(
      path.join(root, "notes/declared.md"),
      ["---", "type: plan", "metadata:", "  type: concept", "---", "", "Body."].join("\n"),
    );
    const index = await buildWikiIndex(root);
    expect(index.resolve("declared")!.type).toBe("plan");
  });

  test("titleFrom is inert when unset — a name: page is still titled by its stem", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await Bun.write(
      path.join(root, "notes/feedback_depth.md"),
      ["---", "name: Depth over brevity", "---", "", "Body."].join("\n"),
    );
    const index = await buildWikiIndex(root);
    expect(index.readerConfig).toBeNull();
    expect(index.resolve("feedback_depth")!.title).toBe("feedback_depth");
  });

  test('titleFrom: ["name"] titles from name:, and title: still wins', async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ titleFrom: ["name", "metadata.name"] }),
    );
    await Bun.write(
      path.join(root, "notes/feedback_depth.md"),
      ["---", "name: Depth over brevity", "---", "", "Body."].join("\n"),
    );
    await Bun.write(
      path.join(root, "notes/titled.md"),
      ["---", "name: The name key", "title: The title key", "---", "", "Body."].join("\n"),
    );
    // A dotted key works too — it is just a key in the parsed map.
    await Bun.write(
      path.join(root, "notes/nested-name.md"),
      ["---", "metadata:", "  name: Nested name", "---", "", "Body."].join("\n"),
    );
    // No key from the list present ⇒ the stem, unchanged.
    await Bun.write(path.join(root, "notes/bare.md"), "# Bare\n\nBody.");
    const index = await buildWikiIndex(root);
    expect(index.resolve("feedback_depth")!.title).toBe("Depth over brevity");
    expect(index.resolve("titled")!.title).toBe("The title key");
    expect(index.resolve("nested-name")!.title).toBe("Nested name");
    expect(index.resolve("bare")!.title).toBe("bare");
    // The derived title joins byKey like any other title.
    expect(index.resolve("Depth over brevity")!.relPath).toBe("notes/feedback_depth.md");
  });

  test("titleFrom of the wrong type warns and degrades to stem titles", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await mkdir(path.join(root, "notes"), { recursive: true });
      await Bun.write(
        path.join(root, ".wiki-reader.json"),
        JSON.stringify({ titleFrom: "name", typeLabels: { plan: "Plans" } }),
      );
      await Bun.write(
        path.join(root, "notes/feedback_depth.md"),
        ["---", "name: Depth over brevity", "---", "", "Body."].join("\n"),
      );
      const index = await buildWikiIndex(root);
      expect(index.readerConfig?.titleFrom).toEqual([]);
      // The valid half of the config survives, as with typeMap/typeLabels.
      expect(index.readerConfig?.typeLabels.plan).toBe("Plans");
      expect(index.resolve("feedback_depth")!.title).toBe("feedback_depth");
      expect(
        records.some((r) => r.level === "warning" && r.rawMessage.includes("titleFrom")),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("defaultType replaces the note fallback and ONLY that fallback", async () => {
    await mkdir(path.join(root, "projects"), { recursive: true });
    await mkdir(path.join(root, "misc"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({
        defaultType: "memory-index",
        typeMap: { projects: "subsystem" },
        typeLabels: { "memory-index": "Memory index", subsystem: "Subsystems" },
      }),
    );
    // Nothing types this page: no frontmatter, no typeMap entry, not a standard
    // folder name ⇒ the wiki's own default instead of `note`.
    await Bun.write(path.join(root, "misc/loose.md"), "# Loose\n\nBody.");
    // Each of the three rules that DO type a page still wins ahead of it.
    await Bun.write(path.join(root, "projects/mapped.md"), "# Mapped\n\nBody."); // typeMap
    await Bun.write(path.join(root, "misc/authored.md"), "---\ntype: concept\n---\n\nBody."); // frontmatter
    const index = await buildWikiIndex(root);
    expect(index.readerConfig?.defaultType).toBe("memory-index");
    expect(index.resolve("loose")!.type).toBe("memory-index");
    expect(index.resolve("mapped")!.type).toBe("subsystem");
    expect(index.resolve("authored")!.type).toBe("concept");
    // …including the built-in standard-folder fallback (beforeEach's pages).
    expect(index.resolve("harness engineering")!.type).toBe("concept");
    expect(index.resolve("Creatine")!.type).toBe("source");
  });

  test("a defaultType the wiki declares needs no typeLabels entry to apply", async () => {
    await mkdir(path.join(root, "misc"), { recursive: true });
    await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ defaultType: "memo" }));
    await Bun.write(path.join(root, "misc/loose.md"), "# Loose\n\nBody.");
    const index = await buildWikiIndex(root);
    expect(index.resolve("loose")!.type).toBe("memo");
  });

  test("a defaultType of the wrong type warns and degrades to note", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await mkdir(path.join(root, "misc"), { recursive: true });
      await Bun.write(
        path.join(root, ".wiki-reader.json"),
        JSON.stringify({ defaultType: ["memory-index"], typeLabels: { plan: "Plans" } }),
      );
      await Bun.write(path.join(root, "misc/loose.md"), "# Loose\n\nBody.");
      const index = await buildWikiIndex(root);
      expect(index.readerConfig?.defaultType).toBe("");
      // The valid half survives, as with typeMap/typeLabels/titleFrom.
      expect(index.readerConfig?.typeLabels.plan).toBe("Plans");
      expect(index.resolve("loose")!.type).toBe("note");
      expect(
        records.some((r) => r.level === "warning" && r.rawMessage.includes("defaultType")),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("colliding stems get a disambiguated displayTitle; a unique stem does not", async () => {
    await mkdir(path.join(root, "projects/muninn"), { recursive: true });
    await mkdir(path.join(root, "projects/huginn"), { recursive: true });
    await Bun.write(path.join(root, "projects/muninn/tracing.md"), "# Tracing\n\nBody.");
    await Bun.write(path.join(root, "projects/huginn/tracing.md"), "# Tracing\n\nBody.");
    // Same stem, but this one AUTHORS a title — already distinguishable, left alone.
    await mkdir(path.join(root, "projects/nav"), { recursive: true });
    await Bun.write(
      path.join(root, "projects/nav/tracing.md"),
      "---\ntitle: Tracing in nav\n---\n\nBody.",
    );
    const index = await buildWikiIndex(root);
    const byRel = (rel: string) => index.resolveRelPath(rel)!;
    // Prefix is the immediately-containing folder — the discriminator — and the
    // stem is KEPT, so the row still says what the page is about.
    expect(byRel("projects/muninn/tracing.md").displayTitle).toBe("muninn/tracing");
    expect(byRel("projects/huginn/tracing.md").displayTitle).toBe("huginn/tracing");
    expect(byRel("projects/nav/tracing.md").displayTitle).toBeUndefined();
    // `title` is untouched on all three — it is what `byKey`/`stripTitle` read.
    expect(byRel("projects/muninn/tracing.md").title).toBe("tracing");
    // Scoped to the collision: beforeEach's lone `index.md` still reads `index`.
    expect(index.resolve("index")!.displayTitle).toBeUndefined();
  });

  test("folderLabels: configured entries beat the derived strip and drive the display title", async () => {
    await mkdir(path.join(root, "-Users-me-source-muninn/memory"), { recursive: true });
    await mkdir(path.join(root, "-Users-me-source-mimir/memory"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ folderLabels: { "-Users-me-source-muninn": "muninn" } }),
    );
    await Bun.write(path.join(root, "-Users-me-source-muninn/memory/MEMORY.md"), "# M\n\nBody.");
    await Bun.write(path.join(root, "-Users-me-source-mimir/memory/MEMORY.md"), "# M\n\nBody.");
    const index = await buildWikiIndex(root);
    const byRel = (rel: string) => index.resolveRelPath(rel)!;
    // The configured label replaces the FIRST segment — not the parent dir
    // (`memory`), which every one of these pages shares and so disambiguates
    // nothing.
    expect(byRel("-Users-me-source-muninn/memory/MEMORY.md").displayTitle).toBe("muninn/MEMORY");
    expect(index.folderLabels!["-Users-me-source-muninn"]).toBe("muninn");
    // An unlabeled folder gets no derived label HERE (this fixture's other
    // folders — concepts/, sources/, life/ — share no dash prefix with it, so
    // there is nothing to strip) and falls back to its parent dir. The
    // derivation itself is covered in `deriveFolderLabels` below.
    expect(index.folderLabels!["-Users-me-source-mimir"]).toBeUndefined();
    expect(byRel("-Users-me-source-mimir/memory/MEMORY.md").displayTitle).toBe("memory/MEMORY");
  });

  test("folderLabels of the wrong type warns and degrades to the derived labels", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await Bun.write(
        path.join(root, ".wiki-reader.json"),
        JSON.stringify({ folderLabels: ["nope"], typeLabels: { plan: "Plans" } }),
      );
      const index = await buildWikiIndex(root);
      expect(index.readerConfig?.folderLabels).toEqual({});
      expect(index.readerConfig?.typeLabels.plan).toBe("Plans");
      expect(
        records.some((r) => r.level === "warning" && r.rawMessage.includes("folderLabels")),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("a defaultType of `explainer` is refused: it would serve markdown as raw HTML", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await mkdir(path.join(root, "misc"), { recursive: true });
      await Bun.write(
        path.join(root, ".wiki-reader.json"),
        JSON.stringify({ defaultType: "explainer" }),
      );
      await Bun.write(path.join(root, "misc/loose.md"), "# Loose\n\nBody.");
      const index = await buildWikiIndex(root);
      // `explainer` is the ONE type that changes how a page is SERVED — the reader
      // puts it in a sandboxed iframe off `/api/wiki/html`, which streams the file
      // raw. Typing every untyped `.md` that way would ship markdown as text/html.
      expect(index.readerConfig?.defaultType).toBe("");
      expect(index.resolve("loose")!.type).toBe("note");
      expect(
        records.some(
          (r) => r.level === "warning" && r.rawMessage.includes("defaultType"),
        ),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("a defaultType of `note` is a no-op and says so", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await mkdir(path.join(root, "misc"), { recursive: true });
      await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ defaultType: "note" }));
      await Bun.write(path.join(root, "misc/loose.md"), "# Loose\n\nBody.");
      const index = await buildWikiIndex(root);
      expect(index.resolve("loose")!.type).toBe("note");
      expect(
        records.some((r) => r.level === "warning" && r.rawMessage.includes("defaultType")),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("an authored `type:` equal to the wiki's own defaultType is honoured", async () => {
    await mkdir(path.join(root, "projects"), { recursive: true });
    await mkdir(path.join(root, "misc"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ defaultType: "memory-index", typeMap: { projects: "subsystem" } }),
    );
    // Outside any typeMap folder the value is indistinguishable from the fallback…
    await Bun.write(path.join(root, "misc/a.md"), "---\ntype: memory-index\n---\n\nBody.");
    // …but INSIDE one, the typeMap would win over an unaccepted authored value, so
    // the page the author explicitly typed would render as `subsystem`.
    await Bun.write(path.join(root, "projects/b.md"), "---\ntype: memory-index\n---\n\nBody.");
    const index = await buildWikiIndex(root);
    expect(index.resolve("a")!.type).toBe("memory-index");
    expect(index.resolve("b")!.type).toBe("memory-index");
  });

  test("displayTitle is widened until it is UNIQUE", async () => {
    // mimir's real shape: two `huginn/` folders under different top-level dirs.
    // The depth-1 rule gives both `huginn/wiki-collection-pattern`, i.e. 30 rows
    // reading `MEMORY` traded for 2 rows reading the same thing.
    await mkdir(path.join(root, "archive/huginn"), { recursive: true });
    await mkdir(path.join(root, "projects/huginn"), { recursive: true });
    await Bun.write(path.join(root, "archive/huginn/wiki-collection-pattern.md"), "# x\n\nB.");
    await Bun.write(path.join(root, "projects/huginn/wiki-collection-pattern.md"), "# x\n\nB.");
    const index = await buildWikiIndex(root);
    const byRel = (rel: string) => index.resolveRelPath(rel)!;
    expect(byRel("archive/huginn/wiki-collection-pattern.md").displayTitle).toBe(
      "archive/huginn/wiki-collection-pattern",
    );
    expect(byRel("projects/huginn/wiki-collection-pattern.md").displayTitle).toBe(
      "projects/huginn/wiki-collection-pattern",
    );
  });

  test("widening a LABELED prefix grows forward from the label", async () => {
    // Two same-stem pages under ONE labeled project dir: the label alone can't
    // separate them, so the intermediate dirs are appended to it.
    await mkdir(path.join(root, "-Users-me-muninn/memory"), { recursive: true });
    await mkdir(path.join(root, "-Users-me-muninn/notes"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ folderLabels: { "-Users-me-muninn": "muninn" } }),
    );
    await Bun.write(path.join(root, "-Users-me-muninn/memory/MEMORY.md"), "# M\n\nB.");
    await Bun.write(path.join(root, "-Users-me-muninn/notes/MEMORY.md"), "# M\n\nB.");
    const index = await buildWikiIndex(root);
    const byRel = (rel: string) => index.resolveRelPath(rel)!;
    expect(byRel("-Users-me-muninn/memory/MEMORY.md").displayTitle).toBe("muninn/memory/MEMORY");
    expect(byRel("-Users-me-muninn/notes/MEMORY.md").displayTitle).toBe("muninn/notes/MEMORY");
  });

  test("two folders under ONE label still separate — the widening drops to the raw folder", async () => {
    // `deriveFolderLabels` warns when two folders resolve to the same label and
    // leaves the rows to the widening pass. At depth 1 the labeled chain is the
    // label ALONE, so every widening step returned the same string, the loop
    // stopped, and both rows read `same/p` — the very duplicate this mechanism
    // exists to remove. One step past the label chain is the RAW folder name,
    // which is unique by construction.
    await mkdir(path.join(root, "x"), { recursive: true });
    await mkdir(path.join(root, "y"), { recursive: true });
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ folderLabels: { x: "same", y: "same" } }),
    );
    await Bun.write(path.join(root, "x/p.md"), "# p\n\nB.");
    await Bun.write(path.join(root, "y/p.md"), "# p\n\nB.");
    const index = await buildWikiIndex(root);
    const byRel = (rel: string) => index.resolveRelPath(rel)!;
    expect(byRel("x/p.md").displayTitle).toBe("x/p");
    expect(byRel("y/p.md").displayTitle).toBe("y/p");
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

  test("index.shadowed records the three-way group, sorted, attributed to the .md winner", async () => {
    await mkdir(path.join(root, "blogs/src"), { recursive: true });
    await Bun.write(path.join(root, "concepts/Trio.md"), "---\ntype: concept\n---\n\nThe winner.");
    await Bun.write(path.join(root, "blogs/src/Trio.mdx"), "---\ntitle: Trio\n---\n\nMdx loser.");
    await Bun.write(
      path.join(root, "blogs/Trio.html"),
      "<!doctype html><html><head><title>Trio</title></head><body>Html loser.</body></html>",
    );
    const index = await buildWikiIndex(root);
    const trio = (index.shadowed ?? []).filter((s) => s.stem.toLowerCase() === "trio");
    // BOTH losers are recorded, each naming the same winner, in the SAME relPath
    // order `pages` itself is sorted in (`localeCompare`, which collates
    // `blogs/src/…` ahead of `blogs/Trio…` — punctuation is not primary-weighted).
    expect(trio.map((s) => s.relPath)).toEqual(["blogs/src/Trio.mdx", "blogs/Trio.html"]);
    expect(trio.map((s) => s.shadowedBy)).toEqual([
      "concepts/Trio.md",
      "concepts/Trio.md",
    ]);
  });

  test("index.shadowed is byte-identical across two builds (attribution can't flip)", async () => {
    // `pages` arrives in `Promise.all` completion order and the winner scan keeps
    // the FIRST page at the best rank — so with two same-rank `.md` candidates the
    // `.mdx` loser's `shadowedBy` named whichever file the filesystem returned
    // first, and flipped between builds. A human reads this through the linter.
    await Bun.write(path.join(root, "concepts/Flip.md"), "---\ntype: concept\n---\n\nOne.");
    await Bun.write(path.join(root, "entities/Flip.md"), "---\ntype: entity\n---\n\nTwo.");
    await Bun.write(path.join(root, "sources/Flip.mdx"), "---\ntitle: Flip\n---\n\nLoser.");
    const a = await buildWikiIndex(root);
    const b = await buildWikiIndex(root);
    expect(JSON.stringify(a.shadowed)).toBe(JSON.stringify(b.shadowed));
    // …and the winner is the relPath-first one, not an arbitrary same-rank page.
    const flip = (a.shadowed ?? []).find((s) => s.stem.toLowerCase() === "flip");
    expect(flip?.shadowedBy).toBe("concepts/Flip.md");
  });

  test("same-stem detection folds NFC — an NFD filename still shadows its NFC twin", async () => {
    // macOS writes decomposed filenames. Without the fold these are two different
    // stems, both survive, and the reader silently serves whichever `[[Blåbær]]`
    // registered first.
    const nfd = "Blåbær".normalize("NFD");
    const nfc = "Blåbær".normalize("NFC");
    await Bun.write(path.join(root, "concepts", `${nfc}.md`), "---\ntype: concept\n---\n\nWinner.");
    await Bun.write(path.join(root, "sources", `${nfd}.mdx`), `---\ntitle: ${nfd}\n---\n\nLoser.`);
    const index = await buildWikiIndex(root);
    const berry = (index.shadowed ?? []).filter((s) => s.stem.normalize("NFC") === nfc);
    expect(berry.length).toBe(1);
    expect(berry[0]!.relPath.normalize("NFC")).toBe(`sources/${nfc}.mdx`);
    expect(berry[0]!.shadowedBy.normalize("NFC")).toBe(`concepts/${nfc}.md`);
    expect(index.pages.filter((p) => p.name.normalize("NFC") === nfc).length).toBe(1);
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

  test("compile-pipeline source excluded: compiled explainer survives with backlinks, .mdx source absent", async () => {
    // Capture wiki-store logs so we can assert the exclusion is logged at DEBUG
    // (expected pipeline shape), NOT at WARN (which flags authoring mistakes).
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await mkdir(path.join(root, "blogs/src"), { recursive: true });
      // Mirror the real mimir pipeline layout: SOURCE at blogs/src/<slug>.mdx,
      // compiled explainer at blogs/<slug>.html carrying the generated marker.
      await Bun.write(
        path.join(root, "blogs/src/foo.mdx"),
        "---\ntitle: Foo Source\n---\n\n# Foo\n\n```mermaid\ngraph TD; A-->B;\n```\n",
      );
      await Bun.write(
        path.join(root, "blogs/foo.html"),
        "<!-- generated from blogs/src/foo.mdx — edit the source -->\n" +
          "<!doctype html><html><head><title>Foo Explainer</title></head><body>Compiled.</body></html>",
      );
      // A .md page backlinks the compiled explainer by relative path.
      await Bun.write(
        path.join(root, "concepts/Links Foo.md"),
        "---\ntype: concept\n---\n\nSee [foo](../blogs/foo.html).",
      );
      const index = await buildWikiIndex(root);

      // The compiled explainer stays listed…
      const foo = index.pages.filter((p) => p.name.toLowerCase() === "foo");
      expect(foo.length).toBe(1);
      expect(foo[0]!.relPath).toBe("blogs/foo.html");
      expect(foo[0]!.type).toBe("explainer");
      expect(foo[0]!.title).toBe("Foo Explainer");
      // …and keeps its backlink from the .md page.
      expect(index.backlinks.get("blogs/foo.html")).toEqual(["concepts/links foo.md"]);
      // The .mdx SOURCE is absent from pages, byKey, and byRelPath.
      expect(index.pages.some((p) => p.relPath === "blogs/src/foo.mdx")).toBe(false);
      expect(index.resolve("blogs/src/foo")).toBeUndefined();
      // resolve("foo") lands on the explainer, not the shadowing source.
      expect(index.resolve("foo")?.relPath).toBe("blogs/foo.html");
    } finally {
      await reset();
    }
    // Logged at debug (expected), never surfaced as a "shadowed" warn.
    expect(records.some((r) => r.rawMessage.includes("shadowed") && r.level === "warning")).toBe(
      false,
    );
    expect(
      records.some(
        (r) => r.level === "debug" && r.rawMessage.includes("compile-pipeline source"),
      ),
    ).toBe(true);
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

describe("deriveFolderLabels", () => {
  const projectDirs = [
    "-Users-rune-source-private-muninn",
    "-Users-rune-source-nav-melosys-api",
    "-Users-rune-private-AI-2027",
  ];

  test("strips the dash-token prefix every folder shares", () => {
    expect(deriveFolderLabels(projectDirs)).toEqual({
      "-Users-rune-source-private-muninn": "source-private-muninn",
      "-Users-rune-source-nav-melosys-api": "source-nav-melosys-api",
      "-Users-rune-private-AI-2027": "private-AI-2027",
    });
  });

  test("a configured entry wins; the shared prefix is still computed over it", () => {
    const labels = deriveFolderLabels(projectDirs, {
      "-Users-rune-source-private-muninn": "muninn",
    });
    expect(labels["-Users-rune-source-private-muninn"]).toBe("muninn");
    expect(labels["-Users-rune-private-AI-2027"]).toBe("private-AI-2027");
  });

  test("inert on every wiki whose folders share no dash prefix", () => {
    // mimir / jarvis / melosys-kode-wiki — measured, all of them.
    expect(deriveFolderLabels(["plans", "projects", "archive", "blogs"])).toEqual({});
    expect(deriveFolderLabels(["concepts", "entities", "sources"])).toEqual({});
  });

  test("the prefix is computed over ALL folders, so ONE unlabeled newcomer still gets a label", () => {
    // The memory wiki's real shape: 31 project dirs, every one of them labeled by
    // hand, and then a new project is opened. Computed over the UNLABELED subset
    // alone that is n=1 and the `< 2` guard returned nothing, so the newcomer's
    // rows read `memory/MEMORY` — the one folder the label exists to name.
    const labels = deriveFolderLabels(
      [
        "-Users-rune-source-private-muninn",
        "-Users-rune-source-private-mimir",
        "-Users-rune-source-private-brandnew",
      ],
      {
        "-Users-rune-source-private-muninn": "muninn",
        "-Users-rune-source-private-mimir": "mimir",
      },
    );
    expect(labels["-Users-rune-source-private-brandnew"]).toBe("brandnew");
    expect(labels["-Users-rune-source-private-muninn"]).toBe("muninn");
  });

  test("a folder that IS the shared prefix keeps its own name instead of an empty label", () => {
    // `p-q-` splits to a trailing EMPTY token, so the in-loop "leave one token"
    // bound leaves a remainder of "" — a blank facet option and a `"/MEMORY"`
    // display title. That folder keeps its own name; its siblings still strip.
    const labels = deriveFolderLabels(["p-q-", "p-q-r", "p-q-s"]);
    expect(labels["p-q-"]).toBeUndefined();
    expect(labels["p-q-r"]).toBe("r");
    expect(labels["p-q-s"]).toBe("s");
  });

  test("two folders mapping to one label are warned about", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      const labels = deriveFolderLabels(["-a-x-muninn", "-b-y-muninn"], {
        "-a-x-muninn": "muninn",
        "-b-y-muninn": "muninn",
      });
      // Both keep the label they were given — the collision is reported, not
      // silently "fixed" by dropping one folder's configured name.
      expect(labels["-a-x-muninn"]).toBe("muninn");
      expect(labels["-b-y-muninn"]).toBe("muninn");
      expect(
        records.some((r) => r.level === "warning" && r.rawMessage.includes("same label")),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("the three guards: one folder, one shared token, a folder that IS the prefix", () => {
    // A single folder is its own prefix — stripping it leaves nothing.
    expect(deriveFolderLabels(["-Users-rune-source-private-muninn"])).toEqual({});
    // One shared token is as likely meaningful as noise.
    expect(deriveFolderLabels(["nav-a", "nav-b"])).toEqual({});
    // `a-b` is the whole shared prefix of `a-b`/`a-b-c`; it keeps its own name
    // rather than being labeled "".
    expect(deriveFolderLabels(["a-b", "a-b-c", "a-b-d"])).toEqual({});
  });
});

describe("stemDisplayTitle", () => {
  test("prefers the wiki's folder label for the FIRST segment", () => {
    expect(
      stemDisplayTitle("-Users-x-muninn/memory/MEMORY.md", "MEMORY", {
        "-Users-x-muninn": "muninn",
      }),
    ).toBe("muninn/MEMORY");
  });

  test("falls back to the immediately-containing folder", () => {
    expect(stemDisplayTitle("projects/yggdrasil/architecture.md", "architecture", {})).toBe(
      "yggdrasil/architecture",
    );
  });

  test("a wiki-root page has no disambiguator", () => {
    expect(stemDisplayTitle("index.md", "index", {})).toBeNull();
  });

  test("a prefix identical to the stem adds nothing", () => {
    expect(stemDisplayTitle("memory/memory.md", "memory", {})).toBeNull();
  });
});

describe("extractPubDate", () => {
  test("reads the date from a body Source: line", () => {
    const md = [
      "---",
      "type: source",
      "created: 2026-04-25",
      "---",
      "",
      "# Title",
      "",
      "Source: YouTube, 2026-03-25 — https://www.youtube.com/watch?v=abc",
      "",
      "## Summary",
    ].join("\n");
    // The pub date is the Source: line's date, NOT the frontmatter created date.
    expect(extractPubDate(md)).toBe("2026-03-25");
  });

  test("undefined when there is no Source: line", () => {
    expect(extractPubDate("---\ntype: concept\n---\n\n# X\n\nProse.")).toBeUndefined();
    expect(extractPubDate("Source: nowhere without a date")).toBeUndefined();
  });
});

describe("extractDesc", () => {
  test("returns the first prose line, skipping frontmatter/heading/Source/list", () => {
    const md = [
      "---",
      "type: source",
      'title: "X"',
      "---",
      "",
      "# The Title",
      "",
      "Source: YouTube, 2026-03-25 — https://x",
      "",
      "## Summary",
      "",
      "- a bullet",
      "This is the first real prose line.",
    ].join("\n");
    expect(extractDesc(md)).toBe("This is the first real prose line.");
  });

  test("flattens wikilinks and markdown links to display text", () => {
    const md = "---\ntype: concept\n---\n\nSee [[Target Page|the display]] and [docs](x.md) here.";
    expect(extractDesc(md)).toBe("See the display and docs here.");
  });

  test("never leaks raw YAML — a page whose body is only frontmatter has no desc", () => {
    expect(extractDesc("---\ntype: note\ntitle: Only Frontmatter\n---\n")).toBeUndefined();
  });

  test("skips blockquotes, HTML comments and horizontal rules", () => {
    const md = [
      "---",
      "type: note",
      "---",
      "",
      "<!-- a comment -->",
      "> a callout",
      "---",
      "Actual prose.",
    ].join("\n");
    expect(extractDesc(md)).toBe("Actual prose.");
  });

  test("skips a bare URL:/metadata line and returns the prose two lines below", () => {
    const md = [
      "---",
      "type: source",
      "---",
      "",
      "# Title",
      "",
      "URL: https://example.com/some/article",
      "Date: 2026-03-25",
      "",
      "The real prose summary of the article.",
    ].join("\n");
    expect(extractDesc(md)).toBe("The real prose summary of the article.");
  });

  test("skips markdown table rows", () => {
    const md = [
      "---",
      "type: note",
      "---",
      "",
      "| Col A | Col B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Prose after the table.",
    ].join("\n");
    expect(extractDesc(md)).toBe("Prose after the table.");
  });

  test("skips a leading JSX/HTML component opening tag (mimir .mdx pages)", () => {
    const md = [
      "---",
      "type: plan",
      "---",
      "",
      '<Callout tone="info">',
      "",
      "This is the first genuine prose line.",
    ].join("\n");
    expect(extractDesc(md)).toBe("This is the first genuine prose line.");
  });

  test("strips a mid-prose component tag instead of leaking JSX into the blurb", () => {
    const md =
      '---\ntype: source\n---\n\nThe rover weighed <Fact n="1" v="ok">1.32 kg</Fact> at launch.';
    expect(extractDesc(md)).toBe("The rover weighed 1.32 kg at launch.");
  });

  test("a paragraph STARTING with a component tag is prose, not a skipped markup line", () => {
    // Without the strip, `startsWith("<")` dropped the whole (real) lead
    // paragraph and blurbed the next one instead.
    const md = [
      "---",
      "type: source",
      "---",
      "",
      '<Fact n="1" v="ok">The rover weighed 1.32 kg.</Fact> It launched in 2026.',
      "",
      "A later paragraph.",
    ].join("\n");
    expect(extractDesc(md)).toBe("The rover weighed 1.32 kg. It launched in 2026.");
  });

  test("strips inline emphasis/code markers so the blurb is plain text", () => {
    const md = "---\ntype: concept\n---\n\nThe **bold** and _italic_ and `code` and *starred* words.";
    expect(extractDesc(md)).toBe("The bold and italic and code and starred words.");
  });

  test("leaves interior underscores in identifiers alone", () => {
    const md = "---\ntype: note\n---\n\nThe some_var_name identifier stays intact.";
    expect(extractDesc(md)).toBe("The some_var_name identifier stays intact.");
  });

  test("drops the leading ! from an image, keeping its alt text", () => {
    const md = "---\ntype: note\n---\n\n![a diagram](img.png) shows the flow.";
    expect(extractDesc(md)).toBe("a diagram shows the flow.");
  });
});

describe("flattenLinks", () => {
  // Driven DIRECTLY, not through extractDesc, which splits on "\n" and feeds
  // this one line at a time — so the `\n` exclusion is unreachable from there
  // and a test routed through it stays green when the exclusion is removed.
  test("a dangling [[ never pairs with a LATER line's ]]", () => {
    // Without the `\n` exclusion the lazy target group runs from the unclosed
    // opener to the next line's `]]`, flattening both lines into one phantom
    // target and destroying the real `[[Beta]]` link between them.
    expect(flattenLinks("see [[Half Of A Link\n- [[Beta]] tail")).toBe("see [[Half Of A Link\n- Beta tail");
  });

  test("an alias is still taken from a well-formed link on one line", () => {
    expect(flattenLinks("- [[Beta|the label]] tail")).toBe("- the label tail");
  });
});

describe("buildWikiIndex — Atlas fields + trails", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-atlas-store-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stamps pubDate + desc onto markdown pages", async () => {
    await Bun.write(
      path.join(root, "sources/Vid.md"),
      [
        "---",
        "type: source",
        'title: "Vid"',
        "created: 2026-04-25",
        "---",
        "",
        "# Vid",
        "",
        "Source: YouTube, 2026-03-25 — https://x",
        "",
        "The interview covers agentic engineering.",
      ].join("\n"),
    );
    const index = await buildWikiIndex(root);
    const meta = index.resolve("Vid")!;
    expect(meta.pubDate).toBe("2026-03-25");
    expect(meta.desc).toBe("The interview covers agentic engineering.");
  });

  test("reads trails.json; malformed entries dropped, valid ones kept", async () => {
    await Bun.write(
      path.join(root, "trails.json"),
      JSON.stringify([
        { title: "Getting started", blurb: "A path.", steps: [{ page: "Vid", note: "watch first" }, { page: "Ghost" }] },
        { blurb: "no title — dropped" },
        { title: "Empty steps", steps: [{ note: "no page — dropped" }] },
      ]),
    );
    await Bun.write(path.join(root, "sources/Vid.md"), "---\ntype: source\n---\n\nProse.");
    const index = await buildWikiIndex(root);
    expect(index.trails).toHaveLength(2);
    expect(index.trails![0]!.title).toBe("Getting started");
    expect(index.trails![0]!.steps).toEqual([
      { page: "Vid", note: "watch first" },
      { page: "Ghost", note: undefined },
    ]);
    expect(index.trails![1]!.steps).toEqual([]); // step with no page dropped
  });

  test("no trails.json ⇒ empty trails array", async () => {
    await Bun.write(path.join(root, "sources/Vid.md"), "---\ntype: source\n---\n\nProse.");
    const index = await buildWikiIndex(root);
    expect(index.trails).toEqual([]);
  });

  test("malformed trails.json ⇒ empty trails, wiki stays browsable", async () => {
    await Bun.write(path.join(root, "trails.json"), "{ not json");
    await Bun.write(path.join(root, "sources/Vid.md"), "---\ntype: source\n---\n\nProse.");
    const index = await buildWikiIndex(root);
    expect(index.trails).toEqual([]);
    expect(index.pages).toHaveLength(1);
  });
});

describe("buildWikiIndex — plan status fields", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-planstatus-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const page = (name: string, fmLines: string[]) =>
    Bun.write(
      path.join(root, `plans/${name}.md`),
      ["---", `title: ${name}`, ...fmLines, "---", "", "Plan body."].join("\n"),
    );

  test("parses all four fields off a well-formed plan page", async () => {
    await page("Good Plan", [
      "plan_status: in-flight",
      "status_date: 2026-07-30",
      "followups: open",
      "status_note: waiting on the huginn tag-strip PR",
    ]);
    const meta = (await buildWikiIndex(root)).resolve("Good Plan")!;
    expect(meta.plan_status).toBe("in-flight");
    expect(meta.status_date).toBe("2026-07-30");
    expect(meta.followups).toBe("open");
    expect(meta.status_note).toBe("waiting on the huginn tag-strip PR");
  });

  test("every enum member is accepted", async () => {
    for (const v of PLAN_STATUS_VALUES) await page(`Plan ${v}`, [`plan_status: ${v}`]);
    const index = await buildWikiIndex(root);
    for (const v of PLAN_STATUS_VALUES) {
      expect(index.resolve(`Plan ${v}`)!.plan_status).toBe(v);
    }
  });

  test("a page declaring none of them carries none of them", async () => {
    await page("Bare", []);
    const meta = (await buildWikiIndex(root)).resolve("Bare")!;
    expect(meta.plan_status).toBeUndefined();
    expect(meta.status_date).toBeUndefined();
    expect(meta.followups).toBeUndefined();
    expect(meta.status_note).toBeUndefined();
  });

  // The load-bearing key check: melosys-kode-wiki carries `status:` on 75 pages
  // with an unrelated vocabulary (untracked / deleted-from-source / free prose).
  // A bare `status` key would hijack every one of them, so it must be inert here.
  test("the bare `status` key is ignored — it belongs to another wiki's vocabulary", async () => {
    await page("Melosys Shaped", ["status: deleted-from-source"]);
    const meta = (await buildWikiIndex(root)).resolve("Melosys Shaped")!;
    expect(meta.plan_status).toBeUndefined();
    expect(meta).not.toHaveProperty("status");
  });

  test("an invalid plan_status is dropped and uncounted — not passed through", async () => {
    await page("Bad Status", ["plan_status: in_flight", "status_date: 2026-07-30"]);
    await page("Wrong Case", ["plan_status: Shipped"]);
    const index = await buildWikiIndex(root);

    const bad = index.resolve("Bad Status")!;
    expect(bad.plan_status).toBeUndefined();
    // Dropping one field never collaterally drops its valid siblings.
    expect(bad.status_date).toBe("2026-07-30");
    // Strict membership: no case folding, no normalization.
    expect(index.resolve("Wrong Case")!.plan_status).toBeUndefined();

    // "Uncounted": the dropped values appear in NO plan_status tally anywhere in
    // the index — the pages are present, the field simply is not.
    const byStatus = new Map<string, number>();
    for (const p of index.pages) {
      if (p.plan_status) byStatus.set(p.plan_status, (byStatus.get(p.plan_status) ?? 0) + 1);
    }
    expect(byStatus.size).toBe(0);
    expect(index.pages.filter((p) => p.plan_status !== undefined)).toHaveLength(0);
    expect(index.pages).toHaveLength(2); // both pages still browsable
  });

  test("a malformed status_date is dropped", async () => {
    await page("Loose Date", ["plan_status: shipped", "status_date: 2026-7-1"]);
    await page("Prose Date", ["plan_status: shipped", "status_date: last tuesday"]);
    await page("Datetime", ["status_date: 2026-07-30T12:00:00Z"]);
    const index = await buildWikiIndex(root);
    expect(index.resolve("Loose Date")!.status_date).toBeUndefined();
    expect(index.resolve("Prose Date")!.status_date).toBeUndefined();
    expect(index.resolve("Datetime")!.status_date).toBeUndefined();
    // The sibling enum field is unaffected.
    expect(index.resolve("Loose Date")!.plan_status).toBe("shipped");
  });

  // The shape gate `/^\d{4}-\d{2}-\d{2}$/` admits days that do not exist. Left
  // through, a downstream staleness comparison gets `new Date("2026-99-99")` ⇒
  // Invalid Date ⇒ a NaN comparator ⇒ a non-deterministic sort, and the aggregated
  // warn would report zero drops so nothing points at the bad file.
  test("a shape-valid but impossible calendar day is dropped AND counted", async () => {
    await page("Feb 31", ["status_date: 2026-02-31"]);
    await page("Month 13", ["status_date: 2026-13-01"]);
    await page("All Nines", ["status_date: 2026-99-99"]);
    await page("Zeroes", ["status_date: 0000-00-00"]);
    await page("Day Zero", ["status_date: 2026-07-00"]);
    // A real leap day must survive — the round-trip check must not over-reject.
    await page("Leap Day", ["status_date: 2028-02-29"]);
    // …and the non-leap year's Feb 29 must not.
    await page("Fake Leap", ["status_date: 2027-02-29"]);

    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    let index: Awaited<ReturnType<typeof buildWikiIndex>>;
    try {
      index = await buildWikiIndex(root);
    } finally {
      await reset();
    }

    for (const name of ["Feb 31", "Month 13", "All Nines", "Zeroes", "Day Zero", "Fake Leap"]) {
      expect(index.resolve(name)!.status_date).toBeUndefined();
    }
    expect(index.resolve("Leap Day")!.status_date).toBe("2028-02-29");

    // Counted, not silently absent — the whole point of the round-trip check.
    const warn = records.find(
      (r) => r.level === "warning" && r.rawMessage.includes("plan-status"),
    )!;
    expect(warn).toBeDefined();
    expect((warn.properties as Record<string, unknown>).statusDate).toBe(6);
  });

  // The plan authoring contract tells humans to hand-write these keys, and YAML
  // lets them trail a comment. `parseFrontmatter` keeps the whole rest of the line,
  // so without a strip `plan_status: shipped # merged` fails the enum and vanishes.
  test("a trailing YAML comment is stripped from the three VALIDATED fields", async () => {
    await page("Commented", [
      "plan_status: shipped   # already merged",
      "status_date: 2026-07-30 # affirmed at the retro",
      "followups: none\t# nothing left",
    ]);
    const index = await buildWikiIndex(root);
    const meta = index.resolve("Commented")!;
    expect(meta.plan_status).toBe("shipped");
    expect(meta.status_date).toBe("2026-07-30");
    expect(meta.followups).toBe("none");
  });

  // Deliberate asymmetry: a note legitimately references a PR as `#399`, and the
  // documented contract for `status_note` is "quote it".
  test("status_note keeps a `#` — the comment strip is validated-fields-only", async () => {
    await page("Hash Note", ['status_note: "blocked on #399 — awaiting merge"']);
    const meta = (await buildWikiIndex(root)).resolve("Hash Note")!;
    expect(meta.status_note).toBe("blocked on #399 — awaiting merge");
  });

  // `parseFrontmatter` is line-oriented with no block-scalar support: given
  // `status_note: >` it reads the value as the single character ">" and never sees
  // the continuation lines. That ">" passed the `typeof === "string"` check and
  // shipped to /api/wiki/pages AND /api/wiki/page as the page's status note.
  test("a bare YAML block-scalar indicator is treated as an absent status_note", async () => {
    // Written by hand: the `page()` helper's frontmatter lines are flat.
    const write = (name: string, body: string) =>
      Bun.write(path.join(root, `plans/${name}.md`), body);
    await write(
      "Folded",
      ["---", "title: Folded", "status_note: >", "  a folded multi-line note", "  that continues here", "---", "", "Body."].join("\n"),
    );
    await write(
      "Literal",
      ["---", "title: Literal", "status_note: |", "  a literal block note", "---", "", "Body."].join("\n"),
    );
    await write(
      "Chomped",
      ["---", "title: Chomped", "status_note: |-", "  chomped literal", "---", "", "Body."].join("\n"),
    );
    await write(
      "Kept",
      ["---", "title: Kept", "status_note: >+", "  kept folded", "---", "", "Body."].join("\n"),
    );

    const index = await buildWikiIndex(root);
    for (const name of ["Folded", "Literal", "Chomped", "Kept"]) {
      expect(index.resolve(name)!.status_note).toBeUndefined();
    }
    // The indicator is not a validated field, so dropping it is not a drop.
    expect(index.pages).toHaveLength(4);
  });

  test("a note that merely CONTAINS a block-scalar character is untouched", async () => {
    await page("Arrow", ['status_note: "shipped > merged > verified"']);
    await page("Pipe", ['status_note: "A | B"']);
    const index = await buildWikiIndex(root);
    expect(index.resolve("Arrow")!.status_note).toBe("shipped > merged > verified");
    expect(index.resolve("Pipe")!.status_note).toBe("A | B");
  });

  // Documented contract, asserted: the tally counts a field only when the
  // frontmatter parser handed us a value. A key whose value reads as EMPTY is
  // skipped by `parseFrontmatter` (`if (!raw) continue`) and is indistinguishable
  // from an absent key, so it is NOT a drop — whereas `""` and `[x]` DO arrive.
  test("the drop tally cannot see a key the frontmatter parser read as empty", async () => {
    const write = (name: string, lines: string[]) =>
      Bun.write(
        path.join(root, `plans/${name}.md`),
        ["---", `title: ${name}`, ...lines, "---", "", "Body."].join("\n"),
      );
    await write("Bare Key", ["plan_status:"]);
    await write("Block Seq", ["plan_status:", "  - shipped"]);
    await write("Empty Quoted", ['plan_status: ""']);
    await write("Inline Array", ["plan_status: [shipped]"]);

    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    let index: Awaited<ReturnType<typeof buildWikiIndex>>;
    try {
      index = await buildWikiIndex(root);
    } finally {
      await reset();
    }

    // All four end up with no plan_status — the OUTCOME is uniform.
    for (const n of ["Bare Key", "Block Seq", "Empty Quoted", "Inline Array"]) {
      expect(index.resolve(n)!.plan_status).toBeUndefined();
    }
    // …but only the two that produced a value are COUNTED.
    const warn = records.find(
      (r) => r.level === "warning" && r.rawMessage.includes("plan-status"),
    )!;
    expect((warn.properties as Record<string, unknown>).planStatus).toBe(2);
    const samples = (warn.properties as Record<string, unknown>).samples as string;
    expect(samples).toContain("Empty Quoted.md");
    expect(samples).toContain("Inline Array.md");
    expect(samples).not.toContain("Bare Key.md");
    expect(samples).not.toContain("Block Seq.md");
  });

  test("followups accepts only open/none; anything else is dropped", async () => {
    await page("Open", ["followups: open"]);
    await page("None", ["followups: none"]);
    await page("Yes", ["followups: yes"]);
    const index = await buildWikiIndex(root);
    expect(index.resolve("Open")!.followups).toBe("open");
    expect(index.resolve("None")!.followups).toBe("none");
    expect(index.resolve("Yes")!.followups).toBeUndefined();
  });

  test("status_note takes free prose verbatim; an empty value is absent", async () => {
    await page("Prose", ['status_note: "capped at 4 rounds — R4 fixes unreviewed"']);
    await page("Empty", ['status_note: ""']);
    const index = await buildWikiIndex(root);
    expect(index.resolve("Prose")!.status_note).toBe("capped at 4 rounds — R4 fixes unreviewed");
    expect(index.resolve("Empty")!.status_note).toBeUndefined();
  });

  // The backfill writes these fields into ~145 files at once against a 5-min index
  // TTL — one warn PER PAGE would flood the log on every refresh, so the build
  // emits exactly one aggregated warn carrying the root and the drop counts.
  test("drops are reported as ONE aggregated warn per build, not one per page", async () => {
    for (let i = 0; i < 12; i++) {
      await page(`Broken ${i}`, ["plan_status: nonsense", "status_date: nope", "followups: maybe"]);
    }
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await buildWikiIndex(root);
    } finally {
      await reset();
    }
    const warns = records.filter(
      (r) => r.level === "warning" && r.rawMessage.includes("plan-status"),
    );
    expect(warns).toHaveLength(1);
    const props = warns[0]!.properties as Record<string, unknown>;
    expect(props.count).toBe(36); // 12 pages × 3 rejected fields
    expect(props.planStatus).toBe(12);
    expect(props.statusDate).toBe(12);
    expect(props.followups).toBe(12);
    expect(props.pages).toBe(12); // pages, not fields — one page contributed 3
    expect(props.root).toBe(root);

    // Counts alone are not actionable on a 385-page wiki: the warn must name the
    // offending pages, capped at 5 with the rest collapsed into "+N more".
    const samples = props.samples as string;
    const named = samples.split(" (+")[0]!.split(", ");
    expect(named).toHaveLength(5);
    for (const rel of named) expect(rel).toMatch(/^plans\/Broken \d+\.md$/);
    expect(samples).toEndWith(" (+7 more)"); // 12 offending pages − 5 named
  });

  test("a build with no invalid values logs no plan-status warn at all", async () => {
    await page("Clean", ["plan_status: shipped", "status_date: 2026-07-30", "followups: none"]);
    await page("Bare", []);
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await buildWikiIndex(root);
    } finally {
      await reset();
    }
    expect(records.some((r) => r.rawMessage.includes("plan-status"))).toBe(false);
  });
});

/**
 * The project resolver, driven directly. Pure, so every rule and every
 * precedence pair is provable without a filesystem — the index tests below
 * cover the WIRING (both meta constructors, the known-set first pass, the
 * config parse) rather than re-testing the rules through ~700 file reads.
 *
 * Every name here is invented. muninn must not know any wiki's layout: the
 * whole point of the declaration is that the reader learns it at runtime, so a
 * fixture spelled like a real wiki would be a spec muninn quietly grew.
 */
describe("resolveProject", () => {
  const rule: WikiProjectRule = {
    pathFolders: ["areas", "vault"],
    pageFolder: "units",
    filePrefixFolders: ["drafts"],
    frontmatter: ["owner-unit", "units"],
    tagFallback: true,
    aliases: { pomme: "pomme-core", zx: "zebra-exchange" },
  };
  const known = new Set(["pomme-core", "zebra-exchange", "quill", "quill-press"]);

  test("rule 1: the second segment under a declared pathFolder", () => {
    expect(resolveProject("areas/pomme-core/setup.md", {}, [], rule, known)).toBe("pomme-core");
    expect(resolveProject("vault/quill/notes.mdx", {}, [], rule, known)).toBe("quill");
  });

  test("rule 1: a file sitting DIRECTLY in the pathFolder is not a project", () => {
    // The segment count is the whole rule. `2026-07-07-x.md` has a second
    // segment too, and reading it as a project mints one facet value per file.
    expect(resolveProject("areas/2026-07-07-x.md", {}, [], rule, known)).toBeUndefined();
  });

  test("rule 1: a pathFolder value need not be in the known set", () => {
    // A project directory exists whether or not the wiki also keeps a page per
    // project — the layout is the evidence.
    expect(resolveProject("areas/never-heard-of-it/x.md", {}, [], rule, known)).toBe(
      "never-heard-of-it",
    );
  });

  test("rule 2: the file stem inside the pageFolder", () => {
    expect(resolveProject("units/zebra-exchange.md", {}, [], rule, known)).toBe("zebra-exchange");
  });

  test("rule 2: only direct children of the pageFolder", () => {
    // `units` is not a pathFolder, so a nested page falls through every rule.
    expect(resolveProject("units/zebra-exchange/deep.md", {}, [], rule, known)).toBeUndefined();
  });

  test("rule 3: the longest known project prefixing the stem", () => {
    // Both `quill` and `quill-press` are known; the shorter one must not win.
    expect(resolveProject("drafts/quill-press-rollout.mdx", {}, [], rule, known)).toBe(
      "quill-press",
    );
    expect(resolveProject("drafts/quill-index-rebuild.mdx", {}, [], rule, known)).toBe("quill");
  });

  test("rule 3: the prefix must be followed by a dash, not merely start the stem", () => {
    expect(resolveProject("drafts/quillpress-notes.mdx", {}, [], rule, known)).toBeUndefined();
  });

  test("rule 3: an UNKNOWN prefix falls through rather than minting a project", () => {
    expect(resolveProject("drafts/mango-alert-delivery.mdx", {}, [], rule, known)).toBeUndefined();
  });

  test("rule 4: the first declared frontmatter key with a value, aliased", () => {
    expect(resolveProject("notes/x.md", { "owner-unit": "pomme" }, [], rule, known)).toBe(
      "pomme-core",
    );
    // The FIRST key wins even when a later one also carries a value.
    expect(
      resolveProject("notes/x.md", { "owner-unit": "quill", units: ["zx"] }, [], rule, known),
    ).toBe("quill");
  });

  test("rule 4: an array value is filed under its first element", () => {
    expect(resolveProject("notes/x.md", { units: ["zebra-exchange", "quill"] }, [], rule, known))
      .toBe("zebra-exchange");
  });

  test("rule 4: an empty value is not a value — the next key gets its turn", () => {
    expect(resolveProject("notes/x.md", { "owner-unit": "  ", units: ["quill"] }, [], rule, known))
      .toBe("quill");
  });

  test("rule 4: a frontmatter value need not be known", () => {
    // Unlike a tag, an explicitly declared key IS the author saying so.
    expect(resolveProject("notes/x.md", { "owner-unit": "brand-new" }, [], rule, known)).toBe(
      "brand-new",
    );
  });

  test("rule 5: the first tag, through the aliases", () => {
    expect(resolveProject("notes/x.md", {}, ["pomme", "monitoring"], rule, known)).toBe(
      "pomme-core",
    );
  });

  test("rule 5: a first tag already in the known set resolves as itself", () => {
    expect(resolveProject("notes/x.md", {}, ["quill"], rule, known)).toBe("quill");
  });

  test("rule 5: an unknown, un-aliased first tag resolves to nothing", () => {
    // The guard the facet lives by: without it every page's leading tag becomes
    // a one-page bucket that is not a project at all.
    expect(resolveProject("notes/x.md", {}, ["monitoring", "quill"], rule, known)).toBeUndefined();
  });

  test("rule 5: off when tagFallback is not declared", () => {
    const noTags = { ...rule, tagFallback: false };
    expect(resolveProject("notes/x.md", {}, ["pomme"], noTags, known)).toBeUndefined();
  });

  test("precedence: the path beats a contradicting tag AND frontmatter", () => {
    expect(
      resolveProject(
        "areas/pomme-core/setup.md",
        { "owner-unit": "quill" },
        ["zx"],
        rule,
        known,
      ),
    ).toBe("pomme-core");
  });

  test("precedence: the pageFolder stem beats a contradicting frontmatter key", () => {
    expect(resolveProject("units/quill.md", { "owner-unit": "zx" }, [], rule, known)).toBe("quill");
  });

  test("precedence: a file-prefix match beats a contradicting tag", () => {
    expect(resolveProject("drafts/quill-x.md", {}, ["pomme"], rule, known)).toBe("quill");
  });

  test("precedence: frontmatter beats the tag fallback", () => {
    expect(resolveProject("notes/x.md", { units: ["quill"] }, ["pomme"], rule, known)).toBe("quill");
  });

  test("aliases apply to frontmatter and tags BOTH, and to neither path rule", () => {
    expect(resolveProject("notes/x.md", { "owner-unit": "zx" }, [], rule, known)).toBe(
      "zebra-exchange",
    );
    expect(resolveProject("notes/x.md", {}, ["zx"], rule, known)).toBe("zebra-exchange");
    // A directory literally named `zx` is what the layout says; a declaration
    // does not get to overrule the filesystem.
    expect(resolveProject("areas/zx/page.md", {}, [], rule, known)).toBe("zx");
  });

  test("no rule ⇒ undefined, whatever the page carries", () => {
    expect(
      resolveProject("areas/pomme-core/x.md", { "owner-unit": "quill" }, ["zx"], null, known),
    ).toBeUndefined();
  });

  test("a page matching nothing resolves to undefined", () => {
    expect(resolveProject("misc/loose.md", { title: "Loose" }, ["misc"], rule, known)).toBeUndefined();
  });

  test("aliases and frontmatter are read own-key only", () => {
    // A page tagged `constructor` must not read Object.prototype.
    expect(resolveProject("notes/x.md", {}, ["constructor"], rule, known)).toBeUndefined();
    const ctorKeys = { ...rule, frontmatter: ["constructor"] };
    expect(resolveProject("notes/x.md", {}, [], ctorKeys, known)).toBeUndefined();
  });
});

describe("collectKnownProjects", () => {
  const rule: WikiProjectRule = {
    pathFolders: [],
    pageFolder: "units",
    filePrefixFolders: [],
    frontmatter: [],
    tagFallback: false,
    aliases: {},
  };

  test("collects the stems of direct children, any admitted extension", () => {
    expect(
      collectKnownProjects(
        ["units/quill.md", "units/pomme-core.mdx", "units/zebra-exchange.html", "notes/x.md"],
        rule,
      ),
    ).toEqual(new Set(["quill", "pomme-core", "zebra-exchange"]));
  });

  test("a nested page under the pageFolder is not a project", () => {
    expect(collectKnownProjects(["units/quill/deep.md"], rule)).toEqual(new Set());
  });

  test("no rule, or no pageFolder, ⇒ an empty set", () => {
    expect(collectKnownProjects(["units/quill.md"], null)).toEqual(new Set());
    expect(collectKnownProjects(["units/quill.md"], { ...rule, pageFolder: "" })).toEqual(new Set());
  });
});

/**
 * The WIRING: the declaration is read once per build, the known set is collected
 * before any page resolves, and `project` lands on BOTH meta constructors.
 */
describe("buildWikiIndex — project", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-project-"));
    for (const d of ["areas/pomme-core", "units", "drafts", "misc"]) {
      await mkdir(path.join(root, d), { recursive: true });
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const declare = (project: unknown) =>
    Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ project }));

  const fullRule = {
    pathFolders: ["areas"],
    pageFolder: "units",
    filePrefixFolders: ["drafts"],
    frontmatter: ["owner-unit"],
    tagFallback: true,
    aliases: { pomme: "pomme-core" },
  };

  const page = (relPath: string, fmLines: string[], body = "Body.") =>
    Bun.write(
      path.join(root, relPath),
      fmLines.length > 0 ? ["---", ...fmLines, "---", "", body].join("\n") : body,
    );

  test("every rule reaches the page metadata through one declaration", async () => {
    await declare(fullRule);
    await page("units/pomme-core.md", ["title: Pomme Core"]);
    await page("units/quill.md", ["title: Quill"]);
    await page("areas/pomme-core/setup.md", ["title: Setup"]);
    await page("drafts/quill-rollout.md", ["title: Rollout"]);
    await page("misc/tagged.md", ["title: Tagged", "tags: [pomme, misc]"]);
    await page("misc/declared.md", ["title: Declared", "owner-unit: quill"]);
    await page("misc/orphan.md", ["title: Orphan", "tags: [misc]"]);

    const index = await buildWikiIndex(root);
    const project = (name: string) => index.resolve(name)!.project;
    expect(project("Pomme Core")).toBe("pomme-core");
    expect(project("Setup")).toBe("pomme-core");
    expect(project("Rollout")).toBe("quill");
    expect(project("Tagged")).toBe("pomme-core");
    expect(project("Declared")).toBe("quill");
    expect(project("Orphan")).toBeUndefined();
  });

  test("a drafts/ page resolves off a units/ stem regardless of walk order", async () => {
    // The known set is a FIRST pass over the path list. Resolved inside the
    // concurrent read instead, this page would answer differently depending on
    // which read finished first.
    await declare(fullRule);
    await page("units/zebra-exchange.md", ["title: Zebra Exchange"]);
    await page("drafts/zebra-exchange-cutover.md", ["title: Cutover"]);
    const index = await buildWikiIndex(root);
    expect(index.resolve("Cutover")!.project).toBe("zebra-exchange");
  });

  test("an explainer .html under a pathFolder gets the project too", async () => {
    await declare(fullRule);
    await Bun.write(
      path.join(root, "areas/pomme-core/report.html"),
      "<html><head><title>Pomme report</title></head><body>x</body></html>",
    );
    const index = await buildWikiIndex(root);
    const meta = index.pages.find((p) => p.relPath === "areas/pomme-core/report.html")!;
    expect(meta.type).toBe("explainer");
    expect(meta.project).toBe("pomme-core");
  });

  test("a CRLF page keeps the path rule after losing its frontmatter", async () => {
    // `parseFrontmatter`'s line regex ends in `(.*)$`, which does not match a
    // trailing `\r`, so a CRLF page parses to `{}` — no title, no tags. The
    // project must still resolve, because the path rule never reads the body.
    await declare(fullRule);
    await Bun.write(
      path.join(root, "areas/pomme-core/crlf.md"),
      "---\r\ntitle: CRLF Page\r\ntags: [quill]\r\n---\r\n\r\nBody.\r\n",
    );
    const index = await buildWikiIndex(root);
    const meta = index.pages.find((p) => p.relPath === "areas/pomme-core/crlf.md")!;
    expect(meta.title).toBe("crlf"); // frontmatter genuinely lost
    expect(meta.project).toBe("pomme-core");
  });

  test("no project declaration ⇒ undefined on every page", async () => {
    await Bun.write(
      path.join(root, ".wiki-reader.json"),
      JSON.stringify({ typeLabels: { plan: "Plans" } }),
    );
    await page("units/quill.md", ["title: Quill"]);
    await page("areas/pomme-core/setup.md", ["title: Setup", "tags: [pomme]"]);
    const index = await buildWikiIndex(root);
    expect(index.readerConfig?.project).toBeNull();
    expect(index.pages.every((p) => p.project === undefined)).toBe(true);
  });

  test("no .wiki-reader.json at all ⇒ undefined on every page", async () => {
    await page("units/quill.md", ["title: Quill"]);
    const index = await buildWikiIndex(root);
    expect(index.resolve("Quill")!.project).toBeUndefined();
  });

  test("a project that is not an object warns and drops the whole rule", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      await Bun.write(
        path.join(root, ".wiki-reader.json"),
        JSON.stringify({ project: "areas", typeLabels: { plan: "Plans" } }),
      );
      await page("areas/pomme-core/setup.md", ["title: Setup"]);
      const index = await buildWikiIndex(root);
      expect(index.readerConfig?.project).toBeNull();
      // The valid half of the config survives, as with typeMap/titleFrom.
      expect(index.readerConfig?.typeLabels.plan).toBe("Plans");
      expect(index.resolve("Setup")!.project).toBeUndefined();
      expect(
        records.some((r) => r.level === "warning" && r.rawMessage.includes("project is not")),
      ).toBe(true);
    } finally {
      await reset();
    }
  });

  test("a malformed SUB-FIELD warns and drops only that field", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      // `pathFolders` is a string, `aliases` a list, `tagFallback` a string —
      // all three dropped; `pageFolder` still works.
      await declare({
        pathFolders: "areas",
        pageFolder: "units",
        aliases: ["pomme"],
        tagFallback: "yes",
      });
      await page("units/quill.md", ["title: Quill"]);
      await page("areas/pomme-core/setup.md", ["title: Setup", "tags: [quill]"]);
      const index = await buildWikiIndex(root);
      const rule = index.readerConfig?.project;
      expect(rule?.pathFolders).toEqual([]);
      expect(rule?.aliases).toEqual({});
      expect(rule?.tagFallback).toBe(false);
      expect(rule?.pageFolder).toBe("units");
      expect(index.resolve("Quill")!.project).toBe("quill");
      // The dropped path rule means this page has no project — and the dropped
      // tagFallback means its `quill` tag does not rescue it.
      expect(index.resolve("Setup")!.project).toBeUndefined();
      for (const key of ["pathFolders", "aliases", "tagFallback"]) {
        expect(
          records.some(
            (r) => r.level === "warning" && JSON.stringify(r.properties).includes(key),
          ) || records.some((r) => r.level === "warning" && r.rawMessage.includes(key)),
        ).toBe(true);
      }
    } finally {
      await reset();
    }
  });

  test("blank entries are normalized away rather than invalidating the list", async () => {
    await declare({ ...fullRule, pathFolders: ["areas", "  ", ""] });
    await page("areas/pomme-core/setup.md", ["title: Setup"]);
    const index = await buildWikiIndex(root);
    expect(index.readerConfig?.project?.pathFolders).toEqual(["areas"]);
    expect(index.resolve("Setup")!.project).toBe("pomme-core");
  });
});

/**
 * Git date signals reach the page metadata. The parser itself is covered in
 * `git-dates.test.ts`; what these assert is the WIRING — that the walk's keys line
 * up with `WikiPageMeta.relPath`. A mismatch there (a normalization, a leading `./`,
 * a case fold) would silently stamp nothing and quietly reinstate the sweep-collapse
 * bug, with the index build still reporting success.
 */
describe("buildWikiIndex + git dates", () => {
  let root: string;

  /** Run git in the fixture with an identity supplied inline — the test host may
   *  have no global user.name, and a repo-local config write would be one more
   *  thing to clean up. Signing is forced off for the same reason. */
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(
      ["git", "-C", root, "-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-git-"));
    await git("init", "-q");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stamps gitCreatedMs on tracked pages, leaves untracked ones bare", async () => {
    await Bun.write(path.join(root, "plans/one.md"), "# One");
    await git("add", "-A");
    await git("commit", "-qm", "add one");
    // Written but never committed — no history, so nothing to stamp. Its birthtime
    // is honest anyway, which is why an absent field costs nothing.
    await Bun.write(path.join(root, "plans/untracked.md"), "# Untracked");

    const index = await buildWikiIndex(root);
    const one = index.pages.find((p) => p.relPath === "plans/one.md")!;
    const untracked = index.pages.find((p) => p.relPath === "plans/untracked.md")!;
    expect(one.gitCreatedMs).toBeGreaterThan(0);
    expect(untracked.gitCreatedMs).toBeUndefined();
  });

  test("a renamed page keeps its ORIGINAL creation date, not the rename's", async () => {
    // The end-to-end shape of mimir's `wiki/`→`projects/` reorg: `git mv` resets the
    // filesystem birthtime, so if the git date followed the rename too there would be
    // no surviving signal at all.
    await Bun.write(path.join(root, "old-name.md"), "# Page");
    await git("add", "-A");
    await git("commit", "-qm", "add");
    const firstCommit = (await buildWikiIndex(root)).pages.find(
      (p) => p.relPath === "old-name.md",
    )!.gitCreatedMs;
    // Assert the premise, or the comparison below passes vacuously on two undefineds
    // — which is exactly how the /tmp-symlink degrade first hid from this test.
    expect(firstCommit).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1100)); // %at is second-granular
    await git("mv", "old-name.md", "new-name.mdx");
    await git("commit", "-qm", "rename");

    __resetWikiCacheForTest();
    const renamed = (await buildWikiIndex(root)).pages.find((p) => p.relPath === "new-name.mdx")!;
    expect(renamed.gitCreatedMs).toBe(firstCommit);
  });

  test("a non-ASCII filename is stamped (core.quotePath regression guard)", async () => {
    // git's `core.quotePath` defaults to TRUE and octal-escapes any non-ASCII path:
    // `Årsavregning.md` arrives as `"wiki/concepts/\303\205rsavregning.md"`, a key that
    // matches no relPath. This silently cost huginn-nav 171 of 540 pages (32%) — and it
    // could never trip the zero-hit warn, because the ASCII majority still matched. This
    // is a REAL-git test on purpose: the parser cannot detect the problem, only the
    // spawn's `-c core.quotePath=false` prevents it, so a hand-written fixture would
    // guard nothing.
    await Bun.write(path.join(root, "concepts/Årsavregning.md"), "# Årsavregning");
    await Bun.write(path.join(root, "entities/Carissa Véliz.md"), "# Carissa Véliz");
    await git("add", "-A");
    await git("commit", "-qm", "non-ascii names");

    const index = await buildWikiIndex(root);
    for (const rel of ["concepts/Årsavregning.md", "entities/Carissa Véliz.md"]) {
      expect(index.pages.find((p) => p.relPath === rel)?.gitCreatedMs).toBeGreaterThan(0);
    }
  });

  test("a non-git wiki builds cleanly with the fields simply absent", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "wiki-nogit-"));
    try {
      await Bun.write(path.join(plain, "p.md"), "# P");
      const index = await buildWikiIndex(plain);
      expect(index.pages).toHaveLength(1);
      expect(index.pages[0]!.gitCreatedMs).toBeUndefined();
      // All three degrade together — the client reads an absent `gitCreatedMs` as
      // "git knows nothing here" and goes back to ranking on mtime.
      expect(index.pages[0]!.gitTouchedMs).toBeUndefined();
      expect(index.pages[0]!.gitDirty).toBeUndefined();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("a SWEEP contributes no gitTouchedMs, so the real edit survives it", async () => {
    // The end-to-end shape of mimir's 2026-07-31 backfill: one commit rewriting more
    // pages than the threshold allows. `target.md`'s own small edit must still be the
    // date it reports, and the pages that arrived only in the sweep must report
    // nothing at all — that absence is what `pageTimeMs` folds onto their creation date.
    await Bun.write(path.join(root, "plans/target.md"), "# Target");
    await git("add", "-A");
    await git("commit", "-qm", "add target");
    await new Promise((r) => setTimeout(r, 1100)); // %at is second-granular
    await Bun.write(path.join(root, "plans/target.md"), "# Target (edited)");
    await git("add", "-A");
    await git("commit", "-qm", "real edit");
    const realEdit = (await buildWikiIndex(root)).pages.find(
      (p) => p.relPath === "plans/target.md",
    )!.gitTouchedMs;
    expect(realEdit).toBeGreaterThan(0); // premise, not a vacuous undefined===undefined

    await new Promise((r) => setTimeout(r, 1100));
    await Bun.write(path.join(root, "plans/target.md"), "# Target (swept)");
    for (let i = 0; i < SWEEP_THRESHOLD; i++) {
      await Bun.write(path.join(root, `plans/bulk-${i}.md`), "# Bulk");
    }
    await git("add", "-A");
    await git("commit", "-qm", "sweep");

    __resetWikiCacheForTest();
    const after = await buildWikiIndex(root);
    const target = after.pages.find((p) => p.relPath === "plans/target.md")!;
    expect(target.gitTouchedMs).toBe(realEdit);
    // Born in the sweep and never touched outside it — no update date at all.
    const bulk = after.pages.find((p) => p.relPath === "plans/bulk-0.md")!;
    expect(bulk.gitCreatedMs).toBeGreaterThan(0);
    expect(bulk.gitTouchedMs).toBeUndefined();
  });

  test("an uncommitted edit is flagged gitDirty — the mtime rule's only opener", async () => {
    await Bun.write(path.join(root, "plans/clean.md"), "# Clean");
    await Bun.write(path.join(root, "plans/edited.md"), "# Edited");
    await git("add", "-A");
    await git("commit", "-qm", "add both");
    await Bun.write(path.join(root, "plans/edited.md"), "# Edited, again");

    __resetWikiCacheForTest();
    const index = await buildWikiIndex(root);
    expect(index.pages.find((p) => p.relPath === "plans/edited.md")!.gitDirty).toBe(true);
    expect(index.pages.find((p) => p.relPath === "plans/clean.md")!.gitDirty).toBeUndefined();
  });

  test("pages in a wholly-untracked FOLDER are flagged dirty individually", async () => {
    // `git status --porcelain` defaults to collapsing an untracked directory into ONE
    // entry naming the directory (`?? newdir/`), never its files. Those pages would
    // then be neither git-dated nor dirty — invisible to the mtime rule and counted as
    // unexplained by the coverage warn, which would fire on every index build until
    // someone committed the folder. `-uall` on the status spawn is what prevents it.
    await Bun.write(path.join(root, "seed.md"), "# Seed");
    await git("add", "-A");
    await git("commit", "-qm", "seed");
    await Bun.write(path.join(root, "brand-new-folder/a.md"), "# A");
    await Bun.write(path.join(root, "brand-new-folder/b.md"), "# B");

    __resetWikiCacheForTest();
    const index = await buildWikiIndex(root);
    for (const rel of ["brand-new-folder/a.md", "brand-new-folder/b.md"]) {
      expect(index.pages.find((p) => p.relPath === rel)!.gitDirty).toBe(true);
    }
  });
});

// ── flattenWikiLinks (share body prep) ───────────────────────────────────────
// The rule is by SCHEME, not by extension: mimir links `.md`, `.mdx`, `.html` AND
// extension-less relative paths, and all four resolve only inside the reader.
// Emphasis and real external links are deliberately untouched — this is not the
// Atlas blurb's private `flattenLinks`.

describe("flattenWikiLinks", () => {
  test("wikilinks collapse to their display label", () => {
    expect(flattenWikiLinks("see [[Harness Engineering]] today")).toBe("see Harness Engineering today");
    expect(flattenWikiLinks("see [[repos/huginn.md|Huginn]] today")).toBe("see Huginn today");
  });

  test("an empty pipe label falls back to the target", () => {
    expect(flattenWikiLinks("[[Target|]]")).toBe("Target");
  });

  test("a dangling [[ does not flatten the lines between it and a later ]]", () => {
    // This runs over a whole page body on its way OUT of the wiki, so a cross-line
    // match deletes headings, bullets and the next entry's link from the post.
    const body = ["- cut at [[Some Frag", "", "## Heading", "", "- see Harness Engineering]]"].join("\n");
    expect(flattenWikiLinks(body)).toBe(body);
  });

  for (const [target, label] of [
    ["plans/x.md", ".md"],
    ["plans/x.mdx", ".mdx"],
    ["blogs/x.html", ".html"],
    ["projects/muninn", "extension-less bare path"],
    ["../repos/huginn.md", "relative with .."],
    ["#a-section", "same-page anchor"],
  ] as const) {
    test(`internal link (${label}) collapses to its text`, () => {
      expect(flattenWikiLinks(`read [the plan](${target}) first`)).toBe("read the plan first");
    });
  }

  test("external http(s) and mailto links survive untouched", () => {
    const md = "see [docs](https://example.com/a) and [mail](mailto:x@example.com) and [p](http://x.test)";
    expect(flattenWikiLinks(md)).toBe(md);
  });

  test("an external link keeps its title attribute verbatim", () => {
    const md = '[docs](https://example.com "The docs")';
    expect(flattenWikiLinks(md)).toBe(md);
  });

  test("emphasis, bold and inline code are left alone", () => {
    const md = "**bold** and *italic* and `code` with [[Link]]";
    expect(flattenWikiLinks(md)).toBe("**bold** and *italic* and `code` with Link");
  });

  test("links inside a fenced code block are untouched", () => {
    const md = "before [x](y.md)\n```md\n[x](y.md) and [[Wiki Link]]\n```\nafter [z](z.md)";
    expect(flattenWikiLinks(md)).toBe("before x\n```md\n[x](y.md) and [[Wiki Link]]\n```\nafter z");
  });

  test("links inside an inline backtick span are untouched", () => {
    expect(flattenWikiLinks("write `[x](y.md)` like this, not [x](y.md)")).toBe(
      "write `[x](y.md)` like this, not x",
    );
  });

  test("an internal image collapses to its alt text; an external one survives", () => {
    expect(flattenWikiLinks("![diagram](img/x.png)")).toBe("diagram");
    expect(flattenWikiLinks("![d](https://x.test/x.png)")).toBe("![d](https://x.test/x.png)");
  });

  test("a body with no links is returned unchanged", () => {
    expect(flattenWikiLinks("plain prose, 2 * 3 and a [bracket] alone")).toBe(
      "plain prose, 2 * 3 and a [bracket] alone",
    );
  });
});
