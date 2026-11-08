/**
 * The section bar's pure parts on the real render: `renderWikiHtml` output in
 * a happy-dom `Window` of the test's own (no globals installed), then
 * `sectionTargets`/`sectionTitle`, and the current-section rule. The bar's
 * scroll, menu and fold behaviour is layout: `e2e/wiki-section-bar.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderWikiHtml } from "../../../wiki/render.ts";
import { currentSection, sectionHolding, sectionTargets, sectionTitle } from "./wiki-section-bar.ts";

/** The article as the reader renders it, and its section titles. */
function sections(md: string, visible?: (el: Element) => boolean): string[] {
  const doc = new Window().document;
  const article = doc.createElement("div");
  article.className = "wiki-article";
  article.innerHTML = renderWikiHtml(md, () => undefined, { readerShapes: true });
  doc.body.appendChild(article);
  return sectionTargets(article as unknown as Element, visible).map(sectionTitle);
}

describe("sectionTargets", () => {
  test("the top heading level: `##` sections, their `###` not counted", () => {
    expect(sections("## One\n\ntext\n\n### Sub\n\n## Two\n\n## Three\n")).toEqual(["One", "Two", "Three"]);
  });
  test("a lone `#` title first in the body is the title: the sections are the `##` under it", () => {
    expect(sections("# Title\n\nlead\n\n## A\n\n## B\n\n### b1\n\n## C\n")).toEqual(["A", "B", "C"]);
    expect(sections("# Title\n\nlead\n")).toEqual([]);
    expect(sections('# Title\n\n<Fold title="A">\n\na\n\n</Fold>\n')).toEqual(["A"]);
  });
  test("`#` in the body is the top level when present", () => {
    expect(sections("# A\n\n## a1\n\n# B\n\n# C\n")).toEqual(["A", "B", "C"]);
  });
  test("two `#` headings, the first leading, over three or more `##`: titles, the `##` are the sections (log.md)", () => {
    expect(sections("# Activity Log\n\n## e1\n\n## e2\n\n# Log\n\n## e3\n\n## e4\n")).toEqual(["e1", "e2", "e3", "e4"]);
    expect(sections("# Activity Log\n\n# Wiki Log\n\n## e1\n\n## e2\n\n## e3\n")).toEqual(["e1", "e2", "e3"]);
  });
  test("two `#` over fewer than three `##`, or text before the first `#`: the `#` stay the sections", () => {
    expect(sections("# A\n\n## a1\n\n# B\n\n## b1\n")).toEqual(["A", "B"]);
    expect(sections("## lead\n\n# A\n\n## a1\n\n## a2\n\n# B\n")).toEqual(["A", "B"]);
  });
  test("a lone first heading below `#` is a section, not a title", () => {
    expect(sections("## Summary\n\ntext\n\n### A\n\n### B\n\n### C\n")).toEqual(["Summary"]);
    expect(sections('## Brief\n\n<Fold title="A">\n\na\n\n</Fold>\n\n<Fold title="B">\n\nb\n\n</Fold>\n')).toEqual(["Brief", "A", "B"]);
  });
  test("each top-level fold's summary, in document order with the headings; the fold's own heading counted once", () => {
    const md = [
      "## Brief",
      "",
      "text",
      "",
      '<Fold title="Decisions" summary="D1–D5">',
      "",
      "## Decisions",
      "",
      "- D1",
      "",
      '<Fold title="Inner">',
      "",
      "inner",
      "",
      "</Fold>",
      "",
      "</Fold>",
      "",
      '<Fold title="PR slate">',
      "",
      "## PR slate",
      "",
      "### At a glance",
      "",
      "</Fold>",
      "",
      "## Sources",
      "",
    ].join("\n");
    expect(sections(md)).toEqual(["Brief", "Decisions", "PR slate", "Sources"]);
  });
  test("a page of folds only", () => {
    expect(sections('<Fold title="A">\n\na\n\n</Fold>\n\n<Fold title="B">\n\nb\n\n</Fold>\n\n<Fold title="C">\n\nc\n\n</Fold>\n')).toEqual(["A", "B", "C"]);
  });
  test("headings inside a component (a Callout) are not sections", () => {
    expect(sections('## One\n\n<Callout tone="info">\n\n## Inside\n\n</Callout>\n\n## Two\n')).toEqual(["One", "Two"]);
  });
  test("fewer than three: the list is what it is (the bar hides under 3)", () => {
    expect(sections("## One\n\n## Two\n")).toEqual(["One", "Two"]);
    expect(sections("just text\n")).toEqual([]);
  });
  test("`visible` drops what the lens hides", () => {
    expect(sections("## One\n\n## Two\n\n## Three\n", (el) => el.textContent !== "Two")).toEqual(["One", "Three"]);
  });
});

