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

  test("one column: an empty line is an empty value (psql writes NULL that way); the final newline is not a row", () => {
    expect(parseCsv("n\n1\n\n3\n").rows).toEqual([["1"], [""], ["3"]]);
    expect(parseCsv("n\n1\n").rows).toEqual([["1"]]);
  });

  test('a quoted "" record is always kept, whatever the width', () => {
    expect(parseCsv('n\n""\n2\n').rows).toEqual([[""], ["2"]]);
    expect(parseCsv('a,b\n1,2\n""\n').rows).toEqual([["1", "2"], ["", ""]]);
  });

  test("a lone CR ends a row, like CRLF; a trailing CR stays out of the cell", () => {
    expect(parseCsv("a,b\r1,2\r3,4\r")).toEqual({ header: ["a", "b"], rows: [["1", "2"], ["3", "4"]] });
    expect(parseCsv("a,b\r\n1,2\r").rows).toEqual([["1", "2"]]);
  });

  test("an unterminated quote at the end of the file is a warning, not silence", () => {
    const csv = parseCsv('a,b\n1,"open\n2,3\n');
    expect(csv.warning).toBe("unterminated-quote");
    expect(parseCsv("a\n1\n").warning).toBeUndefined();
  });
});
