import { test, expect, describe } from "bun:test";
import {
  parseBlocks,
  parseMeterAttrs,
  normalizeMeterTone,
  normalizeFactVerdict,
  factClaimIndex,
  factClaimNumberFromHeading,
  parseChecklistItem,
  parseChecklist,
  scanInlineComponents,
  type Block,
} from "./markdown-ast.ts";

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
      { type: "ol", items: ["a", "b", "c"], start: 1 },
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

  test("Meter is a block component; label is its children, attrs kept", () => {
    expect(parseBlocks("<Meter value=\"4\" max=\"5\" tone=\"good\">Autonomy</Meter>")).toEqual([
      {
        type: "component",
        name: "Meter",
        attrs: { value: "4", max: "5", tone: "good" },
        children: [{ type: "text", lines: ["Autonomy"] }],
      },
    ]);
  });

  test("Meter is NOT self-closing → falls through as text", () => {
    expect(parseBlocks("<Meter value=\"4\" max=\"5\" />")).toEqual([
      { type: "text", lines: ["<Meter value=\"4\" max=\"5\" />"] },
    ]);
  });

  test("Diff wraps a fenced diff block as its child (fence parsed inside)", () => {
    expect(parseBlocks("<Diff>\n```diff\n-old\n+new\n```\n</Diff>")).toEqual([
      {
        type: "component",
        name: "Diff",
        attrs: {},
        children: [{ type: "code_block", lang: "diff", code: "-old\n+new" }],
      },
    ]);
  });

  test("AnnotatedCode keeps file/lang attrs and body fence + paragraphs", () => {
    expect(
      parseBlocks("<AnnotatedCode file=\"x.ts\" lang=\"ts\">\n```ts\nconst x = 1;\n```\n\nSets x.\n</AnnotatedCode>"),
    ).toEqual([
      {
        type: "component",
        name: "AnnotatedCode",
        attrs: { file: "x.ts", lang: "ts" },
        children: [
          { type: "code_block", lang: "ts", code: "const x = 1;" },
          { type: "text", lines: ["", "Sets x."] },
        ],
      },
    ]);
  });

  test("Checklist parses its task items as a ul child", () => {
    expect(parseBlocks("<Checklist>\n- [x] Done\n- [ ] Todo\n</Checklist>")).toEqual([
      {
        type: "component",
        name: "Checklist",
        attrs: {},
        children: [{ type: "ul", items: ["[x] Done", "[ ] Todo"] }],
      },
    ]);
  });

  test("CodeTabs parses repeated <Tab label> children as component blocks", () => {
    const blocks = parseBlocks(
      "<CodeTabs>\n<Tab label=\"TS\">\n```ts\nx\n```\n</Tab>\n<Tab label=\"JS\">\n```js\ny\n```\n</Tab>\n</CodeTabs>",
    );
    expect(blocks).toHaveLength(1);
    const tabs = (blocks[0] as { children: { name: string; attrs: Record<string, string> }[] }).children;
    expect(tabs.map((t) => t.name)).toEqual(["Tab", "Tab"]);
    expect(tabs.map((t) => t.attrs.label)).toEqual(["TS", "JS"]);
  });

  test("Tab is globally parseable (standalone), not scoped to CodeTabs", () => {
    expect(parseBlocks("<Tab label=\"Only\">\nx\n</Tab>")[0]).toMatchObject({
      type: "component",
      name: "Tab",
      attrs: { label: "Only" },
    });
  });

  test("a CodeTabs nested in a component puts Tab at depth 2 → Tab degrades to text", () => {
    // Documented top-level-only constraint: MAX_COMPONENT_DEPTH = 2.
    const blocks = parseBlocks("<Callout>\n<CodeTabs>\n<Tab label=\"A\">\nx\n</Tab>\n</CodeTabs>\n</Callout>");
    const callout = blocks[0] as { children: { type: string; name?: string; children?: unknown[] }[] };
    const codeTabs = callout.children.find((c) => c.name === "CodeTabs")!;
    // CodeTabs at depth 1 IS a component, but its <Tab> body is at depth 2 → text.
    expect(codeTabs.children!.every((c) => (c as { type: string }).type === "text")).toBe(true);
  });
});

