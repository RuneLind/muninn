import { test, expect } from "bun:test";
import {
  appendLedeAmendment,
  claimOutcomeMapFromRows,
  buildClaimRetryUrl,
  claimBlockIndex,
  claimCountFromMap,
  claimRefFromHeadingText,
  claimRetryBatchLabel,
  claimRetryDoneCopy,
  claimRetryRunningCopy,
  claimRetryStoppedCopy,
  claimRetryUrlFor,
  isRetryableOutcome,
  outcomeCountsFromMap,
  renumberClaimBlockHeading,
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

// ── renumbered headings are CORRECTED, not thrown away (defect A4) ────

test("spliceClaimBlock RENUMBERS a block whose heading drifted, and splices it", () => {
  // The route accepts a renumbered heading on purpose (`isClaimVerdictBlock` calls
  // it a formatting wobble rather than a wrong claim, because refusing it discards
  // a completed 180s verification). The client refusing it moved that loss to the
  // last hop. It is rewritten to the claim that was ASKED about, keeping the
  // verdict emoji and the title as returned.
  const out = spliceClaimBlock(MULTI, 3, "### ✅ Claim 1/1 — Founded in 1994\n\nCorrected.")!;
  expect(out).toContain("### ✅ Claim 3/3 — Founded in 1994");
  expect(out).not.toContain("Claim 1/1");
  expect(out).toContain("Corrected.");
  // No duplicate index, siblings untouched, still three claims in order.
  expect(parseFactcheckClaims(out).map((c) => c.index)).toEqual([1, 2, 3]);
  expect(parseFactcheckClaims(out).map((c) => c.verdict)).toEqual(["✅", "❓", "✅"]);
  // `m` comes from the block being REPLACED, so the heading stays in step with the
  // siblings even when the model renumbered both halves.
  expect(spliceClaimBlock(MULTI, 2, "### ⚠️ claim 5 / 9 — Revenue")!).toContain(
    "### ⚠️ claim 2 / 3 — Revenue",
  );
});

test("renumberClaimBlockHeading rewrites only the numbers", () => {
  expect(renumberClaimBlockHeading("### ✅ Claim 1/1 — Title\n\nBody.", 3, 4)).toBe(
    "### ✅ Claim 3/4 — Title\n\nBody.",
  );
  // Spelling and spacing survive; a block with no claim heading is refused.
  expect(renumberClaimBlockHeading("### ❓ claim 5 / 9 — T", 2, 3)).toBe("### ❓ claim 2 / 3 — T");
  expect(renumberClaimBlockHeading("Just prose.", 1, 1)).toBeNull();
});

test("spliceClaimBlock still refuses a block with NO claim heading at all", () => {
  // Without the `### <emoji> Claim n/m` anchor everything downstream stops seeing
  // the claim — there is nothing to renumber.
  expect(spliceClaimBlock(MULTI, 2, "Just some prose, no heading.")).toBeNull();
  // A heading only visible inside a fence is not an anchor either.
  expect(spliceClaimBlock(MULTI, 2, "```\n### ✅ Claim 2/3 — quoted\n```")).toBeNull();
});

// ── post-splice invariant guard (defect A1) ───────────────────────────

/** A fence that OPENS inside claim 1's block and CLOSES after claim 2's heading.
 *  The heading is masked, so the extent scan runs straight through it and the
 *  splice would replace both claims with one — deleting claim 2 from an answer
 *  ➕/integrate then commit to the wiki page. The pre-adc4063 fence-blind splicer
 *  stopped at the first `###` and kept claim 2. */
const MASKED_SIBLING = [
  LEDE,
  "",
  "### ❓ Claim 1/2 — First",
  "",
  "Here is what a verdict looks like:",
  "",
  "```md",
  "some sample",
  "",
  "### ✅ Claim 2/2 — Second",
  "",
  "ok",
  "```",
  "",
  "Verification timed out after 110s.",
].join("\n");

test("the invariant guard REFUSES a splice that would delete a masked sibling", () => {
  // The parse itself cannot see claim 2 (it is inside a fence), which is exactly
  // why the guard is a line-SHAPE check and not a parse comparison.
  expect(parseFactcheckClaims(MASKED_SIBLING).map((c) => c.index)).toEqual([1]);
  expect(spliceClaimBlock(MASKED_SIBLING, 1, "### ✅ Claim 1/2 — First\n\nFresh verdict.")).toBeNull();
});

test("the guard refuses any region carrying a fence delimiter", () => {
  // A retryable claim's block is a one-line synthetic stub — timed out / skipped /
  // errored — so a fence inside the region means the extent is not trustworthy.
  // Costing a failed retry is the deliberate trade against a corrupted answer.
  const fencedRegion = [
    LEDE,
    "",
    "### ❓ Claim 1/2 — First",
    "",
    "```",
    "quoted",
    "```",
    "",
    "timed out",
    "",
    "### ✅ Claim 2/2 — Second",
    "",
    "ok",
  ].join("\n");
  expect(spliceClaimBlock(fencedRegion, 1, "### ✅ Claim 1/2 — First\n\nFresh.")).toBeNull();
  // The sibling whose block is clean still splices.
  expect(spliceClaimBlock(fencedRegion, 2, "### ⚠️ Claim 2/2 — Second\n\nHedged.")).not.toBeNull();
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

// ── the amendment can never land mid-answer (defect A3) ───────────────

test("appendLedeAmendment lands ABOVE claim 1 when a pseudo-fence sits in the lede", () => {
  // The failure: a stray ``` in the lede masked claim 1's heading, so the "first
  // claim heading" was claim 2's — and the amendment was inserted BETWEEN the two
  // verdict blocks, in an answer ➕/integrate commit to the wiki page.
  const strayFence = [
    LEDE,
    "",
    "```unclosed",
    "",
    "### ❓ Claim 1/2 — First",
    "",
    "timed out",
    "",
    "### ❓ Claim 2/2 — Second",
    "",
    "timed out",
  ].join("\n");
  const out = appendLedeAmendment(strayFence, 2);
  expect(out).toContain("_Claim 2 was re-checked after the initial run._");
  expect(out.indexOf("_Claim 2 was")).toBeLessThan(out.indexOf("### ❓ Claim 1/2"));
});

test("appendLedeAmendment NEVER changes the claim set (the invariant guard)", () => {
  // Belt-and-braces backstop: the amendment is a lede edit by definition, so if the
  // rewrite moved any claim block the answer is returned untouched. A missing
  // amendment is cosmetic; a mid-answer one is durable corruption.
  for (const src of [MULTI, WITH_FENCE, appendLedeAmendment(MULTI, 2)]) {
    const before = parseFactcheckClaims(src);
    const after = parseFactcheckClaims(appendLedeAmendment(src, 3));
    expect(after.map((c) => c.index)).toEqual(before.map((c) => c.index));
    expect(after.map((c) => c.block)).toEqual(before.map((c) => c.block));
  }
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

// ── batch lifecycle copy ──────────────────────────────────────────────

test("a STOPPED batch does not report itself as a completed one", () => {
  // A batch broken by a turn switch / a navigation / a mid-run ➕ or ✎ rendered
  // "Re-checked 1 of 4", which reads as a finished run whose other three claims
  // were unfixable.
  expect(claimRetryDoneCopy(1, 4)).toBe("Re-checked 1 of 4");
  expect(claimRetryStoppedCopy("switched", 1, 4)).toBe(
    "Stopped after 1 of 4 — you opened another answer.",
  );
  expect(claimRetryStoppedCopy("navigated", 0, 3)).toBe(
    "Stopped after 0 of 3 — you left this page.",
  );
  expect(claimRetryStoppedCopy("wrote", 2, 3)).toBe(
    "Stopped after 2 of 3 — the article was written from this answer.",
  );
  for (const reason of ["switched", "navigated", "wrote"] as const) {
    expect(claimRetryStoppedCopy(reason, 1, 4)).not.toBe(claimRetryDoneCopy(1, 4));
  }
});
