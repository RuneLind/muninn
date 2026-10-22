/**
 * The `<Steps>` client's two pure seams (`wiki-visuals.ts`): where a scroller
 * goes to show a step's lit nodes (`revealOffset`, state space A), and the
 * stacked container fill the stuck bar paints (`stackedFill`, state space C).
 * The laid-out rows are e2e/wiki-steps.spec.ts's «class check» describes.
 */
import { describe, expect, test } from "bun:test";
import { revealOffset, stackedFill } from "../dashboard/views/components/wiki-visuals.ts";

describe("class check A: revealOffset, one axis (table)", () => {
  // A box 500 wide over 2400 of content (max 1900), now at `pos`; the focus is [a, b] in content coordinates.
  const rows: [string, number, number, number, number][] = [
    // row, pos, a, b, want
    ["fits and is in view: unchanged", 100, 200, 400, 100],
    ["partly right: centred", 0, 420, 620, 270],
    ["fully right: centred", 0, 1500, 1700, 1350],
    ["fully left after scrolling right: centred, clamped at 0", 1750, 20, 220, 0],
    ["wider than the box: its start at the box's start", 1000, 20, 2350, 20],
    ["wider than the box, start already in view: unchanged", 10, 20, 2350, 10],
    ["centring past the end clamps to max", 0, 2300, 2390, 1900],
  ];
  for (const [row, pos, a, b, want] of rows) test(row, () => expect(revealOffset(pos, 500, 1900, a, b)).toBe(want));
  test("no overflow (max 0): never moves", () => expect(revealOffset(0, 500, 0, 600, 700)).toBe(0));
});

describe("class check C: stackedFill composites the fills behind the bar (table)", () => {
  const rows: [string, string[], string | null][] = [
    ["an opaque container", ["rgb(26, 26, 46)"], "rgb(26, 26, 46)"],
    ["transparent layers are skipped", ["rgba(0, 0, 0, 0)", "transparent", "rgb(10, 20, 30)"], "rgb(10, 20, 30)"],
    ["a tint over its ground", ["rgba(255, 0, 0, 0.5)", "rgb(0, 0, 0)"], "rgb(128, 0, 0)"],
    ["two tints stack (a callout in a callout)", ["rgba(0, 0, 255, 0.5)", "rgba(255, 0, 0, 0.5)", "rgb(0, 0, 0)"], "rgb(64, 0, 128)"],
    ["color(srgb …) as Blink computes color-mix", ["color(srgb 1 0 0 / 0.5)", "rgb(0, 0, 0)"], "rgb(128, 0, 0)"],
    ["space syntax with a slash", ["rgb(255 0 0 / 0.5)", "rgb(0 0 0)"], "rgb(128, 0, 0)"],
    ["an opaque layer hides what is under it", ["rgb(1, 2, 3)", "rgba(255, 0, 0, 0.5)", "rgb(0, 0, 0)"], "rgb(1, 2, 3)"],
    ["no opaque layer: null (the CSS fallback stays)", ["rgba(255, 0, 0, 0.5)"], null],
    ["an unreadable colour: null", ["oklch(0.5 0.1 200 / 0.5)", "rgb(0, 0, 0)"], null],
  ];
  for (const [row, layers, want] of rows) test(row, () => expect(stackedFill(layers)).toBe(want));
});
