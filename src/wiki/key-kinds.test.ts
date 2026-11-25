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

describe("parseKeyKinds refuses a pattern whose matching cost can explode", () => {
  // Each of these backtracks exponentially or polynomially on a near-miss key.
  const refused = [
    "MEL-(\\d+)+", // nested unbounded quantifiers
    "(x*)*",
    "(?:a+){2}", // repeated more than once is enough
    "(?:a{1,3})+", // a variable count inside a repeat
    "(x|x)+", // overlapping alternatives in a repeat
    "(a|ab)+",
    "(a|)+", // an alternative that matches nothing
    "\\d+\\d+", // adjacent unbounded repeats of overlapping classes
    "[A-Z]+\\d*[A-Z]+", // ... with only optional atoms between them
    "\\d+5\\d+", // ... or atoms the overlap can also match
    "(?:x|\\d+)\\d+", // a group that ends in an unbounded repeat
    "(?=(a+)+)a", // inside a lookaround too
    "(a)\\1", // backreferences
  ];
  for (const pattern of refused) {
    test(`refuses ${pattern}`, () => {
      const { kinds, warnings } = parseKeyKinds([{ name: "case", pattern }]);
      expect(kinds).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("can backtrack");
    });
  }

  const kept = [
    "MEL-\\d+",
    "[A-Z]{2,10}-\\d+",
    "(?:MEL|SAK)-\\d{1,8}",
    "[a-z]+(?:-[a-z]{2})+",
    "\\d+-\\d+",
    "\\p{Lu}{2,5}-\\d+",
    "(\\d+)?x",
    "(?:ab|ba)+",
  ];
  for (const pattern of kept) {
    test(`keeps ${pattern}`, () => {
      const { kinds, warnings } = parseKeyKinds([{ name: "case", pattern }]);
      expect(warnings).toEqual([]);
      expect(kinds.length).toBe(1);
    });
  }

  test("the reported pattern no longer classifies a hostile key", () => {
    const { kinds } = parseKeyKinds([{ name: "case", pattern: "MEL-(\\d+)+" }]);
    const t0 = performance.now();
    expect(classifyKey(`MEL-${"1".repeat(27)}x`, [], kinds)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("classifyKey", () => {
  const trackers = [{ id: "jira", projects: ["MELOSYS"] }] as never[];
  const { kinds } = parseKeyKinds([{ name: "case", pattern: "MEL-\\d+" }, { name: "anything", pattern: "[A-Z]+-\\d+" }]);

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
