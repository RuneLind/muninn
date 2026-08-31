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
    // The REASON is the assertion, not just the drop. The precondition refuses this
    // at the honest place: the range never cut anything, so the truth is "starts or
    // ends inside someone else's formatting", not "cuts through". Drop the
    // precondition and this reads `cut through` instead. (An earlier comment here
    // claimed the precondition was provably redundant for safety — "growth adds
    // exactly one run". That proof is FALSE: a run merges with one already at the
    // slice edge, so growth can add zero. The claim is withdrawn in
    // `growOverEmphasisRuns`' docblock and withdrawn here.)
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

/**
 * The mark-span guard, as the ENUMERATION it is written to be.
 *
 * Three rounds of per-finding patching produced two false-refusal classes and lost
 * two corruption catches, so the guard was rewritten as one table and this is that
 * table. Every row is a case some round got wrong; a row is a behaviour, not a
 * spelling, so a future rewrite is judged against all of them at once rather than
 * against whichever one a reviewer happened to send.
 */
describe("mark-span guard — the whole state space", () => {
  const ROWS: [string, string, string, boolean][] = [
    // A — where the mark would SIT. Both were measured as rendered corruption.
    ["code-span interior: tags render literally AND survive the zone-aware strip",
     "# T\n\nRun `bun test` now to check.\n", "bun test", false],
    ["emphasis interior: the opener re-pairs with a neighbour's `_`",
     "# T\n\n[beta](https://beta.example/x) _alpha_ [[eta]].\n", "alpha", false],
    // Each EDGE separately. Both fixtures above are delimited on BOTH sides, so
    // either half of rule A alone still refuses them and neither half is pinned —
    // measured: removing one edge check killed no test. These two are exact-tier
    // (no rescue gate runs at all) and delimited on ONE side only.
    ["rule A, start edge alone", "# T\n\nRun `bun test` now to check.\n",
     "bun test` now to check.", false],
    ["rule A, end edge alone", "# T\n\nRun `bun test` now to check.\n",
     "Run `bun test", false],
    // B — what a TRIM threw away.
    ["a trim that drops the delimiter which balanced the span",
     "# T\n\n**Bold text\nmore** here and there.\n", "Bold text more here", false],
    // C — odd delimiter counts that are NOT cut constructs.
    ["snake_case identifier", "# T\n\nThe field user_id is set by the API.\n",
     "The field user_id is set by the API.", true],
    ["literal asterisk", "# T\n\nCost is 2 * 3 dollars per unit here.\n",
     "Cost is 2 * 3 dollars per unit here.", true],
    ["a glob", "# T\n\nThe glob a*b matches many files here.\n",
     "The glob a*b matches many files here.", true],
    ["a TRIMMED span whose odd count is unchanged by the trim",
     "# T\n\nIntro line here.\nThe user_id field spans a much longer second line of prose.\nTail line.\n",
     "The user_id field spans a much longer second line of prose. Tail line.", true],
    // `*` is a bullet AND an emphasis delimiter — the marker strip changes the count
    // without touching a construct, which a naive parity comparison reads as damage.
    ["a `*` list bullet the trim strips",
     "# T\n\nAlpha line.\n* Bullet line that is much longer than the others in this list here.\nGamma line.\n",
     "Alpha line. * Bullet line that is much longer than the others in this list here.", true],
    ["…and the `-` bullet control",
     "# T\n\nAlpha line.\n- Bullet line that is much longer than the others in this list here.\nGamma line.\n",
     "Alpha line. - Bullet line that is much longer than the others in this list here.", true],
    // D — a whole-wikilink expansion is exempt: the reader resolves that link.
    ["a backticked wikilink, single line",
     "The engine `[[Tidal Router]]` is the default.\n", "Tidal Router", true],
    ["a wikilink straddling a backtick, on a TRIMMED span",
     "# T\n\nShort intro.\nWrite [[Tidal `Router]] and much more prose follows here on this longer line.\n",
     "Short intro. Write [[Tidal", true],
    // E — the feature itself, and the shape that must stay refused.
    ["the cut construct the relaxation exists for",
     "# T\n\n- **Norepinephrine** acts as a mental spotlight.\n",
     "Norepinephrine acts as a mental spotlight.", true],
    ["the neighbour steal", "# T\n\nSee **Alpha**the middle  words**Beta** ok.\n",
     "the middle words", false],
  ];

  for (const [label, body, quote, wantMarked] of ROWS) {
    test(label, () => {
      const res = markOne(body, quote);
      expect({ label, marked: res.edits.length > 0 }).toEqual({ label, marked: wantMarked });
    });
  }

  /** The two wikilink rows are EXEMPT from render-equivalence, and that is the
   *  documented trade rather than an oversight: a `[[Page]]` inside backticks is a
   *  live link to `renderWikiHtml` (which substitutes over the raw body before any
   *  code handling), so the mark must take it whole — and `formatWebHtml` then shows
   *  the tags as escaped text inside `<code>`. Cosmetic damage, accepted in place of
   *  durable damage: the alternative is a mark that rewrites the link TARGET.
   *  `integrate-wikilink.test.ts` owns that case; this row set only records why the
   *  invariant below stops at its door. */
  const RENDER_EXEMPT = new Set([
    "a backticked wikilink, single line",
    "a wikilink straddling a backtick, on a TRIMMED span",
  ]);

  test("every other marked row leaves the render unchanged apart from the mark", () => {
    // The safety property, asserted rather than assumed: strip the chip and the
    // fc-mark wrapper out of the marked render and it must equal the unmarked one.
    for (const [label, body, quote, wantMarked] of ROWS) {
      if (!wantMarked || RENDER_EXEMPT.has(label)) continue;
      const edit = markOne(body, quote).edits[0]!;
      const marked = formatWebHtml(body.replace(edit.old, edit.new))
        .replace(/<button[\s\S]*?<\/button>/g, "")
        .replace(/<(span|div) class="fc-mark[^"]*"[^>]*>/g, "")
        .replace(/<\/(span|div)>/g, "");
      const plain = formatWebHtml(body).replace(/<\/(span|div)>/g, "");
      expect({ label, marked }).toEqual({ label, marked: plain });
    }
  });
});

describe("growth completes from the side that carries the delimiter", () => {
  test("a cut construct completes; a delimiter on BOTH edges drops either way", () => {
    // One-sided growth is a readability choice, not a safety property. The
    // both-sides mutant is OUTCOME-equivalent — measured over 22 913 generated
    // fixtures by an independent pass: zero outcome divergences, 117 drop-REASON
    // divergences — so this pins the outcomes and the enumeration lives in the
    // `growOverEmphasisRuns` docblock rather than being faked as a behavioural test.
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
