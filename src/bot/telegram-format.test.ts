import { test, expect } from "bun:test";
import { formatTelegramHtml, formatTelegramHtmlChunks, TELEGRAM_MAX_MESSAGE } from "./telegram-format.ts";

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

test("component: AnnotatedCode → file line + fence + notes fallback", () => {
  const out = formatTelegramHtml(
    "<AnnotatedCode file=\"src/x.ts\" lang=\"ts\">\n```ts\nconst x = 1;\n```\n\nSets x.\n</AnnotatedCode>",
  );
  expect(out).toBe('<b>src/x.ts</b>\n<pre><code class="language-ts">const x = 1;</code></pre>\n\nSets x.');
});

test("component: unclosed AnnotatedCode degrades to escaped text", () => {
  const out = formatTelegramHtml("<AnnotatedCode file=\"x.ts\">\nno close");
  expect(out).toContain("&lt;AnnotatedCode");
});

test("component: CodeTabs → sequential — label — sections fallback", () => {
  const out = formatTelegramHtml(
    "<CodeTabs>\n<Tab label=\"TS\">\n```ts\nconst x=1;\n```\n</Tab>\n<Tab label=\"JS\">\n```js\nvar x=1;\n```\n</Tab>\n</CodeTabs>",
  );
  expect(out).toBe(
    '— TS —\n<pre><code class="language-ts">const x=1;</code></pre>\n— JS —\n<pre><code class="language-js">var x=1;</code></pre>',
  );
});

test("component: unclosed CodeTabs degrades to escaped text", () => {
  const out = formatTelegramHtml("<CodeTabs>\n<Tab label=\"A\">no close");
  expect(out).toContain("&lt;CodeTabs&gt;");
});

test("component: standalone Tab → labeled section fallback", () => {
  const out = formatTelegramHtml("<Tab label=\"Only\">\n```ts\nx\n```\n</Tab>");
  expect(out).toBe('— Only —\n<pre><code class="language-ts">x</code></pre>');
});

test("inline Verdict mid-sentence → ✅ label in the sentence flow", () => {
  expect(formatTelegramHtml("Build is <Verdict value=\"yes\">green</Verdict> now")).toBe(
    "Build is ✅ green now",
  );
});

test("inline Pill mid-sentence → [text] in the sentence flow", () => {
  expect(formatTelegramHtml("Rollout <Pill tone=\"rec\">beta</Pill> today")).toBe(
    "Rollout [beta] today",
  );
});

test("inline component injection through inner text cannot emit a live tag", () => {
  const out = formatTelegramHtml("tag <Pill tone=\"rec\"><img src=x onerror=alert(1)></Pill> here");
  expect(out).not.toContain("<img");
  expect(out).toContain("&lt;img");
});

test("Embed fallback line echoes only a gated src", () => {
  expect(formatTelegramHtml('<Embed src="./arch.html" />')).toContain("Embedded page: ./arch.html");
  const bad = formatTelegramHtml('<Embed src="javascript:alert(1)" />');
  expect(bad).toContain("Embedded page: invalid embed");
  expect(bad).not.toContain("javascript:");
});

test("Embed: a bad height is an invalid embed, the src is not blamed", () => {
  const out = formatTelegramHtml('<Embed src="./arch.html" height="640px" />');
  expect(out).toContain("Embedded page: invalid embed");
  expect(out).not.toContain("./arch.html");
});

test("F29: a marker word between a link and a code span forges no placeholder", () => {
  expect(formatTelegramHtml("[l](https://x.com)INLINE0`c`")).toBe('<a href="https://x.com">l</a>INLINE0<code>c</code>');
});

// A weekly X digest (~4.2k chars of link bullets) was refused whole by Telegram
// with 400 "message is too long" (2026-11-24); the watcher runner now sends chunks.
const digestBullet = (i: number) =>
  `- [@author${i}](https://x.com/author${i}/status/${1_000_000_000 + i}) — a sentence about item ${i} long enough to matter.`;
const longDigest = `𝕏 **X Weekly Digest**\n**Themes of the Week**\n${Array.from({ length: 60 }, (_, i) => digestBullet(i)).join("\n")}`;

test("formatTelegramHtmlChunks: a short message is one chunk, same HTML", () => {
  const md = "**Top Picks**\n- [@a](https://x.com/a) — hi";
  expect(formatTelegramHtmlChunks(md)).toEqual([formatTelegramHtml(md)]);
});

test("formatTelegramHtmlChunks: an over-cap digest splits under the cap without cutting a tag", () => {
  expect(formatTelegramHtml(longDigest).length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE);
  const chunks = formatTelegramHtmlChunks(longDigest);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    expect(c.match(/<a /g)?.length ?? 0).toBe(c.match(/<\/a>/g)?.length ?? 0);
  }
  // Every bullet survives, in order, exactly once.
  const joined = chunks.join("\n");
  for (let i = 0; i < 60; i++) expect(joined.split(`>@author${i}</a>`).length).toBe(2);
  expect(joined.indexOf(">@author0<")).toBeLessThan(joined.indexOf(">@author59<"));
});

test("formatTelegramHtmlChunks: HTML that outgrows its markdown part is re-split", () => {
  // Markdown parts fit a 1000 budget, but the rendered href doubles each link.
  const chunks = formatTelegramHtmlChunks(longDigest, 1000);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
});

test("formatTelegramHtmlChunks: a fence cut across parts is closed and reopened, code stays escaped", () => {
  const md = "Intro\n```html\n" + Array.from({ length: 30 }, (_, i) => `<b>bold ${i} <i>open`).join("\n") + "\n```\nOutro";
  const chunks = formatTelegramHtmlChunks(md, 300);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(300);
    expect(c).not.toContain("```");
    expect(c).toContain("<pre>");
    expect(c.match(/<pre>/g)!.length).toBe(c.match(/<\/pre>/g)?.length ?? 0);
    expect(c).not.toMatch(/<b>|<i>/); // the code's tags stay &lt;-escaped
  }
  for (let i = 0; i < 30; i++) expect(chunks.join("\n").split(`bold ${i} `).length).toBe(2);
});

test("formatTelegramHtmlChunks: one over-budget line never cuts a link or bold span", () => {
  const md = Array.from({ length: 40 }, (_, i) => `**bold ${i} words** [link label ${i}](https://x.com/a/${i})`).join(" ");
  const chunks = formatTelegramHtmlChunks(md, 300);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c).not.toMatch(/\]\(|\[link|\*\*/);
    expect(c.match(/<a /g)?.length ?? 0).toBe(c.match(/<\/a>/g)?.length ?? 0);
  }
  for (let i = 0; i < 40; i++) expect(chunks.join(" ")).toContain(`<a href="https://x.com/a/${i}">link label ${i}</a>`);
});
