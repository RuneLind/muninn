import { test, expect, describe } from "bun:test";
import {
  assignStamps,
  insertFrontmatterAuthor,
  mtimeIsStamp,
  mtimeMsFromNs,
  needsAuthor,
  nextFailureStreak,
  planSequence,
  rollbackTargets,
} from "./author-backfill.ts";

/** An invented document in huginn's `write_summary` shape. */
const DOC = [
  "---",
  'date: "2026-07-14"',
  'url: "https://www.youtube.com/watch?v=abcdefghijk"',
  'category: "career"',
  'tags: "career"',
  "---",
  "",
  "### Heading",
  "- a point with author: in it",
  "",
  "## Transcript",
  "",
  "words",
  "",
].join("\n");

describe("skip-if-present", () => {
  test("a document with no author needs one; one with author, or no frontmatter, does not", () => {
    expect(needsAuthor(DOC)).toBe(true);
    expect(needsAuthor(DOC.replace('category: "career"', 'author: "X"\ncategory: "career"'))).toBe(false);
    expect(needsAuthor("no frontmatter at all\n")).toBe(false);
    expect(insertFrontmatterAuthor(DOC.replace('category: "career"', 'author: "X"\ncategory: "career"'), "Y")).toBeNull();
    expect(insertFrontmatterAuthor("plain\n", "Y")).toBeNull();
  });

  test("an author: line in the BODY is not the key", () => {
    expect(needsAuthor(DOC)).toBe(true);
  });
});

describe("the frontmatter insert", () => {
  test("one line, before category, encoded like huginn's frontmatter_scalar; body byte-identical", () => {
    const next = insertFrontmatterAuthor(DOC, 'A "Quoted" \\ Channel')!;
    const before = DOC.split("\n");
    const after = next.split("\n");
    expect(after.length).toBe(before.length + 1);
    expect(after[3]).toBe('author: "A \\"Quoted\\" \\\\ Channel"');
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(after.slice(4)).toEqual(before.slice(3));
    const body = (t: string) => t.slice(t.indexOf("\n---\n") + 5);
    expect(body(next)).toBe(body(DOC));
  });

  test("after summary_kind, before upload_date — huginn's own key order", () => {
    const doc = DOC.replace('category: "career"', 'summary_kind: "deep"\nupload_date: "2024-01-15"\ncategory: "career"');
    const lines = insertFrontmatterAuthor(doc, "X")!.split("\n");
    expect(lines.slice(1, 7)).toEqual([
      'date: "2026-07-14"',
      'url: "https://www.youtube.com/watch?v=abcdefghijk"',
      'summary_kind: "deep"',
      'author: "X"',
      'upload_date: "2024-01-15"',
      'category: "career"',
    ]);
  });

  test("with none of the later keys, it goes just before the closing fence; a blank author is refused", () => {
    const doc = '---\ndate: "d"\nurl: "u"\n---\n\nbody\n';
    expect(insertFrontmatterAuthor(doc, "X")).toBe('---\ndate: "d"\nurl: "u"\nauthor: "X"\n---\n\nbody\n');
    expect(insertFrontmatterAuthor(doc, "  ")).toBeNull();
  });
});

describe("stamp ordering", () => {
  const files = [
    { path: "b/Zeta.md", title: "Zeta.md", originalMtimeMs: 3000 },
    { path: "a/Alpha.md", title: "Alpha.md", originalMtimeMs: 1000 },
    { path: "a/Beta.md", title: "Beta.md", originalMtimeMs: 3000 },
    { path: "c/Gamma.md", title: "Gamma.md", originalMtimeMs: 2000 },
    { path: "c/New.md", title: "New.md", originalMtimeMs: 5000 },
  ];

  test("every candidate: the whole tail from the oldest one, ascending mtime, ties by title", () => {
    const seq = planSequence(files, new Set(["a/Alpha.md", "a/Beta.md", "b/Zeta.md"]));
    expect(seq.map((f) => [f.path, f.write])).toEqual([
      ["a/Alpha.md", true],
      ["c/Gamma.md", false], // already has author, but newer than a write: re-stamped in place
      ["a/Beta.md", true],
      ["b/Zeta.md", true],
      ["c/New.md", false],
    ]);
  });

  test("--limit keeps the NEWEST candidates, so the tail stays short", () => {
    const seq = planSequence(files, new Set(["a/Alpha.md", "a/Beta.md", "b/Zeta.md"]), 2);
    expect(seq.map((f) => [f.path, f.write])).toEqual([
      ["a/Beta.md", true],
      ["b/Zeta.md", true],
      ["c/New.md", false],
    ]);
    expect(planSequence(files, new Set())).toEqual([]);
  });

  test("stamps rise 1 ms apart and the last one is the moment of writing, floored", () => {
    const seq = planSequence(files, new Set(["a/Alpha.md"]));
    const stamps = assignStamps(seq, 1_700_000_000_123.9).map((p) => p.stampMs);
    expect(stamps).toEqual([1_700_000_000_119, 1_700_000_000_120, 1_700_000_000_121, 1_700_000_000_122, 1_700_000_000_123]);
  });
});

describe("the rollback filter", () => {
  const stampsByPath = new Map([
    ["a.md", new Set([100, 200])],
    ["b.md", new Set([101])],
    ["c.md", new Set([102])],
    ["d.md", new Set([103])],
  ]);

  test("restores only files whose current mtime is a stamp on THAT file", () => {
    const targets = rollbackTargets({
      tarballMembers: ["a.md", "b.md", "c.md", "d.md", "e.md", "gone.md"],
      currentMtimeMs: new Map([
        ["a.md", 200.0003], // the full run's stamp, read back with ns noise
        ["b.md", 101],
        ["c.md", 5_000], // re-run since the backfill — survives
        ["d.md", 102], // another file's stamp — not this one's
        ["e.md", 103], // never stamped by the backfill
      ]),
      stampsByPath,
    });
    expect(targets).toEqual(["a.md", "b.md"]);
  });

  test("a stamp read back through utimes (a hair UNDER the integer) is still that stamp", () => {
    // Measured on APFS: stamp 1790665482540 set via utimesSync, read back as this.
    const ms = mtimeMsFromNs(1790665482540999889n);
    expect(ms).toBe(1790665482540.999);
    expect(mtimeIsStamp(ms, new Set([1790665482541]))).toBe(true);
    // Sub-ms order survives, where whole-ms `mtimeMs` would tie.
    expect(mtimeMsFromNs(1788701194409078000n) < mtimeMsFromNs(1788701194409871000n)).toBe(true);
  });

  test("mtimeIsStamp rounds and needs a stamp set", () => {
    expect(mtimeIsStamp(99.6, new Set([100]))).toBe(true);
    expect(mtimeIsStamp(100.6, new Set([100]))).toBe(false);
    expect(mtimeIsStamp(100, undefined)).toBe(false);
  });
});

test("the failure streak counts errors and resets on any answer about the video", () => {
  let s = 0;
  for (const k of ["error", "error", "unavailable", "error", "error", "error", "ok"] as const) {
    s = nextFailureStreak(s, { kind: k });
  }
  expect(s).toBe(0);
  expect([1, 2, 3, 4].reduce((acc) => nextFailureStreak(acc, { kind: "error" }), 0)).toBe(4);
});
