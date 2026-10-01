import { test, expect, describe } from "bun:test";
import { isNumericColumn, parseCellNumber, sortOrder } from "./wiki-query-table.ts";

describe("Query table sorting", () => {
  test("numbers: integers, decimals (dot or comma), signs, exponents; not ids or dates", () => {
    expect(parseCellNumber(" 42 ")).toBe(42);
    expect(parseCellNumber("-1.5")).toBe(-1.5);
    expect(parseCellNumber("1,5")).toBe(1.5);
    expect(parseCellNumber("1e3")).toBe(1000);
    for (const s of ["MEL-1", "2026-09-30", "1 000", "", "0x10", "Infinity"]) expect(parseCellNumber(s)).toBeNull();
  });

  test("a column is numeric when every non-empty cell is a number", () => {
    expect(isNumericColumn(["10", "", "9"])).toBe(true);
    expect(isNumericColumn(["10", "x"])).toBe(false);
    expect(isNumericColumn(["", " "])).toBe(false);
  });

  test("numeric sort compares values, not text", () => {
    expect(sortOrder(["10", "9", "100"], "ascending")).toEqual([1, 0, 2]);
    expect(sortOrder(["10", "9", "100"], "descending")).toEqual([2, 0, 1]);
  });

  test("text sort uses Norwegian collation (æ ø å after z)", () => {
    const cells = ["å", "z", "æ", "a", "ø"];
    expect(sortOrder(cells, "ascending").map((i) => cells[i])).toEqual(["a", "z", "æ", "ø", "å"]);
  });

  test("stable in both directions; empty cells last in both", () => {
    const cells = ["b", "", "a", "b", "a"];
    expect(sortOrder(cells, "ascending")).toEqual([2, 4, 0, 3, 1]);
    expect(sortOrder(cells, "descending")).toEqual([0, 3, 2, 4, 1]);
  });
});
