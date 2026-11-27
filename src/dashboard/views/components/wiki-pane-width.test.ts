import { describe, expect, test } from "bun:test";
import {
  PANE_ARTICLE_RESERVE,
  PANE_WIDTH_DEFAULT,
  PANE_WIDTH_MAX,
  PANE_WIDTH_MIN,
  clampPaneWidth,
  effectivePaneWidth,
  paneWidthFromPointer,
  parseStoredPaneWidth,
} from "./wiki-pane-width.ts";

describe("wiki pane width", () => {
  test("clamp and stored round-trip", () => {
    expect(clampPaneWidth(100)).toBe(PANE_WIDTH_MIN);
    expect(clampPaneWidth(5000)).toBe(PANE_WIDTH_MAX);
    expect(clampPaneWidth(Number.NaN)).toBe(PANE_WIDTH_DEFAULT);
    expect(clampPaneWidth(401.6)).toBe(402);
    expect(parseStoredPaneWidth(null)).toBeNull();
    expect(parseStoredPaneWidth(" ")).toBeNull();
    expect(parseStoredPaneWidth("wide")).toBeNull();
    expect(parseStoredPaneWidth("9000")).toBe(PANE_WIDTH_MAX);
    expect(parseStoredPaneWidth("480")).toBe(480);
  });

  test("the drag width is the pane's right edge minus the pointer", () => {
    expect(paneWidthFromPointer(1000, 1400)).toBe(400);
    expect(paneWidthFromPointer(1390, 1400)).toBe(PANE_WIDTH_MIN);
  });

  test("the applied width is bounded by the window and by what the rail leaves", () => {
    // Wide window, default rail: the chosen width fits.
    expect(effectivePaneWidth(500, 1800, 300)).toBe(500);
    // 40% of a 1400px window is 560; 1400 − 300 − reserve is 600: 560 wins.
    expect(effectivePaneWidth(720, 1400, 300)).toBe(560);
    // A 560px rail leaves 1400 − 560 − reserve.
    expect(effectivePaneWidth(720, 1400, 560)).toBe(1400 - 560 - PANE_ARTICLE_RESERVE);
    // Never under the minimum, however little is left.
    expect(effectivePaneWidth(720, 1150, 560)).toBe(PANE_WIDTH_MIN);
    // A chosen width under the bound is applied as chosen.
    expect(effectivePaneWidth(300, 1600, 300)).toBe(300);
    // No usable viewport: the chosen width as is.
    expect(effectivePaneWidth(500, 0, 300)).toBe(500);
  });
});
