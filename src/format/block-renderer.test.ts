import { test, expect } from "bun:test";
import { renderBlocks, type BlockRenderer } from "./block-renderer.ts";
import type { Block } from "./markdown-ast.ts";

// A renderer that tags each block type so we can assert dispatch + args.
const probe: BlockRenderer = {
  code_block: (b) => `CODE[${b.lang}]:${b.code}`,
  hr: () => "HR",
  heading: (b) => `H${b.level}:${b.content}`,
  blockquote: (lines) => `BQ:${lines.join("|")}`,
  ul: (items) => `UL:${items.join("|")}`,
  ol: (items) => `OL:${items.join("|")}`,
  table: (headers, rows) => `TBL:${headers.join(",")};${rows.map((r) => r.join(",")).join(";")}`,
  component: (name, attrs, kids) => `CMP[${name}]{${JSON.stringify(attrs)}}:${kids}`,
  text: (lines) => `TXT:${lines.join("|")}`,
};

test("dispatches each block type to the matching method with the right args", () => {
  const blocks: Block[] = [
    { type: "heading", level: 1, content: "Title" },
    { type: "text", lines: ["para line"] },
    { type: "ul", items: ["a", "b"] },
    { type: "ol", items: ["one", "two"] },
    { type: "blockquote", lines: ["quoted"] },
    { type: "code_block", lang: "ts", code: "const x = 1;" },
    { type: "hr" },
    { type: "table", headers: ["H1", "H2"], rows: [["a", "b"]] },
  ];
  expect(renderBlocks(blocks, probe)).toBe(
    [
      "H1:Title",
      "TXT:para line",
      "UL:a|b",
      "OL:one|two",
      "BQ:quoted",
      "CODE[ts]:const x = 1;",
      "HR",
      "TBL:H1,H2;a,b",
    ].join("\n"),
  );
});

test("dispatches component blocks, rendering children through the same renderer", () => {
  const blocks: Block[] = [
    {
      type: "component",
      name: "Callout",
      attrs: { tone: "info", title: "Heads up" },
      children: [{ type: "text", lines: ["body"] }],
    },
  ];
  expect(renderBlocks(blocks, probe)).toBe('CMP[Callout]{{"tone":"info","title":"Heads up"}}:TXT:body');
});

test("joins rendered blocks with a single newline", () => {
  const blocks: Block[] = [
    { type: "heading", level: 1, content: "A" },
    { type: "heading", level: 1, content: "B" },
  ];
  expect(renderBlocks(blocks, probe)).toBe("H1:A\nH1:B");
});

test("empty block list renders to empty string", () => {
  expect(renderBlocks([], probe)).toBe("");
});
