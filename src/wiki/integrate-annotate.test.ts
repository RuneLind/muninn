/**
 * The inline `<Fact>` annotation pass — the write half of the fact-check
 * annotation feature (`annotateEdits` + the strip + the wrapper-only predicate).
 *
 * Kept in its own file rather than appended to `integrate-edits.test.ts`: that
 * file is the regression gate for the pre-annotation engine and must stay
 * readable as such.
 */

import { test, expect, describe } from "bun:test";
import {
  annotateEdits,
  applyEdits,
  changedCharsOfOutcomes,
  countFactWrappers,
  enforceChangeBudget,
  maxChangedChars,
  originalsOfOutcomes,
  outcomeChangedChars,
  stripFactWrappers,
  type IntegrateEdit,
} from "./integrate-edits.ts";
import {
  editChangedChars,
  factWrapperForms,
  isWrapperOnlyEdit,
  type FactcheckClaimAnchor,
} from "../dashboard/views/components/wiki-integrate.ts";

const anchor = (index: number, verdict: string): FactcheckClaimAnchor => ({
  index,
  verdict,
  title: "claim " + index,
  block: `### ${verdict} Claim ${index}/9 — claim ${index}`,
});

const correction = (over: Partial<IntegrateEdit> = {}): IntegrateEdit => ({
  claimIndex: 1,
  verdict: "❌",
  old: "",
  new: "",
  reason: "because",
  ...over,
});

function annotate(over: Partial<Parameters<typeof annotateEdits>[0]>) {
  return annotateEdits({
    body: "",
    isMdx: true,
    corrections: [],
    claims: [],
    quotes: [],
    maxEdits: 20,
    maxEditChars: 2000,
    ...over,
  });
}

// ── strip ────────────────────────────────────────────────────────────────────

describe("stripFactWrappers", () => {
  test("keeps the wrapped prose byte-for-byte, inline form", () => {
    const body = 'Creatine is <Fact n="2" v="ok">made from three amino acids</Fact> in the liver.';
    expect(stripFactWrappers(body)).toBe("Creatine is made from three amino acids in the liver.");
  });

  test("removes a BLOCK form's tag lines whole, not just the tags", () => {
    const body = ["Intro.", "", '<Fact n="7" v="warn">', "The dosing claim.", "</Fact>", "", "Tail."].join("\n");
    // Leaving the (now empty) tag lines behind would split the wrapped paragraph.
    expect(stripFactWrappers(body)).toBe(["Intro.", "", "The dosing claim.", "", "Tail."].join("\n"));
  });

  test("leaves the sibling FactCheck component alone", () => {
    const body = '<FactCheck date="2026-07-29" ok="2">\n\n### ✅ Claim 1/2 — x\n</FactCheck>';
    expect(stripFactWrappers(body)).toBe(body);
  });

  test("strips an orphan closing tag (a hand-edit, a truncated write)", () => {
    expect(stripFactWrappers("Prose.</Fact>")).toBe("Prose.");
  });

  test("is idempotent, and counts what it is about to supersede", () => {
    const body = 'a <Fact n="1" v="ok">b</Fact> c <Fact n="2" v="bad">d</Fact>';
    expect(countFactWrappers(body)).toBe(2);
    const once = stripFactWrappers(body);
    expect(stripFactWrappers(once)).toBe(once);
    expect(countFactWrappers(once)).toBe(0);
  });
});

// ── the wrapper-only predicate, at all three measuring sites ─────────────────

