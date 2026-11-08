/**
 * The section bar's pure parts on the real render: `renderWikiHtml` output in
 * a happy-dom `Window` of the test's own (no globals installed), then
 * `sectionTargets`/`sectionTitle`, and the current-section rule. The bar's
 * scroll, menu and fold behaviour is layout: `e2e/wiki-section-bar.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderWikiHtml } from "../../../wiki/render.ts";
import { currentSection, sectionTargets, sectionTitle } from "./wiki-section-bar.ts";

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
});

describe("currentSection", () => {
  // Tops relative to the viewport; the line is the pane's top + slack (100).
  test("the last section whose top passed the line, never before the first", () => {
    expect(currentSection([300, 900, 1500], 100, false, 800)).toBe(0);
    expect(currentSection([50, 900, 1500], 100, false, 800)).toBe(0);
    expect(currentSection([-900, 100, 1500], 100, false, 800)).toBe(1);
    expect(currentSection([-2000, -900, -10], 100, false, 800)).toBe(2);
  });
  test("at the very bottom, the last section whose top is on screen", () => {
    expect(currentSection([-900, 50, 400, 700], 100, true, 800)).toBe(3);
    expect(currentSection([-900, 50, 400, 900], 100, true, 800)).toBe(2);
  });
});
