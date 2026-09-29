import { test, expect, describe } from "bun:test";
import {
  assignStamps,
  insertFrontmatterAuthor,
  lastWrites,
  mtimeMsFromNs,
  needsAuthor,
  nextFailureStreak,
  nfcPath,
  originalMtimeFor,
  originalMtimeIndex,
  parseBackfillArgs,
  parseExcludeList,
  parseJournal,
  planSequence,
  rollbackDisposition,
  titleSimilarity,
  TITLE_REVIEW_THRESHOLD,
  type JournalEvent,
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

describe("the rollback predicate: content identity", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const written = insertFrontmatterAuthor(DOC, "A Channel")!;

  test("restores a file holding exactly the snapshot plus the inserted line", () => {
    expect(rollbackDisposition({ current: enc(written), preWrite: enc(DOC), author: "A Channel" })).toEqual({ restore: true });
  });

  test("a capture or re-run since — any other bytes — survives, whatever its mtime", () => {
    const recaptured = written.replace("- a point", "- a NEW point");
    expect(rollbackDisposition({ current: enc(recaptured), preWrite: enc(DOC), author: "A Channel" })).toEqual({
      restore: false,
      reason: "changed since",
    });
    // Same file, but written with another name than the journal records: not ours.
    expect(rollbackDisposition({ current: enc(insertFrontmatterAuthor(DOC, "Someone Else")!), preWrite: enc(DOC), author: "A Channel" }))
      .toEqual({ restore: false, reason: "changed since" });
  });

  test("missing, unchanged, absent from the snapshot, and a snapshot the insert refuses", () => {
    expect(rollbackDisposition({ current: null, preWrite: enc(DOC), author: "A" })).toEqual({ restore: false, reason: "missing" });
    expect(rollbackDisposition({ current: enc(DOC), preWrite: enc(DOC), author: "A" })).toEqual({
      restore: false,
      reason: "unchanged from snapshot",
    });
    expect(rollbackDisposition({ current: enc(written), preWrite: null, author: "A" })).toEqual({
      restore: false,
      reason: "not in snapshot",
    });
    expect(rollbackDisposition({ current: enc(written), preWrite: enc("no frontmatter\n"), author: "A" })).toEqual({
      restore: false,
      reason: "snapshot not writable",
    });
  });
});

describe("NFC matching", () => {
  test("bsdtar's NFD name and huginn's NFC name are one key", () => {
    const nfc = "ai/general/What It Actually Takes to Build a Software Factory — Tereza Tížková, Factory.md".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    expect(nfcPath(nfd)).toBe(nfc);
    expect(nfcPath(`./${nfd}`)).toBe(nfc);
    expect(parseExcludeList(`# review\n\n  ./${nfd}  \nb/x.md\n`)).toEqual(new Set([nfc, "b/x.md"]));
  });
});

