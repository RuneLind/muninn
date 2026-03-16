import { test, expect, describe } from "bun:test";
import { formatWebHtml, renderSlackMrkdwn } from "./web-format-client.ts";
import { formatWebHtml as serverFormatWebHtml } from "../../../web/web-format.ts";

// ── formatWebHtml ─────────────────────────────────────────────────────

describe("formatWebHtml", () => {
  // ── Inline formatting ───────────────────────────────────────────────

  test("bold: **text** → <strong>", () => {
    expect(formatWebHtml("**hello**")).toBe("<strong>hello</strong>");
  });

  test("italic: *text* → <em>", () => {
    expect(formatWebHtml("*hello*")).toBe("<em>hello</em>");
  });

  test("italic: _text_ → <em>", () => {
    expect(formatWebHtml("_hello_")).toBe("<em>hello</em>");
  });

  test("strikethrough: ~~text~~ → <s>", () => {
    expect(formatWebHtml("~~removed~~")).toBe("<s>removed</s>");
  });

  test("bold + italic combined", () => {
    expect(formatWebHtml("**bold** and *italic*")).toBe(
      "<strong>bold</strong> and <em>italic</em>",
    );
  });

  // ── Code ────────────────────────────────────────────────────────────

  test("code blocks with language class", () => {
    const input = "```ts\nconst x = 1;\n```";
    expect(formatWebHtml(input)).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  test("code blocks without language", () => {
    const input = "```\nhello\n```";
    expect(formatWebHtml(input)).toBe("<pre><code>hello</code></pre>");
  });

  test("inline code", () => {
    expect(formatWebHtml("use `foo()` here")).toBe(
      "use <code>foo()</code> here",
    );
  });

  test("code blocks preserve content from further formatting", () => {
    const input = "```\n**not bold** <div>raw</div>\n```";
    const result = formatWebHtml(input);
    expect(result).toContain("&lt;div&gt;raw&lt;/div&gt;");
    expect(result).toContain("**not bold**");
    expect(result).not.toContain("<strong>");
  });

  // ── Headings ────────────────────────────────────────────────────────

  test("# heading → h2", () => {
    expect(formatWebHtml("# Title")).toBe("<h2>Title</h2>");
  });

  test("## heading → h3", () => {
    expect(formatWebHtml("## Section")).toBe("<h3>Section</h3>");
  });

  test("### heading → h4", () => {
    expect(formatWebHtml("### Sub")).toBe("<h4>Sub</h4>");
  });

  test("#### heading → h5", () => {
    expect(formatWebHtml("#### Deep")).toBe("<h5>Deep</h5>");
  });

  test("##### heading → h6 (capped)", () => {
    expect(formatWebHtml("##### Deeper")).toBe("<h6>Deeper</h6>");
  });

  test("###### heading → h6 (capped at 6)", () => {
    // 6 hashes → level = min(6+1,6) = 6
    expect(formatWebHtml("###### Max")).toBe("<h6>Max</h6>");
  });

  // ── Links ───────────────────────────────────────────────────────────

  test("markdown links with http", () => {
    expect(formatWebHtml("[Google](https://google.com)")).toBe(
      '<a href="https://google.com" target="_blank" rel="noopener">Google</a>',
    );
  });

  test("markdown links with https", () => {
    expect(formatWebHtml("[Docs](https://docs.example.com)")).toBe(
      '<a href="https://docs.example.com" target="_blank" rel="noopener">Docs</a>',
    );
  });

  test("non-http links are stripped (prevents javascript: XSS)", () => {
    // The closing ) in alert(1) terminates the markdown link regex early,
    // so the result includes the trailing ) — but the link is NOT created.
    const result = formatWebHtml("[click](javascript:alert(1))");
    expect(result).not.toContain("<a ");
    expect(result).toContain("click");
  });

  test("non-http links: file protocol stripped", () => {
    expect(formatWebHtml("[f](file:///etc/passwd)")).toBe("f");
  });

  // ── Lists ───────────────────────────────────────────────────────────

  test("unordered list with -", () => {
    const input = "- one\n- two\n- three";
    expect(formatWebHtml(input)).toBe(
      "<ul><li>one</li><li>two</li><li>three</li></ul>",
    );
  });

  test("unordered list with *", () => {
    const input = "* apple\n* banana";
    expect(formatWebHtml(input)).toBe(
      "<ul><li>apple</li><li>banana</li></ul>",
    );
  });

  test("ordered list", () => {
    const input = "1. first\n2. second\n3. third";
    expect(formatWebHtml(input)).toBe(
      "<ol><li>first</li><li>second</li><li>third</li></ol>",
    );
  });

  // ── Tables ──────────────────────────────────────────────────────────

  test("markdown table → HTML table", () => {
    const input = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    const result = formatWebHtml(input);
    expect(result).toContain("<table>");
    expect(result).toContain("<thead><tr><th>Name</th><th>Age</th></tr></thead>");
    expect(result).toContain("<td>Alice</td>");
    expect(result).toContain("<td>Bob</td>");
    expect(result).toContain("</table>");
  });

  // ── Blockquotes ─────────────────────────────────────────────────────

  test("blockquotes: > lines → <blockquote>", () => {
    const input = "> quote line 1\n> quote line 2";
    const result = formatWebHtml(input);
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quote line 1<br>quote line 2");
    expect(result).toContain("</blockquote>");
  });

  // ── Horizontal rules ───────────────────────────────────────────────

  test("horizontal rule: --- → <hr>", () => {
    expect(formatWebHtml("---")).toBe("<hr>");
  });

  test("horizontal rule: ----- → <hr>", () => {
    expect(formatWebHtml("-----")).toBe("<hr>");
  });

  // ── HTML entity escaping (XSS prevention) ──────────────────────────

  test("escapes < > & \" in regular text", () => {
    const result = formatWebHtml('<script>alert("xss")</script>');
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&quot;xss&quot;");
  });

  test("escapes ampersands", () => {
    expect(formatWebHtml("foo & bar")).toBe("foo &amp; bar");
  });

  // ── Slack-style link normalization ─────────────────────────────────

  test("Slack-style <url|text> → markdown link → HTML link", () => {
    const input = "<https://example.com|Example Site>";
    const result = formatWebHtml(input);
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain("Example Site</a>");
  });

  test("Slack-style <url> (no label) → self-labeled link", () => {
    const input = "<https://example.com>";
    const result = formatWebHtml(input);
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain("https://example.com</a>");
  });

  // ── Excessive blank line cleanup ───────────────────────────────────

  test("collapses 3+ blank lines to 2", () => {
    const input = "line1\n\n\n\nline2";
    const result = formatWebHtml(input);
    expect(result).toBe("line1\n\nline2");
  });

  test("collapses blank lines around block elements", () => {
    const input = "text\n\n\n## Heading\n\n\nmore";
    const result = formatWebHtml(input);
    // Should not have multiple newlines before/after the heading
    expect(result).not.toMatch(/\n\n<h3>/);
    expect(result).not.toMatch(/<\/h3>\n\n/);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  test("empty string", () => {
    expect(formatWebHtml("")).toBe("");
  });

  test("plain text passthrough", () => {
    expect(formatWebHtml("just text")).toBe("just text");
  });

  test("\\r\\n normalized to \\n", () => {
    const result = formatWebHtml("line1\r\nline2");
    expect(result).not.toContain("\r");
    expect(result).toContain("line1\nline2");
  });
});

// ── Parity: client vs server formatWebHtml ────────────────────────────

describe("formatWebHtml parity with server-side web-format.ts", () => {
  const inputs = [
    "**bold** and *italic*",
    "~~struck~~",
    "`inline code`",
    "```ts\nconst x = 1;\n```",
    "# Heading One\n## Heading Two",
    "[Link](https://example.com)",
    "- item1\n- item2\n- item3",
    "1. first\n2. second",
    "> blockquote line",
    "---",
    "plain text with <html> & \"quotes\"",
    "<https://example.com|Click Here>",
    "line1\n\n\n\nline2",
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    "",
    "no formatting at all",
  ];

  for (const input of inputs) {
    test(`parity: ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(formatWebHtml(input)).toBe(serverFormatWebHtml(input));
    });
  }
});

// ── renderSlackMrkdwn ─────────────────────────────────────────────────

describe("renderSlackMrkdwn", () => {
  test("bold: *text* → <strong>", () => {
    expect(renderSlackMrkdwn("*hello*")).toBe("<strong>hello</strong>");
  });

  test("italic: _text_ → <em>", () => {
    expect(renderSlackMrkdwn("_world_")).toBe("<em>world</em>");
  });

  test("strikethrough: ~text~ → <del>", () => {
    expect(renderSlackMrkdwn("~removed~")).toBe("<del>removed</del>");
  });

  test("inline code", () => {
    expect(renderSlackMrkdwn("`code`")).toBe("<code>code</code>");
  });

  test("code block", () => {
    expect(renderSlackMrkdwn("```block```")).toBe(
      "<pre><code>block</code></pre>",
    );
  });

  test("Slack links: <url|label> → <a>", () => {
    const result = renderSlackMrkdwn("<https://example.com|Example>");
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain("Example</a>");
  });

  test("newlines → <br>", () => {
    expect(renderSlackMrkdwn("line1\nline2")).toBe("line1<br>line2");
  });

  test("escapes HTML in text", () => {
    const result = renderSlackMrkdwn("<script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  test("escapes HTML in link URLs and labels", () => {
    const result = renderSlackMrkdwn('<https://example.com/a&b|A & "B">');
    expect(result).toContain("A &amp; &quot;B&quot;");
  });

  test("multiple links in same text", () => {
    const result = renderSlackMrkdwn(
      "See <https://a.com|A> and <https://b.com|B>",
    );
    expect(result).toContain('href="https://a.com"');
    expect(result).toContain('href="https://b.com"');
    expect(result).toContain("A</a>");
    expect(result).toContain("B</a>");
  });

  test("combined formatting", () => {
    const result = renderSlackMrkdwn("*bold* and _italic_ with `code`");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain("<code>code</code>");
  });
});
