import { test, expect, describe } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";

describe("parseBlocks", () => {
  test("parses heading", () => {
    expect(parseBlocks("## Title")).toEqual([
      { type: "heading", level: 2, content: "Title" },
    ]);
  });

  test("parses heading levels 1–6", () => {
    expect(parseBlocks("# H1")).toEqual([{ type: "heading", level: 1, content: "H1" }]);
    expect(parseBlocks("###### H6")).toEqual([{ type: "heading", level: 6, content: "H6" }]);
  });

  test("parses hr", () => {
    expect(parseBlocks("---")).toEqual([{ type: "hr" }]);
    expect(parseBlocks("-----")).toEqual([{ type: "hr" }]);
  });

  test("parses code block with lang", () => {
    expect(parseBlocks("```ts\nconst x = 1;\n```")).toEqual([
      { type: "code_block", lang: "ts", code: "const x = 1;" },
    ]);
  });

  test("parses code block without lang", () => {
    expect(parseBlocks("```\nhello\n```")).toEqual([
      { type: "code_block", lang: "", code: "hello" },
    ]);
  });

  test("does not parse markdown inside code blocks", () => {
    const input = "```\n## not a heading\n- not a list\n```";
    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "code_block",
      lang: "",
      code: "## not a heading\n- not a list",
    });
  });

  test("groups consecutive blockquote lines", () => {
    expect(parseBlocks("> first\n> second")).toEqual([
      { type: "blockquote", lines: ["first", "second"] },
    ]);
  });

  test("groups unordered list items", () => {
    expect(parseBlocks("- a\n- b\n- c")).toEqual([
      { type: "ul", items: ["a", "b", "c"] },
    ]);
  });

  test("accepts both - and * for unordered lists", () => {
    expect(parseBlocks("* a\n* b")).toEqual([
      { type: "ul", items: ["a", "b"] },
    ]);
  });

  test("groups ordered list items", () => {
    expect(parseBlocks("1. a\n2. b\n3. c")).toEqual([
      { type: "ol", items: ["a", "b", "c"] },
    ]);
  });

  test("parses table with headers and rows", () => {
    const input = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    expect(parseBlocks(input)).toEqual([
      {
        type: "table",
        headers: ["Name", "Age"],
        rows: [
          ["Alice", "30"],
          ["Bob", "25"],
        ],
      },
    ]);
  });

  test("rejects table with no separator row (passes through as text)", () => {
    const input = "| A | B |\n| 1 | 2 |";
    const blocks = parseBlocks(input);
    expect(blocks).toEqual([{ type: "text", lines: ["| A | B |", "| 1 | 2 |"] }]);
  });

  test("rejects single-pipe text (passes through as text)", () => {
    expect(parseBlocks("this | is not | a table")).toEqual([
      { type: "text", lines: ["this | is not | a table"] },
    ]);
  });

  test("groups text lines together", () => {
    expect(parseBlocks("one\ntwo\nthree")).toEqual([
      { type: "text", lines: ["one", "two", "three"] },
    ]);
  });

  test("preserves blank lines inside text blocks", () => {
    expect(parseBlocks("one\n\ntwo")).toEqual([
      { type: "text", lines: ["one", "", "two"] },
    ]);
  });

  test("normalizes \\r\\n to \\n", () => {
    expect(parseBlocks("a\r\nb\r\n")).toEqual([
      { type: "text", lines: ["a", "b", ""] },
    ]);
  });

  test("handles empty input", () => {
    expect(parseBlocks("")).toEqual([{ type: "text", lines: [""] }]);
  });

  test("mixed content stays in order", () => {
    const input = "intro\n\n## Heading\n\n- item 1\n- item 2\n\n```js\ncode\n```\n\nafter";
    const blocks = parseBlocks(input);
    expect(blocks.map((b) => b.type)).toEqual([
      "text",
      "heading",
      "text",
      "ul",
      "text",
      "code_block",
      "text",
    ]);
  });

  test("code block with surrounding text", () => {
    const input = "before\n```\ncode\n```\nafter";
    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", lines: ["before"] });
    expect(blocks[1]).toEqual({ type: "code_block", lang: "", code: "code" });
    expect(blocks[2]).toEqual({ type: "text", lines: ["after"] });
  });

  test("blockquote interspersed with text breaks the quote", () => {
    const input = "> quote\nplain\n> next";
    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "blockquote", lines: ["quote"] });
    expect(blocks[1]).toEqual({ type: "text", lines: ["plain"] });
    expect(blocks[2]).toEqual({ type: "blockquote", lines: ["next"] });
  });
});