describe("the journal", () => {
  const lines = (events: JournalEvent[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const events: JournalEvent[] = [
    { t: "run", run: 1, kind: "write", at: "t1", root: "/r", tarball: "/s/pilot.tgz" },
    { t: "plan", run: 1, path: "a.md", originalMtimeMs: 100, stampMs: 900, write: true, author: "A" },
    { t: "plan", run: 1, path: "b.md", originalMtimeMs: 200, stampMs: 901, write: false },
    { t: "done", run: 1, path: "a.md", status: "written" },
    { t: "done", run: 1, path: "b.md", status: "restamped" },
    { t: "end", run: 1 },
    // Run 2 was killed after its plan: c.md is pending, never marked done.
    { t: "run", run: 2, kind: "write", at: "t2", root: "/r", tarball: "/s/full.tgz" },
    { t: "plan", run: 2, path: "b.md", originalMtimeMs: 200, stampMs: 950, write: false },
    { t: "plan", run: 2, path: "c.md", originalMtimeMs: 300, stampMs: 951, write: true, author: "C" },
  ];

  test("a torn last line is counted, not fatal, and a killed run keeps its whole plan", () => {
    const { runs, badLines } = parseJournal(lines(events) + '\n{"t":"done","run":2,"pa');
    expect(badLines).toBe(1);
    expect(runs.map((r) => [r.run, r.plans.size, r.done.size, r.ended])).toEqual([
      [1, 2, 2, true],
      [2, 2, 0, false],
    ]);
  });

  test("lastWrites names each written path's own run tarball, pending plans included", () => {
    const w = lastWrites(parseJournal(lines(events)).runs);
    expect([...w.entries()].sort()).toEqual([
      ["a.md", { run: 1, tarball: "/s/pilot.tgz", author: "A", originalMtimeMs: 100 }],
      ["c.md", { run: 2, tarball: "/s/full.tgz", author: "C", originalMtimeMs: 300 }],
    ]);
  });

  test("a path written again after a rollback answers to its LAST write run", () => {
    const again = lines([
      ...events,
      { t: "run", run: 3, kind: "rollback", at: "t3", root: "/r" },
      { t: "plan", run: 3, path: "a.md", originalMtimeMs: 100, stampMs: 990, write: true },
      { t: "run", run: 4, kind: "write", at: "t4", root: "/r", tarball: "/s/again.tgz" },
      { t: "plan", run: 4, path: "a.md", originalMtimeMs: 100, stampMs: 999, write: true, author: "A2" },
    ]);
    expect(lastWrites(parseJournal(again).runs).get("a.md")).toEqual({
      run: 4,
      tarball: "/s/again.tgz",
      author: "A2",
      originalMtimeMs: 100,
    });
  });

  test("the original-mtime lookup reads every run's stamps, rollback runs too", () => {
    const withRollback = lines([
      ...events,
      { t: "run", run: 3, kind: "rollback", at: "t3", root: "/r" },
      { t: "plan", run: 3, path: "a.md", originalMtimeMs: 100, stampMs: 990, write: true },
    ]);
    const idx = originalMtimeIndex(parseJournal(withRollback).runs);
    expect(originalMtimeFor(idx, "b.md", 950.0004)).toBe(200); // run 2's stamp, ns noise
    expect(originalMtimeFor(idx, "b.md", 900.999)).toBe(200); // run 1's, a hair under
    expect(originalMtimeFor(idx, "a.md", 990)).toBe(100); // the rollback's own stamp
    expect(originalMtimeFor(idx, "a.md", 5000)).toBe(5000); // written since: its own mtime
    expect(originalMtimeFor(idx, "c.md", 300)).toBe(300); // pending stamp never landed
  });
});

describe("the title review", () => {
  test("a wrong-url document scores low; a retitle with a channel suffix does not", () => {
    const wrong = titleSimilarity(
      "Why 80% of People Will Fail at AI Delegation (And How to Be in the 20%)",
      "Steve Jobs talks about managing people",
    )!;
    expect(wrong).toBeLessThan(TITLE_REVIEW_THRESHOLD);
    expect(titleSimilarity("Claude Code Skills Explained", "Claude Code Skills, Explained | Channel Name")).toBe(1);
    expect(titleSimilarity("Tížková on factories", "Tizkova on Factories")).toBe(1);
    expect(titleSimilarity("The a of", "anything")).toBeNull();
  });
});

describe("arguments", () => {
  const err = (argv: string[]) => {
    const r = parseBackfillArgs(argv);
    return r.ok ? null : r.error;
  };

  test("each input that used to fall through to the FULL write is a usage error", () => {
    expect(err(["--rollback", "/some/backup.tar.gz"])).toBe("unexpected argument /some/backup.tar.gz");
    expect(err(["--limit"])).toBe("--limit needs a value");
    expect(err(["--limit", "--no-update"])).toBe("--limit needs a value");
    expect(err(["--limit", "20x"])).toBe("--limit must be a positive integer, got 20x");
    expect(err(["--limit", "0"])).toBe("--limit must be a positive integer, got 0");
    expect(err(["--dryrun"])).toBe("unknown flag --dryrun");
    expect(err(["--exclude"])).toBe("--exclude needs a value");
    expect(err(["--no-update", "--no-update"])).toBe("--no-update given twice");
    expect(err(["--rollback", "--limit", "3"])).toContain("--rollback takes no --limit");
    expect(err(["--dry-run", "--rollback"])).toBe("--rollback and --dry-run are exclusive");
  });

  test("the valid forms", () => {
    expect(parseBackfillArgs([])).toEqual({ ok: true, args: expect.objectContaining({ mode: "write", noUpdate: false }) });
    expect(parseBackfillArgs(["--dry-run", "--exclude", "x.txt"])).toEqual({
      ok: true,
      args: expect.objectContaining({ mode: "dry-run", exclude: "x.txt" }),
    });
    expect(parseBackfillArgs(["--limit", "20", "--no-update", "--root", "/r"])).toEqual({
      ok: true,
      args: expect.objectContaining({ mode: "write", limit: 20, noUpdate: true, root: "/r" }),
    });
    expect(parseBackfillArgs(["--rollback"])).toEqual({ ok: true, args: expect.objectContaining({ mode: "rollback" }) });
  });
});

describe("the author cap in the insert", () => {
  test("a name over huginn's 512-byte field cap is refused, not truncated", () => {
    expect(insertFrontmatterAuthor(DOC, "x".repeat(513))).toBeNull();
    expect(insertFrontmatterAuthor(DOC, "x".repeat(512))).toContain(`author: "${"x".repeat(512)}"`);
  });
});

test("the failure streak counts errors and resets on any answer about the video", () => {
  let s = 0;
  for (const k of ["error", "error", "unavailable", "error", "error", "error", "ok"] as const) {
    s = nextFailureStreak(s, { kind: k });
  }
  expect(s).toBe(0);
  expect([1, 2, 3, 4].reduce((acc) => nextFailureStreak(acc, { kind: "error" }), 0)).toBe(4);
  expect(nextFailureStreak(4, { kind: "unavailable" })).toBe(0);
});
