/**
 * The Discuss locator on the server side: selections and the context the
 * client read around them (as the reader shows text: no markup), located as
 * line ranges in the raw file. End-to-end cases through the reader's render
 * and the client's own reading are in
 * `src/dashboard/views/components/wiki-discuss-cases.test.ts`; the collapse's
 * parity with the render is `wiki-discuss-parity.test.ts` beside it.
 */
import { describe, expect, test } from "bun:test";
import { stripFactWrappers, stripFactWrappersWithMap } from "../format/markdown-ast.ts";
import {
  collapseForLocate,
  CONTEXT_FULL_MIN,
  CONTEXT_PARTIAL_MIN,
  contextAccepts,
  LOCATE_EDGE_CHARS,
  locatePassage,
  pageHeadings,
  sideState,
  type SideState,
} from "./discuss-locate.ts";

/** A page whose line N (1-based) is `lines[N-1]`. */
const page = (...lines: string[]) => lines.join("\n") + "\n";

const PAGE = page(
  "---", //                                                     1
  "title: Harbour plan",
  "---",
  "",
  "# Harbour plan", //                                           5
  "",
  "## Brief",
  "",
  "Kari Nordmann keeps the **winter** timetable in `harbour.yaml`.",
  "", //                                                        10
  "Boats leave early. The pier opens at six.",
  "",
  "## Design",
  "",
  "Ferries run late. The pier opens at six.", //                15
  "",
  "Bells ring at noon.",
);

describe("the agreement rule, one side", () => {
  test("the constants", () => {
    expect(CONTEXT_FULL_MIN).toBe(12);
    expect(CONTEXT_PARTIAL_MIN).toBe(8);
  });

  // sideState's whole state table. L: key characters the client sent; S: the
  // source's characters in the window; d: where a character first differs
  // (within both), or null. The source running out before the client's text,
  // and the source going on past the client's page edge, are disagreements at
  // that position too: never `full` or `open` on their own.
  const ROWS: [L: number, clientEdge: boolean, S: number, sourceEdge: boolean, d: number | null, want: SideState][] = [
    // L = 0: nothing sent.
    [0, false, 0, false, null, "open"],
    [0, false, 0, true, null, "open"],
    [0, false, 30, false, null, "open"],
    [0, false, 30, true, null, "open"],
    [0, true, 0, true, null, "full"], // both at the page's edge
    [0, true, 0, false, null, "contradicted"], // the client's page ends, the source goes on
    [0, true, 30, false, null, "contradicted"],
    [0, true, 30, true, null, "contradicted"],
    // L = 1–7.
    [5, false, 5, false, null, "agrees"],
    [5, false, 30, false, null, "agrees"],
    [5, false, 5, true, null, "agrees"],
    [5, false, 3, true, null, "contradicted"], // the source ran out at 3
    [5, false, 0, true, null, "contradicted"],
    [5, false, 30, false, 2, "contradicted"],
    [5, true, 5, true, null, "full"],
    [5, true, 5, false, null, "contradicted"],
    [5, true, 30, false, null, "contradicted"],
    [5, true, 30, true, null, "contradicted"],
    [5, true, 3, true, null, "contradicted"],
    // L = 8–11.
    [10, false, 10, false, null, "agrees"],
    [10, false, 30, false, null, "agrees"],
    [10, false, 9, true, null, "partial"], // the source ran out at 9
    [10, false, 5, true, null, "contradicted"],
    [10, false, 30, false, 8, "partial"],
    [10, false, 30, false, 7, "contradicted"],
    [10, true, 10, true, null, "full"],
    [10, true, 30, false, null, "partial"], // the source goes on past the client's edge, at 10
    [10, true, 9, true, null, "partial"],
    // L = 12–47.
    [20, false, 20, false, null, "full"],
    [20, false, 30, false, null, "full"],
    [20, false, 20, true, null, "full"],
    [20, false, 15, true, null, "partial"],
    [20, false, 11, true, null, "partial"],
    [20, false, 7, true, null, "contradicted"],
    [20, false, 0, true, null, "contradicted"],
    [20, false, 30, false, 12, "partial"],
    [20, false, 30, false, 8, "partial"],
    [20, false, 30, false, 3, "contradicted"],
    [20, true, 20, true, null, "full"],
    [20, true, 30, false, null, "partial"],
    [20, true, 30, true, null, "partial"],
    [20, true, 15, true, null, "partial"],
    [20, true, 15, true, 5, "contradicted"],
    // L = 48, the whole near window.
    [48, false, 48, false, null, "full"],
    [48, false, 48, true, null, "full"],
    [48, false, 30, true, null, "partial"],
    [48, false, 5, true, null, "contradicted"],
    [48, false, 48, false, 40, "partial"],
    [48, false, 48, false, 0, "contradicted"],
    [48, true, 48, true, null, "full"],
    [48, true, 48, false, null, "partial"],
  ];
  const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const [L, clientEdge, S, sourceEdge, d, want] of ROWS) {
    test(`L=${L} client${clientEdge ? "@edge" : ""} S=${S} source${sourceEdge ? "@edge" : ""} d=${d}: ${want}`, () => {
      // Built for the right side (compared from the start); the left side is the mirror.
      const client = ALPHA.slice(0, L);
      let source = ALPHA.slice(0, S);
      if (d !== null) source = source.slice(0, d) + "#" + source.slice(d + 1);
      const rev = (s: string) => [...s].reverse().join("");
      expect(sideState(client, source, "right", clientEdge, sourceEdge)).toBe(want);
      expect(sideState(rev(client), rev(source), "left", clientEdge, sourceEdge)).toBe(want);
    });
  }
  test("accepted: one side full and neither contradicted", () => {
    expect(contextAccepts("full", "full")).toBe(true);
    expect(contextAccepts("full", "partial")).toBe(true);
    expect(contextAccepts("open", "full")).toBe(true);
    expect(contextAccepts("full", "contradicted")).toBe(false);
    expect(contextAccepts("partial", "partial")).toBe(false);
    expect(contextAccepts("agrees", "open")).toBe(false);
  });
});

