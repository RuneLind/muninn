import { test, expect, describe } from "bun:test";
import {
  computeIndexCoverage,
  buildIndexCoverageResponse,
  type CollectionPatterns,
  type CoverageListing,
} from "./index-coverage.ts";

describe("computeIndexCoverage", () => {
  test("basic membership: indexed vs missing", () => {
    const pages = ["concepts/A.md", "concepts/B.md", "concepts/C.md"];
    const cov = computeIndexCoverage(pages, [["concepts/A.md", "concepts/C.md"]]);
    expect(cov.totalMd).toBe(3);
    expect(cov.indexed).toBe(2);
    expect(cov.missing).toEqual(["concepts/B.md"]);
    expect(cov.ghosts).toEqual([]);
    expect(cov.htmlPages).toBe(0);
  });

  test("union across collections dedupes — a page in two collections counts once", () => {
    // Mirrors jarvis `wiki` (superset) + `wiki-life`: the same id in both.
    const pages = ["life/X.md", "concepts/Y.md"];
    const wiki = ["life/X.md", "concepts/Y.md"];
    const wikiLife = ["life/X.md"];
    const cov = computeIndexCoverage(pages, [wiki, wikiLife]);
    expect(cov.totalMd).toBe(2);
    expect(cov.indexed).toBe(2);
    expect(cov.missing).toEqual([]);
    expect(cov.ghosts).toEqual([]);
  });

  test("NFD (macOS file) vs NFC (huginn id) match — no false missing+ghost pair", () => {
    // "Blåbær" — å + æ. Compose one form for the page, the other for the id.
    const nfc = "concepts/Blåbær.md".normalize("NFC");
    const nfd = "concepts/Blåbær.md".normalize("NFD");
    expect(nfc).not.toBe(nfd); // sanity: the two byte forms genuinely differ
    const cov = computeIndexCoverage([nfd], [[nfc]]);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]);
    expect(cov.ghosts).toEqual([]);
  });

  test("case-insensitive match", () => {
    const cov = computeIndexCoverage(["Concepts/Foo.md"], [["concepts/foo.md"]]);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]);
    expect(cov.ghosts).toEqual([]);
  });

  test("`./`-prefix and redundant path segments normalize", () => {
    const cov = computeIndexCoverage(["./a/../concepts/Foo.md"], [["concepts/Foo.md"]]);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]);
  });

  test("html excluded from missing but counted in htmlPages", () => {
    const pages = ["concepts/A.md", "blogs/Explainer.html", "blogs/Other.HTML"];
    const cov = computeIndexCoverage(pages, [["concepts/A.md"]]);
    expect(cov.totalMd).toBe(1);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]); // the .html is never "missing"
    expect(cov.htmlPages).toBe(2); // case-insensitive extension
  });

  test("native .mdx counts as markdown (indexed/missing), never htmlPages", () => {
    // A .mdx page indexed by huginn resolves like a first-class .md page; an
    // un-indexed .mdx is a real gap (missing), not a silently-ignored file.
    const pages = ["blogs/src/Native.mdx", "blogs/src/Gap.mdx", "blogs/Ex.html"];
    const cov = computeIndexCoverage(pages, [["blogs/src/Native.mdx"]]);
    expect(cov.totalMd).toBe(2); // both .mdx count as markdown
    expect(cov.indexed).toBe(1); // the indexed .mdx id matched
    expect(cov.missing).toEqual(["blogs/src/Gap.mdx"]); // the un-indexed .mdx
    expect(cov.htmlPages).toBe(1); // only the .html
    expect(cov.ghosts).toEqual([]); // the .mdx id matched a file
  });

  test("a .mdx doc id whose file is gone is a ghost (indexable, case-insensitive)", () => {
    const cov = computeIndexCoverage(
      ["blogs/src/Native.mdx"],
      [["blogs/src/Native.mdx", "blogs/src/Renamed.MDX"]],
    );
    expect(cov.indexed).toBe(1);
    expect(cov.ghosts).toEqual(["blogs/src/Renamed.MDX"]);
  });

  test("ghost: indexed id with no file", () => {
    const cov = computeIndexCoverage(["concepts/A.md"], [["concepts/A.md", "concepts/Renamed.md"]]);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]);
    expect(cov.ghosts).toEqual(["concepts/Renamed.md"]);
  });

  test("ghost with an html id only when the file is truly gone", () => {
    // A stray indexed .html whose file exists ⇒ NOT a ghost.
    const present = computeIndexCoverage(["blogs/Ex.html"], [["blogs/Ex.html"]]);
    expect(present.ghosts).toEqual([]);
    // Same indexed .html id, but the file is gone ⇒ ghost.
    const gone = computeIndexCoverage(["concepts/A.md"], [["concepts/A.md", "blogs/Ex.html"]]);
    expect(gone.ghosts).toEqual(["blogs/Ex.html"]);
  });

  test("empty wiki: every indexed id is a ghost, nothing missing", () => {
    const cov = computeIndexCoverage([], [["concepts/A.md", "concepts/B.md"]]);
    expect(cov.totalMd).toBe(0);
    expect(cov.indexed).toBe(0);
    expect(cov.missing).toEqual([]);
    expect(cov.ghosts).toEqual(["concepts/A.md", "concepts/B.md"]);
  });

  test("empty listings: all md pages missing", () => {
    const cov = computeIndexCoverage(["concepts/A.md", "concepts/B.md"], [[]]);
    expect(cov.totalMd).toBe(2);
    expect(cov.indexed).toBe(0);
    expect(cov.missing).toEqual(["concepts/A.md", "concepts/B.md"]);
    expect(cov.ghosts).toEqual([]);
  });

  test("missing and ghosts are sorted", () => {
    const pages = ["z.md", "a.md", "m.md"];
    const cov = computeIndexCoverage(pages, [["ghost-b.md", "ghost-a.md"]]);
    expect(cov.missing).toEqual(["a.md", "m.md", "z.md"]);
    expect(cov.ghosts).toEqual(["ghost-a.md", "ghost-b.md"]);
  });

  test("output reports original (un-normalized) casing, matches on normalized keys", () => {
    const cov = computeIndexCoverage(["Concepts/Missing.MD".replace(".MD", ".md")], [[]]);
    // Original relPath casing preserved in the missing list.
    expect(cov.missing).toEqual(["Concepts/Missing.md"]);
  });
});

