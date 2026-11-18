/**
 * The Discuss locator's cases: selections as the reader shows them, located
 * as line ranges in the raw file. The collapse's parity with the reader's
 * render is `src/dashboard/views/components/wiki-discuss-parity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { stripFactWrappers, stripFactWrappersWithMap } from "../format/markdown-ast.ts";
import { collapseForLocate, locatePassage, pageHeadings } from "./discuss-locate.ts";

/** A page whose line N (1-based) is `lines[N-1]`. */
const page = (...lines: string[]) => lines.join("\n") + "\n";

/** Lines of filler prose, so a page is past Explain's 3,000-character whole-page cut. */
const filler = (n: number) => Array.from({ length: n }, (_, k) => `Filler sentence ${k} about the harbour and its many quiet piers.`);

const PAGE = page(
  "---", //                                                     1
  "title: Harbour plan",
  "---",
  "",
  "# Harbour plan", //                                           5
  "",
  "## Brief",
  "",
  "Kari Nordmann keeps the **winter** timetable in `harbour.yaml`, see [the docs](https://example.com/d), [[ferry-plan]] and [[ferry-plan|the ferry plan]].",
  "", //                                                        10
  "- **R2, behind.** The page's `status_date` is older than the newest merge.",
  "- The night route is unchanged.",
  "",
  "The pier opens at six.",
  "", //                                                        15
  '<Fold title="Design" summary="three routes, one new stop">',
  "",
  "## Design",
  "",
  '<Callout tone="warn" title="Watch the tide">', //            20
  "",
  "Low water closes the north pier.",
  "",
  "</Callout>",
  "", //                                                        25
  "| Route | Stops |",
  "|---|---|",
  "| Summer | `4` |",
  "",
  "The pier opens at six.", //                                  30
  "",
  "</Fold>",
  "",
  "## Section with a repeat",
  "", //                                                        35
  "Bells ring at noon.",
  "",
  "Bells ring at noon.",
  "",
  ...filler(50), //                                             40–89
);

describe("one match: the passage's own lines", () => {
  test("a selection over bold, inline code, a link, a bare and a labelled wikilink, as the reader shows them", () => {
    const sel = "Kari Nordmann keeps the winter timetable in harbour.yaml, see the docs, ferry-plan and the ferry plan.";
    expect(locatePassage(PAGE, { selection: sel })).toMatchObject({ found: "one", tier: "whole", matches: 1, fromLine: 9, toLine: 9 });
  });
  test("a bullet that opens in bold and holds inline code", () => {
    const sel = "R2, behind. The page's status_date is older than the newest merge.";
    expect(locatePassage(PAGE, { selection: sel })).toMatchObject({ found: "one", fromLine: 11, toLine: 11 });
  });
  test("across two list items, with the newlines a selection carries", () => {
    const sel = "older than the newest merge.\nThe night route";
    expect(locatePassage(PAGE, { selection: sel })).toMatchObject({ found: "one", fromLine: 11, toLine: 12 });
  });
  test("inside a Fold and a component", () => {
    expect(locatePassage(PAGE, { selection: "Low water closes the north pier." })).toMatchObject({ found: "one", fromLine: 22, toLine: 22 });
  });
  test("a Fold's summary maps to the Fold's tag line", () => {
    expect(locatePassage(PAGE, { selection: "three routes, one new stop" })).toMatchObject({ found: "one", fromLine: 16, toLine: 16 });
  });
  test("a table row", () => {
    expect(locatePassage(PAGE, { selection: "Summer\t4" })).toMatchObject({ found: "one", fromLine: 28, toLine: 28 });
  });
  test("a page of under 3,000 characters still gets the passage's line, not the page", () => {
    const short = page("# Short", "", "One line.", "", "The second line here.", "", "Third.");
    expect(short.length).toBeLessThan(3000);
    expect(locatePassage(short, { selection: "The second line here." })).toMatchObject({ found: "one", fromLine: 5, toLine: 5 });
  });
});

describe("fact wrappers: line numbers stay the file's", () => {
  const FACTS = page(
    "# Facts",
    "",
    'Before <Fact n="1" v="ok">a checked claim</Fact> after.',
    "",
    '<Fact n="2" v="warn">',
    "A whole checked paragraph.",
    "</Fact>",
    "",
    "The last line.",
  );
  test("an inline wrapper", () => {
    expect(locatePassage(FACTS, { selection: "Before a checked claim after." })).toMatchObject({ fromLine: 3, toLine: 3 });
  });
  test("a block wrapper's tag lines are skipped, the lines after them keep their numbers", () => {
    expect(locatePassage(FACTS, { selection: "A whole checked paragraph." })).toMatchObject({ fromLine: 6, toLine: 6 });
    expect(locatePassage(FACTS, { selection: "The last line." })).toMatchObject({ fromLine: 9, toLine: 9 });
  });
  test("the strip with a map strips what the strip strips", () => {
    expect(stripFactWrappersWithMap(FACTS).text).toBe(stripFactWrappers(FACTS));
    const { text, map } = stripFactWrappersWithMap(FACTS);
    for (let i = 0; i < text.length; i++) expect(FACTS[map[i]!]).toBe(text[i]!);
  });
});

