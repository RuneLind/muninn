/**
 * The `related:` reader and resolver (plan `muninn-wiki-work-thread-grouping`,
 * D18): one case per form a wiki writes, and the five resolution steps. The
 * `owns:` form table lives in `lint-state.test.ts`. Synthetic names only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readFrontmatterLists,
  readOwns,
  readRelated,
  resolveRelatedEntries,
  type RelatedRead,
  type RelatedResolveContext,
} from "./frontmatter-lists.ts";
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
   *  the value in full costs fanout^depth (here 9^depth) while the text stays a
   *  few hundred bytes. */
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

describe("fix round 2 — the related: reader against the whole D18 table", () => {
  /** Entries as `L:<target>` / `T:<value>` / `U`, sorted: order-insensitive, and a
   *  duplicate shows as a repeated string. */
  const read = (content: string) =>
    readRelated(content)
      .entries.map((e) => (e.kind === "link" ? `L:${e.target}` : e.kind === "text" ? `T:${e.value}` : "U"))
      .sort();
  const fmPage = (value: string) => page(`related:${value.startsWith("\n") ? "" : " "}${value}`);
  /** `a0` holds `fanout` leaves, each `a<i>` `fanout` references to `a<i-1>`. */
  const aliasChain = (depth: number, fanout: number) => {
    let y = `a0: &a0 [${Array(fanout).fill("lol").join(", ")}]\n`;
    for (let i = 1; i <= depth; i++) y += `a${i}: &a${i} [${Array(fanout).fill(`*a${i - 1}`).join(", ")}]\n`;
    return `---\n${y}related: *a${depth}\n---\nbody\n`;
  };

  // [row, raw value after `related:` (a leading \n is a block), expected]
  const TABLE: [number, string, string[]][] = [
    [1, "[[a]]", ["L:a"]],
    [2, "[[a]], [[b]]", ["L:a", "L:b"]],
    [3, '["[[a]]"]', ["L:a"]],
    [4, '"[[x]]"', ["L:x"]],
    [5, "[]", []],
    [6, "\n  - [[x]]", ["L:x"]],
    [7, "\n  - plans/a.md\n  - plans/b.md", ["T:plans/a.md", "T:plans/b.md"]],
    [8, "[plans/a.md, notes/b.md]", ["T:notes/b.md", "T:plans/a.md"]],
    [9, "some prose words", ["T:some prose words"]],
    [10, "[[x|PR #702]], [[y]]", ["L:x", "L:y"]],
    [11, "[[a #Section]]", ["L:a"]],
    [12, "\n  - [[plan|Fase #2]]", ["L:plan"]],
    [13, "[[a]] # [[c]]", ["L:a"]],
    [14, '\n  - "[[b]]"\n# history: [[c]] was the old plan', ["L:b"]],
    [15, "[['90s design]] # [[c]]", ["L:'90s design"]],
    [16, "\n  - [['90s design]]\n  # [[c]]\n  - [[d]]", ["L:'90s design", "L:d"]],
    [17, '"[[a]] # [[c]]", [[d]]', ["L:a", "L:c", "L:d"]],
    [18, "'[[a]] # [[c]]', [[d]]", ["L:a", "L:c", "L:d"]],
    [19, "Rune's notes # [[c]]", ["T:Rune's notes"]],
    [20, "[[O'Brien]] # [[c]]", ["L:O'Brien"]],
    [21, "\n  - [plans/a.md, plans/b.md]", ["T:plans/a.md", "T:plans/b.md"]],
    [22, "\n  - - plans/a.md\n    - plans/b.md", ["T:plans/a.md", "T:plans/b.md"]],
    // No `[[…]]` span (the scanner needs `]]`): YAML's two one-item lists, flattened to text.
    [23, "[[a], [b]]", ["T:a", "T:b"]],
    [24, '["[[a]]", [b, c]]', ["L:a", "T:b", "T:c"]],
    // The scanner's span is `[[[a]]` (target `[a`, its leading `[` dropped);
    // YAML's `[[["a"]]]` holds that span's own reading, which adds nothing.
    [25, "[[[a]]]", ["L:a"]],
    [26, "[[123]]", ["L:123"]],
    [27, "[[1.10]]", ["L:1.10"]],
    [28, "[[Foo, Bar]]", ["L:Foo, Bar"]],
    [29, "[[Title: sub]]", ["L:Title: sub"]],
    [30, "[1.10]", ["U"]],
    [31, "[[a#Section]]", ["L:a"]],
    [32, '\n  - "[[a]]\n  # [[c]]', ["L:a"]],
    [34, '\n  - "[[a]] # not a comment"', ["L:a"]],
    // Each row below breaks YAML on purpose, so only the scanner reads it: one
    // row per quote opener, escape and comment rule the scanner keeps.
    [35, '"[[a]]\n  # [[c]]", [[d]]', ["L:a", "L:c", "L:d"]], // a quote spans lines
    [36, '["[[a]] # [[c]]"], [[d]]', ["L:a", "L:c", "L:d"]], // opener `[`
    [37, '[[d]], "[[a]] # [[c]]"', ["L:a", "L:c", "L:d"]], // opener `,`
    [38, '\n  - "[[a]] # [[c]]", [[d]]', ["L:a", "L:c", "L:d"]], // opener `-`
    [39, '\n  "[[a]] # [[c]]", [[d]]', ["L:a", "L:c", "L:d"]], // opener at line start
    [40, '{"[[a]] # [[c]]": x}, [[d]]', ["L:a", "L:c", "L:d"]], // opener `{`
    [41, "'it''s [[a]] # [[c]]', [[d]]", ["L:a", "L:c", "L:d"]], // `''` escape
    [42, '"say \\"hi\\" [[a]] # [[c]]", [[d]]', ["L:a", "L:c", "L:d"]], // `\\"` escape
    [43, "[[x]], see#y [[a]]", ["L:a", "L:x"]], // `#` after a non-space opens no comment
    [48, '"[[a]]" "x # [[c]]", [[d]]', ["L:a"]], // a quote right after a closed one opens nothing
    [49, "[1.10, 2.5, {k: v}, ~]", ["U", "U", "U"]], // each non-string item is one count; a null names nothing
    [50, '"[[[a]]]"', ["L:a"]], // the string's link and the scanner's span are one target
    [51, "[['90s]], [[d]] # [['80s]]", ["L:'90s", "L:d"]], // a quote inside a span opens nothing
    [52, '\n  - [[a]]\n  "[[b]] # [[c]]", [[d]]', ["L:a", "L:b", "L:c", "L:d"]], // each line starts a fresh opener test
    [53, '\n  - "[[a]]"\n  - - - a\n      - b', ["L:a", "T:a", "T:b"]], // a list longer than a span's reading is not that reading
  ];

  for (const [row, value, expected] of TABLE) {
    test(`row ${row}: related: ${JSON.stringify(value)}`, () => {
      expect(read(fmPage(value))).toEqual([...expected].sort());
    });
  }

  test("row 33: the depth-9 alias chain reads in bounded time and is counted, not dropped", () => {
    const content = aliasChain(9, 9);
    const t = performance.now();
    const got = read(content);
    expect(performance.now() - t).toBeLessThan(100);
    // Its leaves sit ten lists deep, past the depth bound: counted, never dropped.
    expect(got).toEqual(["U"]);
  });

  test("row 44: a list nested past the depth cap is one unread entry", () => {
    expect(read(aliasChain(20, 1))).toEqual(["U"]);
  });

  test("row 45: a list past the node cap is one unread entry", () => {
    expect(read(aliasChain(4, 9))).toEqual(["T:lol", "U"]);
  });

  test("row 47: an entry of unclosed quotes reads in linear time", () => {
    const content = page(`related:\n${'  - "[[a]] x\n'.repeat(5000)}`);
    const t = performance.now();
    const got = read(content);
    expect(performance.now() - t).toBeLessThan(100);
    expect(got).toEqual(["L:a"]);
  });

  test("row 46: within the caps, a nested list is read whole", () => {
    expect(read(aliasChain(3, 2))).toEqual(["T:lol"]);
    expect(read(fmPage("\n  - - - a\n      - b\n    - c"))).toEqual(["T:a", "T:b", "T:c"]);
  });
});