describe("computeIndexCoverage — excludePattern / includePattern partition", () => {
  // Mirrors huginn's `wiki` manifest reader block.
  const wikiPatterns: CollectionPatterns = {
    includePatterns: [".*"],
    excludePatterns: ["^index\\.md$", "^log\\.md$", "^CLAUDE\\.md$", "^plans/.*"],
  };

  test("exclude patterns demote meta pages to excludedByRule, not missing", () => {
    const pages = ["concepts/A.md", "index.md", "log.md", "plans/README.md"];
    const cov = computeIndexCoverage(pages, [["concepts/A.md"]], [wikiPatterns]);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]); // meta pages are NOT actionable gaps
    expect(cov.excludedByRule).toEqual(["index.md", "log.md", "plans/README.md"]);
    expect(cov.totalMd).toBe(4);
  });

  test("include-pattern scoping: out-of-scope pages under a sole ^life/.* collection are excludedByRule", () => {
    const pages = ["life/X.md", "concepts/Y.md"];
    const patterns: CollectionPatterns = { includePatterns: ["^life/.*"], excludePatterns: [] };
    const cov = computeIndexCoverage(pages, [["life/X.md"]], [patterns]);
    expect(cov.indexed).toBe(1); // life/X.md
    expect(cov.missing).toEqual([]); // concepts/Y.md is out of scope, not a gap
    expect(cov.excludedByRule).toEqual(["concepts/Y.md"]);
  });

  test("an indexed page stays indexed even if a rule would exclude it", () => {
    const cov = computeIndexCoverage(["index.md"], [["index.md"]], [wikiPatterns]);
    expect(cov.indexed).toBe(1);
    expect(cov.missing).toEqual([]);
    expect(cov.excludedByRule).toEqual([]);
  });

  test("absent patterns: no excludedByRule partition, meta stays in missing (degrade)", () => {
    const pages = ["concepts/A.md", "index.md"];
    const cov = computeIndexCoverage(pages, [["concepts/A.md"]]); // no patterns arg
    expect(cov.missing).toEqual(["index.md"]);
    expect(cov.excludedByRule).toEqual([]);
  });

  test("empty include array is treated as unknown (never demotes) — not index-nothing", () => {
    const pages = ["concepts/A.md"];
    const patterns: CollectionPatterns = { includePatterns: [], excludePatterns: [] };
    const cov = computeIndexCoverage(pages, [[]], [patterns]);
    expect(cov.missing).toEqual(["concepts/A.md"]); // stays missing, not excludedByRule
    expect(cov.excludedByRule).toEqual([]);
  });

  test("partial patterns (one collection unknown) blocks demotion", () => {
    const pages = ["index.md"];
    const patterns = [wikiPatterns, undefined];
    const cov = computeIndexCoverage(pages, [[], []], patterns);
    expect(cov.excludedByRule).toEqual([]);
    expect(cov.missing).toEqual(["index.md"]);
  });

  test("excludedByRule requires EVERY collection to never-index (wiki + wiki-life)", () => {
    const pages = ["index.md", "concepts/A.md"];
    const patterns: (CollectionPatterns | undefined)[] = [
      wikiPatterns,
      { includePatterns: ["^life/.*"], excludePatterns: [] },
    ];
    const cov = computeIndexCoverage(pages, [["concepts/A.md"], []], patterns);
    // index.md: excluded by wiki, out-of-scope for wiki-life ⇒ excludedByRule.
    expect(cov.excludedByRule).toEqual(["index.md"]);
    expect(cov.indexed).toBe(1); // concepts/A.md indexed by wiki
    expect(cov.missing).toEqual([]);
  });

  test("a page one collection WOULD index is missing, not excludedByRule", () => {
    // wiki-life scopes to ^life/.* and would index life/Z.md — so if it's not in
    // the union it's a genuine gap (missing), never excludedByRule.
    const pages = ["life/Z.md"];
    const patterns: (CollectionPatterns | undefined)[] = [
      wikiPatterns, // .* includes life/Z.md
      { includePatterns: ["^life/.*"], excludePatterns: [] }, // also includes it
    ];
    const cov = computeIndexCoverage(pages, [[], []], patterns);
    expect(cov.missing).toEqual(["life/Z.md"]);
    expect(cov.excludedByRule).toEqual([]);
  });
});