describe("isWrapperOnlyEdit", () => {
  test("recognizes the INLINE form", () => {
    const [inline] = factWrapperForms(3, "ok", "the marked span");
    expect(isWrapperOnlyEdit({ claimIndex: 3, verdict: "✅", new: inline }, "the marked span")).toBe(true);
  });

  test("recognizes the BLOCK form", () => {
    const [, block] = factWrapperForms(3, "ok", "the marked paragraph");
    expect(isWrapperOnlyEdit({ claimIndex: 3, verdict: "✅", new: block }, "the marked paragraph")).toBe(
      true,
    );
  });

  test("rejects a wrapper around DIFFERENT text — a rewrite is not an annotation", () => {
    const [inline] = factWrapperForms(3, "ok", "the corrected span");
    expect(isWrapperOnlyEdit({ claimIndex: 3, verdict: "❌", new: inline }, "the original span")).toBe(
      false,
    );
  });

  test("rejects a mismatched claim number or verdict — a client cannot claim the carve-out", () => {
    const [inline] = factWrapperForms(3, "ok", "span");
    expect(isWrapperOnlyEdit({ claimIndex: 4, verdict: "✅", new: inline }, "span")).toBe(false);
    expect(isWrapperOnlyEdit({ claimIndex: 3, verdict: "❌", new: inline }, "span")).toBe(false);
  });

  test("all three budget authorities score a wrapper-only edit at 0", () => {
    const span = "A long confirmed sentence that would otherwise cost its full length.";
    const body = "Intro paragraph.\n\n" + span + "\n\nTail paragraph.\n";
    const [inline] = factWrapperForms(1, "ok", span);
    const e = correction({ claimIndex: 1, verdict: "✅", old: span, new: inline });

    // 1. the engine's per-outcome measure
    const r = applyEdits(body, [e], true);
    expect(r.appliedCount).toBe(1);
    expect(outcomeChangedChars(r.outcomes[0]!)).toBe(0);
    // 2. the propose/apply total (the same number `enforceChangeBudget` gates on)
    expect(changedCharsOfOutcomes(r.outcomes)).toBe(0);
    const budget = enforceChangeBudget(r.outcomes, body.length);
    expect(budget.dropped).toHaveLength(0);
    expect(budget.changedChars).toBe(0);
    // 3. the client's mirror
    expect(editChangedChars({ ...e, resolvedText: span })).toBe(0);
  });

  test("BLOCK form is scored at 0 at all three sites too", () => {
    const span = "A whole confirmed paragraph.";
    const body = "Intro.\n\n" + span + "\n\nTail.\n";
    const [, block] = factWrapperForms(1, "ok", span);
    const e = correction({ claimIndex: 1, verdict: "✅", old: span, new: block });
    const r = applyEdits(body, [e], true);
    expect(outcomeChangedChars(r.outcomes[0]!)).toBe(0);
    expect(changedCharsOfOutcomes(r.outcomes)).toBe(0);
    expect(editChangedChars({ ...e, resolvedText: span })).toBe(0);
  });
});

// ── two-pass overlap: corrections claim their spans first ────────────────────

test("a ✅ wrapper overlapping a ❌ correction is dropped — the correction survives", () => {
  // The ✅ quote starts EARLIER in the body than the correction's anchor, which is
  // exactly the case position-ordered overlap rejection would resolve the wrong way.
  const body = "The device ships 4M units per year in total.\n";
  const r = annotate({
    body,
    corrections: [correction({ claimIndex: 2, verdict: "❌", old: "ships 4M units", new: "ships 2.1M units" })],
    claims: [anchor(1, "✅"), anchor(2, "❌")],
    quotes: [{ index: 1, quote: "The device ships 4M units per year" }],
  });
  // The correction is present and Fact-wrapped; the wrapper-only mark is gone.
  expect(r.edits).toHaveLength(1);
  expect(r.edits[0]!.claimIndex).toBe(2);
  expect(r.edits[0]!.new).toBe('<Fact n="2" v="bad">ships 2.1M units</Fact>');
  expect(r.dropped.map((d) => d.reason)).toContain("overlaps a correction — the correction wins");
  // …and it really applies, which is the point of resolving corrections first.
  const applied = applyEdits(body, r.edits, true);
  expect(applied.appliedCount).toBe(1);
  expect(applied.body).toContain('<Fact n="2" v="bad">ships 2.1M units</Fact>');
});

test("one chip per claim: only the FIRST accepted edit for a claim is wrapped", () => {
  const body = "Alpha sentence here. Beta sentence here.\n";
  const r = annotate({
    body,
    corrections: [
      correction({ claimIndex: 1, old: "Alpha sentence", new: "Alpha corrected" }),
      correction({ claimIndex: 1, old: "Beta sentence", new: "Beta corrected" }),
    ],
    claims: [anchor(1, "❌")],
  });
  expect(r.edits).toHaveLength(2);
  expect(r.edits[0]!.new).toBe('<Fact n="1" v="bad">Alpha corrected</Fact>');
  expect(r.edits[1]!.new).toBe("Beta corrected");
});

