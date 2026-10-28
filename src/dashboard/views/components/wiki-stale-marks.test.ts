/**
 * The pure halves of the stale marks (PR 2b, D21): the said word the server
 * would find, and the score that picks a hit's line. The DOM half runs in
 * `wiki-stale-marks-dom.test.ts` (happy-dom) and `e2e/wiki-stale-counts.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { saidSpan } from "../../../wiki/status-words.ts";
import { hitTokens, lineScore, MATCH_MIN, tokens } from "./wiki-stale-marks.ts";

describe("stale marks (PR 2b)", () => {
  test("the said word is the earliest word of a said kind, edged on æøå", () => {
    expect(saidSpan(" is in-flight and done", ["in-flight"])).toEqual([4, 13]);
    expect(saidSpan(" pågår fortsatt", ["in-flight"])).toEqual([1, 6]);
    // A kind not said is not marked, and a word inside another word is no word.
    expect(saidSpan(" is done", ["in-flight"])).toBeNull();
    expect(saidSpan(" uferdig", ["shipped"])).toBeNull();
    // The negated merget is in-flight, with its negation.
    const s = " er ikke merget";
    const span = saidSpan(s, ["in-flight"])!;
    expect(s.slice(span[0], span[1])).toBe("ikke merget");
  });

  test("a hit's words leave its wikilinks out, read a markdown link as its text, and drop a cut word", () => {
    expect(hitTokens("- [[p|the plan]] is **in-flight**")).toEqual(["is", "in", "flight"]);
    expect(hitTokens("| [[p]] | blokkert |")).toEqual(["blokkert"]);
    expect(hitTokens("see [the PR](https://x/1) for [[p]] pågår")).toEqual(["see", "the", "pr", "for", "pågår"]);
    expect(hitTokens("…tail of a wo [[p]] is in-flight and mo…")).toEqual(["of", "a", "wo", "is", "in", "flight", "and"]);
    expect(tokens("Æ-ø 12")).toEqual(["æ", "ø", "12"]);
  });

  test("a line scores the share of the hit's words it holds in order", () => {
    expect(lineScore(["is", "in", "flight"], ["is", "in", "flight", "two", "prs"])).toBe(1);
    expect(lineScore(["is", "in", "flight", "x"], ["is", "in", "flight", "y"])).toBe(0.75);
    expect(lineScore(["is", "in", "flight", "x"], ["is", "in", "flight", "y"])).toBeLessThan(MATCH_MIN);
    expect(lineScore(["b", "a"], ["a", "b"])).toBe(0.5);
    expect(lineScore([], ["a"])).toBe(1);
  });
});
