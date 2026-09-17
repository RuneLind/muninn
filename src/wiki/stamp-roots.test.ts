/**
 * `WIKI_STAMP_ROOTS` / `WIKI_STAMP_BIN` — muninn's own parse of the roots the
 * `wiki-stamp` CLI classifies against, and the `stampable` predicate the reader
 * hides every Stamp button behind.
 *
 * muninn cannot import claude-usage, so the parse is re-implemented against
 * `src/wiki-stamp.ts`'s `parseRoots` semantics: `:`-separated like `PATH`,
 * relative entries dropped, `/` refused, normalized, deduped.
 *
 * The predicate is EQUALITY, not containment. The CLI locks the longest matching
 * stamp root and muninn locks the WIKI root, so a wiki registered at a strict
 * subdirectory of a stamp root gets two different lock files and no mutual
 * exclusion — the lost-append the single-writer rule exists to prevent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "./readonly.ts";
import {
  isStampRoot,
  parseStampRoots,
  stampConfigFromEnv,
  stampableFor,
  WIKI_STAMP_BIN_ENV,
  WIKI_STAMP_BUN_ENV,
  WIKI_STAMP_ROOTS_ENV,
} from "./stamp-roots.ts";

afterEach(() => {
  __setWikiReadonlyForTest();
  __setReadonlyWikiRootsForTest();
});

describe("parseStampRoots", () => {
  test("splits on `:` and keeps absolute entries in order", () => {
    expect(parseStampRoots("/a/mimir:/b/wiki")).toEqual(["/a/mimir", "/b/wiki"]);
  });

  test("drops blank and relative entries rather than guessing", () => {
    expect(parseStampRoots("::/a/mimir: :rel/path:./also")).toEqual(["/a/mimir"]);
  });

  test("refuses `/` — as a root it makes every markdown file on the machine a page", () => {
    expect(parseStampRoots("/:/a/mimir")).toEqual(["/a/mimir"]);
  });

  test("normalizes a trailing slash and a `..` segment, and dedupes", () => {
    expect(parseStampRoots("/a/mimir/:/a/b/../mimir:/a/mimir")).toEqual(["/a/mimir"]);
  });

  test("an unset or empty value is no roots at all", () => {
    expect(parseStampRoots(undefined)).toEqual([]);
    expect(parseStampRoots("")).toEqual([]);
  });
});

describe("isStampRoot", () => {
  const roots = ["/src/mimir", "/src/wiki"];

  test("a wiki root that EQUALS a stamp root matches", () => {
    expect(isStampRoot("/src/mimir", roots)).toBe(true);
    expect(isStampRoot("/src/mimir/", roots)).toBe(true);
  });

  test("a sibling sharing the root's prefix does NOT match", () => {
    // The boundary case: a `startsWith(root)` predicate says true here.
    expect(isStampRoot("/src/mimir-old", roots)).toBe(false);
  });

  test("a strict SUBDIRECTORY of a stamp root does NOT match", () => {
    // A `startsWith(root + "/")` predicate says true here, and the two lock
    // files that follow are the lost-append this rule exists to prevent.
    expect(isStampRoot("/src/mimir/plans", roots)).toBe(false);
  });

  test("a PARENT of a stamp root does not match either", () => {
    expect(isStampRoot("/src", roots)).toBe(false);
  });

  test("a symlinked spelling of a root matches the root it resolves to", () => {
    const base = mkdtempSync(path.join(tmpdir(), "muninn-stamp-roots-"));
    try {
      const real = path.join(base, "real");
      mkdirSync(real);
      const link = path.join(base, "link");
      symlinkSync(real, link);
      expect(isStampRoot(link, [real])).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("stampConfigFromEnv", () => {
  test("reads the three variables and parses the roots", () => {
    const c = stampConfigFromEnv({
      [WIKI_STAMP_BIN_ENV]: " /src/claude-usage/scripts/wiki-stamp.ts ",
      [WIKI_STAMP_ROOTS_ENV]: "/src/mimir",
      // The NAME through its export: the module owns the spelling so the docs,
      // the error copy and the reader agree on it, and a test that re-types the
      // literal is green against a second spelling.
      [WIKI_STAMP_BUN_ENV]: "/opt/bun",
    });
    expect(c.bin).toBe("/src/claude-usage/scripts/wiki-stamp.ts");
    expect(c.roots).toEqual(["/src/mimir"]);
    expect(c.bun).toBe("/opt/bun");
  });

  test("a whitespace-only value is unset, and `bun` defaults to the name on PATH", () => {
    const c = stampConfigFromEnv({ [WIKI_STAMP_BIN_ENV]: "   ", [WIKI_STAMP_ROOTS_ENV]: "" });
    expect(c.bin).toBeNull();
    expect(c.roots).toEqual([]);
    expect(c.bun).toBe("bun");
  });
});

describe("stampableFor", () => {
  const config = stampConfigFromEnv({
    [WIKI_STAMP_BIN_ENV]: "/src/claude-usage/scripts/wiki-stamp.ts",
    [WIKI_STAMP_ROOTS_ENV]: "/src/mimir",
  });

  test("bin + roots + an equal wiki root + writable ⇒ stampable", () => {
    expect(stampableFor({ wikiDir: "/src/mimir", config })).toBe(true);
  });

  test("no WIKI_STAMP_BIN ⇒ false", () => {
    const c = stampConfigFromEnv({ [WIKI_STAMP_ROOTS_ENV]: "/src/mimir" });
    expect(stampableFor({ wikiDir: "/src/mimir", config: c })).toBe(false);
  });

  test("no WIKI_STAMP_ROOTS ⇒ false", () => {
    const c = stampConfigFromEnv({ [WIKI_STAMP_BIN_ENV]: "/src/claude-usage/scripts/wiki-stamp.ts" });
    expect(stampableFor({ wikiDir: "/src/mimir", config: c })).toBe(false);
  });

  test("a wiki under, but not equal to, a stamp root ⇒ false", () => {
    expect(stampableFor({ wikiDir: "/src/mimir/plans", config })).toBe(false);
  });

  test("a read-only INSTANCE ⇒ false — this is the mini's shape", () => {
    __setWikiReadonlyForTest(true);
    expect(stampableFor({ wikiDir: "/src/mimir", config })).toBe(false);
  });

  test("a read-only ROOT ⇒ false", () => {
    __setReadonlyWikiRootsForTest(["/src/mimir"]);
    expect(stampableFor({ wikiDir: "/src/mimir", config })).toBe(false);
  });
});
