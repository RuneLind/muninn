/**
 * The fact-check annotation pass vs `[[wikilinks]]`.
 *
 * The defect this file pins: a claim quote that resolves to text INSIDE a
 * wikilink used to be wrapped where it sat, so the mark landed inside the link
 * brackets — `[[<Fact n="4" v="ok">Some Page</Fact>]]`. The link target becomes
 * markup: the link is dead and the chrome renders inside the brackets. The
 * correct nesting is the inverse, over the ORIGINAL link:
 * `<Fact n="4" v="ok">[[Some Page]]</Fact>`.
 *
 * Kept out of `integrate-annotate.test.ts` so that file stays readable as the
 * regression gate for the newline/block-marker tiers.
 *
 * Every fixture here is invented. muninn is a PUBLIC repo — no wiki content.
 */

import { test, expect, describe } from "bun:test";
import {
  annotateEdits,
  applyEdits,
  dropLinkCrossingCorrections,
  repairNestedFactWrappers,
  type IntegrateEdit,
} from "./integrate-edits.ts";
import { renderWikiHtml } from "./render.ts";
import type { WikiPageMeta } from "./store.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

const anchor = (index: number, verdict: string): FactcheckClaimAnchor => ({
  index,
  total: 4,
  verdict,
  title: "claim " + index,
  block: `### ${verdict} Claim ${index}/4 — claim ${index}`,
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

/** One ✅ claim whose quote is `quote`, over `body`. */
function markOne(body: string, quote: string) {
  return annotate({ body, claims: [anchor(1, "✅")], quotes: [{ index: 1, quote }] });
}

describe("a span intersecting a wikilink expands to the link's full extent", () => {
  test("REPRO: a span WHOLLY inside a link wraps the WHOLE link, never the target", () => {
    // The shipped defect's shape: the checked passage is the link's own label.
    const body = "The guide sends [[Tidal Router]]-class engines to the hard problems.\n";
    const r = markOne(body, "Tidal Router");

    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');

    const spliced = applyEdits(body, r.edits, true).body;
    expect(spliced).toContain('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');
    // The forbidden shape, stated directly: markup inside the brackets.
    expect(spliced).not.toContain("[[<Fact");
    // …and the link target survives byte-for-byte, so the link still resolves.
    expect(spliced).toContain("[[Tidal Router]]");
  });

  test("a span STARTING inside a link is expanded leftwards over the opener", () => {
    const body = "Route [[Tidal Router]] and its cousins to the slow queue.\n";
    const r = markOne(body, "Router]] and its cousins");
    expect(r.edits[0]!.old).toBe("[[Tidal Router]] and its cousins");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]] and its cousins</Fact>');
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });

  test("a span ENDING inside a link is expanded rightwards over the closer", () => {
    const body = "We route [[Tidal Router]] carefully these days.\n";
    const r = markOne(body, "route [[Tidal");
    expect(r.edits[0]!.old).toBe("route [[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">route [[Tidal Router]]</Fact>');
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });

  test("a span EXACTLY wrapping a link is unchanged", () => {
    const body = "The engine [[Tidal Router]] is the default.\n";
    const r = markOne(body, "[[Tidal Router]]");
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("a span CONTAINING a link plus prose is unchanged — nothing to expand over", () => {
    const body = "The guide sends [[Tidal Router]] to the hard problems every time.\n";
    const r = markOne(body, "sends [[Tidal Router]] to the hard problems");
    expect(r.edits[0]!.old).toBe("sends [[Tidal Router]] to the hard problems");
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("a piped link expands as one unit, alias included", () => {
    const body = "The guide names [[Tidal Router|the router]] as the default engine.\n";
    const r = markOne(body, "the router");
    expect(r.edits[0]!.old).toBe("[[Tidal Router|the router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router|the router]]</Fact>');
  });

  test("a span with NO link nearby is byte-identical to today", () => {
    const body = "The guide sends heavier engines to the hard problems.\n";
    const r = markOne(body, "heavier engines");
    expect(r.edits[0]!.old).toBe("heavier engines");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">heavier engines</Fact>');
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("expansion is reported in the edit's reason", () => {
    const body = "The guide sends [[Tidal Router]]-class engines to the hard problems.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits[0]!.reason).toContain("wikilink");
  });
});

describe("column 0 — an expanded span is marked, not refused", () => {
  test("REPRO: a link OPENING the line is marked, not dropped as unmarkable", () => {
    // The primary defect shape, and the one the first cut refused: the checked
    // passage is the label of a link that opens its own line. Expanding leftwards
    // moves the opening tag to column 0, which the block parser can claim — but the
    // rendered result is correct either way (asserted through the real renderer in
    // the `render` describe below), so a refusal here only cost the mark.
    const body = "Intro paragraph.\n\n[[Tidal Router]] is the default engine here.\n\nTail.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');
    const spliced = applyEdits(body, r.edits, true).body;
    expect(spliced).toContain('\n<Fact n="1" v="ok">[[Tidal Router]]</Fact> is the default engine here.\n');
    expect(spliced).not.toContain("[[<Fact");
  });

  test("REPRO: a RIGHTWARD-only expansion at column 0 is marked too", () => {
    // `expanded !== null` refused this as "a [[wikilink]] opening its own line" —
    // but the span already owned the line start before any expansion, and the
    // expansion only grew RIGHTWARDS over the closer.
    const body = "Use [[Tidal Router]] here today.\n";
    const r = markOne(body, "Use [[Tidal");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("Use [[Tidal Router]]");
    expect(applyEdits(body, r.edits, true).body).toBe(
      '<Fact n="1" v="ok">Use [[Tidal Router]]</Fact> here today.\n',
    );
  });

  test("REPRO: a multi-line quote touching a link still marks (tier 3 starts at column 0)", () => {
    // `longestLineRange` trims to a line's first non-marker character, so a tier-3
    // range owns its line start BY CONSTRUCTION — every multi-line quote whose
    // longest line carried a link was silently dropped.
    const body = "Intro.\n\n[[Tidal Router]] is the default engine here.\nIt runs nightly.\n\nTail.\n";
    const r = markOne(body, "Tidal Router]] is the default engine here.\nIt runs");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Tidal Router]] is the default engine here.");
    expect(r.edits[0]!.reason).toContain("expanded to cover the whole [[wikilink]]");
    // BOTH adjustments are named — the trim AND the growth over the link.
    expect(r.edits[0]!.reason).toContain("trimmed to one line");
  });

  test("a paragraph-initial span with NO link still takes the inline form (no churn)", () => {
    // The live corpus shape the refusal must not touch: an ordinary column-0
    // passage, marked inline exactly as it is today.
    const body = "Intro paragraph.\n\nTidal Router is the default engine here.\n\nTail.\n";
    const r = markOne(body, "Tidal Router is the default");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">Tidal Router is the default</Fact>');
    expect(applyEdits(body, r.edits, true).body).toContain(
      '\n<Fact n="1" v="ok">Tidal Router is the default</Fact> engine here.\n',
    );
  });

  test("a link after a list marker expands fine — the marker still owns the line", () => {
    const body = "Intro.\n\n- Send [[Tidal Router]] to the slow queue.\n- Another bullet.\n\nTail.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(body, r.edits, true).body).toContain(
      '- Send <Fact n="1" v="ok">[[Tidal Router]]</Fact> to the slow queue.',
    );
  });
});

describe("corrections that cross a wikilink boundary are dropped WHOLE", () => {
  test("a correction rewriting a link's label is dropped, not applied unwrapped", () => {
    const body = "Route [[Tidal Router]] to the slow queue.\n";
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 1, old: "Tidal Router", new: "Tidal Router v2" })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(0);
    const reason = r.dropped.map((d) => d.reason).join(" ");
    expect(reason).toContain("wikilink");
    // The correction is NOT applied unwrapped — the link target is untouched.
    expect(reason).not.toContain("the correction itself still applies");
    expect(applyEdits(body, r.edits, true).body).toBe(body);
  });

  test("a correction whose claim the answer does not carry is dropped too", () => {
    // The unwrapped path is exactly where a silent `[[X]]` → `[[Y]]` rewrite hid:
    // it never reaches the wrapper branch, so the refusal cannot live there.
    const body = "Route [[Tidal Router]] to the slow queue.\n";
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 7, old: "Tidal Router", new: "Tidal Router v2" })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(0);
    expect(applyEdits(body, r.edits, true).body).toBe(body);
  });

  test("a correction CONTAINING a whole link still applies, link intact", () => {
    const body = "Route [[Tidal Router]] to the slow queue.\n";
    const r = annotate({
      body,
      corrections: [
        correction({
          claimIndex: 1,
          old: "Route [[Tidal Router]] to the slow queue.",
          new: "Route [[Tidal Router]] to the fast queue.",
        }),
      ],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(body, r.edits, true).body).toContain("[[Tidal Router]] to the fast queue.");
  });

  test("a wrapper whose span sits inside a correction's span is dropped, correction wins", () => {
    // The claimed-overlap gate, with the link in play: the correction owns the
    // whole sentence (link included), so the ✅ mark inside it has nowhere to go.
    const body = "Route [[Tidal Router]] to the slow queue today.\n";
    const r = annotate({
      body,
      corrections: [
        correction({
          claimIndex: 1,
          old: "Route [[Tidal Router]] to the slow queue",
          new: "Route [[Tidal Router]] to the fast queue",
        }),
      ],
      claims: [anchor(1, "❌"), anchor(2, "✅")],
      quotes: [{ index: 2, quote: "Tidal Router" }],
    });
    expect(r.edits).toHaveLength(1); // the correction only
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("overlaps a correction");
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });
});

describe("a BACKTICKED wikilink is a link — the renderer resolves it", () => {
  // Measured 2026-08-30 through the shipped `renderWikiHtml`: wikilink substitution
  // runs over the RAW body BEFORE `formatWebHtml` sees a backtick, so
  // `` `[[Old Name]]` `` comes out as `<code><a class="wiki-link">Old Name</a></code>`.
  // The earlier spelling of `wikilinkSpansIn` masked inline code and therefore
  // disagreed with the renderer in the one direction that produces damage: it left
  // the mark INSIDE the brackets, i.e. the forbidden shape, rendering as a dead link.
  const body = "Write `[[Old Name]]` to link a page from another one.\n";

  test("REPRO: a correction on a BACKTICKED link's TARGET is dropped as link-crossing", () => {
    // Under the mask this correction resolved to a line with no link on it, so it
    // applied and silently rewrote a link target — exactly what the guard exists to
    // stop, one code span away. NB the `old: "[[Old Name]]"` shape this replaced
    // CONTAINED the whole link, so it could never cross one and could never fail.
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 1, old: "Old Name", new: "New Name" })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("rewrite the link target");
    expect(applyEdits(body, r.edits, true).body).toBe(body);
  });

  test("a correction CONTAINING the backticked link whole still applies", () => {
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 1, old: "`[[Old Name]]` to link", new: "`[[Old Name]]` to reach" })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(body, r.edits, true).body).toContain("`[[Old Name]]` to reach");
  });

  test("REPRO: a mark inside a backticked link expands over the WHOLE link", () => {
    const r = markOne(body, "Old Name");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Old Name]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Old Name]]</Fact>');
    expect(r.edits[0]!.reason).toContain("expanded to cover the whole [[wikilink]]");
    // The forbidden shape, stated directly.
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });

  test("a REAL link on the same line as a backticked one still expands", () => {
    const mixed = "Write `[[Old Name]]` when you mean [[Tidal Router]] exactly.\n";
    const r = markOne(mixed, "Tidal Router");
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
  });

  test("a link STRADDLING a backtick pairs the way the renderer pairs it", () => {
    // `renderWikiHtml` runs one regex over the raw body, so the link here is
    // `[[Tidal `Router]]` — backtick and all. Under the mask the ` `Router]]` ` span
    // was blanked, the `[[` was left dangling, and the mark landed mid-link.
    const straddle = "Write [[Tidal `Router]]` here.\n";
    const r = markOne(straddle, "Tidal");
    expect(r.edits[0]!.old).toBe("[[Tidal `Router]]");
    expect(applyEdits(straddle, r.edits, true).body).not.toContain("[[<Fact");
  });

  test("…and the mirror-image straddle pairs the same way", () => {
    const straddle = "Write `[[Tidal` Router]] here.\n";
    const r = markOne(straddle, "Router");
    expect(r.edits[0]!.old).toBe("[[Tidal` Router]]");
    expect(applyEdits(straddle, r.edits, true).body).not.toContain("[[<Fact");
  });
});