describe("one match: taken only when its context agrees", () => {
  test("a selection over markup, with the reader's context", () => {
    const r = locatePassage(PAGE, {
      selection: "keeps the winter timetable in harbour.yaml.",
      before: "Brief\nKari Nordmann ",
      after: "Boats leave early. The pier opens at six.",
      heading: "Brief",
      stripTitle: "Harbour plan",
    });
    expect(r).toMatchObject({ found: "exact", reason: null, tier: "whole", matches: 1, fromLine: 9, toLine: 9 });
    expect(PAGE.slice(r.rawFrom!, r.rawTo!)).toBe("keeps the **winter** timetable in `harbour.yaml`.");
  });
  test("finding 1: the source's only match, whose neighbours disagree with the client's, is not taken", () => {
    // The client selected these words somewhere the source does not hold them (chrome).
    const r = locatePassage(PAGE, { selection: "Bells ring at noon.", before: "Lane head: owner", after: "Waiting on the harbour", heading: "Design" });
    expect(r).toMatchObject({ found: "section", reason: "no-agreement", matches: 1, fromLine: 13, toLine: 17, candidates: [17] });
    expect(r.section).toEqual({ heading: "Design", fromLine: 13, toLine: 17 });
  });
  test("no context at all: nothing to agree with, so no exact line", () => {
    expect(locatePassage(PAGE, { selection: "Bells ring at noon." }).found).toBe("none");
  });
  test("atStart with more text than the near window: the window's slice is not at the edge, so it still agrees in full", () => {
    const md = page("Kari Nordmann keeps the winter timetable for every boat in the harbour office.", "", "The pier opens at six.", "", "Bells ring at noon on every day.");
    const before = "Kari Nordmann keeps the winter timetable for every boat in the harbour office.";
    expect(before.length).toBeGreaterThan(48);
    const r = locatePassage(md, { selection: "The pier opens at six.", before, atStart: true, after: "Bells" });
    expect(r).toMatchObject({ found: "exact", fromLine: 3, toLine: 3 });
    // The mirror at the page's end.
    const end = page("# T", "", "Bells ring.", "", "The pier opens at six.", "", before);
    expect(locatePassage(end, { selection: "The pier opens at six.", before: "ring.", after: before, atEnd: true })).toMatchObject({ found: "exact", fromLine: 5, toLine: 5 });
  });
  test("a page of under 3,000 characters still gets the passage's own line", () => {
    const short = page("# Short", "", "One line.", "", "The second line here.", "", "Third.");
    expect(short.length).toBeLessThan(3000);
    const r = locatePassage(short, { selection: "The second line here.", before: "Short One line.", after: "Third.", atEnd: true });
    expect(r).toMatchObject({ found: "exact", fromLine: 5, toLine: 5 });
  });
});

