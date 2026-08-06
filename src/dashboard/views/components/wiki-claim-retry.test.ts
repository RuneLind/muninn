import { test, expect } from "bun:test";
import {
  appendLedeAmendment,
  claimOutcomeMapFromRows,
  buildClaimRetryUrl,
  claimBlockIndex,
  claimCountFromMap,
  claimRefFromHeadingText,
  claimRetryBatchLabel,
  claimRetryRunningCopy,
  claimRetryUrlFor,
  isRetryableOutcome,
  outcomeCountsFromMap,
  retryableClaims,
  spliceClaimBlock,
} from "./wiki-claim-retry.ts";
import { parseFactcheckClaims } from "./wiki-integrate.ts";
import { formatWebHtml } from "../../../web/web-format.ts";

const LEDE = "Overall: two of the three claims hold up.";

const MULTI = [
  LEDE,
  "",
  "### ✅ Claim 1/3 — Ships worldwide",
  "",
  "Confirmed by the filing.",
  "",
  "Confidence: 88/100",
  "",
  "### ❓ Claim 2/3 — Revenue doubled",
  "",
  "Verification timed out after 110s.",
  "",
  "### ❌ Claim 3/3 — Founded in 1990",
  "",
  "The company was founded in 1994.",
].join("\n");

const SINGLE = ["### ❓ Claim 1/1 — Revenue doubled", "", "Verification timed out after 110s."].join("\n");

const RETRIED_BLOCK = [
  "### ✅ Claim 2/3 — Revenue doubled",
  "",
  "The 2025 filing reports revenue up 104%.",
  "",
  "Confidence: 82/100",
].join("\n");

// ── retryableClaims ───────────────────────────────────────────────────

test("retryableClaims keeps timeout/skipped/error and joins quotes by index", () => {
  const claims = retryableClaims(
    MULTI,
    { 1: "verified", 2: "timeout", 3: "verified" },
    [{ index: 2, quote: "revenue doubled last year" }],
  );
  expect(claims.map((c) => c.index)).toEqual([2]);
  expect(claims[0]!.total).toBe(3);
  expect(claims[0]!.title).toBe("Revenue doubled");
  expect(claims[0]!.quote).toBe("revenue doubled last year");
  expect(claims[0]!.outcome).toBe("timeout");
});

test("retryableClaims does NOT offer a model-chosen unverifiable", () => {
  expect(retryableClaims(MULTI, { 1: "verified", 2: "unverifiable", 3: "verified" })).toEqual([]);
  expect(isRetryableOutcome("unverifiable")).toBe(false);
  expect(isRetryableOutcome("timeout")).toBe(true);
  expect(isRetryableOutcome("skipped")).toBe(true);
  expect(isRetryableOutcome("error")).toBe(true);
  expect(isRetryableOutcome(undefined)).toBe(false);
});

test("retryableClaims yields nothing for a turn persisted before the outcome map", () => {
  // Migration behaviour, not a bug: the ❓ emoji alone cannot tell a model-chosen
  // "unverifiable" apart from a claim that timed out.
  expect(retryableClaims(MULTI, undefined)).toEqual([]);
});

test("retryableClaims carries the heading's own total, not the anchor count", () => {
  // A verify block that missed the heading contract leaves 2 anchors on a 3-claim
  // run — exactly the failure class the retry exists for.
  const damaged = [
    LEDE,
    "",
    "### ✅ Claim 1/3 — Ships worldwide",
    "",
    "ok",
    "",
    "❓ Claim 2/3 — heading contract missed",
    "",
    "### ❓ Claim 3/3 — Founded in 1990",
    "",
    "timed out",
  ].join("\n");
  const claims = retryableClaims(damaged, { 1: "verified", 3: "timeout" });
  expect(claims).toHaveLength(1);
  expect(claims[0]!.total).toBe(3);
  expect(parseFactcheckClaims(damaged)).toHaveLength(2); // anchors.length would say 2
});

