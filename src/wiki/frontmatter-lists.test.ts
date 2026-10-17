/**
 * The `related:` reader and resolver (plan `muninn-wiki-work-thread-grouping`,
 * D18): one case per form a wiki writes, and the five resolution steps. The
 * `owns:` form table lives in `lint-state.test.ts`. Synthetic names only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFrontmatterLists, readOwns, readRelated, resolveRelatedEntries, type RelatedResolveContext } from "./frontmatter-lists.ts";
import { buildWikiIndex } from "./store.ts";
import { toListing } from "../dashboard/routes/wiki-routes.ts";

const page = (fm: string) => `---\ntitle: X\n${fm}\nstatus: open\n---\n\nBody [[not-related]].\n`;
const entries = (fm: string) => readRelated(page(fm)).entries;

/** A five-page wiki: `notes/a`, `notes/b`, `plans/c`, `d.mdx` at the root and
 *  `plans/e.html`; `notes/a` is titled "Alpha" with alias "al"; two pages share
 *  the title "Twin". Link resolution is the graph's: names and titles. */
const PAGES: Record<string, { names: string[] }> = {
  "notes/a.md": { names: ["a", "alpha", "al"] },
  "notes/b.md": { names: ["b", "twin"] },
  "plans/c.mdx": { names: ["c", "twin"] },
  "d.mdx": { names: ["d"] },
  "plans/e.html": { names: ["e"] },
};
const ctx = (from: string): RelatedResolveContext => ({
  fromRelPath: from,
  roots: ["/w/wiki", "/Users/x/wiki/"],
  byPath: (rel) => Object.keys(PAGES).find((p) => p.toLowerCase() === path.posix.normalize(rel).toLowerCase()),
  byName: (key) => Object.entries(PAGES).filter(([, v]) => v.names.includes(key)).map(([k]) => k),
  byLink: (t) => {
    const k = t.toLowerCase();
    const named = Object.entries(PAGES).find(([, v]) => v.names.includes(k));
    if (named) return named[0];
    return Object.keys(PAGES).find((p) => p === `${k}.md` || p === `${k}.mdx`);
  },
});
const resolve = (fm: string, from = "notes/b.md") => resolveRelatedEntries(entries(fm), ctx(from));

describe("readRelated — every form, each target read once", () => {
  test("unquoted single [[a]] (YAML reads a nested list; the scanner the link)", () => {
    expect(entries("related: [[a]]")).toEqual([{ kind: "link", target: "a" }]);
    expect(resolve("related: [[a]]")).toEqual({ targets: ["notes/a.md"], skipped: 0, ambiguous: 0 });
  });
  test("unquoted several [[a]], [[d]] (YAML refuses the whole frontmatter)", () => {
    expect(entries("related: [[a]], [[d]]")).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "d" },
    ]);
    expect(resolve("related: [[a]], [[d]]").targets).toEqual(["notes/a.md", "d.mdx"]);
  });
  test('quoted inline ["[[a]]"] beside an unquoted [[a]] elsewhere is one resolution, not two', () => {
    expect(entries('related: ["[[a]]", "[[d|Dee]]"]')).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "d" },
    ]);
    expect(resolve('related: ["[[a]]", "[[A]]"]')).toEqual({ targets: ["notes/a.md"], skipped: 0, ambiguous: 0 });
  });
  test('a scalar "[[x]]" is a one-entry list', () => {
    expect(entries('related: "[[plans/c]]"')).toEqual([{ kind: "link", target: "plans/c" }]);
    expect(resolve('related: "[[plans/c]]"').targets).toEqual(["plans/c.mdx"]);
  });
  test("an empty [] is none, and a page without the key reads nothing", () => {
    expect(readRelated(page("related: []"))).toEqual({ present: true, entries: [] });
    expect(readRelated(page("tags: [x]"))).toEqual({ present: false, entries: [] });
    expect(readRelated("no frontmatter, [[a]]")).toEqual({ present: false, entries: [] });
  });
  test("a block list of - [[x]], with a #fragment and a |label stripped", () => {
    const fm = "related:\n  - [[a#Section]]\n  - [[d|the d page]]";
    expect(entries(fm)).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "d" },
    ]);
    expect(resolve(fm).targets).toEqual(["notes/a.md", "d.mdx"]);
  });
  test("a block list of paths", () => {
    const fm = "related:\n  - plans/c.mdx\n  - ../d.mdx";
    expect(entries(fm)).toEqual([
      { kind: "text", value: "plans/c.mdx" },
      { kind: "text", value: "../d.mdx" },
    ]);
    expect(resolve(fm).targets).toEqual(["plans/c.mdx", "d.mdx"]);
  });
  test("an inline list of bare root-relative paths, extension implied", () => {
    expect(resolve("related: [plans/c, notes/a]")).toEqual({ targets: ["plans/c.mdx", "notes/a.md"], skipped: 0, ambiguous: 0 });
  });
  test("prose and Jira keys are skipped and counted, never an error", () => {
    expect(entries("related: see the old notes, and more")).toEqual([{ kind: "text", value: "see the old notes, and more" }]);
    expect(resolve("related: see the old notes, and more")).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
    expect(resolve("related: [ABC-123, ABC-456, [[a]]]")).toEqual({ targets: ["notes/a.md"], skipped: 2, ambiguous: 0 });
  });
  test("an entry whose frontmatter breaks YAML elsewhere is read from its own lines", () => {
    const broken = "---\ntitle: X: Y: [\nrelated:\n  - plans/c.mdx\nowns: [ABC-12]\n---\n";
    expect(readRelated(broken).entries).toEqual([{ kind: "text", value: "plans/c.mdx" }]);
    expect(readFrontmatterLists(broken)).toEqual({ owns: readOwns(broken), related: readRelated(broken) });
    expect(readOwns(broken).keys).toEqual(["ABC-12"]);
  });
  test("a related: line inside another key's value is not the key", () => {
    expect(readRelated(page("description: |\n  related: [[a]]")).entries).toEqual([]);
  });
});

