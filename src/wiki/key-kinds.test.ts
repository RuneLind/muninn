import { describe, expect, test } from "bun:test";
import { KEY_PATTERN_MAX, KEY_SCAN_LINE_MAX, classifyKey, parseKeyKinds, scanKeyKinds } from "./key-kinds.ts";

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

describe("scanKeyKinds (the Trace view's page-wide marking)", () => {
  const kinds = parseKeyKinds([{ name: "case", pattern: "MEL-\\d+" }, { name: "ticket", pattern: "[A-Z]{2,10}-\\d+" }]).kinds;

  test("whole words only, the earlier then the longer match, each with its kind and offsets", () => {
    const text = "See MEL-12, xMEL-3 and MEL-4x, then ABC-7 and MEL-55.\nAB-1";
    const { matches, skippedLines } = scanKeyKinds(text, kinds);
    expect(matches.map((m) => `${m.key}:${m.kind}`)).toEqual(["MEL-12:case", "ABC-7:ticket", "MEL-55:case", "AB-1:ticket"]);
    for (const m of matches) expect(text.slice(m.start, m.end)).toBe(m.key);
    expect(skippedLines).toBe(0);
  });

  test("a match shorter than 3 or longer than 80 characters is no key the mentions route searches", () => {
    const short = parseKeyKinds([{ name: "d", pattern: "\\d{1,2}" }]).kinds;
    expect(scanKeyKinds("7 and 12", short).matches).toEqual([]);
    const long = parseKeyKinds([{ name: "l", pattern: "X\\d+" }]).kinds;
    expect(scanKeyKinds(`X${"1".repeat(80)}`, long).matches).toEqual([]);
  });

  test("a line over the bound is skipped and counted; the next line is still scanned", () => {
    const text = `${"MEL-1 ".repeat(Math.ceil((KEY_SCAN_LINE_MAX + 1) / 6))}\nMEL-2`;
    const { matches, skippedLines } = scanKeyKinds(text, kinds);
    expect(skippedLines).toBe(1);
    expect(matches.map((m) => m.key)).toEqual(["MEL-2"]);
  });

  test("pathological input stays fast: a long run of letters, a long digit run, and a quadratic grammar-legal pattern capped by the line bound", () => {
    const greedy = parseKeyKinds([{ name: "g", pattern: "[-A]+" }]).kinds;
    expect(greedy.length).toBe(1);
    const t0 = performance.now();
    // At the bound: each start of `-A-A…b` runs to the same `b`, the quadratic worst case.
    scanKeyKinds(`${"-A".repeat(KEY_SCAN_LINE_MAX / 2)}b`, greedy);
    scanKeyKinds("A".repeat(KEY_SCAN_LINE_MAX), kinds);
    scanKeyKinds(`MEL-${"1".repeat(KEY_SCAN_LINE_MAX - 5)}x`, kinds);
    // Over the bound: a 1 MB line of the same is skipped, not scanned.
    const huge = scanKeyKinds(`${"-A".repeat(500_000)}b`, greedy);
    const ms = performance.now() - t0;
    expect(huge).toEqual({ matches: [], skippedLines: 1 });
    expect(ms).toBeLessThan(250);
  });
});
