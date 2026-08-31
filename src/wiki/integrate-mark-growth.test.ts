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

describe("the final-span check also covers the EXACT tier", () => {
  test("a quote that exactly matches a construct's interior is refused", () => {
    // Pre-existing before the `"mark"` mode: an exact-tier match needs no rescue, so
    // nothing looked at the span at all and the mark was spliced INSIDE the
    // delimiters. `finalSpanCutReason` runs on every pass-2 span regardless of tier,
    // so it closes this too.
    const body = "# T\n\n[beta](https://beta.example/x) _alpha_ [[eta]].\n";
    const res = markOne(body, "alpha");
    expect(res.edits).toEqual([]);
    expect(res.dropped[0]!.reason).toContain("inside markdown formatting");
  });

  test("…including inside a code span, which strip cannot undo", () => {
    // The worst instance: `stripFactWrappers` is zone-aware, so a `<Fact>` inside a
    // backtick span is DOCUMENTATION to it — the strip is a no-op and the next
    // integrate run wraps the mark again, nesting `<Fact><Fact>…</Fact></Fact>`.
    const body = "# T\n\nRun `bun test` now to check.\n";
    const res = markOne(body, "bun test");
    expect(res.edits).toEqual([]);
    expect(res.dropped[0]!.reason).toContain("inside markdown formatting");
  });
});