describe("computeIndexCoverage — non-md/html ids + case-only collisions", () => {
  test("non-md/html indexed ids are ignored — not ghosts, not counted (mimir case)", () => {
    const pages = ["concepts/A.md"];
    const cov = computeIndexCoverage(pages, [
      ["concepts/A.md", ".gitignore", "notes.txt", "data.json", "run.sh"],
    ]);
    expect(cov.indexed).toBe(1);
    expect(cov.ghosts).toEqual([]); // the non-md/html ids never become ghosts
  });

  test("case-only-distinct pages both count (per-file, not per-key)", () => {
    const pages = ["Foo.md", "foo.md"]; // collide on normalized key
    const cov = computeIndexCoverage(pages, [["foo.md"]]);
    expect(cov.totalMd).toBe(2); // both files counted
    expect(cov.indexed).toBe(2); // both match the indexed key
    expect(cov.missing).toEqual([]);
    expect(cov.indexed + cov.missing.length + cov.excludedByRule.length).toBe(cov.totalMd);
  });

  test("case-only-distinct with none indexed: both variants stay visible as missing", () => {
    const cov = computeIndexCoverage(["Foo.md", "foo.md", "Bar.md"], [[]]);
    expect(cov.totalMd).toBe(3);
    expect(cov.indexed).toBe(0);
    expect(cov.missing).toEqual(["Bar.md", "Foo.md", "foo.md"]);
  });
});

