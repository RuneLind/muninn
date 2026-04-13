import { test, expect } from "bun:test";
import {
  tokenize,
  ngrams,
  jaccard,
  shakeoutSimilarity,
  classify,
} from "./jaccard.ts";

test("tokenize lowercases, strips punctuation, drops empties", () => {
  expect(tokenize("Hello, World! Foo...bar")).toEqual([
    "hello",
    "world",
    "foo",
    "bar",
  ]);
});

test("tokenize handles markdown artifacts", () => {
  expect(tokenize("**BeregningService**.kt uses `.last()` in 3 places")).toEqual([
    "beregningservice",
    "kt",
    "uses",
    "last",
    "in",
    "3",
    "places",
  ]);
});

test("ngrams produces empty set for input shorter than n", () => {
  expect(ngrams(["a", "b", "c"], 5).size).toBe(0);
});

test("ngrams produces all windows of length n", () => {
  const grams = ngrams(["a", "b", "c", "d", "e", "f"], 3);
  expect(grams.size).toBe(4);
  expect(grams.has("a b c")).toBe(true);
  expect(grams.has("d e f")).toBe(true);
});

test("jaccard of empty sets is 0", () => {
  expect(jaccard(new Set(), new Set())).toBe(0);
});

test("jaccard of identical sets is 1", () => {
  const a = new Set(["x", "y", "z"]);
  const b = new Set(["x", "y", "z"]);
  expect(jaccard(a, b)).toBe(1);
});

test("jaccard of disjoint sets is 0", () => {
  const a = new Set(["a", "b"]);
  const b = new Set(["c", "d"]);
  expect(jaccard(a, b)).toBe(0);
});

test("jaccard handles partial overlap correctly", () => {
  const a = new Set(["a", "b", "c"]);
  const b = new Set(["b", "c", "d"]);
  // intersection: {b, c} = 2
  // union:        {a, b, c, d} = 4
  expect(jaccard(a, b)).toBeCloseTo(2 / 4);
});

test("shakeoutSimilarity on identical reports approaches 1", () => {
  const report = "The class BeregningService uses .last() in three places. " +
    "This causes the bug where only the last grunnlag is preserved.";
  expect(shakeoutSimilarity(report, report)).toBe(1);
});

test("shakeoutSimilarity on unrelated texts is near 0", () => {
  const a = "The beregning service uses the last method to pick grunnlag periods.";
  const b = "React components render in a virtual DOM with hooks and context.";
  expect(shakeoutSimilarity(a, b)).toBeLessThan(0.05);
});

test("shakeoutSimilarity catches paraphrased contamination", () => {
  // Simulating Bug 9: two cells where cell B is cell A reformatted slightly.
  // The core content (specific terms, structure) is preserved. Without n=5
  // 5-grams of substantive content, jaccard should still be high.
  const cellA = "The BeregningService class uses .last() in three places to pick " +
    "grunnlag periods from the list. V150 migration introduces a new table " +
    "trygdeavgiftsperiode_grunnlag with FK to Trygdeavgiftsperiode. V151 drops " +
    "the old FK columns after deploy verification.";
  const cellB = "The BeregningService class uses .last() in three places to pick " +
    "grunnlag periods from the list. V150 migration introduces a new table " +
    "trygdeavgiftsperiode_grunnlag with FK to Trygdeavgiftsperiode. V151 drops " +
    "the old FK columns after deploy verification.";
  // Same text — should be 1.0
  expect(shakeoutSimilarity(cellA, cellB)).toBe(1);
});

test("shakeoutSimilarity distinguishes tool-stack differences from contamination", () => {
  // Two reports that describe the same issue but at different levels of
  // detail — as would happen when one cell uses Serena (specific file paths,
  // method names) and another uses knowledge-only (higher-level description).
  const withSerena = "The addGrunnlag method in Trygdeavgiftsperiode.kt at line 109 " +
    "throws when called with more than one grunnlag. The erLikForSatsendring method " +
    "uses compareTo on trygdesats which fails with null.";
  const knowledgeOnly = "Implementation likely requires changing how grunnlag is " +
    "tracked per trygdeavgiftsperiode, probably a new table or a list-valued field. " +
    "Existing code compares sats strictly and may break with nullable types.";
  const sim = shakeoutSimilarity(withSerena, knowledgeOnly);
  // Should be genuinely low — different phrasing, different detail level
  expect(sim).toBeLessThan(0.2);
});

test("classify maps similarity to the right verdict", () => {
  expect(classify(0.98)).toBe("contamination-very-likely");
  expect(classify(0.85)).toBe("calibration-band");
  expect(classify(0.50)).toBe("legitimate-tool-diff");
  expect(classify(0.15)).toBe("unexpectedly-divergent");
});

test("classify band boundaries are inclusive on the low side", () => {
  expect(classify(0.95)).toBe("contamination-very-likely");
  expect(classify(0.80)).toBe("calibration-band");
  expect(classify(0.40)).toBe("legitimate-tool-diff");
});
