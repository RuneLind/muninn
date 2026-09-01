import { describe, expect, test } from "bun:test";
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  clampRailWidth,
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

describe("railWidthFromPointer", () => {
  test("is the pointer's offset from the layout's left edge", () => {
    expect(railWidthFromPointer(424, 24)).toBe(400);
  });
  test("dragging past either edge clamps", () => {
    expect(railWidthFromPointer(0, 24)).toBe(RAIL_WIDTH_MIN);
    expect(railWidthFromPointer(2000, 24)).toBe(RAIL_WIDTH_MAX);
  });
});