describe("a leading `[` — the mark covers exactly what the renderer replaces", () => {
  test("`[[[Tidal Router]]` marks the same 17 characters the renderer consumes", () => {
    // The dangling test starts at index 2, so the extra opener here reads as `[T` and
    // passes. That is correct, not a miss: `renderWikiHtml` runs the SAME regex from
    // the same start and replaces the SAME range, so the mark and the rendered link
    // cover identical bytes — asserted through the real renderer below.
    const body = "Write [[[Tidal Router]] here.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[[Tidal Router]]");

    const spliced = applyEdits(body, r.edits, true).body;
    expect(spliced).not.toContain("[[<Fact");
    const html = renderWikiHtml(spliced, () => undefined);
    // The mark WRAPS the rendered link element — no orphan bracket outside it.
    expect(html).toContain('<span class="fc-mark fc-mark-ok" data-fact="1"><span class="wiki-link-missing"');
    expect(html).not.toContain("&lt;Fact");
  });
});

describe("a dangling [[ does not pair with a later closer", () => {
  test("REPRO: the mark covers the real link, not the prose before it", () => {
    // `[[ b [[ c [[Tidal Router]]` is one match for a target class that admits `[` —
    // so the mark swallowed 24 characters the fact check never looked at.
    const body = "A [[ b [[ c [[Tidal Router]] d.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');
  });

  test("REPRO: and it cannot run across a table cell separator", () => {
    // The alias branch admits `|`, so a dangling opener in an earlier cell paired
    // with this cell's closer — the exact damage the table refusal exists to stop,
    // unreachable there because the span does not own the line start.
    const body = "| Note [[ dangling | [[Tidal Router]] |\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).not.toContain("|");
  });
});

