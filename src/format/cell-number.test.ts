import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { isEmptyCell, parseCellNumber, parseCellNumberParts, parseCellValue } from "./cell-number.ts";

describe("parseCellNumberParts: the shapes a cell is read in", () => {
  test("plain integers and decimals, either mark, with a sign", () => {
    expect(parseCellNumberParts("42")).toEqual({ n: 42, decimals: 0, decimalComma: false });
    expect(parseCellNumberParts("+3.25")).toEqual({ n: 3.25, decimals: 2, decimalComma: false });
    expect(parseCellNumberParts("-2,5")).toEqual({ n: -2.5, decimals: 1, decimalComma: true });
    expect(parseCellNumberParts(".5")).toEqual({ n: 0.5, decimals: 1, decimalComma: false });
  });

  test("a U+2212 minus is a minus", () => {
    expect(parseCellNumber("−42")).toBe(-42);
  });

  test("space, NBSP and narrow NBSP group thousands", () => {
    expect(parseCellNumber("1 000")).toBe(1000);
    expect(parseCellNumber("1 000")).toBe(1000);
    expect(parseCellNumber("12 345,5")).toBe(12345.5);
  });

  test("comma thousands with an optional dot decimal", () => {
    expect(parseCellNumberParts("1,500")).toEqual({ n: 1500, decimals: 0, decimalComma: false });
    expect(parseCellNumberParts("1,234,567.25")).toEqual({ n: 1234567.25, decimals: 2, decimalComma: false });
  });

  test("an exponent keeps the mantissa's decimals", () => {
    expect(parseCellNumberParts("1e-7")).toEqual({ n: 1e-7, decimals: 0, decimalComma: false });
    expect(parseCellNumberParts("2.5E3")).toEqual({ n: 2500, decimals: 1, decimalComma: false });
  });

  test("text, two marks or a bare sign is no number", () => {
    for (const c of ["x", "1.2.3", "+", "", "12 sek", "1,2,3"]) expect(parseCellNumberParts(c)).toBeNull();
  });

  test("a 0,ddd cell is always a decimal, never thousands", () => {
    expect(parseCellNumberParts("0,125")).toEqual({ n: 0.125, decimals: 3, decimalComma: true });
    expect(parseCellNumberParts("-0,980")).toEqual({ n: -0.98, decimals: 3, decimalComma: true });
  });

  test("in a decimal-comma context, a d,ddd cell is a decimal", () => {
    expect(parseCellNumberParts("1,250", { decimalComma: true })).toEqual({ n: 1.25, decimals: 3, decimalComma: true });
    expect(parseCellNumberParts("22,100", { decimalComma: true })).toEqual({ n: 22.1, decimals: 3, decimalComma: true });
    // Two groups cannot be a decimal: still thousands.
    expect(parseCellNumber("1,234,567", { decimalComma: true })).toBe(1234567);
  });
});

describe("parseCellValue: a number and its unit", () => {
  test("a unit after white space", () => {
    expect(parseCellValue("22,10 sek")).toEqual({ n: 22.1, decimals: 2, decimalComma: true, unit: "sek" });
    expect(parseCellValue("5 kr")).toMatchObject({ n: 5, unit: "kr" });
  });

  test("a glued % is a unit; no other unit is read glued", () => {
    expect(parseCellValue("12%")).toEqual({ n: 12, decimals: 0, decimalComma: false, unit: "%" });
    expect(parseCellValue("12,5%")).toMatchObject({ n: 12.5, unit: "%" });
    expect(parseCellValue("12 %")).toMatchObject({ n: 12, unit: "%" });
    expect(parseCellValue("12kr")).toBeNull();
    expect(parseCellValue("%")).toBeNull();
  });

  test("a unit takes the context too", () => {
    expect(parseCellValue("1,250 sek", { decimalComma: true })).toMatchObject({ n: 1.25, unit: "sek" });
    expect(parseCellValue("0,980 sek")).toMatchObject({ n: 0.98, unit: "sek" });
  });
});

describe("isEmptyCell", () => {
  test("blank and the NULL spellings", () => {
    for (const c of ["", "  ", "NULL", "null", "[NULL]"]) expect(isEmptyCell(c)).toBe(true);
    expect(isEmptyCell("0")).toBe(false);
  });
});

describe("the source keeps its invisible characters as escapes", () => {
  test("no literal NBSP, narrow NBSP or U+2212 in cell-number.ts", () => {
    const src = readFileSync(new URL("./cell-number.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/[  −]/);
  });
});