describe("scanInlineComponents", () => {
  test("plain text with no tag → single text run", () => {
    expect(scanInlineComponents("just prose")).toEqual([{ kind: "text", text: "just prose" }]);
  });

  test("splits surrounding text and an inline Verdict token", () => {
    expect(scanInlineComponents('see <Verdict value="yes">ok</Verdict> here')).toEqual([
      { kind: "text", text: "see " },
      { kind: "component", name: "Verdict", attrs: { value: "yes" }, text: "ok" },
      { kind: "text", text: " here" },
    ]);
  });

  test("self-closing inline component has empty inner text", () => {
    expect(scanInlineComponents("x <Verdict value=\"no\"/> y")).toEqual([
      { kind: "text", text: "x " },
      { kind: "component", name: "Verdict", attrs: { value: "no" }, text: "" },
      { kind: "text", text: " y" },
    ]);
  });

  test("inline Pill keeps its whitelisted tone attr, drops unknown attrs", () => {
    expect(scanInlineComponents('<Pill tone="rec" bogus="x">go</Pill>')).toEqual([
      { kind: "component", name: "Pill", attrs: { tone: "rec" }, text: "go" },
    ]);
  });

  test("only Verdict/Pill are inline; other whitelisted names stay literal text", () => {
    // Callout is a BLOCK-only component — it is not in the inline whitelist, so
    // an embedded <Callout> is left as literal text for the block/escape path.
    expect(scanInlineComponents("mid <Callout>x</Callout> line")).toEqual([
      { kind: "text", text: "mid <Callout>x</Callout> line" },
    ]);
  });

  test("unclosed inline tag → whole string stays literal text", () => {
    expect(scanInlineComponents("go <Verdict value=\"yes\">no close")).toEqual([
      { kind: "text", text: "go <Verdict value=\"yes\">no close" },
    ]);
  });

  test("non-greedy: the FIRST close wins, trailing stray close is text", () => {
    expect(scanInlineComponents("<Pill>a</Pill>b</Pill>")).toEqual([
      { kind: "component", name: "Pill", attrs: {}, text: "a" },
      { kind: "text", text: "b</Pill>" },
    ]);
  });

  test("malformed unquoted attr is not a component → single literal text run", () => {
    // Only double-quoted attrs are valid; `value=yes` (unquoted) fails the tag
    // shape, so the whole string stays literal for the escape path.
    expect(scanInlineComponents("<Verdict value=yes>x</Verdict>")).toEqual([
      { kind: "text", text: "<Verdict value=yes>x</Verdict>" },
    ]);
  });

  test("10k inline components scan linearly in a single pass", () => {
    const md = Array.from({ length: 10_000 }, () => "<Pill>x</Pill>").join(" ");
    const start = Date.now();
    const segs = scanInlineComponents(md);
    expect(segs.filter((s) => s.kind === "component")).toHaveLength(10_000);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("dual behavior: own-line = block, mid-text = inline", () => {
  test("a Verdict alone on its line parses as a BLOCK component", () => {
    expect(parseBlocks('<Verdict value="yes">shipped</Verdict>')[0]).toMatchObject({
      type: "component",
      name: "Verdict",
    });
  });

  test("a Verdict mid-text is left as a text block by the block parser", () => {
    // The block parser only claims a component that owns its whole trimmed line;
    // mid-sentence occurrences fall through to text and are picked up inline.
    expect(parseBlocks('see <Verdict value="yes">shipped</Verdict> now')).toEqual([
      { type: "text", lines: ['see <Verdict value="yes">shipped</Verdict> now'] },
    ]);
    expect(scanInlineComponents('see <Verdict value="yes">shipped</Verdict> now')).toEqual([
      { kind: "text", text: "see " },
      { kind: "component", name: "Verdict", attrs: { value: "yes" }, text: "shipped" },
      { kind: "text", text: " now" },
    ]);
  });
});

describe("parseChecklistItem / parseChecklist", () => {
  test("marker parsing: checked, unchecked, uppercase, unmarked", () => {
    expect(parseChecklistItem("[x] Done")).toEqual({ checked: true, text: "Done" });
    expect(parseChecklistItem("[X] Done")).toEqual({ checked: true, text: "Done" });
    expect(parseChecklistItem("[ ] Todo")).toEqual({ checked: false, text: "Todo" });
    expect(parseChecklistItem("no marker")).toEqual({ checked: false, text: "no marker" });
  });

  test("parseChecklist reads the first ul block's items; empty without a list", () => {
    expect(parseChecklist([{ type: "ul", items: ["[x] A", "[ ] B"] }])).toEqual([
      { checked: true, text: "A" },
      { checked: false, text: "B" },
    ]);
    expect(parseChecklist([{ type: "text", lines: ["prose"] }])).toEqual([]);
  });
});

describe("parseMeterAttrs", () => {
  test("parses value/max/tone", () => {
    expect(parseMeterAttrs({ value: "4", max: "5", tone: "good" })).toEqual({
      value: 4,
      max: 5,
      tone: "good",
    });
  });

  test("max defaults to 5 when absent", () => {
    expect(parseMeterAttrs({ value: "3" })).toEqual({ value: 3, max: 5, tone: "default" });
  });

  test("missing value → null (identical-degrade signal)", () => {
    expect(parseMeterAttrs({ max: "5" })).toBeNull();
  });

  test("non-numeric value → null", () => {
    expect(parseMeterAttrs({ value: "abc" })).toBeNull();
    expect(parseMeterAttrs({ value: "" })).toBeNull();
    expect(parseMeterAttrs({ value: "   " })).toBeNull();
  });

  test("value above max clamps down to max", () => {
    expect(parseMeterAttrs({ value: "8", max: "5" })).toEqual({ value: 5, max: 5, tone: "default" });
  });

  test("negative value clamps up to 0", () => {
    expect(parseMeterAttrs({ value: "-2", max: "5" })).toEqual({ value: 0, max: 5, tone: "default" });
  });

  test("non-numeric or non-positive max falls back to default 5", () => {
    expect(parseMeterAttrs({ value: "3", max: "abc" })).toEqual({ value: 3, max: 5, tone: "default" });
    expect(parseMeterAttrs({ value: "3", max: "0" })).toEqual({ value: 3, max: 5, tone: "default" });
    expect(parseMeterAttrs({ value: "3", max: "-4" })).toEqual({ value: 3, max: 5, tone: "default" });
  });

  test("unknown tone normalizes to default", () => {
    expect(normalizeMeterTone("bogus")).toBe("default");
    expect(normalizeMeterTone(undefined)).toBe("default");
    expect(normalizeMeterTone("good")).toBe("good");
    expect(normalizeMeterTone("warn")).toBe("warn");
    expect(normalizeMeterTone("bad")).toBe("bad");
  });
});

describe("normalizeFactVerdict", () => {
  test("absent or garbage input falls back to `unknown` — NEVER to `ok`", () => {
    // The whole point of the fallback: a malformed or missing verdict must not
    // paint a green "confirmed" chip on a passage nothing actually confirmed.
    for (const bad of [undefined, "", "   ", "bogus", "true", "good", "yes", "0", "❓", "✔"]) {
      expect(normalizeFactVerdict(bad)).toBe("unknown");
    }
    expect(normalizeFactVerdict("bogus")).not.toBe("ok");
  });

  test("the three words map through, case-insensitively and whitespace-trimmed", () => {
    expect(normalizeFactVerdict("ok")).toBe("ok");
    expect(normalizeFactVerdict("OK")).toBe("ok");
    expect(normalizeFactVerdict(" Warn ")).toBe("warn");
    expect(normalizeFactVerdict("BAD")).toBe("bad");
  });

  test("the verify prompt's emoji are accepted, with or without the VS16", () => {
    expect(normalizeFactVerdict("✅")).toBe("ok");
    expect(normalizeFactVerdict("⚠")).toBe("warn");
    expect(normalizeFactVerdict("⚠️")).toBe("warn");
    expect(normalizeFactVerdict("❌")).toBe("bad");
  });
});

describe("factClaimIndex / factClaimNumberFromHeading", () => {
  test("a positive in-range integer parses; everything else is null (not NaN)", () => {
    expect(factClaimIndex("4")).toBe(4);
    expect(factClaimIndex(" 12 ")).toBe(12);
    for (const bad of [undefined, "", "abc", "0", "-1", "4.5", "1000"]) {
      expect(factClaimIndex(bad)).toBeNull();
    }
  });

  test("a claim heading yields its number; a non-claim heading yields null", () => {
    expect(factClaimNumberFromHeading("✅ Claim 4/8 — the weight")).toBe(4);
    expect(factClaimNumberFromHeading("claim 2")).toBe(2);
    expect(factClaimNumberFromHeading("Sources")).toBeNull();
  });
});

describe("Fact: own-line = block, mid-text = inline, self-closing allowed", () => {
  test("a Fact owning its whole trimmed line is claimed by the BLOCK parser", () => {
    expect(parseBlocks('<Fact n="4" v="bad">The weight was 1.32 kg.</Fact>')).toEqual([
      {
        type: "component",
        name: "Fact",
        attrs: { n: "4", v: "bad" },
        children: [{ type: "text", lines: ["The weight was 1.32 kg."] }],
      },
    ]);
  });

  test("a mid-sentence Fact falls through to text and is picked up inline", () => {
    const md = 'It was <Fact n="4" v="bad">1.32 kg</Fact> at launch.';
    expect(parseBlocks(md)).toEqual([{ type: "text", lines: [md] }]);
    expect(scanInlineComponents(md)).toEqual([
      { kind: "text", text: "It was " },
      { kind: "component", name: "Fact", attrs: { n: "4", v: "bad" }, text: "1.32 kg" },
      { kind: "text", text: " at launch." },
    ]);
  });

  test("the self-closing form parses as a childless component, block and inline", () => {
    expect(parseBlocks('<Fact n="4" v="bad"/>')).toEqual([
      { type: "component", name: "Fact", attrs: { n: "4", v: "bad" }, children: [] },
    ]);
    expect(scanInlineComponents('x <Fact n="4" v="bad"/> y')).toEqual([
      { kind: "text", text: "x " },
      { kind: "component", name: "Fact", attrs: { n: "4", v: "bad" }, text: "" },
      { kind: "text", text: " y" },
    ]);
  });

  test("FactCheck is BLOCK-only — a mid-text occurrence stays literal", () => {
    expect(scanInlineComponents('mid <FactCheck date="2026-07-29">x</FactCheck> line')).toEqual([
      { kind: "text", text: 'mid <FactCheck date="2026-07-29">x</FactCheck> line' },
    ]);
  });
});

const NUL = String.fromCharCode(0);

/**
 * Every string anywhere in a parsed block tree.
 *
 * The NUL assertions below read THIS and not `JSON.stringify(blocks)` — that
 * renders U+0000 as the six characters ` `, so a `.toContain(NUL)` over it
 * can never match and every leak assertion written that way passes on the
 * unfixed parser. (Written that way first; caught by the red run.)
 */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}
const leaksNul = (blocks: Block[]) => allStrings(blocks).some((s) => s.includes(NUL));
const hasCodeBlock = (blocks: Block[]) => blocks.some((b) => b.type === "code_block");

// The fence grammar is a LINE grammar: an opener owns its line (<= 3 spaces of
// indent), a closer is a bare run at least as long, the body is dedented by the
// opener's indent. Before that, the extraction regex matched an opener anywhere
// while the restore that turns a placeholder back into a block is anchored, so a
// fence that did not own its line lost its code block and served a raw U+0000.
describe("parseBlocks fence grammar", () => {
  test("an indented fence is a code block, dedented by its opener's indent", () => {
    // The ordinary "code block inside a numbered list" shape.
    const blocks = parseBlocks("1. Step\n\n   ```bash\n   echo hi\n     nested\n   ```\n");
    expect(blocks).toContainEqual({
      type: "code_block",
      lang: "bash",
      code: "echo hi\n  nested",
    });
  });

  test.each([1, 2, 3])("a fence indented by %i spaces is still a fence", (n) => {
    const pad = " ".repeat(n);
    expect(parseBlocks(`${pad}\`\`\`js\n${pad}x\n${pad}\`\`\``)).toEqual([
      { type: "code_block", lang: "js", code: "x" },
    ]);
  });

  test("a >= 4-space-indented fence is not a fence — and not a NUL either", () => {
    // CommonMark calls this indented code. This AST has no indented-code block,
    // so it degrades to a paragraph; what it must NEVER do is leak a placeholder.
    const blocks = parseBlocks("    ```js\n    x\n    ```");
    expect(hasCodeBlock(blocks)).toBe(false);
    expect(leaksNul(blocks)).toBe(false);
  });

  test.each([
    ["with a bare closer", "text ```ts\nconst a = 1;\n```"],
    ["with a trailing-text closer", "text ```ts\nconst a = 1;\n``` more"],
  ])("a fence delimiter starting mid-line is not a fence (%s)", (_name, md) => {
    // The sibling leak: the placeholder landed on a line holding prose either
    // side of it, and in the wiki reader the fence body's [[wikilink]] vanished.
    // The bare-closer case is the one that reads the OPENER's line anchor —
    // without it the closer rule alone already refuses the trailing-text case.
    const blocks = parseBlocks(md);
    expect(hasCodeBlock(blocks)).toBe(false);
    expect(leaksNul(blocks)).toBe(false);
    expect(allStrings(blocks).join("\n")).toContain("const a = 1;");
  });

  test("a 4-backtick fence is one code block, and 3 backticks do not close it", () => {
    expect(parseBlocks("````\n```\nx\n```\n````")).toEqual([
      { type: "code_block", lang: "", code: "```\nx\n```" },
    ]);
  });

  test("a closer carrying trailing text does not close the fence", () => {
    // CommonMark: a closing fence may be followed by spaces only. With no
    // closer the fence is unclosed, which stays literal text — and, unlike
    // before, keeps the whole line rather than a placeholder.
    const blocks = parseBlocks("```js\nx\n``` and more");
    expect(hasCodeBlock(blocks)).toBe(false);
    expect(leaksNul(blocks)).toBe(false);
    expect(allStrings(blocks).join("\n")).toContain("``` and more");
  });

  // ONE preservation pin follows: "an unclosed fence stays text" already held
  // before the line walker, so it does not go red on the old parser. The
  // backtick-info-string test below it is NOT one — it was strengthened to
  // require a real fence after the decoy line, and in that form it IS red on
  // the old parser. The earlier label here said "two"; review measured it false.
  test("an unclosed fence stays text — a half-streamed delta must not flicker", () => {
    const blocks = parseBlocks("```js\nconst x =");
    expect(hasCodeBlock(blocks)).toBe(false);
    expect(leaksNul(blocks)).toBe(false);
  });

  test("a line whose info string holds a backtick opens nothing", () => {
    // ```x``` is inline code the line happens to start with, not a fence. A
    // REAL fence has to follow it: treated as an opener, that line swallows
    // everything down to the next bare closer, so the js fence below it
    // disappears and the prose becomes code — which is the failure this pins,
    // and it is invisible when nothing closes.
    const blocks = parseBlocks("```x```\nordinary prose\n\n```js\nreal code\n```");
    expect(blocks.filter((b) => b.type === "code_block")).toEqual([
      { type: "code_block", lang: "js", code: "real code" },
    ]);
    expect(allStrings(blocks).join("\n")).toContain("ordinary prose");
    expect(leaksNul(blocks)).toBe(false);
  });

  test("lang is the info string's leading token, and the rest is dropped", () => {
    expect(parseBlocks('```ts title="x"\nconst a = 1;\n```')).toEqual([
      { type: "code_block", lang: "ts", code: "const a = 1;" },
    ]);
    expect(parseBlocks("```objective-c\nint x;\n```")).toEqual([
      { type: "code_block", lang: "objective-c", code: "int x;" },
    ]);
  });

  test("a placeholder-shaped string in the input is text, not a code block", () => {
    // U+0000 is not typable prose, but a page's bytes can hold this shape — the
    // live jarvis log.md holds NULs — and dereferencing an index no fence wrote
    // threw, killing the shared renderer for chat, Telegram, Slack and email at
    // once. The per-parse marker means such a string is not a placeholder at
    // all, so it stays the text it was: no throw, no block, nothing deleted.
    for (const md of [`${NUL}CB5${NUL}`, `${NUL}CB12${NUL}`, `\`\`\`js\nx\n\`\`\`\n\n${NUL}CB7${NUL}`]) {
      const blocks = parseBlocks(md);
      expect(blocks.filter((b) => b.type === "code_block")).toHaveLength(md.startsWith("```") ? 1 : 0);
      expect(allStrings(blocks).join("\n")).toContain(`${NUL}CB`);
    }
  });
});

// ── The fence grammar's state space, enumerated ─────────────────────────────
// Round 1 of review on this PR produced five findings that were all the SAME
// defect: a claim about the grammar written into a comment instead of computed.
// So the grammar is TABULATED here rather than described anywhere — every axis
// (opener indent, run length, info string, mid-line, closer indent/run/tail,
// unclosed) gets at least one row, `axisCoverage` fails if an axis loses its
// last row, and the docs point here instead of restating.
//
// `summarize` is deliberately lossy in one direction only: it names every
// code_block a parse produced, so "no code block" and "this exact block" are
// both expressible and neither can be satisfied by accident.
function summarize(blocks: Block[]): string {
  const codes = blocks
    .filter((b): b is Extract<Block, { type: "code_block" }> => b.type === "code_block")
    .map((b) => `code[${b.lang}]${JSON.stringify(b.code)}`);
  return codes.length === 0 ? "none" : codes.join(" + ");
}

const B = "`".repeat(3);
const FENCE_CASES: { axis: string; md: string; want: string }[] = [
  // opener indent
  { axis: "opener-indent", md: `${B}js\nx\n${B}`, want: 'code[js]"x"' },
  { axis: "opener-indent", md: ` ${B}js\n x\n ${B}`, want: 'code[js]"x"' },
  { axis: "opener-indent", md: `   ${B}js\n   x\n   ${B}`, want: 'code[js]"x"' },
  { axis: "opener-indent", md: `    ${B}js\n    x\n    ${B}`, want: "none" },
  // opener run length
  { axis: "opener-run", md: "`js\nx\n`", want: "none" },
  { axis: "opener-run", md: "``js\nx\n``", want: "none" },
  { axis: "opener-run", md: `${B}${B}\nx\n${B}${B}`, want: 'code[]"x"' },
  // a longer opener is not closed by a shorter run
  { axis: "closer-run", md: "````\n```\nx\n```\n````", want: 'code[]"```\\nx\\n```"' },
  { axis: "closer-run", md: "````js\nx\n```", want: "none" },
  { axis: "closer-run", md: "```js\nx\n`````", want: 'code[js]"x"' },
  // closer indent — same 0-3 bound as the opener
  { axis: "closer-indent", md: `${B}js\nx\n   ${B}`, want: 'code[js]"x"' },
  { axis: "closer-indent", md: `${B}js\nx\n    ${B}`, want: "none" },
  // closer tail
  { axis: "closer-tail", md: `${B}js\nx\n${B}   `, want: 'code[js]"x"' },
  { axis: "closer-tail", md: `${B}js\nx\n${B}\t`, want: 'code[js]"x"' },
  { axis: "closer-tail", md: `${B}js\nx\n${B} and more`, want: "none" },
  // info string -> lang
  { axis: "info-lang", md: `${B}\nx\n${B}`, want: 'code[]"x"' },
  { axis: "info-lang", md: `${B}objective-c\nx\n${B}`, want: 'code[objective-c]"x"' },
  { axis: "info-lang", md: `${B}c++\nx\n${B}`, want: 'code[c++]"x"' },
  { axis: "info-lang", md: `${B}c#\nx\n${B}`, want: 'code[c#]"x"' },
  { axis: "info-lang", md: `${B}asp.net\nx\n${B}`, want: 'code[asp.net]"x"' },
  { axis: "info-lang", md: `${B}ts title="x"\nx\n${B}`, want: 'code[ts]"x"' },
  { axis: "info-lang", md: `${B} ts\nx\n${B}`, want: 'code[ts]"x"' },
  { axis: "info-lang", md: `${B}ts!!\nx\n${B}`, want: 'code[ts]"x"' },
  // a backtick in a backtick fence's info string is not a fence at all
  { axis: "info-backtick", md: "```x```\nprose\n\n```js\nreal\n```", want: 'code[js]"real"' },
  // mid-line opener
  { axis: "midline", md: `text ${B}ts\nx\n${B}`, want: "none" },
  { axis: "midline", md: `text ${B}ts\nx\n${B} more`, want: "none" },
  // unclosed
  { axis: "unclosed", md: `${B}js\nconst x =`, want: "none" },
  // body handling
  { axis: "body", md: `${B}js\nx\n\n\n${B}`, want: 'code[js]"x"' },
  { axis: "body", md: `${B}js\n\nx\n${B}`, want: 'code[js]"\\nx"' },
  { axis: "body", md: `  ${B}js\n    x\n  y\n  ${B}`, want: 'code[js]"  x\\ny"' },
  { axis: "body", md: `  ${B}js\nx\n  ${B}`, want: 'code[js]"x"' },
  // tildes are not fences here
  { axis: "tilde", md: "~~~js\nx\n~~~", want: "none" },
  // The futility memo's edge: a LONGER opener finding no closer must not
  // silence a later SHORTER one, which a 3-backtick closer can still close.
  // (The mirror case is not expressible: for a 3-run opener to fail there must
  // be no bare delimiter left in the document at all, and then a longer opener
  // after it cannot close either. That is the memo's soundness argument, and it
  // is why there is no row for it rather than an unfailable one.)
  { axis: "scan-memo", md: "`````\nA\n\n```ts\ny\n```", want: 'code[ts]"y"' },
];

describe("the fence grammar, tabulated", () => {
  test.each(FENCE_CASES)("$axis: $md", ({ md, want }) => {
    expect(summarize(parseBlocks(md))).toBe(want);
  });

  test("every axis still has at least one row", () => {
    const axes = new Set(FENCE_CASES.map((c) => c.axis));
    expect([...axes].sort()).toEqual([
      "body",
      "closer-indent",
      "closer-run",
      "closer-tail",
      "info-backtick",
      "info-lang",
      "midline",
      "opener-indent",
      "opener-run",
      "scan-memo",
      "tilde",
      "unclosed",
    ]);
  });
});

describe("what an UNCLOSED fence actually does", () => {
  // NOT "stays literal text" — an earlier revision of this file and of
  // src/web/CLAUDE.md both said that, and both were wrong. The lines are handed
  // to the ordinary block parser, so headings, lists and COMPONENTS inside an
  // unclosed fence render. Computed, and pinned so the doc cannot drift back.
  test("its body is parsed as ordinary markdown, components included", () => {
    const blocks = parseBlocks("````js\n# heading\n- item\n<Callout>boom</Callout>\n```");
    expect(blocks.map((b) => b.type)).toEqual(["text", "heading", "ul", "component", "text"]);
  });
});

describe("the placeholder namespace is unforgeable", () => {
  // Three review rounds landed on the SANITISER that used to defend this — one
  // pass reassembled a live placeholder from a nested spelling and threw; a
  // bounded loop stopped early at its bound and left a raw NUL or a FORGED
  // DUPLICATE of a real fence's block; unbounded, it was quadratic in time.
  // The class behind all three was a forgeable namespace, so the marker is now
  // chosen per parse to be one `~` longer than any run the input already has.
  // No input is rewritten, so nothing can be reassembled, and the two failure
  // modes below are what these assert against — for EVERY nesting depth, since
  // depth was the axis every bound got wrong.
  const nest = (d: number) => {
    let s = `${NUL}CB0${NUL}`;
    for (let i = 0; i < d; i++) s = `${NUL}C${s}B0${NUL}`;
    return s;
  };
  const shapes: [string, string][] = [
    ["flat", `${NUL}CB5${NUL}`],
    ["multi-digit", `${NUL}CB12${NUL}`],
    ["marker-shaped", `${NUL}CB~0${NUL}`],
    ["longer marker-shaped", `${NUL}CB~~~~~~~~~~0${NUL}`],
    ...([0, 1, 2, 9, 10, 11, 12, 25].map((d) => [`nested x${d}`, nest(d)]) as [string, string][]),
  ];
  test.each(shapes)("%s: no throw, and no block the page did not write", (_name, forged) => {
    for (const [md, realFences] of [
      [forged, 0],
      [`\`\`\`js\nREAL\n\`\`\`\n\n${forged}`, 1],
    ] as const) {
      let blocks: Block[] = [];
      expect(() => (blocks = parseBlocks(md))).not.toThrow();
      const codes = blocks.filter((b) => b.type === "code_block");
      // EXACTLY, not <=: a one-sided bound also passes when the real fence is
      // dropped, which is the other direction this has to catch.
      expect(codes).toHaveLength(realFences);
      // Nothing was deleted from the page either — the forged text is still
      // text. Round 2 scrubbed it; scrubbing is what kept going wrong.
      expect(allStrings(blocks).join("\n")).toContain(`${NUL}CB`);
    }
  });

  test("CRLF is normalized before anything else looks at the text", () => {
    // A preservation pin, not a red->green: `rendered-code.ts` documents this as
    // the first of four reasons its scan reads the RENDERED html rather than the
    // markdown ("a raw-body scan finds no fence at all in a CRLF file"), and the
    // property was load-bearing there while pinned nowhere.
    expect(parseBlocks("```js\r\nx\r\n```")).toEqual([
      { type: "code_block", lang: "js", code: "x" },
    ]);
  });

  test("the marker outruns any run of ~ the input already has", () => {
    // The property the whole design rests on, computed rather than argued: for
    // an input carrying k tildes after a \x00CB, the emitted placeholder must
    // not be spellable by that input. Read off the RENDERED text: whatever
    // marker was chosen, the forged line must not have become a code block.
    for (let k = 0; k < 40; k++) {
      const forged = `${NUL}CB${"~".repeat(k)}0${NUL}`;
      const blocks = parseBlocks(`\`\`\`js\nREAL\n\`\`\`\n\n${forged}`);
      expect(blocks.filter((b) => b.type === "code_block")).toHaveLength(1);
    }
  });

  test("choosing the marker is linear, not quadratic, in nesting depth", () => {
    // The round-3 finding was that the sanitiser it replaces was O(n^2) in
    // TIME: 298 ms at 80 KB of nested spelling, 1.2 s at 160 KB, 4.8 s at
    // 320 KB, blocking the process, per streaming delta. Nothing rewrites the
    // input now, so this is one scan. 2000 ms separates the two by ~100x
    // without being tight on a slow CI runner.
    const md = nest(40_000); // ~320 KB, the size that measured 4.8 s
    const t0 = performance.now();
    parseBlocks(md);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("the closer scan is not quadratic", () => {
  // `parseBlocks` re-runs on every streaming chat delta, so an opener that
  // re-scans the whole tail is a hot-path cost, not a theoretical one. The
  // trigger is not adversarial: a page whose fences all close with trailing
  // text (``` end) has no valid closer at all under CommonMark, so every
  // opener scanned to EOF. Measured on this machine before the memo:
  // 1500 lines 45 ms, 3000 152 ms, 6000 632 ms, 12000 2436 ms, 24000 9848 ms —
  // 4x per doubling. After: single-digit ms at 24000.
  test("24k lines of never-closing fences parse in well under a second", () => {
    const lines: string[] = [];
    for (let i = 0; i < 8000; i++) lines.push("```js", `x${i}`, "``` end");
    const md = lines.join("\n");
    const t0 = performance.now();
    const blocks = parseBlocks(md);
    const ms = performance.now() - t0;
    // None of them close, so none is extracted — the point is the time.
    expect(blocks.some((b) => b.type === "code_block")).toBe(false);
    // 2000 ms is ~5x the pre-memo cost of the HALF-size document and ~100x the
    // post-memo cost of this one, so it separates the two without being tight
    // on a slow CI runner.
    expect(ms).toBeLessThan(2000);
  });
});
