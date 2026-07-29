/**
 * ACCEPTANCE 2 of the fact-check annotation slice — wrapper placement, asserted
 * STRUCTURALLY against a pinned real-world triple:
 *
 *   1. `factcheck-creatine-original.mdx` — the creatine page's PRE-annotation prose
 *      (the live huginn-jarvis page with its persisted fact-check block stripped and
 *      the two corrected sentences restored from the approved fixture's `Was:` lines).
 *   2. `factcheck-creatine-answer.md`    — the persisted fact-check answer whose
 *      appendix the human approved (lede + 8 claim blocks in claim order).
 *   3. `factcheck-creatine-quotes.json`  — the per-claim quotes from ONE REAL Phase-1
 *      extraction over (1), pinned verbatim.
 *
 * The assertions are structural on purpose. The approved fixture's anchors are
 * HAND-PICKED fragments while the real extractor returns whole sentences and, for
 * three of eight claims, shapes that cannot resolve at all (an elided quote, two
 * table-cell fragments). So the wrapper SPANS legitimately differ from the approved
 * page — what must hold is that every mark carries the right claim number and
 * verdict, that nothing nests, that no multi-line span is spliced inline, and that
 * every quote the run could not place appears in `dropped` with an honest reason.
 *
 * The corrections are canned rather than model-generated: this file must not spend a
 * 90s one-shot, and the correction TEXT is not what is under test — its interaction
 * with the wrapper pass is.
 */

import { test, expect } from "bun:test";
import {
  annotateEdits,
  applyEdits,
  countFactWrappers,
  originalsOfOutcomes,
  stripFactWrappers,
  INTEGRATE_MAX_EDIT_CHARS,
  type IntegrateEdit,
} from "./integrate-edits.ts";
import { annotatedMaxEdits } from "./integrate-edits.ts";
import { buildFactcheckAppendix } from "./factcheck-context.ts";
import { CREATINE_ORIGINALS } from "./__fixtures__/factcheck-creatine-originals.ts";
import {
  isWrapperOnlyEdit,
  parseFactcheckClaims,
  type ClaimQuote,
} from "../dashboard/views/components/wiki-integrate.ts";

const ORIGINAL = await Bun.file(
  new URL("./__fixtures__/factcheck-creatine-original.mdx", import.meta.url),
).text();
const ANSWER = await Bun.file(
  new URL("./__fixtures__/factcheck-creatine-answer.md", import.meta.url),
).text();
const PINNED = (await Bun.file(
  new URL("./__fixtures__/factcheck-creatine-quotes.json", import.meta.url),
).json()) as { quotes: ClaimQuote[] };

/** The two corrections the approved fixture's `Was:` → prose pairs imply. The `old`
 *  side IS the shared `Was:` fixture — one transcription of each. */
const CORRECTIONS: IntegrateEdit[] = [
  {
    claimIndex: 4,
    verdict: "❌",
    old: CREATINE_ORIGINALS.get(4)!,
    new: "A mean **1.32 kg** of additional lean muscle mass gained versus resistance training alone (95% CI 0.93–1.72).",
    reason: "The pooled meta-analytic estimate is 1.32 kg.",
  },
  {
    claimIndex: 7,
    verdict: "⚠️",
    old: CREATINE_ORIGINALS.get(7)!,
    new: "Notably, maintenance dosing (3–5g/day) is widely endorsed for cognitive benefit in older adults, but the evidence does not establish that it outperforms loading — observed cognitive effects did not depend on dose.",
    reason: "No dosing strategy is established as superior for cognition.",
  },
];

const CLAIMS = parseFactcheckClaims(ANSWER);
const MAX_EDITS = annotatedMaxEdits(true);

function run() {
  const body = stripFactWrappers(ORIGINAL);
  const annotation = annotateEdits({
    body,
    isMdx: true,
    corrections: CORRECTIONS,
    claims: CLAIMS,
    quotes: PINNED.quotes,
    maxEdits: MAX_EDITS,
    maxEditChars: INTEGRATE_MAX_EDIT_CHARS,
  });
  const applied = applyEdits(body, annotation.edits, true);
  return { body, annotation, applied };
}

