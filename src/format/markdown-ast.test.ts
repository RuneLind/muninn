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
  codeSpanRegions,
  inCodeSpan,
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

describe("codeSpanRegions / inCodeSpan", () => {
  /** Every index of `needle` in `text`, so a case names the construct rather
   *  than a magic offset. */
  const at = (text: string, needle: string) => text.indexOf(needle);

  test("a fenced block is one region, covering its delimiters", () => {
    const text = "before\n```ts\nconst x = 1;\n```\nafter";
    const regions = codeSpanRegions(text);
    expect(regions).toHaveLength(1);
    expect(text.slice(regions[0]!.start, regions[0]!.end)).toBe("```ts\nconst x = 1;\n```");
    expect(inCodeSpan(regions, at(text, "const"))).toBe(true);
    expect(inCodeSpan(regions, at(text, "before"))).toBe(false);
    expect(inCodeSpan(regions, at(text, "after"))).toBe(false);
  });

  test("inline spans on either side of a fence are found, and the prose between is not", () => {
    const text = "use `a` then\n```\nx\n```\nand `b`";
    const regions = codeSpanRegions(text);
    expect(inCodeSpan(regions, at(text, "`a`"))).toBe(true);
    expect(inCodeSpan(regions, at(text, "`b`"))).toBe(true);
    expect(inCodeSpan(regions, at(text, "then"))).toBe(false);
    expect(inCodeSpan(regions, at(text, "and"))).toBe(false);
  });

  test("a fence's own backticks never pair with prose ones — the blanking pass", () => {
    // Mirrors `parseBlocks`, which swaps each fence for a backtick-free
    // placeholder BEFORE `renderInline` scans lines, so a fence delimiter can
    // never become half of an inline pair. Without the blanking this exact input
    // yields the SPURIOUS regions "`b `" and "` c`" — i.e. the prose words `b`
    // and `c` are reported as code, and a wikilink written there would stop
    // being parked. That is an OVER-skip: a working link silently turned into
    // literal brackets, the failure direction this whole guard must not have.
    // Distinct letters throughout, so `at()` cannot resolve a prose probe to a
    // character inside the fence body.
    const text = "a`b ```\nzz\n``` c`d";
    const regions = codeSpanRegions(text);
    expect(regions.map((r) => text.slice(r.start, r.end))).toEqual(["```\nzz\n```"]);
    expect(inCodeSpan(regions, at(text, "b"))).toBe(false);
    expect(inCodeSpan(regions, at(text, "c"))).toBe(false);
    expect(inCodeSpan(regions, at(text, "zz"))).toBe(true);
  });

  test("the inline pass is LINE-scoped, exactly as renderInline applies it", () => {
    // A lone backtick on one line must not pair with one two paragraphs down.
    const text = "a ` stray\n\nprose here\n\nanother ` one";
    expect(inCodeSpan(codeSpanRegions(text), at(text, "prose"))).toBe(false);
  });

  test("a fence inside a block component is found — extraction is document-wide", () => {
    const text = '<Callout tone="info" title="t">\n\n```ts\nconst x = 1;\n```\n\n</Callout>';
    expect(inCodeSpan(codeSpanRegions(text), at(text, "const"))).toBe(true);
  });

  test("regions come back SORTED, which is what inCodeSpan's binary search needs", () => {
    // Fences are collected first and inline spans second, so the two lists
    // interleave; an unsorted return makes the search answer false at random.
    const text = "`a`\n\n```\nfence\n```\n\n`b`\n\n```\ntwo\n```\n\n`c`";
    const regions = codeSpanRegions(text);
    const starts = regions.map((r) => r.start);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    for (const needle of ["`a`", "fence", "`b`", "two", "`c`"]) {
      expect(inCodeSpan(regions, at(text, needle))).toBe(true);
    }
  });

  test("a ~~~ block is NOT a region — this pipeline renders it as prose", () => {
    // The load-bearing divergence from CommonMark. Measured: formatWebHtml
    // renders a tilde-fenced block as ordinary text, so calling it code here
    // would turn a working wikilink inside it into literal brackets.
    const text = "~~~\nplain text\n~~~";
    expect(inCodeSpan(codeSpanRegions(text), at(text, "plain"))).toBe(false);
  });

  test("no code, no regions", () => {
    expect(codeSpanRegions("just prose, no code at all")).toEqual([]);
    expect(inCodeSpan([], 0)).toBe(false);
  });
});