describe("fix round 2 batch 2 — the bare-name root step, the gate's key spellings, its CRLF fold", () => {
  describe("1: a bare name tries the page's folder, then the root, before a name", () => {
    let root = "";
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "wiki-fm-bare-"));
      await mkdir(path.join(root, "plans/x"), { recursive: true });
      await mkdir(path.join(root, "notes"));
      await writeFile(path.join(root, "foo.md"), "---\ntitle: Foo root\n---\n");
      await writeFile(path.join(root, "plans/x/foo.md"), "---\ntitle: Foo deep\n---\n");
      await writeFile(path.join(root, "bar.md"), "---\ntitle: Bar md\n---\n");
      await writeFile(path.join(root, "bar.html"), "<html><head><title>Bar html</title></head><body></body></html>");
      await writeFile(path.join(root, "notes/b.md"), "---\ntitle: B\nrelated: [foo, bar.html]\n---\n");
    });
    afterAll(() => rm(root, { recursive: true, force: true }));

    test("a stem two pages share resolves at the root, and a spelled .html stays the .html", async () => {
      const index = await buildWikiIndex(root);
      const b = index.pages.find((p) => p.relPath === "notes/b.md")!;
      expect(index.resolve("foo")?.relPath).toBe("foo.md");
      expect(b.related).toEqual(["foo.md", "bar.html"]);
      expect(b.relatedAmbiguous).toBeUndefined();
    });
  });

  describe("2: the gate passes every key spelling the readers read", () => {
    const fm = (body: string) => `---\ntitle: X\n${body}\n---\n\nBody.\n`;
    // [spelling, the readers find owns or related present]
    const SPELLINGS: [string, string, boolean][] = [
      ["block", "owns: [ABC-1]\nrelated: [x]", true],
      ["block list", "owns:\n  - ABC-1\nrelated:\n  - x", true],
      ["double-quoted", '"owns": [ABC-1]\n"related": [x]', true],
      ["single-quoted", "'owns': [ABC-1]\n'related': [x]", true],
      ["flow mapping", "{owns: ABC-2, related: [x]}", false],
      ["anchored", "&k owns: [ABC-1]\n&r related: [x]", true],
      ["tagged", "!!str owns: [ABC-1]\n!!str related: [x]", true],
      ["verbatim tag", "!<tag:yaml.org,2002:str> owns: [ABC-1]", true],
      ["alias key", "a: &k owns\nb: &r related\n*k : [ABC-1]\n*r : [x]", true],
      ["merge key", "base: &b {owns: [ABC-1], related: [x]}\n<<: *b", true],
      ["\\x escape", '"\\x6fwns": [ABC-1]\n"rel\\x61ted": [x]', true],
      ["\\u escape", '"\\u006fwns": [ABC-1]\n"rel\\u0061ted": [x]', true],
      ["\\U escape", '"\\U0000006fwns": [ABC-1]\n"rel\\U00000061ted": [x]', true],
      ["broken YAML, entry fallback", "owns: [ABC-1]\nrelated: [[a]], [[b]]\nbad: [unclosed", true],
    ];
    // Whole frontmatters: an indented or flow one, and a lone `?` explicit
    // key, which Bun.YAML refuses after another key.
    const WHOLE: [string, string, boolean][] = [
      ["complex key, owns", "---\n? owns\n: [ABC-1]\n---\n", true],
      ["complex key, related", "---\n? related\n: [x]\n---\n", true],
      ["sequence key, owns", "---\n? [owns]\n: [ABC-1]\n---\n", true],
      ["sequence key, related", "---\n? [related]\n: [x]\n---\n", true],
      ["escaped line break, explicit owns", '---\n? "ow\\\n  ns"\n: [ABC-1]\n---\n', true],
      ["escaped line break, explicit related", '---\n? "rel\\\n  ated"\n: [x]\n---\n', true],
      ["escaped line break, flow key", '---\n{"ow\\\n  ns": [ABC-1], "rel\\\n  ated": [x]}\n---\n', true],
      ["indented", "---\n  title: I\n  owns: ABC-3\n  related: [x]\n---\n", true],
      ["flow frontmatter", "---\n{title: F, owns: ABC-2, related: [x]}\n---\n", true],
      ["anchored flow key", "---\n{title: F, &k owns: [ABC-1], &r related: [x]}\n---\n", true],
    ];
    const cases = [...SPELLINGS.map(([n, b, p]): [string, string, boolean] => [n, fm(b), p]), ...WHOLE];

    for (const [name, content, present] of cases) {
      test(`${name}: gated == ungated`, () => {
        const ungated = { owns: readOwns(content), related: readRelated(content) };
        if (present) expect(ungated.owns.present || ungated.related.present).toBe(true);
        expect(readFrontmatterLists(content)).toEqual(ungated);
      });
    }

    test("a frontmatter naming neither key, with no escape, still skips the parse", () => {
      const content = fm("tags: [a, b]\nstatus: open");
      expect(readFrontmatterLists(content)).toEqual({ owns: readOwns(content), related: readRelated(content) });
    });
  });

  describe("3: the gate folds CRLF the way the readers do", () => {
    const crlf = (body: string) => `---\r\ntitle: C\r\n${body.replace(/\n/g, "\r\n")}\r\n---\r\nBody.\r\n`;
    const CASES: [string, string, string[]][] = [
      ["double-quoted scalar over two lines", 'related: "a\n  b"', ["T:a b"]],
      ["single-quoted scalar over a blank line", "related: 'a\n\n  b'", ["T:a\nb"]],
      ["broken YAML, entry fallback", 'related: "a\n  b"\nbad: [unclosed', ["T:a b"]],
    ];
    const show = (r: RelatedRead) => r.entries.map((e) => (e.kind === "text" ? `T:${e.value}` : e.kind));
    for (const [name, body, expected] of CASES) {
      test(`${name}: gated == ungated`, () => {
        const content = crlf(body);
        expect(show(readRelated(content))).toEqual(expected);
        expect(readFrontmatterLists(content).related).toEqual(readRelated(content));
      });
    }
  });
});