describe("computeIndexCoverage — count invariant", () => {
  const cases: Array<{
    pages: string[];
    ids: string[][];
    patterns?: (CollectionPatterns | undefined)[];
  }> = [
    { pages: ["a.md", "b.md"], ids: [["a.md"]] },
    {
      pages: ["index.md", "c.md"],
      ids: [["c.md"]],
      patterns: [{ includePatterns: [".*"], excludePatterns: ["^index\\.md$"] }],
    },
    { pages: ["Foo.md", "foo.md"], ids: [["foo.md"]] },
    {
      pages: ["life/X.md", "concepts/Y.md"],
      ids: [["life/X.md"]],
      patterns: [{ includePatterns: ["^life/.*"], excludePatterns: [] }],
    },
    { pages: [], ids: [["ghost.md"]] },
    { pages: ["blogs/Ex.html", "a.md"], ids: [["a.md"]] },
  ];

  test("indexed + missing.length + excludedByRule.length === totalMd", () => {
    for (const { pages, ids, patterns } of cases) {
      const cov = computeIndexCoverage(pages, ids, patterns);
      expect(cov.indexed + cov.missing.length + cov.excludedByRule.length).toBe(cov.totalMd);
    }
  });
});

describe("buildIndexCoverageResponse", () => {
  const pages = ["concepts/A.md", "concepts/B.md", "blogs/Ex.html"];

  test("clean: coverage fields populated, no errors", () => {
    const listings: CoverageListing[] = [{ ids: ["concepts/A.md"] }];
    const res = buildIndexCoverageResponse(["wiki"], pages, listings);
    expect(res.collections).toEqual(["wiki"]);
    expect(res.totalMd).toBe(2);
    expect(res.indexed).toBe(1);
    expect(res.missing).toEqual(["concepts/B.md"]);
    expect(res.excludedByRule).toEqual([]); // no patterns ⇒ no partition
    expect(res.ghosts).toEqual([]);
    expect(res.htmlPages).toBe(1);
    expect(res.errors).toBeUndefined();
    expect(typeof res.generatedAt).toBe("number");
  });

  test("threads per-collection patterns into the excludedByRule partition", () => {
    const listings: CoverageListing[] = [
      {
        ids: ["concepts/A.md"],
        patterns: { includePatterns: [".*"], excludePatterns: ["^index\\.md$"] },
      },
    ];
    const res = buildIndexCoverageResponse(
      ["wiki"],
      ["concepts/A.md", "concepts/B.md", "index.md"],
      listings,
    );
    expect(res.missing).toEqual(["concepts/B.md"]);
    expect(res.excludedByRule).toEqual(["index.md"]);
  });

  test("suppresses coverage fields when ANY collection listing failed", () => {
    const listings: CoverageListing[] = [
      { ids: ["concepts/A.md"] },
      { ids: [], error: { source: "wiki-life", collection: "wiki-life", error: "unreachable" } },
    ];
    const res = buildIndexCoverageResponse(["wiki", "wiki-life"], pages, listings);
    expect(res.totalMd).toBeNull();
    expect(res.indexed).toBeNull();
    expect(res.missing).toBeNull();
    expect(res.excludedByRule).toBeNull();
    expect(res.ghosts).toBeNull();
    // htmlPages stays (a page-index fact, independent of collections).
    expect(res.htmlPages).toBe(1);
    expect(res.errors).toEqual([
      { source: "wiki-life", collection: "wiki-life", error: "unreachable" },
    ]);
  });
});
