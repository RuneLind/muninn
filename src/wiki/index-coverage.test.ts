import { test, expect, describe } from "bun:test";
import {
  computeIndexCoverage,
  buildIndexCoverageResponse,
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

describe("buildIndexCoverageResponse", () => {
  const pages = ["concepts/A.md", "concepts/B.md", "blogs/Ex.html"];

  test("clean: coverage fields populated, no errors", () => {
    const listings: CoverageListing[] = [{ ids: ["concepts/A.md"] }];
    const res = buildIndexCoverageResponse(["wiki"], pages, listings);
    expect(res.collections).toEqual(["wiki"]);
    expect(res.totalMd).toBe(2);
    expect(res.indexed).toBe(1);
    expect(res.missing).toEqual(["concepts/B.md"]);
    expect(res.ghosts).toEqual([]);
    expect(res.htmlPages).toBe(1);
    expect(res.errors).toBeUndefined();
    expect(typeof res.generatedAt).toBe("number");
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
    expect(res.ghosts).toBeNull();
    // htmlPages stays (a page-index fact, independent of collections).
    expect(res.htmlPages).toBe(1);
    expect(res.errors).toEqual([
      { source: "wiki-life", collection: "wiki-life", error: "unreachable" },
    ]);
  });
});