// ── spliceClaimBlock ──────────────────────────────────────────────────

test("spliceClaimBlock replaces exactly the matching block, siblings byte-identical", () => {
  const out = spliceClaimBlock(MULTI, 2, RETRIED_BLOCK)!;
  expect(out).toContain("### ✅ Claim 2/3 — Revenue doubled");
  expect(out).not.toContain("Verification timed out");
  // The two siblings survive byte-for-byte, separators included.
  expect(out).toContain("### ✅ Claim 1/3 — Ships worldwide\n\nConfirmed by the filing.\n\nConfidence: 88/100\n\n");
  expect(out).toContain("\n\n### ❌ Claim 3/3 — Founded in 1990\n\nThe company was founded in 1994.");
  expect(out.startsWith(LEDE)).toBe(true);
  // Still parses as three claims in order.
  expect(parseFactcheckClaims(out).map((c) => c.index)).toEqual([1, 2, 3]);
});

test("spliceClaimBlock replaces the LAST block without eating the tail", () => {
  const out = spliceClaimBlock(MULTI, 3, "### ✅ Claim 3/3 — Founded in 1994\n\nCorrected.")!;
  expect(out).toContain("### ✅ Claim 3/3 — Founded in 1994");
  expect(out).toContain("### ❓ Claim 2/3 — Revenue doubled");
  expect(parseFactcheckClaims(out).map((c) => c.verdict)).toEqual(["✅", "❓", "✅"]);
});

test("spliceClaimBlock returns null for an unknown index or an empty block", () => {
  expect(spliceClaimBlock(MULTI, 9, RETRIED_BLOCK)).toBeNull();
  expect(spliceClaimBlock(MULTI, 2, "   ")).toBeNull();
});

test("spliceClaimBlock stops at a non-claim ### heading", () => {
  const withTail = MULTI + "\n\n### Notes\n\nUnrelated section.";
  const out = spliceClaimBlock(withTail, 3, "### ✅ Claim 3/3 — Founded in 1994\n\nCorrected.")!;
  expect(out).toContain("### Notes\n\nUnrelated section.");
});

// ── lede amendment ────────────────────────────────────────────────────

test("appendLedeAmendment adds one line under a multi-claim lede", () => {
  const out = appendLedeAmendment(spliceClaimBlock(MULTI, 2, RETRIED_BLOCK)!, 2);
  expect(out).toContain("_Claim 2 was re-checked after the initial run._");
  // Under the lede, above the first block.
  expect(out.indexOf("_Claim 2 was")).toBeGreaterThan(out.indexOf(LEDE));
  expect(out.indexOf("_Claim 2 was")).toBeLessThan(out.indexOf("### ✅ Claim 1/3"));
});

test("appendLedeAmendment ACCUMULATES instead of stacking sentences", () => {
  const once = appendLedeAmendment(MULTI, 2);
  const twice = appendLedeAmendment(once, 3);
  expect(twice).toContain("_Claims 2 and 3 were re-checked after the initial run._");
  expect(twice.match(/re-checked after the initial run/g)).toHaveLength(1);
  const thrice = appendLedeAmendment(twice, 1);
  expect(thrice).toContain("_Claims 1, 2 and 3 were re-checked after the initial run._");
  expect(thrice.match(/re-checked after the initial run/g)).toHaveLength(1);
});

test("appendLedeAmendment writes NOTHING on a single-claim answer (there is no lede)", () => {
  // `assembleFactcheckAnswer` returns the lone block and Phase 3 never runs, so an
  // amendment would invent a lede above the ### heading — the sel-mode case.
  const spliced = spliceClaimBlock(SINGLE, 1, "### ✅ Claim 1/1 — Revenue doubled\n\nConfirmed.")!;
  expect(appendLedeAmendment(spliced, 1)).toBe(spliced);
  expect(appendLedeAmendment(spliced, 1).startsWith("### ")).toBe(true);
});

