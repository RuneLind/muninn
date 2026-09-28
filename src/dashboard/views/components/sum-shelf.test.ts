/** The shelf card's thumbnail cell, evaluated from the REAL script source. */
import { describe, expect, test } from "bun:test";
import { sumShelfScript, sumShelfStyles } from "./sum-shelf.ts";

interface Shelf {
  thumbnailHtml: (url: unknown) => string;
  shelfWindow: (total: number, filterKey: string) => number;
  shelfMoreHtml: (shown: number, total: number) => string;
  shelfNextLimit: (shown: number, mode: string | null) => number;
  shelfFilterKey: () => string;
  setFilters: (domain: string | null, source: string | null, category: string | null) => void;
  setLimit: (n: number) => void;
}

function load(): Shelf {
  const ctx = {
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    esc: (s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  };
  return new Function(
    "ctx",
    `var document = ctx.document; var esc = ctx.esc; var activeDomain = null;\n${sumShelfScript()}\n` +
      `return { thumbnailHtml: thumbnailHtml, shelfWindow: shelfWindow, shelfMoreHtml: shelfMoreHtml,
        shelfNextLimit: shelfNextLimit, shelfFilterKey: shelfFilterKey,
        setFilters: function(d, s, c) { activeDomain = d; activeSource = s; activeShelfCategory = c; },
        setLimit: function(n) { shelfLimit = n; } };`,
  )(ctx);
}

describe("sum-shelf: the thumbnail cell", () => {
  const { thumbnailHtml } = load();

  test("an https url renders a lazy, cover-cropped img with the url escaped", () => {
    expect(thumbnailHtml('https://i.vimeocdn.com/video/a.jpg?x="1"')).toBe(
      '<img class="recent-item-thumb" src="https://i.vimeocdn.com/video/a.jpg?x=&quot;1&quot;" alt="" loading="lazy" referrerpolicy="no-referrer" />',
    );
    // The rule itself, selector + brace: a renamed selector ships an unstyled img.
    expect(sumShelfStyles()).toMatch(/\.recent-item-thumb \{/);
  });

  test("anything that is not an https url renders nothing", () => {
    expect(thumbnailHtml("http://i.vimeocdn.com/a.jpg")).toBe("");
    expect(thumbnailHtml("javascript:alert(1)")).toBe("");
    expect(thumbnailHtml("")).toBe("");
    expect(thumbnailHtml(undefined)).toBe("");
    expect(thumbnailHtml(7)).toBe("");
  });
});

describe("sum-shelf: the paging window", () => {
  test("shows the newest 10, grows on demand, and resets when the filters change", () => {
    const { shelfWindow, shelfNextLimit, setLimit } = load();
    expect(shelfWindow(1500, "||")).toBe(10);
    setLimit(shelfNextLimit(10, "step"));
    expect(shelfWindow(1500, "||")).toBe(60);
    // Same filters, e.g. the refetch after an ingest: the window is kept.
    expect(shelfWindow(1501, "||")).toBe(60);
    // A different filter set starts over at 10.
    expect(shelfWindow(1500, "ai|youtube|")).toBe(10);
    setLimit(shelfNextLimit(10, "all"));
    expect(shelfWindow(1500, "ai|youtube|")).toBe(1500);
    expect(shelfWindow(4, "life||")).toBe(4);
  });

  test("Show more adds one step past what is shown; Show all lifts the cap", () => {
    const { shelfNextLimit } = load();
    expect(shelfNextLimit(10, "step")).toBe(60);
    expect(shelfNextLimit(60, "step")).toBe(110);
    expect(shelfNextLimit(10, "all")).toBe(Infinity);
  });

  test("the window key covers every shelf filter", () => {
    const { shelfFilterKey, setFilters } = load();
    setFilters(null, null, null);
    const base = shelfFilterKey();
    for (const [d, s, c] of [["life", null, null], [null, "youtube", null], [null, null, "ai/e2e"]] as const) {
      setFilters(d, s, c);
      expect(shelfFilterKey()).not.toBe(base);
    }
    setFilters(null, null, null);
    expect(shelfFilterKey()).toBe(base);
  });

  test("the footer offers the next step and Show all, and disappears when nothing is hidden", () => {
    const { shelfMoreHtml } = load();
    const html = shelfMoreHtml(10, 1500);
    expect(html).toContain("Showing 10 of 1500");
    expect(html).toContain('data-more="step">Show 50 more<');
    expect(html).toContain('data-more="all">Show all<');
    // Fewer than one step left: the step button covers it, no Show all.
    const tail = shelfMoreHtml(10, 30);
    expect(tail).toContain("Show 20 more");
    expect(tail).not.toContain('data-more="all"');
    expect(shelfMoreHtml(30, 30)).toBe("");
    expect(sumShelfStyles()).toMatch(/\.shelf-more-btn \{/);
  });
});
