import { test, expect } from "bun:test";
import { formatTelegramHtml } from "./telegram-format.ts";

test("converts markdown headings to bold", () => {
  expect(formatTelegramHtml("## Summary")).toBe("<b>Summary</b>");
  expect(formatTelegramHtml("### Details")).toBe("<b>Details</b>");
});

test("removes horizontal rules", () => {
  expect(formatTelegramHtml("above\n---\nbelow")).toBe("above\n\nbelow");
});

test("converts **bold** to <b>", () => {
  expect(formatTelegramHtml("this is **bold** text")).toBe(
    "this is <b>bold</b> text",
  );
});

test("converts *italic* to <i>", () => {
  expect(formatTelegramHtml("this is *italic* text")).toBe(
    "this is <i>italic</i> text",
  );
});

test("converts _italic_ to <i>", () => {
  expect(formatTelegramHtml("this is _italic_ text")).toBe(
    "this is <i>italic</i> text",
  );
});

test("converts ~~strike~~ to <s>", () => {
  expect(formatTelegramHtml("this is ~~gone~~ text")).toBe(
    "this is <s>gone</s> text",
  );
});

test("converts markdown links", () => {
  expect(formatTelegramHtml("[click](https://example.com)")).toBe(
    '<a href="https://example.com">click</a>',
  );
});

test("preserves code blocks and escapes HTML inside them", () => {
  const input = "```ts\nconst x = 1 < 2;\n```";
  expect(formatTelegramHtml(input)).toBe(
    '<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>',
  );
});

test("preserves inline code and escapes HTML inside", () => {
  expect(formatTelegramHtml("use `<div>` here")).toBe(
    "use <code>&lt;div&gt;</code> here",
  );
});

test("escapes double quotes inside inline code (Telegram renders &quot; as \")", () => {
  expect(formatTelegramHtml('say `a "b" c`')).toBe(
    "say <code>a &quot;b&quot; c</code>",
  );
});

test("does not convert bold/italic inside code blocks", () => {
  const input = "```\n**not bold**\n```";
  expect(formatTelegramHtml(input)).toBe(
    "<pre><code>**not bold**</code></pre>",
  );
});

test("escapes ampersands in regular text", () => {
  expect(formatTelegramHtml("A & B")).toBe("A &amp; B");
});

test("does not double-escape existing HTML entities", () => {
  expect(formatTelegramHtml("&amp; &lt;")).toBe("&amp; &lt;");
});

test("collapses excessive blank lines", () => {
  expect(formatTelegramHtml("a\n\n\n\nb")).toBe("a\n\nb");
});

test("italic does not overlap with links (prevents Telegram parse error)", () => {
  // This pattern caused: "expected </a>, found </i>" in Telegram
  const input = "Check *[this link](https://example.com) for details*";
  const result = formatTelegramHtml(input);
  // Link should be protected — italic wraps around the placeholder, not inside the <a> tag
  expect(result).toContain('<a href="https://example.com">this link</a>');
  expect(result).not.toMatch(/<a[^>]*>.*<i>.*<\/a>/); // no <i> starting inside <a> and closing outside
});

test("formatting inside link text is not processed (avoids nested tag issues)", () => {
  const result = formatTelegramHtml("[**bold link**](https://example.com)");
  expect(result).toContain('<a href="https://example.com">**bold link**</a>');
});

test("handles a realistic Claude response", () => {
  const input = `## Summary: Email Conversations

---

### 1. AI-Powered Loop (Jan 2026)
You sent **an image** about _testing_.

### 2. Neural Networks (Dec 2025)
He found it ~~bad~~ very well explained.`;

  const result = formatTelegramHtml(input);

  // No markdown headings or rules remain
  expect(result).not.toContain("##");
  expect(result).not.toContain("---");
  // Proper HTML formatting
  expect(result).toContain("<b>Summary: Email Conversations</b>");
  expect(result).toContain("<b>1. AI-Powered Loop (Jan 2026)</b>");
  expect(result).toContain("<b>an image</b>");
  expect(result).toContain("<i>testing</i>");
  expect(result).toContain("<s>bad</s>");
});

