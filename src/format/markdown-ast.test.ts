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