describe("sectionTitle", () => {
  test("drops the reader's chrome: 🧭, reader-only labels, the fold teaser, glossary tips", () => {
    const doc = new Window().document;
    const h = doc.createElement("h3");
    h.innerHTML = 'Decisions <button data-walkthrough-btn="">🧭</button><span data-reader-only="">2k chars</span><span class="gl-tip">tip</span>';
    expect(sectionTitle(h as unknown as Element)).toBe("Decisions");
    const s = doc.createElement("summary");
    s.innerHTML = 'PR slate<span class="fold-summary">at-a-glance table</span><span data-reader-only="">3 min</span>';
    expect(sectionTitle(s as unknown as Element)).toBe("PR slate");
  });
  test("a `<Fact>` in a heading reads as its passage, without the chip's mark and label", () => {
    expect(sections('## Speed <Fact id="f">fast</Fact>\n\n## Two\n\n## Three\n')).toEqual(["Speed fast", "Two", "Three"]);
  });
  test("a new-since mark adds no text; a ref link keeps its text, its reader-only noun goes", () => {
    const doc = new Window().document;
    const h = doc.createElement("h3");
    h.className = "item-new";
    h.setAttribute("data-item-date", "2026-11-08");
    h.innerHTML = 'See <span class="ref-noun" data-reader-only="">decision</span> <a class="wiki-ref" href="#d3">D3</a> → after';
    expect(sectionTitle(h as unknown as Element)).toBe("See D3 → after");
  });
});

describe("currentSection", () => {
  // `abs` are the headings' offsets in the pane's content: at scrollTop `s`
  // their viewport tops are `abs - s`. The pane's top is 0, its bottom 800.
  const at = (abs: number[], line: number, s: number, max: number) =>
    currentSection(abs.map((a) => a - s), line, s, max, 800);
  // Line 100, max 1000: headings 2–6 never reach the line (offset > 1100), so
  // it slides to 800 over the last 700 px of scroll (from 300): heading c
  // passes it at scroll (c + 200) / 2 — 350 for heading 1, then 675, 750,
  // 825, 900, 950.
  const FOOT = [0, 500, 1150, 1300, 1450, 1600, 1700];
  const rows: [string, number[], number, number, number, number][] = [
    ["before the first heading passes: the first", [300, 900, 1500], 100, 0, 5000, 0],
    ["a heading exactly on the line has passed it", [0, 300, 1500], 100, 200, 5000, 1],
    ["the last heading above the line", [0, 1100, 2600], 100, 1000, 5000, 1],
    ["far down, the last", [0, 1100, 2600], 100, 4000, 5000, 2],
    ["a pane that does not scroll: the line rule only", [0, 50, 90, 400], 100, 0, 0, 2],
    ["foot: before heading 1 meets the sliding line", FOOT, 100, 349, 1000, 0],
    ["foot: heading 1 has passed the sliding line", FOOT, 100, 350, 1000, 1],
    ["foot: section 1 keeps the bar until the next heading meets the sliding line", FOOT, 100, 674, 1000, 1],
    ["foot: the first foot heading meets the sliding line", FOOT, 100, 675, 1000, 2],
    ["foot: between two take-overs", FOOT, 100, 800, 1000, 3],
    ["foot: at max, the last", FOOT, 100, 1000, 1000, 6],
    ["a short pane: the line slides from scroll 0, nothing passed yet", [300, 400, 500], 100, 30, 100, 0],
    ["a short pane: the second heading meets the sliding line", [300, 400, 500], 100, 40, 100, 1],
    ["a short pane: at max, the last", [300, 400, 500], 100, 100, 100, 2],
  ];
  test.each(rows)("%s", (_name, abs, line, s, max, want) => {
    expect(at(abs, line, s, max)).toBe(want);
  });
  test("foot: scrolling down visits every section in order, none skipped", () => {
    const seen: number[] = [];
    for (let s = 0; s <= 1000; s += 5) {
      const k = at(FOOT, 100, s, 1000);
      if (seen.at(-1) !== k) seen.push(k);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  test("foot: headings that can reach the line, stacked before one that cannot, still pass in order", () => {
    // Closed folds 1–5 reach the line near max (offset ≤ 1200); 6 does not
    // (nested-claude-md-trim jumped 3 → 8 over its folds this way).
    const STACK = [0, 1000, 1050, 1100, 1150, 1200, 1250];
    const seen: number[] = [];
    for (let s = 0; s <= 1100; s += 1) {
      const k = at(STACK, 100, s, 1100);
      if (seen.at(-1) !== k) seen.push(k);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("sectionHolding", () => {
  const doc = new Window().document;
  const article = doc.createElement("div");
  article.innerHTML = [
    '<h3 id="a">A</h3><p id="pa">a</p>',
    '<details class="fold" id="f"><summary>F</summary><p id="pf">f</p></details>',
    '<h3 id="b">B</h3><p id="pb">b</p>',
  ].join("");
  doc.body.appendChild(article);
  const secs = ["#a", "#f > summary", "#b"].map((q) => article.querySelector(q) as unknown as Element);
  const holding = (id: string) => sectionHolding(secs, article.querySelector(`#${id}`) as unknown as Element);
  test.each([
    ["a heading is its own section", "b", 2],
    ["text after a heading", "pa", 0],
    ["text in a fold's body: the fold's summary", "pf", 1],
    ["a fold addressed by its own id: the summary inside it", "f", 1],
    ["text after the fold, under the next heading", "pb", 2],
  ] as const)("%s", (_name, id, want) => {
    expect(holding(id)).toBe(want);
  });
});
