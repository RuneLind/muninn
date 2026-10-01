import { test, expect, describe } from "bun:test";
import { parseCsv } from "./csv.ts";

describe("parseCsv (RFC 4180)", () => {
  test("plain rows; header verbatim", () => {
    expect(parseCsv("SAK, Beh\na,1\nb,2\n")).toEqual({ header: ["SAK", " Beh"], rows: [["a", "1"], ["b", "2"]] });
  });

  test("quoted fields: commas, newlines and doubled quotes inside", () => {
    const csv = 'a,b,c\n"x,y","line1\nline2","say ""hi"""\n';
    expect(parseCsv(csv).rows).toEqual([["x,y", "line1\nline2", 'say "hi"']]);
  });

  test("CRLF row ends, including inside the last row", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4").rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  test("a CR alone inside a quoted field is kept", () => {
    expect(parseCsv('a\n"x\r\ny"\n').rows).toEqual([["x\r\ny"]]);
  });

  test("a leading BOM is stripped from the first header cell", () => {
    expect(parseCsv("﻿SAK,B\n1,2").header).toEqual(["SAK", "B"]);
  });

  test("ragged rows are padded to the widest row", () => {
    expect(parseCsv("a,b,c\n1\n1,2,3,4\n")).toEqual({
      header: ["a", "b", "c", ""],
      rows: [["1", "", "", ""], ["1", "2", "3", "4"]],
    });
  });

  test("empty fields survive; blank lines are skipped", () => {
    expect(parseCsv("a,b,c\n1,,3\n\n,,\n\n").rows).toEqual([["1", "", "3"], ["", "", ""]]);
  });

  test("a quote inside an unquoted field is literal", () => {
    expect(parseCsv('a\nab"c\n').rows).toEqual([['ab"c']]);
  });

  test("empty input", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [] });
  });
});
