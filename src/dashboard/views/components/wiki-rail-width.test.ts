import { describe, expect, test } from "bun:test";
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  clampRailWidth,
  effectiveRailWidth,
  nextStoredWidth,
  parseStoredRailWidth,
  railWidthFromPointer,
} from "./wiki-rail-width.ts";

describe("clampRailWidth", () => {
  test("keeps an in-range width, rounded to whole pixels", () => {
    expect(clampRailWidth(340.4)).toBe(340);
    expect(clampRailWidth(340.6)).toBe(341);
  });
  test("pins to the range at both ends", () => {
    expect(clampRailWidth(10)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(9999)).toBe(RAIL_WIDTH_MAX);
  });
  test("a non-finite number falls back to the default, never NaN", () => {
    expect(clampRailWidth(NaN)).toBe(RAIL_WIDTH_DEFAULT);
    expect(clampRailWidth(Infinity)).toBe(RAIL_WIDTH_DEFAULT);
  });
});

describe("parseStoredRailWidth", () => {
  test("absent, blank and non-numeric values are null (CSS default stays)", () => {
    expect(parseStoredRailWidth(null)).toBeNull();
    expect(parseStoredRailWidth(undefined)).toBeNull();
    expect(parseStoredRailWidth("")).toBeNull();
    expect(parseStoredRailWidth("   ")).toBeNull();
    expect(parseStoredRailWidth("wide")).toBeNull();
    expect(parseStoredRailWidth("{\"w\":400}")).toBeNull();
  });
  test("a numeric string round-trips", () => {
    expect(parseStoredRailWidth("412")).toBe(412);
    expect(parseStoredRailWidth(String(RAIL_WIDTH_MAX))).toBe(RAIL_WIDTH_MAX);
  });
  test("an out-of-range stored width is CLAMPED, not discarded", () => {
    expect(parseStoredRailWidth("900")).toBe(RAIL_WIDTH_MAX);
    expect(parseStoredRailWidth("50")).toBe(RAIL_WIDTH_MIN);
  });
});

describe("effectiveRailWidth", () => {
  test("a width that fits the viewport is applied as-is", () => {
    expect(effectiveRailWidth(400, 1400)).toBe(400);
  });
  test("a stored desktop width is bounded by the viewport share, below the range minimum too", () => {
    // 560 stored on a monitor, opened in a 700px window: 45% of 700 = 315.
    expect(effectiveRailWidth(RAIL_WIDTH_MAX, 700)).toBe(315);
    // And a phone: the bound goes UNDER RAIL_WIDTH_MIN rather than re-clamping up
    // to it — re-clamping is exactly the squeeze the bound exists to prevent.
    expect(effectiveRailWidth(RAIL_WIDTH_MAX, 400)).toBe(180);
    expect(effectiveRailWidth(RAIL_WIDTH_MAX, 400)).toBeLessThan(RAIL_WIDTH_MIN);
  });
  test("an unusable viewport width leaves the width alone", () => {
    expect(effectiveRailWidth(400, 0)).toBe(400);
    expect(effectiveRailWidth(400, NaN)).toBe(400);
  });
});

describe("nextStoredWidth", () => {
  // stored S, shown V = min(S, bound), requested R.
  test("a shrink below what is shown stores the requested width", () => {
    expect(nextStoredWidth(560, 315, 299)).toBe(299);
    expect(nextStoredWidth(400, 400, 384)).toBe(384);
  });
  test("a grow the bound makes inert never lowers the stored width", () => {
    // 560 stored, 315 shown, ArrowRight asks 331: the reader sees nothing move,
    // and the desktop width they set must survive.
    expect(nextStoredWidth(560, 315, 331)).toBe(560);
    // A drag to the bound itself is the same case.
    expect(nextStoredWidth(560, 315, 315)).toBe(560);
  });
  test("a grow past the stored width stores the requested width", () => {
    expect(nextStoredWidth(300, 300, 316)).toBe(316);
    expect(nextStoredWidth(null, 300, 316)).toBe(316);
  });
  test("with nothing stored, a shrink stores the requested width too", () => {
    expect(nextStoredWidth(null, 300, 284)).toBe(284);
  });
});

describe("railWidthFromPointer", () => {
  test("is the pointer's offset from the RAIL's left edge (not the padded layout's)", () => {
    expect(railWidthFromPointer(424, 48)).toBe(376);
  });
  test("dragging past either edge clamps", () => {
    expect(railWidthFromPointer(0, 24)).toBe(RAIL_WIDTH_MIN);
    expect(railWidthFromPointer(2000, 24)).toBe(RAIL_WIDTH_MAX);
  });
});