test("appendLedeAmendment leaves a multi-claim answer whose lede region is blank alone", () => {
  const noLede = MULTI.slice(MULTI.indexOf("### ✅"));
  expect(appendLedeAmendment(noLede, 2)).toBe(noLede);
});

// ── outcome map is the single authority ───────────────────────────────

test("outcomeCountsFromMap / claimCountFromMap re-derive from the map", () => {
  const map = { 1: "verified", 2: "verified", 3: "unverifiable", 4: "timeout", 5: "skipped" };
  expect(outcomeCountsFromMap(map)).toEqual({
    verified: 2,
    unverifiable: 1,
    timeout: 1,
    skipped: 1,
  });
  // Only REAL verdict blocks count — mirrors the server's `o.real` filter.
  expect(claimCountFromMap(map)).toBe(3);
  expect(claimCountFromMap(undefined)).toBe(0);
  expect(outcomeCountsFromMap(undefined)).toEqual({});
});

test("claimOutcomeMapFromRows lifts the live checklist onto the persisted map", () => {
  const map = claimOutcomeMapFromRows([
    { index: 1, status: "done", outcome: "verified" },
    { index: 2, status: "done", outcome: "timeout" },
    { index: 3, status: "done" }, // older server: a real verdict block
    { index: 4, status: "pending" }, // never ruled — must NOT default to verified
    { index: 5, status: "done", outcome: "bogus" }, // unknown wire value — skipped
  ]);
  expect(map).toEqual({ 1: "verified", 2: "timeout", 3: "verified" });
  // An empty/absent checklist stores nothing rather than an empty object, so a
  // single-claim turn with no checklist reads as "pre-field" rather than "no claims".
  expect(claimOutcomeMapFromRows([])).toBeUndefined();
  expect(claimOutcomeMapFromRows(undefined)).toBeUndefined();
});

// ── DOM contract: h4, not h3 ──────────────────────────────────────────

test("claimRefFromHeadingText reads Claim n/m off a rendered heading", () => {
  expect(claimRefFromHeadingText("❓ Claim 2/3 — Revenue doubled")).toEqual({ index: 2, total: 3 });
  expect(claimRefFromHeadingText("⚠️ claim 10 / 12: lowercase")).toEqual({ index: 10, total: 12 });
  expect(claimRefFromHeadingText("Sources")).toBeNull();
  expect(claimRefFromHeadingText("")).toBeNull();
});

test("the markdown ### contract renders as an h4 in the DOM", () => {
  // The trap this pins: an `h3` selector for the ↻ would match NOTHING, shipping
  // an invisible button. `formatWebHtml` emits h(level + 1).
  const html = formatWebHtml(MULTI);
  expect(html).toContain("<h4>❓ Claim 2/3 — Revenue doubled</h4>");
  expect(html).not.toContain("<h3>❓ Claim 2/3");
});

// ── url + copy ────────────────────────────────────────────────────────

test("buildClaimRetryUrl threads mode/sel/ctx and echoes the claim", () => {
  const url = buildClaimRetryUrl({
    page: "Some Page",
    wiki: "mimir",
    mode: "sel",
    sel: "the selected passage",
    ctx: "A Heading",
    index: 2,
    total: 3,
    title: "Revenue doubled",
    quote: "revenue doubled",
  });
  expect(url).toContain("/api/wiki/factcheck/claim?page=Some%20Page");
  expect(url).toContain("&mode=sel");
  expect(url).toContain("&sel=the%20selected%20passage");
  expect(url).toContain("&ctx=A%20Heading");
  expect(url).toContain("&wiki=mimir");
  expect(url).toContain("&index=2&total=3");
  expect(url).toContain("&title=Revenue%20doubled");
  expect(url).toContain("&quote=revenue%20doubled");
});

test("buildClaimRetryUrl falls back to article mode when no sel was persisted", () => {
  const url = buildClaimRetryUrl({ page: "P", mode: "sel", index: 1, total: 1, title: "t" });
  expect(url).toContain("&mode=article");
  expect(url).not.toContain("&sel=");
});