test("the pinned fixtures agree with each other", () => {
  // Eight claims, one ❌ (4) and one ⚠️ (7), and every claim carries a quote.
  expect(CLAIMS).toHaveLength(8);
  expect(CLAIMS.filter((c) => c.verdict === "❌").map((c) => c.index)).toEqual([4]);
  expect(CLAIMS.filter((c) => c.verdict === "⚠️").map((c) => c.index)).toEqual([7]);
  expect(PINNED.quotes.map((q) => q.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  // The original page carries the PRE-correction prose for both corrected claims.
  for (const c of CORRECTIONS) expect(ORIGINAL).toContain(c.old);
  expect(countFactWrappers(ORIGINAL)).toBe(0);
});

test("every mark carries the right claim number and verdict", () => {
  const { annotation, applied } = run();
  expect(applied.appliedCount).toBe(annotation.edits.length);

  const marks = [...applied.body.matchAll(/<Fact n="(\d+)" v="(ok|warn|bad|unknown)">/g)].map((m) => ({
    n: Number(m[1]),
    v: m[2],
  }));
  const wantVerdict: Record<number, string> = { 1: "ok", 2: "ok", 3: "ok", 4: "bad", 7: "warn" };
  for (const mark of marks) expect(mark.v).toBe(wantVerdict[mark.n]!);
  // The two corrections are marked (they always are — their span is rewritten in
  // place), plus the ✅ claims whose real quote actually resolved.
  expect(marks.map((m) => m.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 7]);
});

test("exactly ONE mark per resolvable claim, and no nesting", () => {
  const { applied } = run();
  const ns = [...applied.body.matchAll(/<Fact n="(\d+)"/g)].map((m) => m[1]);
  expect(new Set(ns).size).toBe(ns.length);
  expect(applied.body).not.toMatch(/<Fact\b[^>]*>(?:(?!<\/Fact>)[\s\S])*?<Fact\b/);
  // Opening and closing tags balance.
  expect(countFactWrappers(applied.body)).toBe(
    (applied.body.match(/<\/Fact>/g) ?? []).length,
  );
});

test("no multi-line span is ever spliced INLINE", () => {
  const { applied } = run();
  // An inline mark (open tag not alone on its line) must not cross a newline.
  for (const m of applied.body.matchAll(/<Fact n="\d+" v="[a-z]+">([\s\S]*?)<\/Fact>/g)) {
    const inner = m[1]!;
    if (!inner.startsWith("\n")) expect(inner).not.toContain("\n");
    else expect(inner.endsWith("\n")).toBe(true); // the legal BLOCK form
  }
});

test("every quote the run could not place is in `dropped` with a reason", () => {
  const { annotation } = run();
  // Claims 5, 6 and 8 are the honest drops the real extractor produced:
  //  5 — an ELIDED quote ("… …" joining two sentences) that exists nowhere verbatim,
  //  6 — a table-cell fragment stitched with an ellipsis,
  //  8 — the body's `"buffered"` typographic quotes against the extractor's `'…'`.
  const dropped = annotation.dropped.filter((d) => d.edit.verdict === "✅");
  expect(dropped.map((d) => d.edit.claimIndex).sort((a, b) => a - b)).toEqual([5, 6, 8]);
  for (const d of dropped) {
    expect(d.reason).toBeTruthy();
    expect(d.reason).not.toBe("");
  }
  // Nothing is dropped without a reason anywhere in the run.
  for (const d of annotation.dropped) expect(d.reason.length).toBeGreaterThan(0);
});

test("the write is a pure overlay — stripping it returns the corrected prose", () => {
  const { body, applied } = run();
  let expected = body;
  for (const c of CORRECTIONS) expected = expected.replace(c.old, c.new);
  expect(stripFactWrappers(applied.body)).toBe(expected);
});

test("the marks and the appendix agree on which claims exist", () => {
  const { applied } = run();
  // PROD's own source for the `Was:` lines: the freshly-resolved apply outcomes.
  const originals = originalsOfOutcomes(applied.outcomes);
  const appendix = buildFactcheckAppendix(ANSWER, "2026-07-29", { originals });
  // Every chip has a claim section to link to.
  for (const m of applied.body.matchAll(/<Fact n="(\d+)"/g)) {
    expect(appendix).toContain(`Claim ${m[1]}/8`);
  }
  // The corrected claims' `Was:` lines carry this run's own pre-edit text.
  expect(originals.get(4)).toBe(CORRECTIONS[0]!.old);
  expect(originals.get(7)).toBe(CORRECTIONS[1]!.old);
  expect(appendix).toContain("Was: " + CORRECTIONS[0]!.old);
});

test("the whole run fits inside the annotated caps", () => {
  const { annotation, applied } = run();
  expect(annotation.edits.length).toBeLessThanOrEqual(MAX_EDITS);
  for (const e of annotation.edits) {
    expect(e.new.length).toBeLessThanOrEqual(INTEGRATE_MAX_EDIT_CHARS);
    expect(e.old.length).toBeLessThanOrEqual(INTEGRATE_MAX_EDIT_CHARS);
  }
  // The marks are free, so the run's cost is the corrections alone.
  const wrapperOnly = applied.outcomes.filter((o) => isWrapperOnlyEdit(o.edit, o.resolvedText));
  expect(wrapperOnly.length).toBe(3);
});