describe("several matches: the context chooses", () => {
  test("a sentence twice: each copy by its neighbours", () => {
    const first = locatePassage(PAGE, { selection: "The pier opens at six.", before: "harbour.yaml. Boats leave early. ", after: "Design Ferries run late." });
    expect(first).toMatchObject({ found: "exact", matches: 2, fromLine: 11, toLine: 11 });
    const second = locatePassage(PAGE, { selection: "The pier opens at six.", before: "Design Ferries run late. ", after: "Bells ring at noon.", atEnd: true });
    expect(second).toMatchObject({ found: "exact", matches: 2, fromLine: 15, toLine: 15 });
  });
  test("when no copy's neighbours agree: the heading's section, with every match's line", () => {
    const r = locatePassage(PAGE, { selection: "The pier opens at six.", before: "something else entirely", after: "and more of it here too", heading: "Design" });
    expect(r).toMatchObject({ found: "section", reason: "no-agreement", ambiguous: true, matches: 2, fromLine: 13, toLine: 17, candidates: [11, 15] });
  });
  test("no heading to fall back on: no range, never the head of the page", () => {
    const r = locatePassage(PAGE, { selection: "The pier opens at six.", before: "something else entirely", after: "and more of it here too" });
    expect(r).toMatchObject({ found: "none", fromLine: null, toLine: null, section: null, candidates: [11, 15] });
  });
  test("copies alike in the near context: the far context chooses the one that agrees in full", () => {
    const tail = "and the harbour office keeps the book.";
    const md = page("# Log", "", `Alpha wrote: check the ropes, ${tail}`, "", `Beta wrote: check the ropes, ${tail}`, "", "End.");
    const r = locatePassage(md, { selection: "check the ropes,", before: "Log Alpha wrote: ", after: `${tail} Beta wrote: check the ropes, ${tail} End.`, atEnd: true });
    // Both near contexts agree on the right; only the first agrees in full far out on both sides.
    expect(r).toMatchObject({ found: "exact", fromLine: 3, toLine: 3 });
  });
  test("copies alike as far as the context reads: ambiguous", () => {
    const md = page("# Log", "", ...Array.from({ length: 6 }, () => "- Same line again."));
    const r = locatePassage(md, { selection: "Same line again.", before: "Same line again. Same line again.", after: "Same line again. Same line again.", heading: "Log" });
    expect(r).toMatchObject({ found: "section", reason: "ambiguous", ambiguous: true, candidates: [3, 4, 5, 6, 7, 8] });
  });
});

describe("the section fallback names a section only when it is the right one", () => {
  const PHASES = page(
    "## Phase 1", //                                              1
    "",
    "### Status",
    "",
    "Not started, waiting on the harbour office.", //             5
    "",
    "## Phase 2",
    "",
    "### Status",
    "", //                                                       10
    "Not started, waiting on the harbour office.",
  );
  test("a heading text that repeats: no section, every match's line listed", () => {
    const r = locatePassage(PHASES, { selection: "Not started, waiting on the harbour office.", before: "words the page never had", after: "nor these either at all", heading: "Status" });
    expect(r).toMatchObject({ found: "none", reason: "no-agreement", fromLine: null, toLine: null, section: null, candidates: [5, 11] });
  });
  test("a heading text that repeats, with no match: no section", () => {
    const r = locatePassage(PHASES, { selection: "Nothing like this is on the page.", heading: "Status" });
    expect(r).toMatchObject({ found: "none", reason: "no-match", section: null, candidates: [] });
  });
  test("one heading of that text whose section holds no match: no section", () => {
    const md = page("## Brief", "", "Intro words.", "", "## Design", "", "The pier opens at six.");
    const r = locatePassage(md, { selection: "The pier opens at six.", before: "words the page never had", after: "nor these", heading: "Brief" });
    expect(r).toMatchObject({ found: "none", candidates: [7], section: null });
  });
});

