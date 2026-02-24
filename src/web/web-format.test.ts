import { test, expect, describe } from "bun:test";
import { formatWebHtml } from "./web-format.ts";

describe("formatWebHtml", () => {
  test("converts headings", () => {
    expect(formatWebHtml("# Heading 1")).toBe("<h2>Heading 1</h2>");
    expect(formatWebHtml("## Heading 2")).toBe("<h3>Heading 2</h3>");
    expect(formatWebHtml("### Heading 3")).toBe("<h4>Heading 3</h4>");
  });

  test("converts bold", () => {
    expect(formatWebHtml("**bold text**")).toBe("<strong>bold text</strong>");
  });

  test("converts italic with asterisks", () => {
    expect(formatWebHtml("*italic*")).toBe("<em>italic</em>");
  });

  test("converts italic with underscores", () => {
    expect(formatWebHtml("_italic_")).toBe("<em>italic</em>");
  });

  test("converts strikethrough", () => {
    expect(formatWebHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  test("converts links", () => {
    expect(formatWebHtml("[click here](https://example.com)")).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener">click here</a>',
    );
  });

  test("converts inline code", () => {
    expect(formatWebHtml("use `const x = 1`")).toBe("use <code>const x = 1</code>");
  });

  test("converts code blocks", () => {
    const input = "```ts\nconst x = 1;\n```";
    const result = formatWebHtml(input);
    expect(result).toContain('<pre><code class="language-ts">');
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  test("converts code blocks without language", () => {
    const input = "```\nhello\n```";
    const result = formatWebHtml(input);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("hello");
  });

  test("does not process formatting inside code blocks", () => {
    const input = "```\n**not bold** *not italic*\n```";
    const result = formatWebHtml(input);
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("<em>");
    expect(result).toContain("**not bold** *not italic*");
  });

  test("does not process formatting inside inline code", () => {
    const input = "`**not bold**`";
    const result = formatWebHtml(input);
    expect(result).not.toContain("<strong>");
    expect(result).toContain("**not bold**");
  });

  test("converts blockquotes", () => {
    const input = "> first line\n> second line";
    const result = formatWebHtml(input);
    expect(result).toContain("<blockquote>");
    expect(result).toContain("first line");
    expect(result).toContain("second line");
    expect(result).toContain("</blockquote>");
  });

  test("converts unordered lists with dashes", () => {
    const input = "- item 1\n- item 2\n- item 3";
    const result = formatWebHtml(input);
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item 1</li>");
    expect(result).toContain("<li>item 2</li>");
    expect(result).toContain("<li>item 3</li>");
    expect(result).toContain("</ul>");
  });

  test("converts unordered lists with asterisks", () => {
    const input = "* item A\n* item B";
    const result = formatWebHtml(input);
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item A</li>");
    expect(result).toContain("<li>item B</li>");
    expect(result).toContain("</ul>");
  });

  test("converts ordered lists", () => {
    const input = "1. first\n2. second\n3. third";
    const result = formatWebHtml(input);
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>first</li>");
    expect(result).toContain("<li>second</li>");
    expect(result).toContain("<li>third</li>");
    expect(result).toContain("</ol>");
  });

  test("converts horizontal rules", () => {
    expect(formatWebHtml("---")).toBe("<hr>");
    expect(formatWebHtml("-----")).toBe("<hr>");
  });

  test("converts tables", () => {
    const input = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = formatWebHtml(input);
    expect(result).toContain("<table>");
    expect(result).toContain("<thead>");
    expect(result).toContain("<th>Name</th>");
    expect(result).toContain("<th>Age</th>");
    expect(result).toContain("<tbody>");
    expect(result).toContain("<td>Alice</td>");
    expect(result).toContain("<td>30</td>");
    expect(result).toContain("</table>");
  });

  test("preserves newlines in text (for pre-wrap CSS)", () => {
    const result = formatWebHtml("line one\nline two");
    expect(result).toContain("line one\nline two");
  });

  test("outputs list HTML without internal newlines", () => {
    const input = "- item 1\n- item 2";
    const result = formatWebHtml(input);
    expect(result).toContain("<ul><li>item 1</li><li>item 2</li></ul>");
  });

  test("preserves newlines between inline-formatted lines", () => {
    const input = "**bold line**\n**another line**";
    const result = formatWebHtml(input);
    expect(result).toContain("<strong>bold line</strong>\n<strong>another line</strong>");
  });

  test("escapes HTML in code blocks", () => {
    const input = "```\n<script>alert('xss')</script>\n```";
    const result = formatWebHtml(input);
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  test("escapes HTML tags in regular text", () => {
    const result = formatWebHtml("<script>alert('xss')</script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  test("escapes HTML in headings and list items", () => {
    expect(formatWebHtml("# Use <div>")).toContain("&lt;div&gt;");
    expect(formatWebHtml("- item with <b>tag</b>")).toContain("&lt;b&gt;");
  });

  test("escapes ampersands in regular text", () => {
    const result = formatWebHtml("AT&T is great");
    expect(result).toBe("AT&amp;T is great");
  });

  test("escapes HTML in table cells", () => {
    const input = "| Expr |\n|------|\n| a < b |";
    const result = formatWebHtml(input);
    expect(result).toContain("a &lt; b");
    expect(result).not.toContain("a < b");
  });

  test("mixed content", () => {
    const input = "## Title\n\nHere is **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconsole.log('hello');\n```";
    const result = formatWebHtml(input);
    expect(result).toContain("<h3>Title</h3>");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item 1</li>");
    expect(result).toContain('<code class="language-js">');
  });

  test("handles empty string", () => {
    expect(formatWebHtml("")).toBe("");
  });

  test("handles plain text", () => {
    expect(formatWebHtml("hello world")).toBe("hello world");
  });

  test("escapes HTML in code blocks (div)", () => {
    const input = "```\n<div>test</div>\n```";
    const result = formatWebHtml(input);
    expect(result).toContain("&lt;div&gt;");
  });

  test("handles links with ampersands in URL", () => {
    const input = "[search](https://example.com?a=1&b=2)";
    const result = formatWebHtml(input);
    // & in href becomes &amp; which is valid HTML
    expect(result).toContain('href="https://example.com?a=1&amp;b=2"');
  });

  test("escapes double quotes to prevent attribute injection in links", () => {
    const input = '[click](https://evil.com" onclick="alert(1))';
    const result = formatWebHtml(input);
    // " is escaped to &quot; so it stays inside the href value, not a separate attribute
    expect(result).toContain("&quot;");
    // Verify no unescaped " that could break out of href (the outer quotes are from the template)
    expect(result).not.toContain('onclick="alert');
  });

  test("rejects javascript: protocol in links", () => {
    const input = "[click](javascript:alert(1))";
    const result = formatWebHtml(input);
    // Should not produce an <a> tag for non-http(s) URLs
    expect(result).not.toContain("<a ");
    expect(result).not.toContain("javascript:");
    expect(result).toContain("click");
  });

  test("escapes double quotes in regular text", () => {
    const result = formatWebHtml('He said "hello"');
    expect(result).toBe("He said &quot;hello&quot;");
  });

  test("converts Slack mrkdwn links with label", () => {
    const input = "Ref: <https://confluence.adeo.no/pages/123|Vurdering av bostedsland>";
    const result = formatWebHtml(input);
    expect(result).toContain('<a href="https://confluence.adeo.no/pages/123" target="_blank" rel="noopener">Vurdering av bostedsland</a>');
  });

  test("converts bare Slack mrkdwn links", () => {
    const input = "See <https://example.com/page>";
    const result = formatWebHtml(input);
    expect(result).toContain('<a href="https://example.com/page" target="_blank" rel="noopener">https://example.com/page</a>');
  });

  test("does not convert non-http Slack-style angle brackets", () => {
    const input = "Use <div> for layout";
    const result = formatWebHtml(input);
    expect(result).not.toContain("<a ");
    expect(result).toContain("&lt;div&gt;");
  });
});