describe("a live-fact chip in the selection", () => {
  const CHIP = page("# Chips", "", ...filler(3), "", "The new timetable for the winter season was drafted by Kari Nordmann in October, and the fix in PR #12 landed on Tuesday, after which the harbour master signed it off before the evening ferry left the north pier for the island.", "", ...filler(3));
  test("without the chip's text (the reader leaves it out): the whole selection", () => {
    const sel = "The new timetable for the winter season was drafted by Kari Nordmann in October, and the fix in PR #12 landed on Tuesday, after which the harbour master signed it off before the evening ferry left the north pier for the island.";
    expect(locatePassage(CHIP, { selection: sel })).toMatchObject({ found: "one", tier: "whole", fromLine: 7, toLine: 7 });
  });
  test("with it, a long selection still finds its start and end by its first and last 80 characters", () => {
    const sel = "The new timetable for the winter season was drafted by Kari Nordmann in October, and the fix in PR #12 merged ✓ landed on Tuesday, after which the harbour master signed it off before the evening ferry left the north pier for the island.";
    expect(locatePassage(CHIP, { selection: sel })).toMatchObject({ found: "one", tier: "prefix", fromLine: 7, toLine: 7 });
  });
  test("with it, a short selection falls back to its heading's section, never the head of the page", () => {
    const r = locatePassage(CHIP, { selection: "PR #12 merged ✓ landed", heading: "Chips" });
    expect(r).toMatchObject({ found: "section", fromLine: 1 });
    expect(locatePassage(CHIP, { selection: "PR #12 merged ✓ landed" })).toMatchObject({ found: "none", fromLine: null, toLine: null });
  });
});

describe("several matches", () => {
  test("a sentence twice on the page: the client's occurrence number picks one when its total agrees", () => {
    expect(locatePassage(PAGE, { selection: "The pier opens at six.", occurrence: 1, total: 2 })).toMatchObject({ found: "occurrence", matches: 2, fromLine: 30, toLine: 30 });
    expect(locatePassage(PAGE, { selection: "The pier opens at six.", occurrence: 0, total: 2 })).toMatchObject({ found: "occurrence", fromLine: 14, toLine: 14 });
  });
  test("when the counts disagree: the heading's section, ambiguous, with every match's line", () => {
    const r = locatePassage(PAGE, { selection: "The pier opens at six.", occurrence: 1, total: 3, heading: "Design" });
    expect(r).toMatchObject({ found: "section", ambiguous: true, matches: 2, fromLine: 18, candidates: [14, 30] });
    expect(locatePassage(PAGE, { selection: "The pier opens at six.", occurrence: 5, total: 2, heading: "Design" }).found).toBe("section");
    expect(locatePassage(PAGE, { selection: "The pier opens at six.", total: 2, heading: "Design" }).found).toBe("section");
  });
  test("twice in one section: the occurrence picks, a disagreement gives that section", () => {
    expect(locatePassage(PAGE, { selection: "Bells ring at noon.", occurrence: 1, total: 2 })).toMatchObject({ fromLine: 38, toLine: 38 });
    expect(locatePassage(PAGE, { selection: "Bells ring at noon.", heading: "Section with a repeat" })).toMatchObject({ found: "section", ambiguous: true, fromLine: 34, toLine: 89 });
  });
  test("no heading to fall back on: no range, never the head of the page", () => {
    expect(locatePassage(PAGE, { selection: "The pier opens at six." })).toMatchObject({ found: "none", fromLine: null, toLine: null, candidates: [14, 30] });
  });
});

describe("not in the source", () => {
  test("a selection the file does not hold: the heading's section, or nothing", () => {
    expect(locatePassage(PAGE, { selection: "Nothing like this sentence is on the page.", heading: "Brief" })).toMatchObject({ found: "section", ambiguous: false, matches: 0, fromLine: 7, toLine: 16 });
    const none = locatePassage(PAGE, { selection: "Nothing like this sentence is on the page." });
    expect(none).toMatchObject({ found: "none", fromLine: null, toLine: null });
  });
});

describe("the collapse and the headings", () => {
  test("frontmatter, the repeated title and markup are not in the collapse", () => {
    const c = collapseForLocate(page("---", "title: T", "---", "", "# T", "", "Body **bold** text."), { stripTitle: "T" });
    expect(c.text).toBe("bodyboldtext.");
  });
  test("a multi-line component tag is markup, and the text after it maps to its own line", () => {
    const md = page("# M", "", "<Callout", '  tone="warn"', '  title="Long tag">', "", "Inside.", "", "</Callout>");
    expect(locatePassage(md, { selection: "Inside." })).toMatchObject({ fromLine: 7, toLine: 7 });
    expect(locatePassage(md, { selection: "Long tag" })).toMatchObject({ fromLine: 5, toLine: 5 });
  });
  test("headings with their sections' line ranges, fenced lines skipped", () => {
    const md = page("# A", "", "text", "", "```", "# not a heading", "```", "", "## B", "", "b text", "", "# C", "c");
    expect(pageHeadings(md)).toEqual([
      { level: 1, text: "A", fromLine: 1, toLine: 11 },
      { level: 2, text: "B", fromLine: 9, toLine: 11 },
      { level: 1, text: "C", fromLine: 13, toLine: 14 },
    ]);
  });
});
