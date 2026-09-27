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
  const spans = (lines: string[], opensParagraph = true) => {
    const text = lines.join("\n");
    return textCodeSpanRanges(lines, opensParagraph).map((r) => text.slice(r.start, r.end));
  };
  // The same lines paired one at a time: what every doubtful stretch must equal.
  const perLine = (lines: string[]) => {
    const out: string[] = [];
    for (const l of lines) for (const r of lineCodeSpanRanges(l)) out.push(l.slice(r.start, r.end));
    return out;
  };

  test("a span pairs across a soft line break", () => {
    expect(spans(["a `one", "two` b"])).toEqual(["`one\ntwo`"]);
    expect(spans(["a `one", "    two` b"])).toEqual(["`one\n    two`"]);
  });

  test("a blank line ends the paragraph, so nothing pairs across it", () => {
    expect(spans(["a `one", "", "two` b"])).toEqual([]);
    expect(spans(["a `one", " \t", "two` b"])).toEqual([]);
  });

  test("a block the caller does not vouch for pairs per line until a blank line", () => {
    // A list item's continuation that the parser split off: `#9` closes the
    // item's span in CommonMark, so pairing it with the NEXT opener inverts the line.
    const cont = ["   #9`), b", "   `g(y)` c"];
    expect(spans(cont, false)).toEqual(perLine(cont));
    expect(spans(cont, false)).toEqual(["`g(y)`"]);
    expect(spans(["a `x", "b`", "", "c `y", "d`"], false)).toEqual(["`y\nd`"]);
  });

  // Each line may begin or interrupt a block in some CommonMark context, so the
  // pairing splits there; what follows it, until a blank line, pairs per line.
  const INTERRUPTERS: [string, string][] = [
    ["bullet -", "- b"],
    ["bullet +", "+ b"],
    ["bullet *", "* b"],
    ["indented *", "  * b"],
    ["4-space nested item", "    - b"],
    ["bare marker", "-"],
    ["ordered 1.", "1. b"],
    ["ordered 1)", "1) b"],
    ["sibling ordered 2)", "2) b"],
    ["indented ordered", "  2. b"],
    ["zero-padded", "01) b"],
    ["thematic ***", "***"],
    ["thematic ___", "___"],
    ["spaced rule", " - - -"],
    ["setext ===", "==="],
    ["setext -", "-"],
    ["ATX heading", "# h"],
    ["indented ATX", "  # h"],
    ["empty ATX", "#"],
    ["blockquote", "> q"],
    ["indented blockquote", "  > q"],
    ["html block", "<div>"],
    ["html comment", "<!-- c -->"],
    ["backtick fence", "```"],
    ["tilde fence", "~~~"],
    ["indented fence", "   ~~~"],
    ["table row", "| a |"],
    ["delimiter row", ":--|--:"],
  ];
  for (const [name, mid] of INTERRUPTERS) {
    test(`a span does not cross a ${name} line`, () => {
      const lines = ["a `x", mid, "y` b"];
      expect(spans(lines)).toEqual(perLine(lines));
      // And the line after it is not a paragraph start either.
      const after = ["p", mid, "a `x", "y` b"];
      expect(spans(after)).toEqual(perLine(after));
    });
  }

  test("text that only looks like a marker still pairs across", () => {
    expect(spans(["a `one", "+two` b"])).toEqual(["`one\n+two`"]);
    expect(spans(["a `one", "#two` b"])).toEqual(["`one\n#two`"]);
    expect(spans(["a `one", "1.5 two` b"])).toEqual(["`one\n1.5 two`"]);
  });

  test("a stretch starting indented 4+ columns is code, so it pairs per line", () => {
    for (const lead of ["    ", "\t", "  \t"]) {
      const lines = ["para", "", `${lead}code \`x`, `${lead}y\``];
      expect(spans(lines)).toEqual([]);
    }
  });

  test("after a fence or raw-HTML-block opener the rest of the block pairs per line", () => {
    for (const opener of ["~~~", "```", "<!--", "<pre>", "<script>"]) {
      const lines = [opener, "", "a `x", "y`"];
      expect({ opener, got: spans(lines) }).toEqual({ opener, got: [] });
    }
  });

  test("CRLF lines split the same way", () => {
    expect(spans(["a `one\r", "two` b"])).toEqual(["`one\r\ntwo`"]);
    expect(spans(["a `one\r", "\r", "two` b"])).toEqual([]);
    expect(spans(["a `one\r", "---\r", "two` b"])).toEqual([]);
    expect(spans(["a `one\r", "-\r", "two` b"])).toEqual([]);
  });

  test("offsets are into the joined block, past blank lines", () => {
    expect(spans(["x", "", "`y`"])).toEqual(["`y`"]);
  });
});

describe("lineCodeSpanRanges is linear", () => {
  test("a paragraph of unmatched runs of distinct lengths is not rescanned per run", () => {
    // Runs of length 1..k, each once: a forward rescan per run is O(n·√n) here.
    let s = "";
    for (let len = 1; s.length < 2_000_000; len++) s += "`".repeat(len) + " x\n";
    const t0 = performance.now();
    lineCodeSpanRanges(s);
    expect(performance.now() - t0).toBeLessThan(500);
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
