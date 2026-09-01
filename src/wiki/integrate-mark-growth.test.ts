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
  /** A real 3-column table. The widest cell of the `L-tyrosine` row is its middle
   *  one, so a whole-row quote and a boundary-crossing quote must both land there. */
  const TABLE_BODY =
    "# T\n\n| Compound | Proposed role | Dose |\n|:---|---|---:|\n" +
    "| L-tyrosine | Amino acid precursor to dopamine and norepinephrine | 500 mg |\n" +
    "| Caffeine | Blocks adenosine signaling in the cortex | 100 mg |\n";
  /** Same shape, with a `[[Target|Label]]` in the middle cell — the alias pipe sits
   *  where a naive cell split would cut the link in half. */
  const WIKILINK_TABLE_BODY =
    "# T\n\n| Compound | Proposed role | Dose |\n|---|---|---|\n" +
    "| Rhodiola | see [[Adaptogens|the adaptogen page]] for the mechanism | optional |\n";

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
    // B — what a TRIM threw away. This row expected `false` for two rounds, on the
    // strength of a reviewer's marked-render screenshot showing literal `**`. It is
    // measured here BOTH ways, and the unmarked render shows the same literal `**`:
    // `formatWebHtml`'s emphasis pass is LINE-SCOPED, so that bold never paired in
    // this pipeline and the mark takes nothing away. Expecting `false` was modelling
    // CommonMark rather than the renderer the reader actually uses — the same
    // mistake, one level up, that the delimiter heuristics kept making.
    ["a trim through a multi-line bold the renderer never paired",
     "# T\n\n**Bold text\nmore** here and there.\n", "Bold text more here", true],
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
    // F — a TABLE ROW. The row itself has no wrapper form (a `<Fact>` across the
    // pipes stops the line being a row and takes the whole table with it), but a
    // CELL has one, so the row is TRIMMED to its widest cell instead of refused —
    // the same move tier 3 makes for a multi-line span. Measured: 4 of the 8 claims
    // on the page that motivated this were whole-row quotes.
    ["a whole table row trims to its widest cell", TABLE_BODY,
     "| L-tyrosine | Amino acid precursor to dopamine and norepinephrine | 500 mg |", true],
    ["a span crossing ONE cell boundary trims to the wider side", TABLE_BODY,
     "L-tyrosine | Amino acid precursor to dopamine and norepinephrine", true],
    ["a quote that is already one cell is untouched", TABLE_BODY,
     "Amino acid precursor to dopamine and norepinephrine", true],
    // The delimiter row's cells are `---`, and marking one stops `isSeparatorRow`
    // matching — so the table stops being a table. The render comparison is what
    // refuses it; the trim has no rule of its own for it.
    ["a table DELIMITER row stays refused", TABLE_BODY, "|:---|---|---:|", false],
    // The alias pipe of `[[Target|Label]]` is NOT a cell boundary: `renderWikiHtml`
    // substitutes the whole link over the RAW body before the table parser ever
    // runs. The OUTCOME here is a refusal either way, and the row is still a pin —
    // it separates the two refusals, which are not the same event:
    //  - splitting AT the alias pipe makes `the adaptogen page]] for the mechanism`
    //    the widest fragment. It sits inside one `<td>`, so the render comparison
    //    passes it and the mark SHIPS — with its opening tag inside the link target,
    //    where the alias class `[^\]\n]*?` swallows it. That is the
    //    nested-annotation damage, reached through a door the whole-wikilink
    //    expansion cannot close: expansion runs BEFORE this trim, never after it.
    //  - not splitting there picks the whole cell, which `formatWebHtml` — which
    //    resolves no wikilink — spreads across two `<td>`s, so the comparison
    //    refuses it. A false refusal, and the ACCEPTED one: it costs a mark on a
    //    rare shape, where the alternative costs a live link. Measured both ways.
    ["a [[link|alias]] is not split at its alias pipe", WIKILINK_TABLE_BODY,
     "| Rhodiola | see [[Adaptogens|the adaptogen page]] for the mechanism | optional |", false],
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

  test("the guard's verdict IS the render-equivalence property, both directions", () => {
    // The rule is no longer a delimiter heuristic, so the table can assert the thing
    // itself — and in BOTH directions, which is what the previous spelling could not
    // do: it only ever checked that marking rows were safe, so it was structurally
    // blind to a rule that refused something harmless (measured: round 3 lost 338
    // render-safe marks and this suite saw none of it).
    for (const [label, body, quote, wantMarked] of ROWS) {
      if (RENDER_EXEMPT.has(label)) continue;
      const edit = markOne(body, quote).edits[0];
      // A row that marks must be render-equivalent; a row that refuses must NOT be.
      // For the refusing rows the span the guard rejected is reconstructed from the
      // quote so the claim "this really would have changed the render" is measured,
      // not assumed.
      const span = edit ? edit.old : quote;
      const at = body.indexOf(span);
      // A refusing row whose quote is not a verbatim substring was refused UPSTREAM
      // of this guard, at the tier-2 rescue gate (the neighbour steal is the one such
      // row: its quote differs from the body by a collapsed double space). There is
      // no span for this assertion to reconstruct, and the guard never saw one.
      if (at === -1) { expect({ label, marked: !!edit }).toEqual({ label, marked: false }); continue; }
      const wrapped =
        body.slice(0, at) + `<Fact n="1" v="ok">${span}</Fact>` + body.slice(at + span.length);
      const strip = (h: string) =>
        h
          .replace(/<button[\s\S]*?<\/button>/g, "")
          .replace(/<(?:span|div) class="fc-mark[^"]*"[^>]*>/g, "")
          .replace(/<\/(?:span|div)>/g, "");
      const equivalent =
        strip(formatWebHtml(wrapped)) === formatWebHtml(body).replace(/<\/(?:span|div)>/g, "");
      expect({ label, equivalent }).toEqual({ label, equivalent: wantMarked });
    }
  });

  test("every marked row leaves the render unchanged apart from the mark", () => {
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

/**
 * The guard removes the ONE mark it spliced, never a sweep of `fc-` chrome.
 *
 * A sweep can only run on the marked side (the unmarked side has nothing to sweep),
 * so any chrome the PAGE renders appears on exactly one side and the comparison can
 * never be equal — dropping every claim on that page with a reason untrue of the
 * passage. Measured on two real mimir pages: 33 and 36 claims lost. Sweeping both
 * sides is not the fix either: it removes the page's own marks too, which masks a
 * genuine difference and re-admits corrupting marks on exactly those pages.
 */
describe("a page that renders chrome of its OWN", () => {
  const SENTENCE = "Norepinephrine acts as a mental spotlight here.";

  /** Both fixtures are asserted to ACTUALLY emit page chrome before they are used to
   *  assert anything about the guard — a first spelling of this block used a
   *  `<CodeTabs>` with no `<Tab>` children and a backticked `<Fact>`, neither of
   *  which renders a button or a mark, so both tests passed against the defect. */
  function chromeCount(body: string): { buttons: number; marks: number } {
    const html = formatWebHtml(body);
    return {
      buttons: (html.match(/<button/g) ?? []).length,
      marks: (html.match(/class="fc-mark/g) ?? []).length,
    };
  }

  test("a CodeTabs block does not cost the page its marks", () => {
    // `<CodeTabs>` emits `<button class="code-tabs-tab">` per `<Tab>` — a button the
    // page owns, on both sides of the comparison.
    const plain = `# T\n\n${SENTENCE}\n`;
    const withTabs =
      `# T\n\n${SENTENCE}\n\n<CodeTabs>\n<Tab label="a">\ntext a\n</Tab>\n<Tab label="b">\ntext b\n</Tab>\n</CodeTabs>\n`;
    expect(chromeCount(withTabs).buttons).toBeGreaterThan(0);
    expect(markOne(plain, SENTENCE).edits).toHaveLength(1);
    expect(markOne(withTabs, SENTENCE).edits).toHaveLength(1);
  });

  test("a page documenting THIS feature does not lose its marks", () => {
    // A page that shows a `<Fact>` example in PROSE renders a real mark, chip and
    // all. A one-sided chrome sweep removes it from the marked render only, so no
    // claim on such a page can ever compare equal.
    const body =
      `# T\n\n${SENTENCE}\n\nA page may show <Fact n="4" v="bad">a marked passage</Fact> in prose.\n`;
    const chrome = chromeCount(body);
    expect(chrome.marks).toBeGreaterThan(0);
    expect(chrome.buttons).toBeGreaterThan(0);
    expect(markOne(body, SENTENCE).edits).toHaveLength(1);
  });

  test("a page-own mark under the SAME claim index does not cost the claim", () => {
    // `data-fact` is not unique. The guard used to locate its own mark by the REAL
    // claim index, so a page showing `<Fact n="2">` in prose made the removal take
    // the PAGE's mark and leave the guard's — and claim 2, and only claim 2, was
    // refused on that page with a reason untrue of the passage. Reproduced on a real
    // mimir page before the fix; the guard now splices under an index the page
    // provably does not use.
    //
    // The page's mark is placed BEFORE the quote deliberately: both locators take the
    // FIRST match, so a page mark after the span cannot expose this. The first
    // spelling of these fixtures put it after, and used `n="4"` against a claim index
    // of 1 — two independent accidents, either of which hid the defect.
    // Two arms, and they pin different things — the rest is a control set, said out
    // loud because the matrix reads like six pins and is two. `pageMark="1"` with
    // `claimIndex=1` is the collision itself (the only arm red before the fix).
    // `pageMark="999"` is `factClaimIndex`'s largest valid value and therefore the
    // sentinel's first probe, so it is the only arm that fails when the search returns
    // its starting point instead of searching. The other four pass on unfixed code.
    for (const pageMark of ["1", "999"]) {
      expectClaimSurvives(pageMark);
    }
  });

  function expectClaimSurvives(pageMark: string): void {
    const body =
      `# T\n\nA page may show <Fact n="${pageMark}" v="bad">a marked passage</Fact> in prose.\n\n${SENTENCE}\n`;
    expect(chromeCount(body).marks).toBeGreaterThan(0);
    for (const claimIndex of [1, 2, 4]) {
      const res = annotateEdits({
        body,
        isMdx: true,
        corrections: [],
        claims: [{ ...okClaim, index: claimIndex }],
        quotes: [{ index: claimIndex, quote: SENTENCE }],
        maxEdits: 32,
        maxEditChars: 2000,
      });
      expect({ pageMark, claimIndex, edits: res.edits.length }).toEqual({
        pageMark,
        claimIndex,
        edits: 1,
      });
    }
  }
});

describe("a table row trims to its widest cell", () => {
  const BODY =
    "# T\n\n| Compound | Proposed role | Dose |\n|:---|---|---:|\n" +
    "| L-tyrosine | Amino acid precursor to dopamine and norepinephrine | 500 mg |\n";
  const WIDEST = "Amino acid precursor to dopamine and norepinephrine";

  test("the mark covers the widest cell — not the row, not a neighbour", () => {
    // The ROWS table records only marked/not-marked, so the RANGE is asserted here:
    // a trim that picked the first or last cell would still be "marked".
    const edit = markOne(BODY, "| L-tyrosine | Amino acid precursor to dopamine and norepinephrine | 500 mg |").edits[0]!;
    expect(edit.old).toBe(WIDEST);
    // …and the mark is INSIDE the cell — the `|` characters stay outside it, which
    // is the whole reason the row was refused before.
    expect(edit.new).not.toContain("|");
  });

  test("the preview names the trim", () => {
    // A mark that covers less than the quote must say so: the reviewer is looking at
    // a row and getting one cell. `markReason` lists EVERY adjustment, so this is
    // also the assertion that the cell trim was added to that list rather than to
    // the 4-deep ternary it replaced.
    const edit = markOne(BODY, "| L-tyrosine | Amino acid precursor to dopamine and norepinephrine | 500 mg |").edits[0]!;
    expect(edit.reason).toBe("marks the checked passage (trimmed to one table cell)");
  });

  test("a quote already inside one cell keeps its exact range and says nothing", () => {
    // The control for both assertions above: the trim must be a no-op — same range,
    // and NO "trimmed to one table cell" note, which would be a false report.
    const edit = markOne(BODY, WIDEST).edits[0]!;
    expect(edit.old).toBe(WIDEST);
    expect(edit.reason).toBe("marks the checked passage");
  });

  test("a row whose cells are all blank is refused by name", () => {
    // `longestCellRange` returns null when every cell it touches is empty, and the
    // refusal has to be its own sentence — the tier-3 "no markable text on any
    // line" one is untrue of a single-line span.
    const body = "# T\n\n| a | b |\n|---|---|\n|  |  |\n";
    const res = markOne(body, "|  |  |");
    expect(res.edits).toEqual([]);
    expect(res.dropped[0]!.reason).toBe(
      "the checked passage is a table row with no markable cell",
    );
  });
});

describe("a mark that would eat a link", () => {
  test("a span covering a link's URL is refused", () => {
    // Carried by the test the collision regression replaced, and not pinned anywhere
    // else once that went — `grep` found no other assertion for it. It is the case
    // NO delimiter heuristic ever covered: rounds 1–3 had no rule for the bracket
    // family at all, so marking the URL rewrote `<a href=…>the docs</a>` to the bare
    // words. The render comparison refuses it without a rule of its own.
    const body = "# T\n\nWe use [the docs](https://example.com/x) here.\n";
    expect(markOne(body, "https://example.com/x").edits).toEqual([]);
  });
});

describe("a marked passage carrying an inline component", () => {
  test("a <Pill> inside the wrapper still compares equal", () => {
    // A regression pin, NOT a pin on the balanced scan, and the difference is worth
    // stating precisely because an earlier comment here got it backwards. THIS
    // fixture is a whole-line quote, so the wrapper takes the BLOCK (`<div>`) form
    // and the Pill really does render a nested `<span class="pill">` inside it — not
    // escaped. What the fixture therefore pins is that a component inside a marked
    // paragraph survives the comparison; it does not exercise the scan, which counts
    // `div` here and never meets a second one.
    //
    // The first-close-tag mutant survives this file, and the reachability argument is:
    // an INLINE (`<span>`) wrapper escapes any component tag inside it (`renderInline`
    // does not recurse), so it can never contain a nested span; a BLOCK (`<div>`)
    // wrapper CAN nest divs — a `<Callout>` renders several — but no quote can resolve
    // to a component's raw source (`"<Callout>…</Callout>"` answers "no longer found
    // in the page"). A single line quoted inside such a group is NOT saved by the
    // inline wrapper spelling — it still renders as a block `div` nested in the
    // callout's — but by its children being one line of inline content. So the
    // counting is defensive against the component vocabulary and the resolver
    // changing, not against anything reachable today.
    const body = "# T\n\nThe status is <Pill>beta</Pill> for now and stable soon.\n";
    expect((formatWebHtml(body).match(/<span/g) ?? []).length).toBeGreaterThan(0);
    expect(markOne(body, "The status is <Pill>beta</Pill> for now and stable soon.").edits)
      .toHaveLength(1);
  });
});
