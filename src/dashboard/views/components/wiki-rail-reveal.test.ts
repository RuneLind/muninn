import { test, expect } from "bun:test";
import { revealScrollTop, rowFullyVisible } from "./wiki-rail-reveal.ts";

const BOX = { top: 100, bottom: 500 }; // a 400px rail, 100px below the viewport top

test("rowFullyVisible: inside, clipped at either edge, and outside", () => {
  expect(rowFullyVisible(BOX, { top: 100, bottom: 130 })).toBe(true);
  expect(rowFullyVisible(BOX, { top: 90, bottom: 120 })).toBe(false);
  expect(rowFullyVisible(BOX, { top: 480, bottom: 510 })).toBe(false);
  expect(rowFullyVisible(BOX, { top: 900, bottom: 930 })).toBe(false);
});

test("revealScrollTop: a visible row does not move", () => {
  expect(revealScrollTop(BOX, { top: 200, bottom: 230 }, 1000)).toBeNull();
});

test("revealScrollTop: a row below the fold is centered", () => {
  // Row mid is 815px into the box's content window; centering puts it at 200.
  expect(revealScrollTop(BOX, { top: 900, bottom: 930 }, 1000)).toBe(1000 + 815 - 200);
});

test("revealScrollTop: a row above the fold is centered, clamped at 0", () => {
  expect(revealScrollTop(BOX, { top: -300, bottom: -270 }, 1000)).toBe(1000 - 385 - 200);
  expect(revealScrollTop(BOX, { top: 40, bottom: 70 }, 10)).toBe(0);
});