test("component: Callout → bold title prefix + body", () => {
  expect(formatTelegramHtml("<Callout tone=\"info\" title=\"Heads up\">\nbody\n</Callout>")).toBe(
    "<b>Heads up</b>\nbody",
  );
});

test("component: Callout without title → just body", () => {
  expect(formatTelegramHtml("<Callout>\nbody\n</Callout>")).toBe("body");
});

test("component: Verdict → check/cross + label", () => {
  expect(formatTelegramHtml("<Verdict value=\"yes\">Fast</Verdict>")).toBe("✅ Fast");
  expect(formatTelegramHtml("<Verdict value=\"no\" />")).toBe("❌ No");
});

test("component: Pill → [text]", () => {
  expect(formatTelegramHtml("<Pill>beta</Pill>")).toBe("[beta]");
});

test("component: FileRef self-closing → plain path", () => {
  expect(formatTelegramHtml("<FileRef path=\"src/x.ts\" />")).toBe("src/x.ts");
});

test("component: ComparisonTable → its inner table (pipe form)", () => {
  const out = formatTelegramHtml("<ComparisonTable>\n| A | B |\n| --- | --- |\n| 1 | 2 |\n</ComparisonTable>");
  expect(out).toContain("| A | B |");
});

test("component: Callout title with angle brackets is escaped", () => {
  const out = formatTelegramHtml("<Callout title=\"a<b\">\nx\n</Callout>");
  expect(out).toContain("a&lt;b");
  expect(out).not.toContain("<b>a<b</b>");
});

test("component: Meter → label: value/max fallback", () => {
  expect(formatTelegramHtml("<Meter value=\"4\" max=\"5\" tone=\"good\">Autonomy</Meter>")).toBe(
    "Autonomy: 4/5",
  );
});

test("component: Meter clamps out-of-range value", () => {
  expect(formatTelegramHtml("<Meter value=\"9\" max=\"5\">Over</Meter>")).toBe("Over: 5/5");
});

test("component: Meter with non-numeric value degrades to plain label", () => {
  expect(formatTelegramHtml("<Meter value=\"abc\">Autonomy</Meter>")).toBe("Autonomy");
});

test("component: Diff falls back to the fence as-is (Telegram renders code)", () => {
  const out = formatTelegramHtml("<Diff>\n```diff\n context\n-old\n+new\n```\n</Diff>");
  expect(out).toBe('<pre><code class="language-diff"> context\n-old\n+new</code></pre>');
});

test("component: unclosed Diff degrades to escaped text", () => {
  const out = formatTelegramHtml("<Diff>\nno close here");
  expect(out).toContain("&lt;Diff&gt;");
  expect(out).not.toContain('class="language-diff"');
});

test("component: FileTree falls back to the fence as-is", () => {
  const out = formatTelegramHtml("<FileTree>\n```\nsrc/\n  a.ts\n```\n</FileTree>");
  expect(out).toBe("<pre><code>src/\n  a.ts</code></pre>");
});

test("component: unclosed FileTree degrades to escaped text", () => {
  const out = formatTelegramHtml("<FileTree>\nno close");
  expect(out).toContain("&lt;FileTree&gt;");
});

test("component: Checklist → ☑/☐-prefixed lines fallback", () => {
  const out = formatTelegramHtml("<Checklist>\n- [x] Done\n- [ ] Todo\n</Checklist>");
  expect(out).toBe("☑ Done\n☐ Todo");
});

test("component: unclosed Checklist degrades to escaped text", () => {
  const out = formatTelegramHtml("<Checklist>\n- [x] no close");
  expect(out).toContain("&lt;Checklist&gt;");
});