test("❓ claims get NO wrapper — they are counted, never marked", () => {
  const body = "An unverifiable assertion sits here.\n";
  const r = annotate({
    body,
    claims: [anchor(1, "❓")],
    quotes: [{ index: 1, quote: "An unverifiable assertion" }],
  });
  expect(r.edits).toHaveLength(0);
});

test("a ✅ claim's quote becomes a wrapper-only edit over the resolved span", () => {
  const body = "Creatine is synthesized from three amino acids in the liver.\n";
  const r = annotate({
    body,
    claims: [anchor(1, "✅")],
    quotes: [{ index: 1, quote: "synthesized from three amino acids" }],
  });
  expect(r.edits).toHaveLength(1);
  expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">synthesized from three amino acids</Fact>');
  const out = applyEdits(body, r.edits, true).outcomes[0]!;
  expect(isWrapperOnlyEdit(out.edit, out.resolvedText)).toBe(true);
});

// ── newline tiers ────────────────────────────────────────────────────────────

describe("newline guard", () => {
  test("tier 1: a whole-paragraph span takes the BLOCK form", () => {
    const para = "First line of the paragraph\nwraps onto a second line.";
    const body = "Intro.\n\n" + para + "\n\nTail.\n";
    const r = annotate({
      body,
      claims: [anchor(1, "✅")],
      quotes: [{ index: 1, quote: para }],
    });
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">\n' + para + "\n</Fact>");
    // …and it renders as a real component, not escaped literal tags.
    const spliced = applyEdits(body, r.edits, true).body;
    expect(spliced).toContain('\n<Fact n="1" v="ok">\n');
    expect(spliced).toContain("\n</Fact>\n");
  });

  test("tier 2: a mid-line two-bullet span is TRIMMED to one newline-free line", () => {
    const body = ["Intro.", "", "- First bullet item.", "- Second bullet item.", "", "Tail.", ""].join("\n");
    const r = annotate({
      body,
      claims: [anchor(1, "✅")],
      quotes: [{ index: 1, quote: "First bullet item.\n- Second bullet item." }],
    });
    expect(r.edits).toHaveLength(1);
    const marked = r.edits[0]!.new;
    expect(marked).not.toContain("\n");
    // The longest run wins, and its `- ` list marker stays OUTSIDE the mark.
    expect(marked).toBe('<Fact n="1" v="ok">Second bullet item.</Fact>');
    expect(r.edits[0]!.reason).toContain("trimmed to one line");
  });

  test("tier 3: nothing markable on any line ⇒ dropped with an honest reason", () => {
    const body = "Intro.\n\n|   |   |\n|---|---|\n\nTail.\n";
    const r = annotate({
      body,
      claims: [anchor(1, "✅")],
      // Resolves (uniquely) but every line in the span is table scaffolding the
      // trim reduces to nothing markable.
      quotes: [{ index: 1, quote: "\n\n\n" }],
    });
    expect(r.edits).toHaveLength(0);
    expect(r.dropped).not.toHaveLength(0);
  });

  test("a CORRECTION whose replacement spans blocks applies UNWRAPPED, never dropped", () => {
    const body = "Intro.\n\nThe single claim sentence.\n\nTail.\n";
    const r = annotate({
      body,
      corrections: [
        correction({ claimIndex: 1, old: "The single claim sentence.", new: "Line one.\n\nLine two." }),
      ],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.new).toBe("Line one.\n\nLine two.");
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("the correction itself still applies");
  });
});

// ── caps ─────────────────────────────────────────────────────────────────────

test("over-cap MARKS are trimmed, never corrections", () => {
  const body = "one two three four five six seven eight nine ten.\n";
  const r = annotate({
    body,
    corrections: [correction({ claimIndex: 1, old: "one", new: "ONE" })],
    claims: [anchor(1, "❌"), anchor(2, "✅"), anchor(3, "✅")],
    quotes: [
      { index: 2, quote: "three" },
      { index: 3, quote: "five" },
    ],
    maxEdits: 2,
  });
  expect(r.edits).toHaveLength(2);
  expect(r.edits[0]!.claimIndex).toBe(1); // the correction always survives
  expect(r.dropped.map((d) => d.reason)).toContain("over the 2-edit cap for one integration");
});

test("a correction whose POST-wrapper `new` breaks the char cap is dropped outright", () => {
  const body = "The claim sentence.\n";
  const long = "x".repeat(60);
  const r = annotate({
    body,
    corrections: [correction({ claimIndex: 1, old: "The claim sentence.", new: long })],
    claims: [anchor(1, "❌")],
    maxEditChars: 70, // `long` fits; `long` + the ~28-char wrapper does not
  });
  expect(r.edits).toHaveLength(0);
  expect(r.dropped.map((d) => d.reason).join(" ")).toContain("exceeds 70 chars");
});

// ── `Was:` originals ─────────────────────────────────────────────────────────

test("originals carry the PRE-edit text per corrected claim", () => {
  const body = "The device ships 4M units per year.\n";
  const r = annotate({
    body,
    corrections: [correction({ claimIndex: 3, old: "ships 4M units", new: "ships 2.1M units" })],
    claims: [anchor(3, "❌")],
  });
  expect(r.originals.get(3)).toBe("ships 4M units");
  // …and re-derived at apply from the freshly-resolved outcomes.
  expect(originalsOfOutcomes(applyEdits(body, r.edits, true).outcomes).get(3)).toBe("ships 4M units");
});

test("originalsOfOutcomes excludes wrapper-only marks — a mark has no `was`", () => {
  const body = "A confirmed sentence.\n";
  const r = annotate({
    body,
    claims: [anchor(1, "✅")],
    quotes: [{ index: 1, quote: "A confirmed sentence." }],
  });
  expect(originalsOfOutcomes(applyEdits(body, r.edits, true).outcomes).size).toBe(0);
});

// ── re-run idempotency ───────────────────────────────────────────────────────

test("annotate → strip → re-annotate with a DIFFERENT claim set: stable, no nesting", () => {
  const original = "Alpha statement here. Beta statement here. Gamma statement here.\n";

  const run1 = annotate({
    body: stripFactWrappers(original),
    claims: [anchor(1, "✅"), anchor(2, "✅")],
    quotes: [
      { index: 1, quote: "Alpha statement" },
      { index: 2, quote: "Beta statement" },
    ],
  });
  const page1 = applyEdits(stripFactWrappers(original), run1.edits, true).body;
  expect(countFactWrappers(page1)).toBe(2);

  // A SECOND check with a different claim set: claim 1 is gone, claim 3 is new.
  const stripped = stripFactWrappers(page1);
  expect(stripped).toBe(original);
  expect(countFactWrappers(page1)).toBe(2); // what run 2 supersedes
  const run2 = annotate({
    body: stripped,
    claims: [anchor(2, "✅"), anchor(3, "✅")],
    quotes: [
      { index: 2, quote: "Beta statement" },
      { index: 3, quote: "Gamma statement" },
    ],
  });
  const page2 = applyEdits(stripped, run2.edits, true).body;

  expect(countFactWrappers(page2)).toBe(2);
  expect(page2).toContain('<Fact n="2" v="ok">Beta statement</Fact>');
  expect(page2).toContain('<Fact n="3" v="ok">Gamma statement</Fact>');
  // The retired claim's mark is gone, and nothing nested.
  expect(page2).not.toContain('n="1"');
  expect(page2).not.toMatch(/<Fact\b[^>]*>[^<]*<Fact\b/);
  // Stripping run 2's page returns the SAME original — the write is a pure overlay.
  expect(stripFactWrappers(page2)).toBe(original);

  // A third run over the same claim set reproduces run 2 byte-for-byte.
  const run3 = annotate({
    body: stripFactWrappers(page2),
    claims: [anchor(2, "✅"), anchor(3, "✅")],
    quotes: [
      { index: 2, quote: "Beta statement" },
      { index: 3, quote: "Gamma statement" },
    ],
  });
  expect(applyEdits(stripFactWrappers(page2), run3.edits, true).body).toBe(page2);
});

test("the budget still binds on real corrections when marks are free", () => {
  // Marks cost 0, so they must not make the ratio budget unenforceable.
  const body = "short page. " + "filler ".repeat(20) + "\n";
  const big = correction({ claimIndex: 1, old: "short page.", new: "x".repeat(9000) });
  const r = applyEdits(body, [big], true);
  const max = maxChangedChars(body.length);
  expect(changedCharsOfOutcomes(r.outcomes)).toBeGreaterThan(max);
  expect(enforceChangeBudget(r.outcomes, body.length).dropped).toHaveLength(1);
});