describe("two claims inside ONE link", () => {
  test("REPRO: the second mark is dropped with a reason that names the first", () => {
    // Both quotes expand to the same extent, so the second edit's `old` is a
    // duplicate of the first's. It used to die in `applyEdits` as a generic
    // "overlaps an earlier edit", leaving an appendix section no chip points at.
    const body = "The guide names [[Tidal Router Engine]] as the default.\n";
    const r = annotate({
      body,
      claims: [anchor(1, "✅"), anchor(2, "✅")],
      quotes: [
        { index: 1, quote: "Tidal" },
        { index: 2, quote: "Router Engine" },
      ],
    });
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.claimIndex).toBe(1);
    const reason = r.dropped.map((d) => d.reason).join(" ");
    expect(reason).toContain("expanded over the same [[wikilink]] as claim 1");
    expect(reason).toContain("one mark carries both");
    expect(reason).not.toContain("overlaps an earlier edit");
  });
});

describe("dropLinkCrossingCorrections — the guard for a page that takes no marks", () => {
  const body = "Route [[Tidal Router]] to the slow queue.\n";

  test("REPRO: a `.md` correction rewriting a link TARGET is dropped", () => {
    const r = dropLinkCrossingCorrections(
      body,
      [correction({ old: "Tidal Router", new: "Tidal Router v2" })],
      false,
    );
    expect(r.edits).toHaveLength(0);
    expect(r.dropped[0]!.reason).toContain("rewrite the link target");
    expect(applyEdits(body, r.edits, false).body).toBe(body);
  });

  test("a correction CONTAINING the link whole still applies", () => {
    const r = dropLinkCrossingCorrections(
      body,
      [correction({ old: "Route [[Tidal Router]] to the slow", new: "Route [[Tidal Router]] to the fast" })],
      false,
    );
    expect(r.edits).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  test("an UNRESOLVABLE edit is passed through, not double-reported", () => {
    // The caller re-resolves the surviving list and reports its own misses.
    const r = dropLinkCrossingCorrections(body, [correction({ old: "not in the page", new: "x" })], false);
    expect(r.edits).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("the marked page renders", () => {
  // The choice this PR makes at column 0 is a RENDER decision, so it is pinned
  // through the shipped renderer rather than argued from the parser.
  const resolve = (t: string) =>
    t.trim() === "Tidal Router"
      ? ({ name: "tidal router", relPath: "concepts/tidal-router.md", title: "Tidal Router" } as WikiPageMeta)
      : undefined;

  test("a column-0 mark over a link renders as a mark AROUND a live link", () => {
    const body = "Intro.\n\n[[Tidal Router]] is the default engine here.\n\nTail.\n";
    const r = markOne(body, "Tidal Router");
    const html = renderWikiHtml(applyEdits(body, r.edits, true).body, resolve);
    expect(html).toContain('class="fc-mark');
    expect(html).toContain('class="wiki-link"');
    expect(html).toContain(">Tidal Router</a>");
    expect(html).toContain("is the default engine here.");
    // The defect's signature: the tags rendered as the link TARGET.
    expect(html).not.toContain("wiki-link-missing");
    expect(html).not.toContain("&lt;Fact");
  });

  test("REPRO: a mark over a BACKTICKED link renders a LIVE link, never a dead one", () => {
    // The whole shipped chain — annotate → apply → the post-splice backstop → the
    // renderer — over the fixture round 1 got wrong. Under the code-span mask the
    // mark landed between the brackets and the link died; with the mask gone the
    // mark wraps the link and the link resolves.
    //
    // ⚠️ KNOWN, MEASURED, and deliberately asserted rather than hidden: the wrapper
    // sits INSIDE the code span, and `formatWebHtml` escapes code-span content, so
    // the `<Fact>` tags render as literal text there and no `fc-mark`/`fc-chip`
    // chrome appears. That is strictly better than what it replaced (which produced
    // literal tags AND a dead link) and it is not a reason to re-add the mask — a
    // mark that cannot be seen is cosmetic, a link target replaced by markup is
    // durable damage. Marking inside a code span at all is the follow-up.
    const body = "The engine `[[Tidal Router]]` is the default.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    const spliced = applyEdits(body, r.edits, true).body;
    const repaired = repairNestedFactWrappers(spliced);
    expect(repaired.body).toBe(spliced); // nothing to repair — the write side is correct now
    expect(repaired.repaired).toHaveLength(0);
    expect(repaired.residual).toHaveLength(0);

    const html = renderWikiHtml(repaired.body, resolve);
    expect(html).toContain('<code>');
    expect(html).toContain('class="wiki-link"');
    expect(html).toContain(">Tidal Router</a>");
    // The defect's signature — the tags as the link TARGET — is gone.
    expect(html).not.toContain("wiki-link-missing");
    expect(html).not.toContain("[[<Fact");
    // The stated cosmetic residual, pinned so it cannot change unnoticed.
    expect(html).toContain("&lt;Fact");
  });

  test("a mark owning its whole line renders as the BLOCK-form mark, link intact", () => {
    const body = "Intro.\n\n[[Tidal Router]]\n\nTail.\n";
    const r = markOne(body, "Tidal Router");
    const html = renderWikiHtml(applyEdits(body, r.edits, true).body, resolve);
    expect(html).toContain("fc-mark-block");
    expect(html).toContain('class="wiki-link"');
    expect(html).not.toContain("&lt;Fact");
  });

  test("the BLOCK form is NOT what a partial line may take — it renders as literal tags", () => {
    // Why `factSpanForm` keeps the inline form for an expanded column-0 span: the
    // block spelling puts prose after the closing tag's line, and the renderer then
    // escapes both tags. Measured here so the alternative cannot be re-adopted by
    // reading the parser instead of the output.
    const wrong = 'Intro.\n\n<Fact n="1" v="ok">\n[[Tidal Router]]\n</Fact> is the default engine here.\n\nTail.\n';
    const html = renderWikiHtml(wrong, resolve);
    expect(html).toContain("&lt;Fact");
    expect(html).not.toContain("fc-mark");
  });
});

describe("repairNestedFactWrappers — the post-splice backstop", () => {
  test("re-nests a mark that landed inside a link", () => {
    const body = "- Send [[<Fact n=\"4\" v=\"ok\">Tidal Router</Fact>]]-class engines onward.\n";
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe('- Send <Fact n="4" v="ok">[[Tidal Router]]</Fact>-class engines onward.\n');
    expect(r.repaired).toHaveLength(1);
    expect(r.residual).toHaveLength(0);
  });

  test("a clean body is returned byte-for-byte with nothing reported", () => {
    const body = 'Send <Fact n="1" v="ok">[[Tidal Router]]</Fact> onward.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(0);
  });

  test("a FENCED example of the broken shape is documentation — left alone", () => {
    const body = ["How the bug looked:", "", "```markdown", '[[<Fact n="4" v="ok">A Page</Fact>]]', "```", ""].join("\n");
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(0);
  });

  test("REPRO: an INLINE CODE nesting is REPAIRED — the renderer resolves it, so it is live damage", () => {
    // A backticked `[[…]]` is substituted before `formatWebHtml` sees the backtick,
    // so this shape renders as a DEAD `wiki-link-missing` inside a `<code>` — not
    // documentation. Skipping it left the backstop blind to exactly the damage the
    // apply route's client-echoed edits can produce.
    const body = 'The broken shape is `[[<Fact n="4" v="ok">A Page</Fact>]]` — do not ship it.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe('The broken shape is `<Fact n="4" v="ok">[[A Page]]</Fact>` — do not ship it.\n');
    expect(r.repaired).toHaveLength(1);
    expect(r.residual).toHaveLength(0);
    expect(r.body).not.toContain("[[<Fact");
  });

  test("a line mixing a live nesting with a backticked one repairs BOTH", () => {
    const body =
      'Live: [[<Fact n="1" v="ok">A Page</Fact>]] and coded: `[[<Fact n="2" v="ok">B Page</Fact>]]`.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(
      'Live: <Fact n="1" v="ok">[[A Page]]</Fact> and coded: `<Fact n="2" v="ok">[[B Page]]</Fact>`.\n',
    );
    expect(r.repaired).toHaveLength(2);
    expect(r.residual).toHaveLength(0);
  });

  test("REPRO: a residual excerpt is located in the REWRITTEN line, so it greps the file", () => {
    // The rewrite shortens the line by 4 per repair (the brackets move inside the
    // tags), so an offset taken before the rewrite indexes a string that is in no
    // file. Here the unrepairable occurrence sits AFTER a repaired one, which is the
    // only arrangement that can tell the two offsets apart.
    const body =
      'Good: [[<Fact n="2" v="ok">Q</Fact>]] then bad: [[<Fact n="1" v="ok>P</Fact>]] end.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.repaired).toHaveLength(1);
    expect(r.residual).toHaveLength(1);
    expect(r.residual[0]!).toStartWith('[[<Fact n="1" v="ok>P</Fact>]]');
    // The excerpt is quoted from what is on disk after the repair.
    expect(r.body).toContain(r.residual[0]!);
  });

  test("REPRO: an attribute value carrying a `>` is parsed WHOLE, never cut open", () => {
    // `[^>\n]*` stopped at the `>` inside the quotes, so the rewrite moved the
    // brackets into the attribute and logged the result as repaired.
    const body = '[[<Fact n="1" v="ok" title="a>b">P</Fact>]]\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe('<Fact n="1" v="ok" title="a>b">[[P]]</Fact>\n');
    expect(r.body).not.toContain('title="a>[[');
    expect(r.residual).toHaveLength(0);
  });

  test("a tag whose quotes do not BALANCE is reported, never rewritten", () => {
    const body = '[[<Fact n="1" v="ok>P</Fact>]]\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(1);
  });

  test("REPRO: an EMPTY inner text does not become a bare [[]]", () => {
    const body = '[[<Fact n="1" v="ok"></Fact>]]\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.body).not.toContain("[[]]");
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(1);
  });

  test("REPRO: a trailing `]]]` does not leave an orphan bracket", () => {
    const body = '[[<Fact n="1" v="ok">P</Fact>]]]\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(1);
  });

  test("REPRO: YAML frontmatter is skipped, exactly as the lint check skips it", () => {
    // The repair rewriting a `title:` the lint never scans is the two halves
    // disagreeing about the same bytes.
    const body = '---\ntitle: "[[<Fact n=\\"1\\" v=\\"ok\\">A Page</Fact>]]"\n---\n\nBody text.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(0);
  });
});