test("claimRetryRunningCopy renders the 409's deadline", () => {
  const now = 1_000_000;
  expect(claimRetryRunningCopy(now + 120_000, now)).toContain("~2m left");
  expect(claimRetryRunningCopy(now - 1, now)).toContain("try again now");
  expect(claimRetryRunningCopy(undefined, now)).toBe("a retry for this page is still running.");
});

test("claimRetryBatchLabel is grammatical at 1 (the RUNNING bar renders run.total)", () => {
  expect(claimRetryBatchLabel(1)).toBe("↻ Retry 1 unverified claim");
  expect(claimRetryBatchLabel(3)).toBe("↻ Retry 3 unverified claims");
});

test("claimRetryUrlFor never falls back to the turn's question for the title", () => {
  // The fallback used to be `claim.title || turn.question`, and a fact-check turn's
  // question is the synthetic label `Fact check: <page>` — so an untitled claim
  // spent a 180s tool-enabled one-shot verifying the label as if it were the claim.
  const url = claimRetryUrlFor(
    { page: "P", fcMode: "article" },
    { index: 2, total: 3, title: "", verdict: "❓", outcome: "timeout" },
    "mimir",
  );
  expect(url).toContain("&title=" + encodeURIComponent("(untitled claim)"));
  expect(url).not.toContain("Fact%20check");
  // …and it threads the same mode/sel/ctx the two hand-copied argument objects did.
  const sel = claimRetryUrlFor(
    { page: "P", fcMode: "sel", fcSel: "a passage", fcCtx: "A Heading" },
    { index: 1, total: 2, title: "T", verdict: "❓", outcome: "timeout", quote: "q" },
  );
  expect(sel).toContain("&mode=sel");
  expect(sel).toContain("&sel=a%20passage");
  expect(sel).toContain("&ctx=A%20Heading");
  expect(sel).toContain("&quote=q");
  expect(sel).not.toContain("&wiki=");
});

// ── fence awareness + extent parity (the shared line-walk) ────────────

/** A verdict block that QUOTES a claim heading inside a fenced code block —
 *  models do this when restating what they were asked to check. */
const WITH_FENCE = [
  LEDE,
  "",
  "### ✅ Claim 1/3 — Ships worldwide",
  "",
  "I was asked to check:",
  "",
  "```",
  "### ❓ Claim 2/3 — Revenue doubled",
  "```",
  "",
  "Confirmed by the filing.",
  "",
  "### ❓ Claim 2/3 — Revenue doubled",
  "",
  "Verification timed out after 110s.",
  "",
  "### ❌ Claim 3/3 — Founded in 1990",
  "",
  "The company was founded in 1994.",
].join("\n");

test("a claim heading quoted inside a fence is not a claim", () => {
  expect(parseFactcheckClaims(WITH_FENCE).map((c) => c.index)).toEqual([1, 2, 3]);
  // Claim 1's block keeps the whole fence, closing marker included.
  expect(parseFactcheckClaims(WITH_FENCE)[0]!.block).toContain("```\n### ❓ Claim 2/3");
});

