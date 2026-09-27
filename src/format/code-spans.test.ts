import { test, expect, describe } from "bun:test";
import { codeSpanContent, lineCodeSpanRanges, textCodeSpanRanges } from "./code-spans.ts";

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

describe("textCodeSpanRanges", () => {
  const spans = (lines: string[]) => {
    const text = lines.join("\n");
    return textCodeSpanRanges(lines).map((r) => text.slice(r.start, r.end));
  };

  test("a span pairs across a soft line break", () => {
    expect(spans(["a `one", "two` b"])).toEqual(["`one\ntwo`"]);
  });

  test("a blank line ends the paragraph, so nothing pairs across it", () => {
    expect(spans(["a `one", "", "two` b"])).toEqual([]);
    expect(spans(["a `one", " \t", "two` b"])).toEqual([]);
  });

  test("a list item line starts a new paragraph, and pairs onward itself", () => {
    expect(spans(["a `one", "+ two` b"])).toEqual([]);
    expect(spans(["a `one", "  - two` b"])).toEqual([]);
    expect(spans(["a `one", "1) two` b"])).toEqual([]);
    expect(spans(["x", "+ a `b", "c` d"])).toEqual(["`b\nc`"]);
    expect(spans(["a `one", "+two` b"])).toEqual(["`one\n+two`"]);
  });

  test("offsets are into the joined block, past blank lines", () => {
    expect(spans(["x", "", "`y`"])).toEqual(["`y`"]);
  });
});

describe("codeSpanContent across lines", () => {
  const joined = (text: string) => lineCodeSpanRanges(text).map((r) => codeSpanContent(text, r));

  test("a line ending becomes a space", () => {
    expect(joined("`one\ntwo`")).toEqual(["one two"]);
  });

  test("the next line's indent goes with the line ending", () => {
    expect(joined("`a\n   b`")).toEqual(["a b"]);
    expect(joined("`a  \n\tb`")).toEqual(["a   b"]);
  });

  test("the newline becomes a space BEFORE the one-space strip", () => {
    expect(joined("`\nx\n`")).toEqual(["x"]);
  });
});
