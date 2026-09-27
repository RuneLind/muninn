import { test, expect, describe } from "bun:test";
import { codeSpanContent, lineCodeSpanRanges } from "./code-spans.ts";

const content = (line: string) => lineCodeSpanRanges(line).map((r) => codeSpanContent(line, r));

describe("lineCodeSpanRanges", () => {
  test("ranges cover the delimiters and report the run length", () => {
    expect(lineCodeSpanRanges("a `b` c ``d`` e")).toEqual([
      { start: 2, end: 5, runLen: 1 },
      { start: 8, end: 13, runLen: 2 },
    ]);
  });

  test("a run of N closes only on exactly N", () => {
    expect(lineCodeSpanRanges("``a`b```c``")).toEqual([{ start: 0, end: 11, runLen: 2 }]);
  });

  test("an unmatched run is literal and the scan continues past it", () => {
    expect(lineCodeSpanRanges("``` x `y`")).toEqual([{ start: 6, end: 9, runLen: 1 }]);
    expect(lineCodeSpanRanges("a ` b")).toEqual([]);
  });

  test("a longer run inside a shorter span is content", () => {
    expect(lineCodeSpanRanges("` ``` `")).toEqual([{ start: 0, end: 7, runLen: 1 }]);
  });
});

describe("lineCodeSpanRanges — backslash escapes", () => {
  test("an escaped backtick cannot open; the rest of its run opens one shorter", () => {
    expect(content("\\`a`")).toEqual([]);
    expect(content("\\``a`")).toEqual(["a"]);
    expect(content("\\```a``")).toEqual(["a"]);
    expect(lineCodeSpanRanges("\\``a`")).toEqual([{ start: 2, end: 5, runLen: 1 }]);
  });

  test("an escaped backslash leaves the backtick free to open", () => {
    expect(content("\\\\`a`")).toEqual(["a"]);
    expect(content("\\\\\\`a`")).toEqual([]);
  });

  test("a closer ignores a backslash: inside a span it is literal", () => {
    expect(content("`a\\`b`")).toEqual(["a\\"]);
  });

  test("an escaped opener frees the next backtick to pair", () => {
    expect(content("Press \\` then `ls` there")).toEqual(["ls"]);
    expect(content("\\`a` b`")).toEqual([" b"]);
  });
});

describe("codeSpanContent", () => {
  test("strips one U+0020 from each end when both ends carry one", () => {
    expect(content("`` `x` ``")).toEqual(["`x`"]);
    expect(content("``  x  ``")).toEqual([" x "]);
  });

  test("leaves a one-sided pad alone", () => {
    expect(content("`` x``")).toEqual([" x"]);
    expect(content("``x ``")).toEqual(["x "]);
  });

  test("a single-space or all-space span is not stripped", () => {
    expect(content("` `")).toEqual([" "]);
    expect(content("`   `")).toEqual(["   "]);
  });

  test("a tab or NBSP is content, not a space", () => {
    expect(content("` \t `")).toEqual(["\t"]);
    expect(content("`   `")).toEqual([" "]);
    expect(content("`\tx\t`")).toEqual(["\tx\t"]);
  });
});
