/** The shelf card's thumbnail cell, evaluated from the REAL script source. */
import { describe, expect, test } from "bun:test";
import { sumShelfScript, sumShelfStyles } from "./sum-shelf.ts";

interface Shelf {
  thumbnailHtml: (url: unknown) => string;
  shelfWindow: (total: number, filterKey: string) => number;
  shelfMoreHtml: (shown: number, total: number) => string;
  grow: (by: number) => void;
}

function load(): Shelf {
  const ctx = {
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    esc: (s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  };
  return new Function(
    "ctx",
    `var document = ctx.document; var esc = ctx.esc;\n${sumShelfScript()}\nreturn { thumbnailHtml: thumbnailHtml, shelfWindow: shelfWindow, shelfMoreHtml: shelfMoreHtml,
      grow: function(by) { shelfLimit = by === Infinity ? Infinity : shelfLimit + by; } };`,
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
    const { shelfWindow, grow } = load();
    expect(shelfWindow(1500, "||")).toBe(10);
    grow(50);
    expect(shelfWindow(1500, "||")).toBe(60);
    // Same filters, e.g. the refetch after an ingest: the window is kept.
    expect(shelfWindow(1501, "||")).toBe(60);
    // A different filter set starts over at 10.
    expect(shelfWindow(1500, "ai|youtube|")).toBe(10);
    grow(Infinity);
    expect(shelfWindow(1500, "ai|youtube|")).toBe(1500);
    expect(shelfWindow(4, "life||")).toBe(4);
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