describe("a heading inside a Diagram's or an Embed's body is no section boundary", () => {
  test("pageHeadings leaves it out, and the section above runs past the body", () => {
    const md = page("## Flow", "", '<Embed src="demo.html">', "", "## Fallback notes", "", "Open the demo in a browser.", "", "</Embed>", "", "The pier opens at six.", "", "## Next", "", "Later.");
    expect(pageHeadings(md).map((h) => [h.text, h.fromLine, h.toLine])).toEqual([
      ["Flow", 1, 11],
      ["Next", 13, 15],
    ]);
    const r = locatePassage(md, { selection: "The pier opens at six.", edge: "added", heading: "Flow" });
    expect(r).toMatchObject({ found: "section", fromLine: 1, toLine: 11 });
    // The hidden heading cannot be the named section.
    expect(locatePassage(md, { selection: "Open the demo in a browser.", edge: "added", heading: "Fallback notes" })).toMatchObject({ found: "none", section: null });
  });
  test("the same in a Diagram's body", () => {
    const md = page("## Flow", "", '<Diagram src="flow.diagram.json" caption="c">', "", "### Legend", "", "boats", "", "</Diagram>", "", "The pier opens at six.");
    expect(pageHeadings(md).map((h) => [h.text, h.fromLine, h.toLine])).toEqual([["Flow", 1, 11]]);
  });
});

describe("the edges tier: the first and last LOCATE_EDGE_CHARS", () => {
  const LONG = "The new timetable for the winter season was drafted by Kari Nordmann in October, and the fix in PR #12 landed on Tuesday, after which the harbour master signed it off before the evening ferry left the north pier for the island.";
  const md = page("# Chips", "", "Opening line of the page.", "", LONG, "", "Closing line of the page.");
  const withChip = LONG.replace("PR #12", "PR #12 merged ✓");
  test("a selection holding text the source does not (a chip): found by its two ends, the range covers it all", () => {
    expect(withChip.length).toBeGreaterThan(LOCATE_EDGE_CHARS * 2);
    const r = locatePassage(md, { selection: withChip, before: "Chips Opening line of the page.", after: "Closing line of the page.", atEnd: true });
    expect(r).toMatchObject({ found: "exact", tier: "edges", fromLine: 5, toLine: 5 });
    expect(md.slice(r.rawFrom!, r.rawTo!)).toBe(LONG);
  });
  test("a start without an end is a miss, not a start-only range", () => {
    const r = locatePassage(md, { selection: withChip.slice(0, -40) + " and then words the file never had at all, none of them.", before: "Opening line of the page.", after: "Closing line of the page.", heading: "Chips" });
    expect(r).toMatchObject({ found: "section", reason: "no-match", tier: null });
  });
  test("the end must follow the start within the bound", () => {
    const far = page("# Far", "", LONG.slice(0, 120), "", ...Array.from({ length: 30 }, (_, k) => `Filler line ${k} about the quiet harbour piers.`), "", LONG.slice(120));
    const r = locatePassage(far, { selection: withChip, before: "Far", after: "", atEnd: true, heading: "Far" });
    expect(r.found).not.toBe("exact");
  });
  test("an end that sits before the start is not taken", () => {
    const back = page("# Back", "", LONG.slice(-100), "", LONG.slice(0, 120), "", "Closing.");
    const r = locatePassage(back, { selection: withChip, before: "Back", after: "Closing.", atEnd: true, heading: "Back" });
    expect(r.found).not.toBe("exact");
  });
  test("two starts: each is a candidate, and the context chooses (never simply the first)", () => {
    const two = page("# Two", "", "Alpha:", "", LONG, "", "Beta:", "", LONG, "", "End.");
    const r = locatePassage(two, { selection: withChip, before: "Beta:", after: "End.", atEnd: true });
    // Three candidates: each start with the end after it, and the first start
    // with the second copy's end (inside the bound); the context takes one.
    expect(r).toMatchObject({ found: "exact", tier: "edges", matches: 3, fromLine: 9, toLine: 9 });
  });
});

describe("what the client marks", () => {
  test("a selection that starts or ends in reader-added text goes to the section, even with one agreeing match", () => {
    const r = locatePassage(PAGE, { selection: "Bells ring at noon.", before: "Ferries run late. The pier opens at six.", atEnd: true, edge: "added", heading: "Design" });
    expect(r).toMatchObject({ found: "section", reason: "added", fromLine: 13 });
  });
  test("a selection over reordered lanes goes to the section", () => {
    expect(locatePassage(PAGE, { selection: "Bells ring at noon.", edge: "reordered", heading: "Design" })).toMatchObject({ found: "section", reason: "reordered" });
  });
  test("text the source does not hold: the section, or nothing, with no candidates", () => {
    expect(locatePassage(PAGE, { selection: "Nothing like this sentence is on the page.", heading: "Brief" })).toMatchObject({ found: "section", reason: "no-match", matches: 0, fromLine: 7, toLine: 11 });
    expect(locatePassage(PAGE, { selection: "Nothing like this sentence is on the page." })).toMatchObject({ found: "none", fromLine: null, section: null });
  });
});

