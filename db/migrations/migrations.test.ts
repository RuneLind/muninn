import { test, expect, describe } from "bun:test";
import { convertTelegramHtmlToMarkdown } from "./017-convert-html-to-markdown.ts";
import { convertSlackMrkdwnToMarkdown } from "./018-convert-slack-mrkdwn-to-markdown.ts";

describe("convertTelegramHtmlToMarkdown", () => {
  test("converts bold tags", () => {
    expect(convertTelegramHtmlToMarkdown("<b>hello</b>")).toBe("**hello**");
    expect(convertTelegramHtmlToMarkdown("<strong>hello</strong>")).toBe("**hello**");
  });

  test("converts italic tags", () => {
    expect(convertTelegramHtmlToMarkdown("<i>hello</i>")).toBe("*hello*");
    expect(convertTelegramHtmlToMarkdown("<em>hello</em>")).toBe("*hello*");
  });

  test("converts inline code", () => {
    expect(convertTelegramHtmlToMarkdown("<code>foo()</code>")).toBe("`foo()`");
  });

  test("converts code blocks with language", () => {
    expect(convertTelegramHtmlToMarkdown('<pre><code class="language-ts">const x = 1;</code></pre>')).toBe(
      "```ts\nconst x = 1;\n```",
    );
  });

  test("converts plain pre blocks", () => {
    expect(convertTelegramHtmlToMarkdown("<pre>some code</pre>")).toBe("```\nsome code\n```");
  });

  test("converts links", () => {
    expect(convertTelegramHtmlToMarkdown('<a href="https://example.com">click</a>')).toBe(
      "[click](https://example.com)",
    );
  });

  test("converts strikethrough", () => {
    expect(convertTelegramHtmlToMarkdown("<s>deleted</s>")).toBe("~~deleted~~");
    expect(convertTelegramHtmlToMarkdown("<del>deleted</del>")).toBe("~~deleted~~");
  });

  test("strips underline tags (no markdown equivalent)", () => {
    expect(convertTelegramHtmlToMarkdown("<u>underlined</u>")).toBe("underlined");
  });

  test("decodes HTML entities", () => {
    expect(convertTelegramHtmlToMarkdown("a &amp; b")).toBe("a & b");
    expect(convertTelegramHtmlToMarkdown("&lt;div&gt;")).toBe("<div>");
    expect(convertTelegramHtmlToMarkdown("&quot;quoted&quot;")).toBe('"quoted"');
  });

  test("decodes entities inside code blocks", () => {
    expect(convertTelegramHtmlToMarkdown("<code>a &amp;&amp; b</code>")).toBe("`a && b`");
  });

  test("handles mixed formatting", () => {
    const input = "Here is <b>bold</b> and <i>italic</i> and <code>code</code>.";
    expect(convertTelegramHtmlToMarkdown(input)).toBe("Here is **bold** and *italic* and `code`.");
  });

  test("handles nested bold+italic", () => {
    expect(convertTelegramHtmlToMarkdown("<b><i>both</i></b>")).toBe("***both***");
  });

  test("passes through plain text unchanged", () => {
    expect(convertTelegramHtmlToMarkdown("no html here")).toBe("no html here");
  });
});

describe("convertSlackMrkdwnToMarkdown", () => {
  test("converts Slack bold to markdown bold", () => {
    expect(convertSlackMrkdwnToMarkdown("*hello*")).toBe("**hello**");
  });

  test("converts Slack links with text", () => {
    expect(convertSlackMrkdwnToMarkdown("<https://example.com|Click here>")).toBe(
      "[Click here](https://example.com)",
    );
  });

  test("converts bare Slack links", () => {
    expect(convertSlackMrkdwnToMarkdown("<https://example.com>")).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  test("converts Slack strikethrough", () => {
    expect(convertSlackMrkdwnToMarkdown("~deleted~")).toBe("~~deleted~~");
  });

  test("does not convert already-double bold", () => {
    expect(convertSlackMrkdwnToMarkdown("**already bold**")).toBe("**already bold**");
  });

  test("does not convert already-double strikethrough", () => {
    expect(convertSlackMrkdwnToMarkdown("~~already struck~~")).toBe("~~already struck~~");
  });

  test("preserves code blocks from conversion", () => {
    expect(convertSlackMrkdwnToMarkdown("```*not bold*```")).toBe("```*not bold*```");
  });

  test("preserves inline code from conversion", () => {
    expect(convertSlackMrkdwnToMarkdown("`some code`")).toBe("`some code`");
  });

  test("unwraps backtick-wrapped Slack bold", () => {
    expect(convertSlackMrkdwnToMarkdown("`*Title*`")).toBe("**Title**");
  });

  test("unwraps backtick-wrapped bullet chars", () => {
    expect(convertSlackMrkdwnToMarkdown("`•` Item")).toBe("• Item");
  });

  test("deduplicates double bullets", () => {
    expect(convertSlackMrkdwnToMarkdown("• • text")).toBe("• text");
  });

  test("handles multiple bold phrases in one line", () => {
    expect(convertSlackMrkdwnToMarkdown("*first* and *second*")).toBe("**first** and **second**");
  });

  test("passes through plain text unchanged", () => {
    expect(convertSlackMrkdwnToMarkdown("no formatting here")).toBe("no formatting here");
  });
});
