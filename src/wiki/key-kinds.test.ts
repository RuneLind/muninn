import { describe, expect, test } from "bun:test";
import { KEY_PATTERN_MAX, KEY_SCAN_LINE_MAX, classifyKey, parseKeyKinds, scanKeyKinds } from "./key-kinds.ts";
import { wholeKeyCount } from "./tracked-files.ts";

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
    expect(huge).toEqual({ matches: [], skippedLines: 1, skippedChars: 1_000_001 });
    expect(ms).toBeLessThan(250);
  });
});

describe("scanKeyKinds: the mentions route's whole-key rule and the page budget (fix round 1)", () => {
  const kinds = parseKeyKinds([{ name: "case", pattern: "MEL-\\d+" }]).kinds;
  const keys = (text: string) => scanKeyKinds(text, kinds).matches.map((m) => m.key);

  test("a Unicode letter or digit on either side is no whole key: æMEL-5555, MEL-5556ø, ÅMEL-5557, MEL-5558é, 𝐀MEL-5559", () => {
    expect(keys("æMEL-5555 MEL-5556ø ÅMEL-5557 MEL-5558é 𝐀MEL-5559 MEL-5560𝐀 ٣MEL-5561")).toEqual([]);
    expect(keys("(MEL-1) MEL-2. «MEL-3» MEL-4\u0301")).toEqual(["MEL-1", "MEL-2", "MEL-3", "MEL-4"]);
  });

  test("marked exactly where the peek's search counts the key whole, for every neighbour pair", () => {
    const sides = ["", " ", "a", "Z", "æ", "ø", "é", "中", "𝐀", "٣", "7", "_", "-", ".", "*", "`", "(", "\u0301", "\u00a0"];
    for (const a of sides)
      for (const b of sides) {
        const text = `x ${a}MEL-12${b} y`;
        const marked = keys(text).includes("MEL-12");
        const counted = wholeKeyCount(text, "MEL-12") === 1;
        // Never a mark the peek does not count. Before an astral letter Bun's
        // lookbehind reads one surrogate, so the search counts `𝐀MEL-12`
        // whole; the scan reads the code point and does not mark it.
        if (marked) expect([text, counted]).toEqual([text, true]);
        if (a !== "𝐀") expect([text, marked]).toEqual([text, counted]);
      }
  });

  // Fix round 2 batch 3 (finding 5): past the budget the scan dropped every
  // later line, so a growing log.md lost its newest entries at the bottom.
  test("the page budget: past it, lines come from both ends inward and the middle is skipped, counted and named", () => {
    const text = ["MEL-1 aaaa", "MEL-2 bbbb", "MEL-3 cccc", "MEL-4 dddd", "MEL-5"].join("\n");
    const r = scanKeyKinds(text, kinds, KEY_SCAN_LINE_MAX, 25);
    expect(r.matches.map((m) => m.key)).toEqual(["MEL-1", "MEL-4", "MEL-5"]);
    expect({ skippedLines: r.skippedLines, skippedChars: r.skippedChars, middle: r.middle }).toEqual({ skippedLines: 2, skippedChars: 20, middle: { fromLine: 2, toLine: 3 } });
    expect(scanKeyKinds(text, kinds, KEY_SCAN_LINE_MAX, 45).middle).toBeUndefined();
  });

  test("a 3 MB log.md past the default budget keeps the entries at both ends, where both wikis add new ones, and skips the oldest in between", () => {
    // Newest entries prepended at the top and appended at the bottom, old ones in the middle.
    const entry = (n: number, day: string) => `## [${day}] note | MEL-${n} entry\n\n- The case MEL-${n} moved on. ${"x".repeat(160)}\n`;
    const old = Array.from({ length: 15_000 }, (_, i) => entry(100_000 + i, "2026-05-01")).join("\n");
    const text = `# Log\n\n${entry(1, "2026-11-26")}\n${old}\n${entry(2, "2026-11-25")}`;
    expect(text.length).toBeGreaterThan(3_000_000);
    const r = scanKeyKinds(text, kinds);
    const keys = new Set(r.matches.map((m) => m.key));
    expect([keys.has("MEL-1"), keys.has("MEL-2"), keys.has("MEL-107500")]).toEqual([true, true, false]);
    const lines = text.split("\n").length;
    expect(r.middle!.fromLine).toBeGreaterThan(1);
    expect(r.middle!.toLine).toBeLessThan(lines);
    expect(r.skippedLines).toBe(r.middle!.toLine - r.middle!.fromLine + 1);
  });

  test("the default budget bounds a page whatever its kinds: 250 worst-case lines under 8 kinds scan 31 lines", () => {
    const eight = parseKeyKinds(Array.from({ length: 8 }, (_, i) => ({ name: `g${i}`, pattern: `[-A${"BCDEFGHI"[i]}]+` }))).kinds;
    expect(eight.length).toBe(8);
    const line = `${"-A".repeat((KEY_SCAN_LINE_MAX - 2) / 2)}b`;
    const t0 = performance.now();
    const r = scanKeyKinds(Array(250).fill(line).join("\n"), eight);
    const ms = performance.now() - t0;
    // 31 lines × 3,999 characters × 8 kinds = 991,752 fits 1,000,000; a 32nd would not.
    expect(r.skippedLines).toBe(219);
    expect(r.skippedChars).toBe(219 * line.length);
    // 16 from the top and 15 from the bottom: the end that has spent less goes next.
    expect(r.middle).toEqual({ fromLine: 17, toLine: 235 });
    expect(ms).toBeLessThan(3000);
  });
});