describe("resolveRelatedEntries — the five steps", () => {
  test("1: a link goes to the graph's resolution (name, title, alias), else an exact path (.html)", () => {
    expect(resolve("related: [[Alpha]], [[al]], [[plans/e.html]]", "d.mdx").targets).toEqual(["notes/a.md", "plans/e.html"]);
  });
  test("1: a dangling link is skipped", () => {
    expect(resolve("related: [[gone]]")).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
  });
  test("2: ./ and ../ resolve against the page's folder; above the root is skipped", () => {
    expect(resolve("related: [./a, ../plans/c.mdx]").targets).toEqual(["notes/a.md", "plans/c.mdx"]);
    expect(resolve("related: [../../x/a.md]")).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
  });
  test("3: an absolute path counts under a root, in any spelling; elsewhere it is skipped", () => {
    expect(resolve("related: [/w/wiki/plans/c.mdx, /Users/x/wiki/notes/a]").targets).toEqual(["plans/c.mdx", "notes/a.md"]);
    expect(resolve("related: [/w/other/plans/c.mdx]")).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
  });
  test("4: a bare name tries the page's folder, the root, then a UNIQUE stem, title or alias", () => {
    expect(resolve("related: [a]", "notes/b.md").targets).toEqual(["notes/a.md"]);
    expect(resolve("related: [d.mdx]", "notes/b.md").targets).toEqual(["d.mdx"]);
    expect(resolve("related: [alpha, al]", "plans/c.mdx").targets).toEqual(["notes/a.md"]);
  });
  test("4: a title two pages carry is ambiguous: skipped and counted apart", () => {
    expect(resolve("related: [twin]", "d.mdx")).toEqual({ targets: [], skipped: 0, ambiguous: 1 });
  });
  test("the page itself is never a target, and targets dedupe across steps", () => {
    expect(resolve("related: [[b]], [[a]], [./a.md, notes/a, /w/wiki/notes/a.md]")).toEqual({
      targets: ["notes/a.md"],
      skipped: 0,
      ambiguous: 0,
    });
  });
});

describe("the index read pass", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-fm-lists-"));
    await mkdir(path.join(root, "plans"));
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "plans/one.md"), "---\ntitle: One\nowns: [ABC-12]\nrelated: [[two]], [[Twin]]\n---\n\nBody.\n");
    await writeFile(path.join(root, "plans/two.md"), "---\ntitle: Two\nrelated:\n  - plans/one\n  - prose here\n---\n");
    await writeFile(path.join(root, "notes/twin.md"), "---\ntitle: Twin\naliases: [shared]\n---\n");
    await writeFile(path.join(root, "notes/other.md"), "---\ntitle: Other\naliases: [shared]\nrelated: [shared]\n---\n");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("owns and resolved related land on the page; the listing ships none of them", async () => {
    const index = await buildWikiIndex(root);
    const by = (rel: string) => index.pages.find((p) => p.relPath === rel)!;
    expect(by("plans/one.md")).toMatchObject({ owns: ["ABC-12"], related: ["plans/two.md", "notes/twin.md"] });
    expect(by("plans/two.md")).toMatchObject({ related: ["plans/one.md"], relatedSkipped: 1 });
    // `shared` is an alias of two pages (other.md itself included): ambiguous.
    expect(by("notes/other.md")).toMatchObject({ relatedAmbiguous: 1 });
    expect(by("notes/other.md").related).toBeUndefined();
    expect(by("notes/twin.md").owns).toBeUndefined();
    for (const opts of [{}, { includeDesc: true, includeProvenance: true, includeCull: true, includeWork: true }]) {
      const row = toListing(index, by("plans/one.md"), opts) as unknown as Record<string, unknown>;
      for (const k of ["owns", "related", "relatedSkipped", "relatedAmbiguous"]) expect(row[k]).toBeUndefined();
    }
    expect(toListing(index, by("plans/two.md")) as unknown as Record<string, unknown>).not.toHaveProperty("relatedSkipped");
  });
});

