import { test, expect, describe } from "bun:test";
import { codeSpanContent, crossLineStretches, lineCodeSpanRanges, textCodeSpanRanges } from "./code-spans.ts";

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

describe("lineCodeSpanRanges — backslash escapes", () => {
  test("an escaped backtick cannot open; the rest of its run opens one shorter", () => {
    expect(content("\\`a`")).toEqual([]);
    expect(content("\\``a`")).toEqual(["a"]);
    expect(content("\\```a``")).toEqual(["a"]);
  });

  test("an escaped backslash leaves the backtick free to open", () => {
    expect(content("\\\\`a`")).toEqual(["a"]);
    expect(content("\\\\\\`a`")).toEqual([]);
  });

  test("a closer ignores a backslash: inside a span it is literal", () => {
    expect(content("`a\\`b`")).toEqual(["a\\"]);
  });

  test("an escaped backtick opens no span across a paragraph's lines", () => {
    const text = "Press \\` to open the console and\nrun `ls` there.";
    expect(content(text)).toEqual(["ls"]);
  });
});

describe("crossLineStretches + textCodeSpanRanges", () => {
  // `lines` read as a whole document body.
  const spans = (lines: string[]) => {
    const text = lines.join("\n");
    return textCodeSpanRanges(lines).map((r) => text.slice(r.start, r.end));
  };
  // The same lines paired one at a time: what every doubtful stretch must equal.
  const perLine = (lines: string[]) => {
    const out: string[] = [];
    for (const l of lines) for (const r of lineCodeSpanRanges(l)) out.push(l.slice(r.start, r.end));
    return out;
  };
  const expectPerLine = (lines: string[]) =>
    expect({ lines, got: spans(lines) }).toEqual({ lines, got: perLine(lines) });

  test("a span pairs across a soft line break", () => {
    expect(spans(["a `one", "two` b"])).toEqual(["`one\ntwo`"]);
    expect(spans(["a `one", "    two` b"])).toEqual(["`one\n    two`"]);
    expect(crossLineStretches(["a `one", "two` b"])).toEqual([{ first: 0, end: 2 }]);
  });

  test("a blank line ends the paragraph, so nothing pairs across it", () => {
    expect(spans(["a `one", "", "two` b"])).toEqual([]);
    expect(spans(["a `one", " \t", "two` b"])).toEqual([]);
  });

  test("(a) a stretch starts only at the body start or after a blank line", () => {
    for (const before of ["# h", "---", "***", "- item", "> q", "| a |", "<Callout>", "<!-- c -->"]) {
      expectPerLine([before, "a `x", "y` b"]);
    }
    expect(spans(["p", "", "a `x", "y` b"])).toEqual(["`x\ny`"]);
    expect(spans(["p", "a `x", "y` b"])).toEqual(["`x\ny`"]); // one paragraph from the body start
  });

  // Each certainly interrupts a CommonMark paragraph, so the stretch before it
  // is a whole paragraph and pairs across.
  const CERTAIN: [string, string][] = [
    ["ATX heading", "# h"],
    ["indented ATX", "   # h"],
    ["empty ATX", "#"],
    ["backtick fence", "```ts"],
    ["tilde fence", "~~~"],
    ["thematic ***", "***"],
    ["indented thematic", "  ***"],
    ["setext ---", "---"],
    ["spaced rule", " - - -"],
    ["bullet -", "- b"],
    ["bullet *", "* b"],
    ["ordered 1.", "1. b"],
    ["ordered 1)", "1) b"],
    ["zero-padded 1", "0001) b"],
    ["blockquote", "> q"],
    ["html type 1", "<pre>"],
    ["html type 2", "<!-- c -->"],
    ["html type 3", "<?x?>"],
    ["html type 4", "<!X>"],
    ["html type 5", "<![CDATA[x]]>"],
    ["html type 6", "<details>"],
  ];
  for (const [name, next] of CERTAIN) {
    test(`(b) a stretch ending before a ${name} pairs across`, () => {
      expect(spans(["a `x", "y` b", next]).slice(0, 1)).toEqual(["`x\ny`"]);
    });
  }

  // Each may, or may not, end the paragraph, so the stretch before it pairs per line.
  const UNCERTAIN: [string, string][] = [
    ["sibling ordered 2)", "2) b"],
    ["indented ordered", "  2. b"],
    ["4-space nested item", "    - b"],
    ["bare marker", "-"],
    ["setext ===", "==="],
    ["indented setext", "   ==="],
    ["component tag", "</Callout>"],
    ["inline html", "<kbd>x</kbd> e"],
    ["table row", "| a |"],
    ["delimiter row", ":--|--:"],
    ["indented heading", "    # h"],
  ];
  for (const [name, next] of UNCERTAIN) {
    test(`(b) a stretch cut by a ${name} line pairs per line`, () => {
      expectPerLine(["a `x", "y` b", next]);
    });
  }

  test("(b) a zero-padded item numbered 1 interrupts, however many digits", () => {
    expect(spans(["a `x", "y` b `z", "0001) w` q"])).toEqual(["`x\ny`"]);
  });

  test("(d) a line that may interrupt anywhere inside a stretch sends the WHOLE stretch per line", () => {
    // CommonMark: one span `a `b c` d 2) e` — a longer run whose closer lies past
    // the cut. Pairing the part before the cut made the inner `b c` a span.
    for (const mid of ["2) e `` end", "<kbd>x</kbd> e `` end", "| t e `` end"]) {
      expectPerLine(["The `` a `b", "c` d", mid]);
    }
  });

  test("(c) a stretch inside a raw context pairs per line", () => {
    const cases = [
      ["<details>", "# Heading", "`a", "b`", "</details>"],
      ["```", "code", "---", "", "`a", "b`"], // unclosed fence: open to EOF
      ["~~~", "# x", "", "`a", "b`", "~~~"],
      ["<pre>", "", "`a", "b`", "</pre>"],
      ["<PRE>", "", "`a", "b`"],
      ["<pre\r", "\r", "`a\r", "b`\r"],
      ["<!--", "", "`a", "b`"],
      ["<?x", "", "`a", "b`"],
      ["<!X", "", "`a", "b`"],
      ["<![CDATA[", "", "`a", "b`"],
      ["<script>", "", "`a", "b`"],
      ["- a", "", "    <pre>", "", "  `x", "  y`"], // a type-1 block inside the item
      ["- ```", "", "  `a", "  b`"], // a fence inside the item
      ["  ```", "x", "", "`a", "b`"], // indent 2 at top level: content at column 0 stays inside
      ["p", "<span>", "```", "", "`a", "b`"], // <span> cannot interrupt, so the fence opens
    ];
    for (const lines of cases) expectPerLine(lines);
  });

  test("(c) a raw context that has closed leaves the next paragraph free to pair", () => {
    expect(spans(["```", "z", "```", "", "a `x", "y`"])).toEqual(["`x\ny`"]);
    expect(spans(["<!-- c -->", "", "a `x", "y`"])).toEqual(["`x\ny`"]);
    expect(spans(["<div>", "q", "", "a `x", "y`"])).toEqual(["`x\ny`"]);
    expect(spans(["<pre>", "</pre>", "", "a `x", "y`"])).toEqual(["`x\ny`"]);
    // A blank line ends the blockquote, and the fence inside it.
    expect(spans(["> ```", "> q", "", "a `x", "y`"])).toEqual(["`x\ny`"]);
    // A list item's fence ends with the item: `` ``` `` at column 0 opens a new one.
    expectPerLine(["- ```", "  q", "```", "", "`a", "b`"]);
    // A list item's HTML block ends with the item, though no `-->` follows.
    expect(spans(["- <!--", "x", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("(c) a fence closer is at most 3 columns right of its container, so a deeper one does not close", () => {
    expectPerLine(["```", "q", "    ```", "", "`a", "b`"]);
    expect(spans(["```", "q", "   ```", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("(c) a backtick run whose info string holds a backtick is no fence", () => {
    expect(spans(["a ` ```", "code", "``` [[x]] ` b"])).toEqual(["` ```\ncode\n``` [[x]] `"]);
    expect(spans(["``` `x`", "", "a `x", "y`"])).toEqual(["`x`", "`x\ny`"]);
  });

  test("(c) past too many open readings every later line pairs per line", () => {
    // Each indented opener may be a fence in a list item at 4 columns; none closes
    // (lengths fall). CommonMark reads indented code, so `a b` would pair — the cap
    // gives that up, and says so.
    const lines: string[] = [];
    for (let k = 40; k >= 3; k--) lines.push("    " + "`".repeat(k));
    lines.push("x", "", "`a", "b`");
    expectPerLine(lines);
    expect(spans(lines.slice(lines.length - 8))).toEqual(["`a\nb`"]);
  });

  test("(e) a stretch starting indented 4+ columns is code, so it pairs per line", () => {
    for (const lead of ["    ", "\t", "  \t"]) {
      expectPerLine(["para", "", `${lead}code \`x`, `${lead}y\``]);
    }
  });

  test("(g) a stretch that may be a link reference definition pairs per line", () => {
    expectPerLine(["[a]: `x", "`y"]);
    expect(spans(["[a](u) `x", "y`"])).toEqual(["`x\ny`"]);
  });

  test("text that only looks like a marker still pairs across", () => {
    expect(spans(["a `one", "+two` b"])).toEqual(["`one\n+two`"]);
    expect(spans(["a `one", "#two` b"])).toEqual(["`one\n#two`"]);
    expect(spans(["a `one", "1.5 two` b"])).toEqual(["`one\n1.5 two`"]);
  });

  test("CRLF lines split the same way", () => {
    expect(spans(["a `one\r", "two` b"])).toEqual(["`one\r\ntwo`"]);
    expect(spans(["a `one\r", "\r", "two` b"])).toEqual([]);
    expectPerLine(["a `one\r", "---\r", "two` b"]);
    expectPerLine(["a `one\r", "-\r", "two` b"]);
  });

  test("an explicit `across` pairs only those ranges", () => {
    expect(textCodeSpanRanges(["a `x", "y` b"], [])).toEqual([]);
    expect(textCodeSpanRanges(["q", "a `x", "y` b"], [{ first: 1, end: 3 }])).toEqual([
      { start: 4, end: 9, runLen: 1 },
    ]);
  });

  test("offsets are into the joined block, past blank lines", () => {
    expect(spans(["x", "", "`y`"])).toEqual(["`y`"]);
  });
});

describe("crossLineStretches is linear", () => {
  test("a 2 MB document of paragraphs and fences", () => {
    const lines: string[] = [];
    while (lines.length < 100_000) lines.push("a `x", "y` b", "", "```", "z", "```", "<!--", "-->", "");
    const t0 = performance.now();
    crossLineStretches(lines);
    expect(performance.now() - t0).toBeLessThan(1000);
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
