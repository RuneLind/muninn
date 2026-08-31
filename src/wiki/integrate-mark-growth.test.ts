/**
 * Red→green pins for the SAFETY half of the `"mark"` rescue: the cases where
 * growing a range over emphasis delimiters must NOT produce a mark.
 *
 * Every assertion here failed on the first shipped spelling of
 * `growOverEmphasisRuns`, which grew both edges unconditionally. Two independent
 * review passes reproduced the resulting corruption in RENDERED html, so each
 * fixture below carries the render that made it a defect rather than a taste call.
 */
import { test, expect, describe } from "bun:test";
import { annotateEdits } from "./integrate-edits.ts";
import { formatWebHtml } from "../web/web-format.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

const okClaim: FactcheckClaimAnchor = {
  index: 1,
  total: 1,
  verdict: "✅",
  title: "t",
  block: "### ✅ Claim 1/1 — t\n\nreasoning",
};

function markOne(body: string, quote: string) {
  return annotateEdits({
    body,
    isMdx: true,
    corrections: [],
    claims: [okClaim],
    quotes: [{ index: 1, quote }],
    maxEdits: 32,
    maxEditChars: 2000,
  });
}

/** The body as it would be written, so a fixture can be judged on its RENDER. */
function spliced(body: string, edit: { old: string; new: string }): string {
  return body.replace(edit.old, edit.new);
}

describe("growth must not acquire a construct the range did not already cut", () => {
  test("delimiters belonging to the NEIGHBOURING constructs are not stolen", () => {
    // The quote sits between two complete bold spans. Growing both edges takes the
    // CLOSER of `**Alpha**` and the OPENER of `**Beta**` — two runs, so a parity
    // test alone waves it through, and the edge test sees ordinary letters because
    // it runs on the grown edges. The render is crossed tags:
    //   `<strong>Alpha<span class="fc-mark"></strong>the middle…<strong></span>Beta</strong>`
    const body = "# T\n\nSee **Alpha**the middle  words**Beta** ok.\n";
    const res = markOne(body, "the middle words");
    expect(res.edits).toEqual([]);
    // The REASON is the assertion, not just the drop. The odd-count precondition is
    // provably redundant for safety — growth adds exactly one run, so an even (=
    // cuts-nothing) slice always turns odd and the parity test refuses it anyway —
    // but it refuses this at the honest place: the range never cut anything, so the
    // truth is "starts inside someone else's formatting", not "cuts through". Drop
    // the precondition and this reads `cut through` instead.
    expect(res.dropped[0]!.reason).toBe(
      "whitespace-rescued match would start or end inside markdown formatting",
    );
  });

  test("a range that cuts NO construct is not grown into one", () => {
    // The raw slice carries an EVEN number of `*` runs (zero), so nothing is cut and
    // there is nothing to complete. Growing anyway is how the neighbour steal above
    // becomes reachable.
    const body = "# T\n\n**Norepinephrine acts here\nand there** is true.\n";
    const res = markOne(body, "Norepinephrine acts here and there");
    expect(res.edits).toEqual([]);
  });
});

describe("the FINAL span is balanced, not just the grown one", () => {
  test("a grown range that factSpanForm then trims to one line is refused", () => {
    // Here the slice DOES cut a construct (one `*` run), so growth is legitimate and
    // produces a balanced `**Bold text\nmore** here`. `factSpanForm` then sees the
    // newline, fails the whole-paragraph test and trims to the longest line —
    // throwing away the delimiter that made it balanced. Nothing re-checked that,
    // and the page was written with two literal `**` and the bold gone.
    const body = "# T\n\n**Bold text\nmore** here and there.\n";
    const res = markOne(body, "Bold text more here");
    expect(res.edits).toEqual([]);
    expect(res.dropped).toHaveLength(1);
  });
});