test("spliceClaimBlock targets the REAL heading, not the one quoted in a fence", () => {
  const out = spliceClaimBlock(WITH_FENCE, 2, RETRIED_BLOCK)!;
  // The fence survives intact — the old splicer started inside it and ate the
  // closing ```, rendering the rest of the answer as one code block.
  expect(out).toContain("```\n### ❓ Claim 2/3 — Revenue doubled\n```");
  expect((out.match(/```/g) || []).length).toBe(2);
  expect(out).toContain("The 2025 filing reports revenue up 104%.");
  expect(out).not.toContain("Verification timed out");
  expect(out).toContain("Confirmed by the filing.");
  expect(parseFactcheckClaims(out).map((c) => c.index)).toEqual([1, 2, 3]);
});

test("a #### sub-heading is CONTENT, not the end of the block (extent parity)", () => {
  const withSub = [
    LEDE,
    "",
    "### ❓ Claim 1/2 — First",
    "",
    "#### Why this is hard",
    "",
    "STALE TAIL that must not survive a splice.",
    "",
    "### ✅ Claim 2/2 — Second",
    "",
    "ok",
  ].join("\n");
  // The parser has always treated it as content; the splicer used to stop there.
  expect(parseFactcheckClaims(withSub)[0]!.block).toContain("STALE TAIL");
  const out = spliceClaimBlock(withSub, 1, "### ✅ Claim 1/2 — First\n\nFresh verdict.")!;
  expect(out).not.toContain("STALE TAIL");
  expect(out).not.toContain("#### Why this is hard");
  expect(out).toContain("### ✅ Claim 2/2 — Second");
});

test("retryableClaims skips a DUPLICATED index — ambiguous, not retryable", () => {
  const dup = [
    LEDE,
    "",
    "### ❓ Claim 1/2 — First",
    "",
    "timed out",
    "",
    "### ❓ Claim 1/2 — First, again",
    "",
    "timed out too",
    "",
    "### ❓ Claim 2/2 — Second",
    "",
    "timed out",
  ].join("\n");
  expect(parseFactcheckClaims(dup)).toHaveLength(3);
  // Claim 1 appears twice: no single block a retry could replace, and the batch
  // would otherwise launch it twice.
  expect(retryableClaims(dup, { 1: "timeout", 2: "timeout" }).map((c) => c.index)).toEqual([2]);
});

test("spliceClaimBlock refuses a block whose heading names a DIFFERENT claim", () => {
  // A model answering `Claim 2/3` for a retry of claim 3 would create a
  // duplicate-index answer and retire the wrong ↻.
  expect(spliceClaimBlock(MULTI, 3, RETRIED_BLOCK)).toBeNull();
  // …and a reply with no claim heading at all destroys the anchor everything
  // downstream reads.
  expect(spliceClaimBlock(MULTI, 2, "Just some prose, no heading.")).toBeNull();
});

test("claimBlockIndex reads the block's own claim index", () => {
  expect(claimBlockIndex(RETRIED_BLOCK)).toBe(2);
  expect(claimBlockIndex("no heading here")).toBeNull();
  expect(claimBlockIndex("```\n### ✅ Claim 2/3 — quoted\n```")).toBeNull();
});

test("claimRefFromHeadingText is ANCHORED — prose mentioning a claim gets no ↻", () => {
  expect(claimRefFromHeadingText("Revisiting claim 2/3 later")).toBeNull();
  expect(claimRefFromHeadingText("Appendix: Claim 1/2 notes")).toBeNull();
  // The real shapes still match.
  expect(claimRefFromHeadingText("Claim 2/3")).toEqual({ index: 2, total: 3 });
  expect(claimRefFromHeadingText("  ❌️ Claim 2/3 — Revenue")).toEqual({ index: 2, total: 3 });
});

test("appendLedeAmendment matches and preserves a blockquote lede's prefix", () => {
  const quoted = [
    "> Overall: two of the three claims hold up.",
    "> _Claim 2 was re-checked after the initial run._",
    "",
    "### ✅ Claim 1/3 — Ships worldwide",
    "",
    "ok",
    "",
    "### ❓ Claim 2/3 — Revenue doubled",
    "",
    "timed out",
  ].join("\n");
  const out = appendLedeAmendment(quoted, 3);
  // Accumulated into the existing sentence rather than stacking a second one…
  expect(out.match(/re-checked after the initial run/g)).toHaveLength(1);
  expect(out).toContain("_Claims 2 and 3 were re-checked after the initial run._");
  // …and it stayed inside the blockquote it belonged to.
  expect(out).toContain("> _Claims 2 and 3 were re-checked after the initial run._");
});
