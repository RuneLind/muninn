/**
 * The one reading of an `aliases:` entry both sides share (`alias-ref.ts`):
 * the server's `aliasWorkedPaths` and the browser's boundary resolver.
 * Arch review 2026-10, batch K fix round 1 (findings A, F, G).
 */

import { describe, expect, test } from "bun:test";
import { aliasTopDirs, aliasWorkedPaths, classifyAliasRef, unwrapAliasRef } from "./alias-ref.ts";

const dirs = new Set(["archive", "plans", "sources"]);

describe("unwrapAliasRef", () => {
  test("only a [[…]] wikilink drops its |label and #anchor; a plain alias keeps # and | as text (F)", () => {
    expect(unwrapAliasRef("[[plans/old|Label]]")).toBe("plans/old");
    expect(unwrapAliasRef(" [[plans/old#x]] ")).toBe("plans/old");
    expect(unwrapAliasRef("The #1 Mistake That Makes Children Disrespectful")).toBe("The #1 Mistake That Makes Children Disrespectful");
    expect(unwrapAliasRef("A | B")).toBe("A | B");
    expect(unwrapAliasRef(" ./plans\\old ")).toBe("plans/old");
    expect(unwrapAliasRef("[[]]")).toBe("");
  });
});

describe("classifyAliasRef", () => {
  test("a no-slash name spelling .md/.mdx/.html is a path: a root-level move names itself so (A)", () => {
    expect(classifyAliasRef("old-plan.md", dirs)).toEqual({ kind: "path", path: "old-plan.md", ext: true });
    expect(classifyAliasRef("[[old-plan.md]]", dirs)).toEqual({ kind: "path", path: "old-plan.md", ext: true });
    expect(classifyAliasRef("x.HTML", dirs)).toEqual({ kind: "path", path: "x.HTML", ext: true });
  });

  test("a slash alias under a top-level folder is a path; its folder is compared without case", () => {
    expect(classifyAliasRef("plans/old", dirs)).toEqual({ kind: "path", path: "plans/old", ext: false });
    expect(classifyAliasRef("Archive/Old.mdx", dirs)).toEqual({ kind: "path", path: "Archive/Old.mdx", ext: true });
  });

  test("a slash title whose first segment is no top-level folder reads as nothing, not a stem (G)", () => {
    for (const a of ["/goal", "/ultrareview", "openai/math Repository", "ω ≤ 9/4", "claude.ai/design", "openai/x.md"]) {
      expect(classifyAliasRef(a, dirs)).toEqual({ kind: "none" });
    }
  });

  test("a bare name is a stem; a plain title keeps its # (F)", () => {
    expect(classifyAliasRef("Vibe coding", dirs)).toEqual({ kind: "stem", stem: "Vibe coding" });
    expect(classifyAliasRef("The #1 Mistake", dirs)).toEqual({ kind: "stem", stem: "The #1 Mistake" });
    expect(classifyAliasRef("  ", dirs)).toEqual({ kind: "none" });
  });
});

// Fix round 2 (finding 1): one fold for the folder set and the alias's first
// segment, and the keys in `normalizeWorkedPath`'s spelling.
describe("aliasTopDirs and the folder an alias names, NFD or NFC", () => {
  const NFD = "cafe\u0301s";
  test("a folder name folds to lower case and NFC; blanks drop", () => {
    expect([...aliasTopDirs([NFD.toUpperCase(), "Plans", ""])]).toEqual(["cafés", "plans"]);
  });
  test("an alias naming the folder in either form is a path", () => {
    for (const dirsOn of [[NFD], ["cafés"]]) {
      for (const a of [`${NFD}/old`, "cafés/old"]) expect(classifyAliasRef(a, aliasTopDirs(dirsOn)).kind).toBe("path");
    }
  });
  test("its keys are normalizeWorkedPath's: //, ./, .. and NFD fold", () => {
    const d = aliasTopDirs(["plans"]);
    for (const a of ["plans//old", "plans/./old", "plans/x/../old", "/plans/old"]) {
      expect(aliasWorkedPaths(a, d)).toEqual(a.startsWith("/") ? [] : ["plans/old.md", "plans/old.mdx"]);
    }
    expect(aliasWorkedPaths("plans/cafe\u0301.md", d)).toEqual(["plans/café.md"]);
  });
});
