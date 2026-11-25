import { describe, expect, test } from "bun:test";
import { KEY_PATTERN_MAX, classifyKey, parseKeyKinds } from "./key-kinds.ts";

describe("parseKeyKinds", () => {
  test("absent is empty with no warning; a non-array is empty with one", () => {
    expect(parseKeyKinds(undefined)).toEqual({ kinds: [], warnings: [] });
    const bad = parseKeyKinds({ name: "case" });
    expect(bad.kinds).toEqual([]);
    expect(bad.warnings.length).toBe(1);
  });

  test("a bad entry warns and is dropped, the rest stand", () => {
    const { kinds, warnings } = parseKeyKinds([
      { name: "case", pattern: "MEL-\\d+" },
      { name: "broken", pattern: "(" },
      { name: "long", pattern: "a".repeat(KEY_PATTERN_MAX + 1) },
      { name: "Upper", pattern: "X-\\d+" },
      { name: "case", pattern: "DUP-\\d+" },
      { name: "empty", pattern: "" },
      "nope",
    ]);
    expect(kinds.map((k) => k.name)).toEqual(["case"]);
    expect(warnings.length).toBe(6);
    expect(warnings.find((w) => w.includes("broken"))).toContain("does not compile");
    expect(warnings.find((w) => w.includes("long"))).toContain(`longer than ${KEY_PATTERN_MAX}`);
  });

  test("a pattern of exactly the bound is kept", () => {
    expect(parseKeyKinds([{ name: "edge", pattern: "a".repeat(KEY_PATTERN_MAX) }]).kinds.length).toBe(1);
  });
});

describe("parseKeyKinds keeps only patterns in the key grammar", () => {
  const refused = [
    "(?:ab)+(?:ab)+x", // groups: whole units traded between repeats
    "(?i:(?:a|A)+)x", // a modifier group
    "(?i:[a-z]+[A-Z]+x)",
    "(a|b)+",
    "(MEL)-\\d+", // any group
    "MEL|SAK", // alternation
    "\\d+-\\d+", // an unbounded atom that is not the last
    "MEL-(\\d+)+",
    "(a)\\1", // a backreference
    "^MEL-\\d+", // an anchor
    "(?=M)MEL", // a lookaround
    ".+", // any-character
    "\\w+", // a class escape other than \d
    "\\p{Lu}{2}-\\d+",
    "[^x]+", // a negated class
    "[\\w-]+",
    "MEL-\\d+?", // a lazy quantifier
    "x{0,33}", // a count over 32
    "\\d{0,32}".repeat(8) + "x", // bounded atoms that can trade digits: 49.9 s on an 80-character key
    "a?a", // an optional atom before one that matches the same character
    "a?b?a", // ... checked past optional atoms up to the first one that must match
    "[A-Z]{2,10}[A-Z0-9]-\\d+",
  ];
  for (const pattern of refused) {
    test(`refuses ${pattern}`, () => {
      const { kinds, warnings } = parseKeyKinds([{ name: "case", pattern }]);
      expect(kinds).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("outside the key grammar");
    });
  }

  const kept = ["MEL-\\d+", "[A-Z]{2,10}-\\d+", "MELOSYS-\\d+", "CASE-\\d+", "[A-Z0-9]{2,8}_\\d{1,8}", "v\\d{1,3}\\.\\d{1,3}\\.\\d+", "a?b?c*", "[a-cx]{3}\\d"];
  for (const pattern of kept) {
    test(`keeps ${pattern}`, () => {
      const { kinds, warnings } = parseKeyKinds([{ name: "case", pattern }]);
      expect(warnings).toEqual([]);
      expect(kinds.length).toBe(1);
    });
  }

  test("an accepted pattern classifies a hostile 80-character key at once", () => {
    const { kinds } = parseKeyKinds(kept.map((pattern, i) => ({ name: `k${i}`, pattern })));
    expect(kinds.length).toBe(kept.length);
    const hostile = ["A".repeat(10) + "-" + "1".repeat(68) + "x", "1".repeat(79) + "x", "MEL-" + "1".repeat(75) + "x", "v" + "1".repeat(78) + "x"];
    const t0 = performance.now();
    for (const key of hostile) expect(classifyKey(key, [], kinds)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  test("the reported pattern no longer classifies a hostile key", () => {
    const { kinds } = parseKeyKinds([{ name: "case", pattern: "MEL-(\\d+)+" }]);
    const t0 = performance.now();
    expect(classifyKey(`MEL-${"1".repeat(27)}x`, [], kinds)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("classifyKey", () => {
  const trackers = [{ id: "jira", projects: ["MELOSYS"] }] as never[];
  const { kinds } = parseKeyKinds([{ name: "case", pattern: "MEL-\\d+" }, { name: "anything", pattern: "[A-Z]{1,16}-\\d+" }]);

  test("a tracker project's key takes the tracker's id before any keys entry", () => {
    expect(classifyKey("MELOSYS-8351", trackers, kinds)).toBe("jira");
  });

  test("the first keys entry whose pattern matches the whole key", () => {
    expect(classifyKey("MEL-1029036", trackers, kinds)).toBe("case");
    expect(classifyKey("ABC-1", trackers, kinds)).toBe("anything");
    expect(classifyKey("xMEL-1", trackers, kinds)).toBeNull();
    expect(classifyKey("MEL-1 and more", trackers, kinds)).toBeNull();
  });

  test("no trackers and no keys: null", () => {
    expect(classifyKey("MELOSYS-1", [], [])).toBeNull();
  });
});