describe("the collapse and the headings", () => {
  test("frontmatter, the repeated title and markup are not in the collapse", () => {
    expect(collapseForLocate(page("---", "title: T", "---", "", "# T", "", "Body **bold** text."), { stripTitle: "T" }).text).toBe("bodyboldtext.");
  });
  test("finding 7: on a CRLF page the repeated title is still dropped and the headings are found", () => {
    const crlf = page("---", "title: T", "---", "", "# T", "", "## One", "", "Body.", "", "## C#", "", "Sharp.").replace(/\n/g, "\r\n");
    expect(collapseForLocate(crlf, { stripTitle: "T" }).text).toBe("onebody.csharp.");
    expect(pageHeadings(crlf).map((h) => [h.level, h.text, h.fromLine, h.toLine])).toEqual([
      [1, "T", 5, 13],
      [2, "One", 7, 9],
      [2, "C#", 11, 13],
    ]);
  });
  test("a closing run of # needs white space before it", () => {
    expect(pageHeadings(page("## C#", "", "## Done ##", "", "#### F# notes")).map((h) => h.text)).toEqual(["C#", "Done", "F# notes"]);
  });
  test("a tag the reader does not parse is text, as the reader shows it: over several lines, a bare attribute, single quotes, unclosed", () => {
    expect(collapseForLocate(page("<Callout", '  title="Long tag">', "", "Inside.", "", "</Callout>")).text).toBe('<callouttitle="longtag">inside.</callout>'.replace(/[<>]/g, ""));
    expect(collapseForLocate(page('<Fold title="D" open>', "", "Body.", "", "</Fold>")).text).toBe('foldtitle="d"openbody./fold');
    expect(collapseForLocate(page("<Fold title='D'>", "", "Body.", "", "</Fold>")).text).toBe("foldtitle='d'body./fold");
    expect(collapseForLocate(page('<Callout title="x">', "", "Never closed.")).text).toBe('callouttitle="x"neverclosed.');
    // Parsed: an indented opener and its closer, and a nested same-name pair.
    expect(collapseForLocate(page('  <Callout title="x">', "", "In.", "", "  </Callout>")).text).toBe("xin.");
    expect(collapseForLocate(page('<Callout title="a">', '<Callout title="b">', "In.", "</Callout>", "</Callout>")).text).toBe("abin.");
  });
  test("a Diagram's and an Embed's body are not in the collapse (the reader shows none of their words)", () => {
    const md = page("Before.", "", '<Diagram src="a.diagram.json" caption="c">', "", "boats to the pier", "", "</Diagram>", "", '<Embed src="x.html">', "fallback", "</Embed>", "", "After.");
    expect(collapseForLocate(md).text).toBe("before.after.");
    expect(collapseForLocate(page('<Diagram src="a.diagram.json" />', "", "Shown.")).text).toBe("shown.");
  });
  test("headings with their sections' line ranges, fenced lines skipped", () => {
    const md = page("# A", "", "text", "", "```", "# not a heading", "```", "", "## B", "", "b text", "", "# C", "c");
    expect(pageHeadings(md)).toEqual([
      { level: 1, text: "A", fromLine: 1, toLine: 11 },
      { level: 2, text: "B", fromLine: 9, toLine: 11 },
      { level: 1, text: "C", fromLine: 13, toLine: 14 },
    ]);
  });
  test("fact wrappers: the strip with a map strips what the strip strips, and lines stay the file's", () => {
    const FACTS = page("# Facts", "", 'Before <Fact n="1" v="ok">a checked claim</Fact> after.', "", '<Fact n="2" v="warn">', "A whole checked paragraph.", "</Fact>", "", "The last line.");
    expect(stripFactWrappersWithMap(FACTS).text).toBe(stripFactWrappers(FACTS));
    const { text, map } = stripFactWrappersWithMap(FACTS);
    for (let i = 0; i < text.length; i++) expect(FACTS[map[i]!]).toBe(text[i]!);
    expect(locatePassage(FACTS, { selection: "A whole checked paragraph.", before: "Before a checked claim after.", after: "The last line.", atEnd: true })).toMatchObject({ found: "exact", fromLine: 6, toLine: 6 });
  });
});
