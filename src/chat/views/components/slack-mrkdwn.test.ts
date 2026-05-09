import { test, expect, describe } from "bun:test";
import { renderSlackMrkdwn } from "./slack-mrkdwn.ts";

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