describe("fix round 1 — the related: reader's three defects", () => {
  /** An alias chain: `a0` holds nine leaves, each `a<i>` nine references to
   *  `a<i-1>`. `Bun.YAML` shares an alias by reference, so a reader that walks
   *  the value in full costs 9^depth while the text stays a few hundred bytes. */
  const aliasBomb = (depth: number, map: boolean) => {
    let y = map ? "a0: &a0 {k0: lol, k1: lol, k2: lol}\n" : "a0: &a0 [lol,lol,lol,lol,lol,lol,lol,lol,lol]\n";
    for (let i = 1; i <= depth; i++) {
      const refs = Array.from({ length: 9 }, (_, j) => (map ? `k${j}: *a${i - 1}` : `*a${i - 1}`)).join(", ");
      y += map ? `a${i}: &a${i} {${refs}}\n` : `a${i}: &a${i} [${refs}]\n`;
    }
    return `---\n${y}related: *a${depth}\n---\nbody\n`;
  };

  for (const map of [false, true]) {
    test(`A: a deep YAML alias chain (${map ? "maps" : "lists"}) reads in bounded time`, () => {
      for (const depth of [3, 5, 7, 9]) {
        const content = aliasBomb(depth, map);
        const t = performance.now();
        readFrontmatterLists(content);
        readRelated(content);
        const ms = performance.now() - t;
        expect({ depth, fast: ms < 100 }).toEqual({ depth, fast: true });
      }
    });
  }

  /** `1.1.md` exists, so a YAML-typed `1.10` read as text would land there. */
  const numCtx = (): RelatedResolveContext => ({
    fromRelPath: "notes/b.md",
    roots: [],
    byPath: (rel) => (["1.1.md", "notes/b.md"].includes(rel) ? rel : undefined),
    byName: (key) => (key === "1.1" ? ["1.1.md"] : []),
    byLink: () => undefined,
  });

  test("B: an unquoted [[…]] is read once, by the scanner, never as YAML's typed scalar", () => {
    expect(entries("related: [[123]]")).toEqual([{ kind: "link", target: "123" }]);
    expect(entries("related: [[true]]")).toEqual([{ kind: "link", target: "true" }]);
    expect(entries("related: [[Title: sub]]")).toEqual([{ kind: "link", target: "Title: sub" }]);
    expect(resolve("related: [[Title: sub]]")).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
    expect(entries("related: [[1.10]]")).toEqual([{ kind: "link", target: "1.10" }]);
    expect(resolveRelatedEntries(entries("related: [[1.10]]"), numCtx())).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
  });

  test("B: [[Foo, Bar]] is one link, not three", () => {
    expect(entries("related: [[Foo, Bar]]")).toEqual([{ kind: "link", target: "Foo, Bar" }]);
  });

  test("B: a top-level item YAML types as a map or number is skipped and counted, once", () => {
    expect(resolve("related:\n  - Title: sub\n  - [[a]]")).toEqual({ targets: ["notes/a.md"], skipped: 1, ambiguous: 0 });
    expect(resolveRelatedEntries(entries("related: [1.10]"), numCtx())).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
  });

  test("C: a wikilink inside a YAML comment is no entry", () => {
    expect(entries('related:\n  - "[[b]]"\n# history: [[c]] was the old plan')).toEqual([{ kind: "link", target: "b" }]);
    expect(entries('related:\n  - "[[b]]"\n  # [[c]] dropped')).toEqual([{ kind: "link", target: "b" }]);
    expect(entries("related: [[a]] # comment [[c]]")).toEqual([{ kind: "link", target: "a" }]);
    expect(entries("related: [[a]], [[d]] # was [[c]]")).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "d" },
    ]);
    expect(entries("related: Rune's notes # [[c]]")).toEqual([{ kind: "text", value: "Rune's notes" }]);
  });

  test("C: a # with no space before it, or inside quotes, is not a comment", () => {
    expect(entries("related: [[a#Section]]")).toEqual([{ kind: "link", target: "a" }]);
    expect(entries('related: ["[[a]] #x"]')).toEqual([{ kind: "link", target: "a" }]);
    expect(entries('related: "[[a]] # [[c]]"')).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "c" },
    ]);
    expect(entries("related: '[[a]] # [[c]]'")).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "c" },
    ]);
    // YAML refuses this one whole, so only the scanner reads it: the quoted
    // `#` is kept and the links after the quote are read.
    expect(entries('related: "[[a]] # [[c]]", [[d]]')).toEqual([
      { kind: "link", target: "a" },
      { kind: "link", target: "c" },
      { kind: "link", target: "d" },
    ]);
  });
});

