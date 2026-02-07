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
