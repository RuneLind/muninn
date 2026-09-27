import { test, expect, describe } from "bun:test";
import { codeSpanContent, crossLineStretches, lineCodeSpanRanges, type LineRange } from "./code-spans.ts";

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

// Every span in `lines`, over `lines.join("\n")`: each `across` range as one text, other lines alone.
function textCodeSpanRanges(lines: string[], across: readonly LineRange[] = crossLineStretches(lines)) {
  const out: { start: number; end: number; runLen: number }[] = [];
  const endAt = new Map(across.map((r) => [r.first, r.end]));
  for (let i = 0, offset = 0; i < lines.length; ) {
    const end = endAt.get(i) ?? i + 1;
    const text = lines.slice(i, end).join("\n");
    for (const r of lineCodeSpanRanges(text)) out.push({ ...r, start: offset + r.start, end: offset + r.end });
    offset += text.length + 1;
    i = end;
  }
  return out;
}

describe("crossLineStretches", () => {
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
  });

  test("(c) a fence closer is at most 3 columns right of its container, so a deeper one does not close", () => {
    expectPerLine(["```", "q", "    ```", "", "`a", "b`"]);
    expect(spans(["```", "q", "   ```", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("(c) a backtick run whose info string holds a backtick is no fence", () => {
    expect(spans(["a ` ```", "code", "``` [[x]] ` b"])).toEqual(["` ```\ncode\n``` [[x]] `"]);
    expect(spans(["``` `x`", "", "a `x", "y`"])).toEqual(["`x`", "`x\ny`"]);
  });

  test("(c) after an opener behind a container marker, 4+ spaces or a tab, every later line pairs per line", () => {
    for (const opener of ["> ```", "- ```", "1) ~~~", "  - <pre>", "- <!--", "    ```", "\t<div>", " \t```"]) {
      expectPerLine([opener, "q", "", "`a", "b`"]);
    }
    expectPerLine(["- a", "", "- ```", "  q", "  ```", "", "`a", "b`", "", "`c", "d`"]);
    // The same opener with no container before it closes, and the paragraph after pairs.
    expect(spans(["```", "q", "```", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("(c) an indented opener may sit in a list item that a less indented line ends", () => {
    // CommonMark: the item ends at `` ``` `` in column 0, which opens a new fence to EOF.
    expectPerLine(["- a", "", "  ```", "  q", "```", "", "`a", "b`"]);
    expectPerLine(["- a", "", "  <!--", "x", "<pre>", "-->", "", "`a", "b`"]);
    expectPerLine(["- a", "", "  <div>", "q", "", "`a", "b`"]);
    // A fence run indented 4+ closes the item's fence in CommonMark and not here.
    expectPerLine(["- a", "", "  ```", "  q", "     ```", "  ```", "", "`a", "b`"]);
    // Every line indented at least as far as the opener: the context closes where CommonMark's does.
    expect(spans(["- a", "", "  ```", "  q", "", "  x", "  ```", "", "`a", "b`"])).toEqual(["`a\nb`"]);
    expect(spans(["- a", "", "  <!--", "  x", "  -->", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("(c) a type 7 HTML line may be paragraph text, so an opener before the next blank line gives up", () => {
    // `<span>` cannot interrupt a paragraph: CommonMark reads `q <span>` as text and opens the fence.
    expectPerLine(["q", "<span>", "  ```", "", "`a", "b`"]);
    expectPerLine(["q", "</pre>", "  <!--", "", "`a", "b`"]);
    expectPerLine(["<Note>", "- ```", "", "`a", "b`"]);
    // With no opener before the blank line, both readings end there.
    expect(spans(["q", "<span>", "text", "", "`a", "b`"])).toEqual(["`a\nb`"]);
    expect(spans(["<Note>", "# h", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("(e) a stretch starting indented 4+ columns is code, so it pairs per line", () => {
    for (const lead of ["    ", "\t", "  \t"]) {
      expectPerLine(["para", "", `${lead}code \`x`, `${lead}y\``]);
    }
  });

  test("a stretch holding a backslash-escaped backtick pairs per line: this grammar reads no escapes", () => {
    expectPerLine(["Press \\` to open", "`ls` and `x", "y`"]);
    expectPerLine(["a `x", "y` \\`"]);
    expect(spans(["a `x", "y` \\ b"])).toEqual(["`x\ny`"]); // a backslash alone is text
  });

  test("a stretch with a backtick inside what may be an inline tag pairs per line", () => {
    // CommonMark reads `<a title="`">` as raw HTML before it pairs backticks.
    expectPerLine(['a <a title="`">', "b `x`", "y`"]);
    expectPerLine(["a <http://x`y>", "`b", "c`"]);
    expect(spans(["a `x < y", "z` b"])).toEqual(["`x < y\nz`"]);
  });

  test("a fence closes only on a run of its own character, at least as long", () => {
    expectPerLine(["```", "q", "~~~", "", "`a", "b`"]);
    expectPerLine(["````", "q", "```", "", "`a", "b`"]);
    expect(spans(["````", "q", "`````", "", "`a", "b`"])).toEqual(["`a\nb`"]);
    expect(spans(["~~~", "q", "~~~~", "", "`a", "b`"])).toEqual(["`a\nb`"]);
  });

  test("an HTML block start is matched case-insensitively", () => {
    for (const open of ["<PRE>", "<Script>"]) expectPerLine([open, "", "`a", "b`"]);
    // …ends at its own marker in any case, and a type 6 tag in any case certainly interrupts.
    expect(spans(["<PRE>", "</Pre>", "", "`a", "b`"])).toEqual(["`a\nb`"]);
    expect(spans(["a `x", "y` b", "<DIV>"])).toEqual(["`x\ny`"]);
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
    expect(spans(["```\r", "q\r", "```\r", "\r", "`a\r", "b`"])).toEqual(["`a\r\nb`"]);
    expect(spans(["<pre>\r", "</pre>\r", "\r", "`a\r", "b`"])).toEqual(["`a\r\nb`"]);
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

  test("it pairs exactly as a forward rescan per run does", () => {
    // The scan it replaced: each run looks ahead for the next run of its length.
    const rescan = (line: string) => {
      const out: { start: number; end: number; runLen: number }[] = [];
      for (let i = 0; i < line.length; ) {
        if (line[i] !== "`") { i++; continue; }
        let open = i;
        while (line[open] === "`") open++;
        const n = open - i;
        let close = -1;
        for (let k = open; k < line.length; ) {
          if (line[k] !== "`") { k++; continue; }
          let e = k;
          while (line[e] === "`") e++;
          if (e - k === n) { close = k; break; }
          k = e;
        }
        if (close === -1) i = open;
        else { out.push({ start: i, end: close + n, runLen: n }); i = close + n; }
      }
      return out;
    };
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let k = 0; k < 20_000; k++) {
      let s = "";
      for (let n = Math.floor(rnd() * 16); n > 0; n--) s += "`a \n"[Math.floor(rnd() * 4)];
      expect({ s, got: lineCodeSpanRanges(s) }).toEqual({ s, got: rescan(s) });
    }
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

describe("crossLineStretches — fix round 1", () => {
  const spans = (lines: string[]) => {
    const text = lines.join("\n");
    return textCodeSpanRanges(lines).map((r) => text.slice(r.start, r.end));
  };
  const expectPerLine = (lines: string[]) =>
    expect({ lines, stretches: crossLineStretches(lines) }).toEqual({ lines, stretches: [] });

  test("a backtick in a raw HTML or autolink window pairs per line, whatever the window holds", () => {
    // CommonMark reads each `<…>` below as raw HTML or an autolink before it pairs backticks.
    expectPerLine(['a <a title="x>y`">', "b `x", "y`"]); // an attribute holding `>`
    expectPerLine(["a <!-- q > r ` -->", "b `x", "y`"]); // a comment holding `>`
    expectPerLine(["a <?x > ` ?>", "b `x", "y`"]); // a processing instruction
    expectPerLine(["a <![CDATA[ > ` ]]>", "b `x", "y`"]); // CDATA
    expectPerLine(["a <!X ` >", "b `x", "y`"]); // a declaration
    expectPerLine(['a <a title="', '`">', "b `x", "y`"]); // a window across lines
    expectPerLine(["a <b>x `c", "d` y</b>"]); // a span between a tag and a later `>`
  });

  test("a backtick in a link destination or title pairs per line", () => {
    expectPerLine(["[a](x`y) b", "c` d"]);
    expectPerLine(['[a](u "t`") b `x', "y`"]);
    expectPerLine(["![a](x`y) b", "c` d"]);
    expectPerLine(["[a](x", "`y) b `c", "d`"]);
  });

  test("a backtick outside every window still pairs across", () => {
    expect(spans(["a < b `x", "y` c > d"])).toEqual(["`x\ny`"]); // `<` + space opens nothing
    expect(spans(["a `x", "y` <b>c</b>"])).toEqual(["`x\ny`"]); // the window starts after the span
    expect(spans(["x > y `a", "b`"])).toEqual(["`a\nb`"]); // a `>` alone
    expect(spans(["a `x", "y` [l](u)"])).toEqual(["`x\ny`"]);
    expect(spans(["[l] (u) `x", "y`"])).toEqual(["`x\ny`"]); // no `](`
  });

  test("a stretch is kept only when a span crosses a line", () => {
    expect(crossLineStretches(["a `x` b", "c"])).toEqual([]);
    expect(crossLineStretches(["a `x", "y`"])).toEqual([{ first: 0, end: 2 }]);
    // A span that ends where a line does crosses no line.
    expect(crossLineStretches(["a `x`", "b"])).toEqual([]);
  });

  test("a link reference definition may be indented up to 3 spaces", () => {
    expectPerLine(["   [a]: `x", "`y"]);
  });

  test("a fence run with an info string does not close a fence", () => {
    expectPerLine(["```", "q", "``` x", "", "`a", "b`"]);
  });

  test("a fence run indented 4+ is no top-level fence, and the stretch before it may continue", () => {
    expectPerLine(["a `x", "y` b", "    ```"]);
  });

  test("a processing instruction or CDATA block ends only at its own marker", () => {
    expectPerLine(["<?x", "a > b", "", "`a", "b`"]);
    expectPerLine(["<![CDATA[", "a > b", "", "`a", "b`"]);
  });

  test("`**` is paragraph text, not a thematic break, so the stretch before it pairs per line", () => {
    expectPerLine(["a `x", "y` b", "**"]);
    expect(crossLineStretches(["a `x", "y` b", "***"])).toEqual([{ first: 0, end: 2 }]);
  });
});

describe("lineCodeSpanRanges — the per-length cursor", () => {
  test("300k single backticks pair in linear time", () => {
    const s = "`a".repeat(300_000);
    const t0 = performance.now();
    expect(lineCodeSpanRanges(s)).toHaveLength(150_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("codeSpanContent — CRLF", () => {
  test("a CRLF line ending becomes one space", () => {
    const text = "`a\r\nb`";
    expect(codeSpanContent(text, lineCodeSpanRanges(text)[0]!)).toBe("a b");
  });
});