describe("fix round 1 batch 2 — leading slash and the name census", () => {
  test("D: a /root-relative path that names no filesystem root falls through to step 4", () => {
    expect(resolve("related: [/plans/c, /notes/a.md]")).toEqual({ targets: ["plans/c.mdx", "notes/a.md"], skipped: 0, ambiguous: 0 });
    // Under no root and no page root-relative: still skipped.
    expect(resolve("related: [/w/other/plans/c.mdx]")).toEqual({ targets: [], skipped: 1, ambiguous: 0 });
  });

  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-fm-census-"));
    await mkdir(path.join(root, "plans"));
    await writeFile(path.join(root, "plans/a.md"), "---\ntitle: A\n---\n");
    await writeFile(path.join(root, "c.md"), "---\ntitle: Gamma Doc\n---\n");
    await writeFile(path.join(root, "c.html"), "<html><head><title>Gamma Doc</title></head><body></body></html>");
    await writeFile(path.join(root, "x.md"), "---\ntitle: X\n---\n");
    await writeFile(path.join(root, "x.html"), "<html><head><title>Diagram Only</title></head><body></body></html>");
    await writeFile(path.join(root, "b.md"), "---\ntitle: B\nrelated: [/plans/a.md, Gamma Doc, Diagram Only]\n---\n");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("D + F: the index resolves /plans/a.md and a title its stem-paired attachment shares", async () => {
    const index = await buildWikiIndex(root);
    const b = index.pages.find((p) => p.relPath === "b.md")!;
    // The graph's own reading of the shared title: the markdown parent.
    expect(index.resolve("Gamma Doc")?.relPath).toBe("c.md");
    expect(index.pages.find((p) => p.relPath === "c.html")?.pairedBy).toBe("stem");
    // A title only the attachment carries is still its own.
    expect(b.related).toEqual(["plans/a.md", "c.md", "x.html"]);
    expect(b.relatedSkipped).toBeUndefined();
    expect(b.relatedAmbiguous).toBeUndefined();
  });
});

describe("fix round 1 batch 3 — N: the index and the reader share one frontmatter boundary", () => {
  // `----` ends the frontmatter for a `\n---` prefix test but not for
  // `frontmatterEndLine`, which wants a line that trims to `---`.
  const DASHED = "---\ntitle: N\nnote: x\n----\nowns: [ABC-7]\nrelated: [[n-target]]\n---\n\nBody.\n";
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-fm-boundary-"));
    await writeFile(path.join(root, "n.md"), DASHED);
    await writeFile(path.join(root, "n-target.md"), "---\ntitle: Target\n---\n");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("a `----` line inside the frontmatter: the index reads what lint check 14's reader reads", async () => {
    expect(readOwns(DASHED).keys).toEqual(["ABC-7"]);
    const index = await buildWikiIndex(root);
    const n = index.pages.find((p) => p.relPath === "n.md")!;
    expect(n.owns).toEqual(readOwns(DASHED).keys);
    expect(n.related).toEqual(["n-target.md"]);
  });

  test("the gate still admits the quoted, flow and indented spellings", () => {
    expect(readFrontmatterLists('---\ntitle: Q\n"owns": [ABC-1]\n---\n').owns.keys).toEqual(["ABC-1"]);
    expect(readFrontmatterLists("---\n{title: F, owns: ABC-2, related: [x]}\n---\n")).toMatchObject({
      owns: { keys: ["ABC-2"] },
      related: { entries: [{ kind: "text", value: "x" }] },
    });
    expect(readFrontmatterLists("---\n  title: I\n  owns: ABC-3\n---\n").owns.keys).toEqual(["ABC-3"]);
  });

  test("the gate's prefix split agrees with the readers on a CRLF page and on a frontmatter longer than the prefix", () => {
    const crlf = "---\r\ntitle: C\r\nowns: [ABC-4]\r\nrelated: [[n-target]]\r\n---\r\nBody.\r\n";
    expect(readFrontmatterLists(crlf)).toEqual({ owns: readOwns(crlf), related: readRelated(crlf) });
    expect(readFrontmatterLists(crlf).owns.keys).toEqual(["ABC-4"]);
    const filler = Array.from({ length: 60 }, (_, i) => `k${i}: v`).join("\n");
    const long = `---\n${filler}\nowns: [ABC-5]\n---\n\n${"line\n".repeat(100)}`;
    expect(readFrontmatterLists(long).owns).toEqual(readOwns(long));
    expect(readFrontmatterLists(long).owns.keys).toEqual(["ABC-5"]);
  });
});