describe("parseBlocks — component blocks", () => {
  test("single-line component with inline close", () => {
    expect(parseBlocks("<Verdict value=\"yes\">Fast</Verdict>")).toEqual([
      { type: "component", name: "Verdict", attrs: { value: "yes" }, children: [{ type: "text", lines: ["Fast"] }] },
    ]);
  });

  test("multi-line Callout parses its body as blocks", () => {
    const input = "<Callout tone=\"warn\" title=\"Watch out\">\n## Inner heading\n\n- a\n- b\n</Callout>";
    expect(parseBlocks(input)).toEqual([
      {
        type: "component",
        name: "Callout",
        attrs: { tone: "warn", title: "Watch out" },
        children: [
          { type: "heading", level: 2, content: "Inner heading" },
          { type: "text", lines: [""] },
          { type: "ul", items: ["a", "b"] },
        ],
      },
    ]);
  });

  test("self-closing FileRef with path attr", () => {
    expect(parseBlocks("<FileRef path=\"src/x.ts\" />")).toEqual([
      { type: "component", name: "FileRef", attrs: { path: "src/x.ts" }, children: [] },
    ]);
  });

  test("self-closing not allowed for Callout → falls through as text", () => {
    expect(parseBlocks("<Callout tone=\"info\" />")).toEqual([
      { type: "text", lines: ["<Callout tone=\"info\" />"] },
    ]);
  });

  test("unknown tag is NOT a component (falls through as text)", () => {
    expect(parseBlocks("<Widget foo=\"bar\">hi</Widget>")).toEqual([
      { type: "text", lines: ["<Widget foo=\"bar\">hi</Widget>"] },
    ]);
  });

  test("unknown attrs are dropped, known attrs kept", () => {
    const blocks = parseBlocks("<Callout tone=\"good\" bogus=\"x\" onclick=\"evil()\">\nbody\n</Callout>");
    expect(blocks[0]).toMatchObject({ type: "component", name: "Callout", attrs: { tone: "good" } });
    expect((blocks[0] as any).attrs).toEqual({ tone: "good" });
  });

  test("unclosed component tag falls through as text", () => {
    const input = "<Callout tone=\"info\">\nnever closed";
    expect(parseBlocks(input)).toEqual([
      { type: "text", lines: ["<Callout tone=\"info\">", "never closed"] },
    ]);
  });

  test("nesting depth cap: a component at depth 2 is not parsed (body stays text)", () => {
    // Callout(0) > Callout(1) > Pill — the innermost Pill is at depth 2, not parsed.
    const input = "<Callout>\n<Callout>\n<Pill>x</Pill>\n</Callout>\n</Callout>";
    const outer = parseBlocks(input);
    expect(outer).toHaveLength(1);
    expect(outer[0]).toMatchObject({ type: "component", name: "Callout" });
    const mid = (outer[0] as any).children;
    expect(mid).toHaveLength(1);
    expect(mid[0]).toMatchObject({ type: "component", name: "Callout" });
    // The innermost body is at depth 2 → the Pill is plain text, not a component.
    expect(mid[0].children).toEqual([{ type: "text", lines: ["<Pill>x</Pill>"] }]);
  });

  test("code fence inside a Callout is preserved as a code block", () => {
    const input = "<Callout tone=\"info\">\n```ts\nconst x = 1;\n```\n</Callout>";
    expect(parseBlocks(input)).toEqual([
      {
        type: "component",
        name: "Callout",
        attrs: { tone: "info" },
        children: [{ type: "code_block", lang: "ts", code: "const x = 1;" }],
      },
    ]);
  });

  test("same-name nesting: inner Callout does not close the outer early", () => {
    const input = "<Callout>\nouter\n<Callout>\ninner\n</Callout>\nmore outer\n</Callout>";
    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    const kids = (blocks[0] as any).children;
    expect(kids.map((b: any) => b.type)).toEqual(["text", "component", "text"]);
    expect(kids[1]).toMatchObject({ type: "component", name: "Callout" });
  });

  test("ComparisonTable wraps an inner table", () => {
    const input = "<ComparisonTable>\n| A | B |\n| --- | --- |\n| 1 | 2 |\n</ComparisonTable>";
    expect(parseBlocks(input)).toEqual([
      {
        type: "component",
        name: "ComparisonTable",
        attrs: {},
        children: [{ type: "table", headers: ["A", "B"], rows: [["1", "2"]] }],
      },
    ]);
  });
});
