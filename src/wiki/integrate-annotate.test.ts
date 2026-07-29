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

  test("leaves a tag inside a FENCED CODE BLOCK alone — it is documentation", () => {
    const body = [
      "How a mark is spelled:",
      "",
      "```mdx",
      '<Fact n="4" v="bad">the corrected passage</Fact>',
      "```",
      "",
      'And <Fact n="1" v="ok">this real mark</Fact> is prose.',
    ].join("\n");
    const out = stripFactWrappers(body);
    // The fenced example survives byte-for-byte; only the real mark comes off.
    expect(out).toContain('<Fact n="4" v="bad">the corrected passage</Fact>');
    expect(out).toContain("And this real mark is prose.");
    // …and the counter agrees with the strip, so no phantom supersede is reported.
    expect(countFactWrappers(body)).toBe(1);
    // A ~~~ fence and an info-string fence are the same case.
    const tilde = ["~~~", '<Fact n="2" v="ok">x</Fact>', "~~~"].join("\n");
    expect(stripFactWrappers(tilde)).toBe(tilde);
    expect(countFactWrappers(tilde)).toBe(0);
  });

  test("leaves a tag inside an INLINE code span alone", () => {
    const body = 'The `<Fact n="4" v="bad">` tag opens a mark; <Fact n="4" v="bad">this</Fact> is one.';
    expect(stripFactWrappers(body)).toBe(
      'The `<Fact n="4" v="bad">` tag opens a mark; this is one.',
    );
    expect(countFactWrappers(body)).toBe(1);
    // An UNCLOSED backtick is not a code span — the tag after it really strips.
    expect(stripFactWrappers('a ` b <Fact n="1" v="ok">c</Fact>')).toBe("a ` b c");
  });

  test("leaves a tag inside FRONTMATTER alone", () => {
    const body = [
      "---",
      "title: How the annotation write path works",
      'summary: emits <Fact n="1" v="ok">…</Fact> pairs',
      "---",
      "",
      'Body <Fact n="1" v="ok">mark</Fact>.',
    ].join("\n");
    const out = stripFactWrappers(body);
    expect(out).toContain('summary: emits <Fact n="1" v="ok">…</Fact> pairs');
    expect(out).toContain("Body mark.");
    expect(countFactWrappers(body)).toBe(1);
  });

  test("a page that is ALL documentation survives a strip untouched", () => {
    // The regression this guards: one integrate on the plan page documenting this
    // feature used to silently delete every tag out of its own code samples.
    const body = [
      "---",
      "title: Plan",
      "---",
      "",
      "The pair:",
      "",
      "```md",
      '<Fact n="4" v="bad">passage</Fact>',
      "</Fact>",
      "```",
      "",
      'Inline: `<Fact n="4" v="bad">`.',
      "",
    ].join("\n");
    expect(stripFactWrappers(body)).toBe(body);
    expect(countFactWrappers(body)).toBe(0);
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
  // Derived at apply from the freshly-resolved outcomes — the ONE source (the body
  // may have drifted between propose and apply).
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

// ── block-marker guard (tier 1) ──────────────────────────────────────────────

describe("block-marker guard", () => {
  const TABLE = [
    "Intro.",
    "",
    "| Dose | Effect |",
    "| --- | --- |",
    "| 3g | maintenance |",
    "",
    "Tail.",
    "",
  ].join("\n");

  test("a TABLE-ROW quote is dropped, and the table survives", () => {
    const r = annotate({
      body: TABLE,
      claims: [anchor(1, "✅")],
      quotes: [{ index: 1, quote: "| 3g | maintenance |" }],
    });
    expect(r.edits).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("break the table");
    // Nothing was written, so every row is still a row.
    expect(applyEdits(TABLE, r.edits, true).body).toBe(TABLE);
  });

  test("a whole BULLET line keeps its marker outside the mark", () => {
    const body = ["Intro.", "", "- The bullet claim sentence.", "- Another bullet.", "", "Tail.", ""].join("\n");
    const r = annotate({
      body,
      claims: [anchor(1, "✅")],
      quotes: [{ index: 1, quote: "- The bullet claim sentence." }],
    });
    expect(r.edits).toHaveLength(1);
    const spliced = applyEdits(body, r.edits, true).body;
    // The list item is still a list item — the tag starts AFTER the `- `.
    expect(spliced).toContain('- <Fact n="1" v="ok">The bullet claim sentence.</Fact>');
    expect(r.edits[0]!.reason).toContain("marker left outside");
    // A blockquote / heading line is the same case.
    const quoted = "Intro.\n\n> The quoted claim.\n\nTail.\n";
    const q = annotate({
      body: quoted,
      claims: [anchor(1, "✅")],
      quotes: [{ index: 1, quote: "> The quoted claim." }],
    });
    expect(applyEdits(quoted, q.edits, true).body).toContain('> <Fact n="1" v="ok">The quoted claim.</Fact>');
  });

  test("a mid-line span is untouched by the guard", () => {
    const body = "- A bullet whose middle phrase was checked.\n";
    const r = annotate({
      body,
      claims: [anchor(1, "✅")],
      quotes: [{ index: 1, quote: "middle phrase" }],
    });
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">middle phrase</Fact>');
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("a CORRECTION on a table row applies UNWRAPPED rather than breaking the table", () => {
    const r = annotate({
      body: TABLE,
      corrections: [
        correction({
          claimIndex: 1,
          old: "| 3g | maintenance |",
          new: "| 5g | maintenance |",
        }),
      ],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.new).toBe("| 5g | maintenance |");
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("the correction itself still applies");
    // The rewritten row is still a row.
    expect(applyEdits(TABLE, r.edits, true).body).toContain("\n| 5g | maintenance |\n");
  });

  test("a CORRECTION on a bullet line applies UNWRAPPED, keeping the list", () => {
    const body = "- The bullet claim.\n- Another.\n";
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 1, old: "- The bullet claim.", new: "- The fixed claim." })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits[0]!.new).toBe("- The fixed claim.");
    expect(applyEdits(body, r.edits, true).body).toContain("- The fixed claim.");
  });
});

// ── unknown claim index ──────────────────────────────────────────────────────

test("a correction naming a claim the answer does not have applies UNMARKED", () => {
  const body = "The device ships 4M units per year.\n";
  const r = annotate({
    body,
    corrections: [correction({ claimIndex: 9, verdict: "❌", old: "ships 4M units", new: "ships 2.1M units" })],
    claims: [anchor(1, "❌")],
  });
  // The correction survives, but carries NO wrapper: a chip for claim 9 would link
  // to a `#fc-claim-9` section the appendix cannot contain.
  expect(r.edits).toHaveLength(1);
  expect(r.edits[0]!.new).toBe("ships 2.1M units");
  expect(r.dropped.map((d) => d.reason).join(" ")).toContain("claim 9 is not in the answer");
  const applied = applyEdits(body, r.edits, true);
  expect(applied.body).not.toContain("<Fact");
  // …and no `Was:` line is fabricated for it either.
  expect(originalsOfOutcomes(applied.outcomes).size).toBe(0);
});

// ── one chip per claim / ⚠️ fallback marks ───────────────────────────────────

test("a claim wrapped by a correction is NOT wrapped again by its quote", () => {
  const body = "Alpha claim sentence sits here. Tail.\n";
  const r = annotate({
    body,
    corrections: [correction({ claimIndex: 1, verdict: "❌", old: "Alpha claim sentence", new: "Alpha fixed sentence" })],
    claims: [anchor(1, "❌")],
    // The extractor's quote for the SAME claim points at text the correction did
    // not consume — so it resolves, and without the filter it would ship a second
    // chip with the same `n`.
    quotes: [{ index: 1, quote: "Tail." }],
  });
  const page = applyEdits(body, r.edits, true).body;
  expect([...page.matchAll(/<Fact n="1"/g)]).toHaveLength(1);
  expect(page).toContain('<Fact n="1" v="bad">Alpha fixed sentence</Fact>');
  // The redundant quote is never a candidate, so it is not reported as a rejection
  // either — the claim IS marked, nothing was lost.
  expect(r.dropped).toHaveLength(0);
});

test("a ⚠️ claim whose correction could not be placed still gets a mark", () => {
  const body = "The dosing guidance sentence sits here.\n";
  const r = annotate({
    body,
    // The model quoted text that is not in the page — the correction drops.
    corrections: [correction({ claimIndex: 1, verdict: "⚠️", old: "text that is absent", new: "hedged" })],
    claims: [anchor(1, "⚠️")],
    quotes: [{ index: 1, quote: "The dosing guidance sentence" }],
  });
  // Without the warn fallback the flagged passage would carry NO visible mark.
  expect(r.edits).toHaveLength(1);
  expect(r.edits[0]!.new).toBe('<Fact n="1" v="warn">The dosing guidance sentence</Fact>');
  // It is a pure mark, so it costs nothing against the change budget.
  const out = applyEdits(body, r.edits, true).outcomes[0]!;
  expect(isWrapperOnlyEdit(out.edit, out.resolvedText)).toBe(true);
  expect(outcomeChangedChars(out)).toBe(0);
});

test("a ⚠️ claim whose correction landed is not double-marked", () => {
  const body = "The dosing guidance sentence sits here.\n";
  const r = annotate({
    body,
    corrections: [
      correction({ claimIndex: 1, verdict: "⚠️", old: "The dosing guidance sentence", new: "The hedged guidance" }),
    ],
    claims: [anchor(1, "⚠️")],
    quotes: [{ index: 1, quote: "The dosing guidance sentence" }],
  });
  const page = applyEdits(body, r.edits, true).body;
  expect([...page.matchAll(/<Fact n="1"/g)]).toHaveLength(1);
  expect(page).toContain('<Fact n="1" v="warn">The hedged guidance</Fact>');
});

// ── CRLF bodies ──────────────────────────────────────────────────────────────

test("a CRLF body gets CRLF-joined block wrappers, and strip → re-annotate is stable", () => {
  const para = "First line of the paragraph\r\nwraps onto a second line.";
  const body = "Intro.\r\n\r\n" + para + "\r\n\r\nTail.\r\n";
  const r = annotate({
    body,
    claims: [anchor(1, "✅")],
    quotes: [{ index: 1, quote: para }],
  });
  expect(r.edits).toHaveLength(1);
  expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">\r\n' + para + "\r\n</Fact>");
  const page = applyEdits(body, r.edits, true);
  // No lone LF was introduced into a CRLF file.
  expect(page.body.replace(/\r\n/g, "")).not.toContain("\n");
  // The mark still costs 0 (the predicate accepts either newline spelling)…
  expect(changedCharsOfOutcomes(page.outcomes)).toBe(0);
  // …and the write is a byte-stable overlay.
  expect(stripFactWrappers(page.body)).toBe(body);
  const again = annotate({
    body: stripFactWrappers(page.body),
    claims: [anchor(1, "✅")],
    quotes: [{ index: 1, quote: para }],
  });
  expect(applyEdits(body, again.edits, true).body).toBe(page.body);
});