describe("the case the relaxation exists for still works", () => {
  test("a cut construct IS completed, and the render is unchanged by the mark", () => {
    const body = "# T\n\n- **Norepinephrine** acts as a mental spotlight, narrowing attention.\n";
    const res = markOne(body, "Norepinephrine acts as a mental spotlight, narrowing attention.");
    expect(res.dropped).toEqual([]);
    expect(res.edits).toHaveLength(1);
    expect(res.edits[0]!.old).toBe(
      "**Norepinephrine** acts as a mental spotlight, narrowing attention.",
    );
    // The mark must be invisible to the markup: strip the chip + the fc-mark span
    // out of the marked render and it is the unmarked render.
    const marked = formatWebHtml(spliced(body, res.edits[0]!));
    expect(marked).toContain("<strong>Norepinephrine</strong>");
    expect(marked).not.toContain("**");
  });

  test("the growth is NAMED in the preview reason", () => {
    // `markReason`'s own docblock: every adjustment is named. Growing over a
    // delimiter run changes what the reviewer is agreeing to, so it is an
    // adjustment like the link expansion and the one-line trim.
    const body = "# T\n\n- **Norepinephrine** acts as a mental spotlight, narrowing attention.\n";
    const res = markOne(body, "Norepinephrine acts as a mental spotlight, narrowing attention.");
    expect(res.edits[0]!.reason).toContain("formatting");
  });
});

describe("the final-span check compares against the PRE-TRIM span, not zero", () => {
  test("an ordinary snake_case identifier is not 'markdown formatting'", () => {
    // Regression injected by fix round 1 and caught by the verify pass: an ABSOLUTE
    // even-run rule refuses every passage carrying an odd number of `_`, `*` or
    // backtick runs — `user_id`, `2 * 3`, a glob — none of which is emphasis, and
    // none of which `formatWebHtml` renders any differently for the mark. The gate
    // this check mirrors (`collapsedRescueRisk`) compares the slice's parity against
    // a REFERENCE; so must this one.
    for (const [body, quote] of [
      ["# T\n\nThe field user_id is set by the API.\n", "The field user_id is set by the API."],
      ["# T\n\nCost is 2 * 3 dollars per unit here.\n", "Cost is 2 * 3 dollars per unit here."],
      ["# T\n\nThe glob a*b matches many files here.\n", "The glob a*b matches many files here."],
    ] as [string, string][]) {
      const res = markOne(body, quote);
      expect({ quote, dropped: res.dropped.map((d) => d.reason) }).toEqual({ quote, dropped: [] });
      expect(res.edits).toHaveLength(1);
    }
  });

  test("…and an odd delimiter count that the TRIM created is still refused", () => {
    // The pre-trim span is balanced; `longestLineRange` throws away the half that
    // balanced it. Parity CHANGED across the trim, which is the actual defect.
    const body = "# T\n\n**Bold text\nmore** here and there.\n";
    expect(markOne(body, "Bold text more here").edits).toEqual([]);
  });

  test("a TRIMMED span with an odd-but-unchanged count is allowed", () => {
    // This one really does reach the trim check (multi-line, not a whole paragraph,
    // so `longestLineRange` fires — the reason says "trimmed to one line"). The
    // surviving line carries a lone `_` that was already in the pre-trim span, so the
    // trim cut nothing. An ABSOLUTE even-run rule refuses it; parity-vs-pre-trim does
    // not. Without a genuinely trimmed fixture the absolute-rule mutant survives.
    const body =
      "# T\n\nIntro line here.\nThe user_id field spans a much longer second line of prose.\nTail line.\n";
    const res = markOne(body, "The user_id field spans a much longer second line of prose. Tail line.");
    expect(res.dropped.map((d) => d.reason)).toEqual([]);
    expect(res.edits[0]!.old).toContain("user_id");
    expect(res.edits[0]!.reason).toContain("trimmed to one line");
  });
});

describe("growth completes from the side that carries the delimiter", () => {
  test("a cut construct completes; a slice with a delimiter on BOTH edges drops", () => {
    // One-sided growth is a readability choice, NOT a safety property — the mutant
    // that grows both sides is equivalent, and the enumeration is in the
    // `growOverEmphasisRuns` docblock. What IS pinned is the observable pair: the
    // ordinary cut completes, and the only configuration where the two spellings
    // could differ (odd count, delimiter on both edges) drops either way.
    const cut = "# T\n\n- **Norepinephrine** acts as a mental spotlight.\n";
    expect(markOne(cut, "Norepinephrine acts as a mental spotlight.").edits[0]!.old).toBe(
      "**Norepinephrine** acts as a mental spotlight.",
    );
    for (const [body, quote] of [
      ["# T\n\n**Bold** middle**more** text here.\n", "Bold middle"],
      ["# T\n\n_em_ middle_more_ text here now.\n", "em middle"],
      ["# T\n\n`cd` middle`more` text here now.\n", "cd middle"],
    ] as [string, string][]) {
      expect({ quote, edits: markOne(body, quote).edits }).toEqual({ quote, edits: [] });
    }
  });
});
