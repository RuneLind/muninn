import { test, expect } from "bun:test";
import { parseFactcheckClaims, correctableClaims } from "./wiki-integrate.ts";

const ANSWER = [
  "Mostly accurate, with one contradicted claim.",
  "",
  "### ✅ Claim 1/3 — Founded in 1998",
  "",
  "Confirmed by the company registry.",
  "",
  "Sources: [example.com](https://example.com/a)",
  "",
  "### ❌ Claim 2/3 — Ships 4M units",
  "",
  "The filing reports 2.1M units.",
  "",
  "Sources: [sec.gov](https://sec.gov/x)",
  "",
  "### ❓ Claim 3/3 — Will double next year",
  "",
  "A prediction — out of scope.",
].join("\n");

test("parseFactcheckClaims splits the answer into per-claim blocks", () => {
  const claims = parseFactcheckClaims(ANSWER);
  expect(claims.map((c) => c.index)).toEqual([1, 2, 3]);
  expect(claims.map((c) => c.verdict)).toEqual(["✅", "❌", "❓"]);
  expect(claims[1]!.title).toBe("Ships 4M units");
  expect(claims[1]!.block).toContain("The filing reports 2.1M units.");
  expect(claims[1]!.block).toContain("sec.gov");
  // The compose lede before the first heading is not part of any block.
  expect(claims[0]!.block).not.toContain("Mostly accurate");
});

test("parseFactcheckClaims tolerates a bare ⚠ (no VS16) and normalizes it", () => {
  const claims = parseFactcheckClaims("### ⚠ Claim 1/1 — Partly right\n\nNeeds a hedge.");
  expect(claims).toHaveLength(1);
  expect(claims[0]!.verdict).toBe("⚠️");
  expect(claims[0]!.title).toBe("Partly right");
});

test("parseFactcheckClaims tolerates en-dash, hyphen, and a title-less heading", () => {
  const claims = parseFactcheckClaims(
    ["### ❌ Claim 1/3 – En dash", "a", "### ⚠️ Claim 2/3 - Hyphen", "b", "### ✅ Claim 3/3", "c"].join("\n"),
  );
  expect(claims.map((c) => c.title)).toEqual(["En dash", "Hyphen", ""]);
  expect(claims.map((c) => c.verdict)).toEqual(["❌", "⚠️", "✅"]);
});

test("parseFactcheckClaims tolerates VS16 on ALL four emoji, a colon separator, and lowercase 'claim'", () => {
  const claims = parseFactcheckClaims(
    [
      "### ❌️ Claim 3/8", // VS16 on ❌, no title
      "a",
      "### ❌ Claim 4/8: Colon separator", // colon instead of a dash
      "b",
      "### ⚠️ claim 5/8 — Lowercase keyword", // lowercase `claim`
      "c",
      "### ✅️ Claim 6/8 — Also VS16", // VS16 on ✅
      "d",
      "### ❓️ Claim 7/8 — Unknown", // VS16 on ❓
      "e",
    ].join("\n"),
  );
  expect(claims.map((c) => c.index)).toEqual([3, 4, 5, 6, 7]);
  expect(claims.map((c) => c.verdict)).toEqual(["❌", "❌", "⚠️", "✅", "❓"]);
  expect(claims.map((c) => c.title)).toEqual([
    "",
    "Colon separator",
    "Lowercase keyword",
    "Also VS16",
    "Unknown",
  ]);
  // …and the VS16 + colon variants still reach the integrate flow.
  expect(correctableClaims("### ❌️ Claim 3/8: Title\n\nbody").map((c) => c.index)).toEqual([3]);
});

test("parseFactcheckClaims does NOT loosen the ### anchor", () => {
  expect(parseFactcheckClaims("## ❌ Claim 1/1 — Wrong level")).toEqual([]);
  expect(parseFactcheckClaims("#### ❌ Claim 1/1 — Wrong level")).toEqual([]);
});

test("parseFactcheckClaims returns [] for a malformed answer", () => {
  expect(parseFactcheckClaims("")).toEqual([]);
  expect(parseFactcheckClaims("Just prose, no headings at all.")).toEqual([]);
});

test("correctableClaims keeps only ❌ and ⚠️", () => {
  const answer = ANSWER + "\n\n### ⚠ Claim 4/4 — Loosely stated\n\nHedge it.";
  const claims = correctableClaims(answer);
  expect(claims.map((c) => c.index)).toEqual([2, 4]);
  expect(claims.map((c) => c.verdict)).toEqual(["❌", "⚠️"]);
});
