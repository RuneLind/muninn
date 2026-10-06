import { test, expect, describe } from "bun:test";
import type { SummaryFactcheck } from "../db/summary-factchecks.ts";
import {
  ASK_FACTCHECK_RIDER_MAX,
  buildAskFactcheckRider,
  buildShareFactcheckRider,
  parseFactcheckParam,
} from "./factcheck-rider.ts";

const ANSWER = [
  "One of three claims is wrong.",
  "",
  "### ❌ Claim 1/3 — Morning affirmations raise cortisol",
  "",
  "Studies of self-affirmation find it LOWERS cortisol responses to stress.",
  "",
  "Confidence: 80/100",
  "",
  "Sources: [pubmed](https://pubmed.ncbi.nlm.nih.gov/1/)",
  "",
  "### ⚠️ Claim 2/3 — Habits form in 21 days",
  "",
  "The median in Lally et al. (2010) was 66 days.",
  "",
  "Confidence: 70/100",
  "",
  "### ✅ Claim 3/3 — Sleep supports memory",
  "",
  "Well supported.",
].join("\n");

function saved(over: Partial<SummaryFactcheck> = {}): SummaryFactcheck {
  return {
    collection: "vimeo-summaries",
    docId: "health/Talk.md",
    url: "https://vimeo.com/123",
    bodySha256: "a".repeat(64),
    answer: ANSWER,
    claims: [
      { index: 1, title: "Morning affirmations raise cortisol", quote: "Affirmations raise your cortisol.", verdict: "❌", outcome: "verified", sources: [] },
      { index: 2, title: "Habits form in 21 days", quote: "It takes 21 days to form a habit.", verdict: "⚠️", outcome: "verified", sources: [] },
      { index: 3, title: "Sleep supports memory", verdict: "✅", outcome: "verified", sources: [] },
    ],
    botName: "jarvis",
    createdAt: Date.UTC(2026, 9, 6, 10, 0, 0),
    transcript: null,
    transcriptSha256: null,
    appliedAt: null,
    ...over,
  };
}

describe("parseFactcheckParam", () => {
  test("splits on the FIRST colon, so a doc id may carry one", () => {
    expect(parseFactcheckParam("vimeo:health/Talk: part 2.md")).toEqual({
      source: "vimeo",
      collection: "vimeo-summaries",
      docId: "health/Talk: part 2.md",
    });
  });
  test("maps the source id through the registry field (x-article → x-articles)", () => {
    expect(parseFactcheckParam("x-article:tech/Post.md")?.collection).toBe("x-articles");
  });
  test.each([
    [undefined],
    [""],
    ["vimeo"],
    [":health/Talk.md"],
    ["bogus:health/Talk.md"],
    ["vimeo:"],
    ["vimeo:../wiki/secret.md"],
    ["vimeo-summaries:health/Talk.md"],
  ])("%p names no document", (value) => {
    expect(parseFactcheckParam(value)).toBeNull();
  });
});

describe("buildShareFactcheckRider", () => {
  test("no row, or a row with nothing wrong, gives no rider", () => {
    expect(buildShareFactcheckRider(null, "vimeo-summaries")).toBe("");
    expect(
      buildShareFactcheckRider(saved({ claims: [{ index: 3, title: "x", verdict: "✅", outcome: "verified", sources: [] }] }), "vimeo-summaries"),
    ).toBe("");
  });
  test("lists the wrong claims with their corrections and asks for attribution", () => {
    const rider = buildShareFactcheckRider(saved(), "vimeo-summaries");
    expect(rider).toContain("Claim 1 (❌ wrong");
    expect(rider).toContain("the talk claims “Affirmations raise your cortisol”");
    expect(rider).toContain("LOWERS cortisol");
    expect(rider).toContain("Claim 2 (⚠️ partly wrong");
    expect(rider).toContain("The talk claims X; sources say Y.");
    expect(rider).toContain("Never repeat one of these claims as true");
    expect(rider).not.toContain("Claim 3");
    expect(rider).toContain("(2026-10-06)");
  });
});

describe("buildAskFactcheckRider", () => {
  test("no row gives no rider", () => {
    expect(buildAskFactcheckRider(null, "vimeo-summaries")).toBe("");
  });
  test("carries the corrections and stays inside the cap with many long claims", () => {
    const rider = buildAskFactcheckRider(saved(), "vimeo-summaries");
    expect(rider).toContain("LOWERS cortisol");
    expect(rider).toContain("do not cite them with [n]");

    const long = "word ".repeat(200);
    const many = saved({
      answer: Array.from({ length: 20 }, (_, i) => `### ❌ Claim ${i + 1}/20 — claim ${i + 1}\n\n${long}`).join("\n\n"),
      claims: Array.from({ length: 20 }, (_, i) => ({
        index: i + 1,
        title: `claim ${i + 1}`,
        quote: long,
        verdict: "❌",
        outcome: "verified",
        sources: [],
      })),
    });
    const capped = buildAskFactcheckRider(many, "vimeo-summaries");
    expect(Array.from(capped).length).toBeLessThanOrEqual(ASK_FACTCHECK_RIDER_MAX);
    expect(capped).toContain("Claim 1 (❌ wrong");
    expect(capped).toContain("more corrected claim(s) not shown");
    expect(capped.endsWith("--- END FACT-CHECK FINDINGS ---")).toBe(true);
  });
});
