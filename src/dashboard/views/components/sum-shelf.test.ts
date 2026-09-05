/** The shelf card's thumbnail cell, evaluated from the REAL script source. */
import { describe, expect, test } from "bun:test";
import { sumShelfScript, sumShelfStyles } from "./sum-shelf.ts";

function load(): { thumbnailHtml: (url: unknown) => string } {
  const ctx = {
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    esc: (s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  };
  return new Function(
    "ctx",
    `var document = ctx.document; var esc = ctx.esc;\n${sumShelfScript()}\nreturn { thumbnailHtml: thumbnailHtml };`,
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
