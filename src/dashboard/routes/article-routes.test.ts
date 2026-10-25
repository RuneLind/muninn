import { describe, expect, test } from "bun:test";
import { deriveTitle } from "./article-routes.ts";
import { htmlToMarkdown } from "../../summaries/html-to-markdown.ts";
import { parseHtml } from "../../test/mini-dom.ts";

// The pasted text is the walk's markdown (`html-to-markdown.ts`), so its first
// line can carry link, emphasis and code syntax that must not reach the title.
describe("deriveTitle", () => {
  test("a linked heading gives the link's text", () => {
    expect(deriveTitle("# [Real title of the post](https://blog.example/p/real)\n\nBody.")).toBe(
      "Real title of the post",
    );
  });

  test("emphasis, code and escapes are removed", () => {
    expect(deriveTitle("**Bold lede**\n\nBody.")).toBe("Bold lede");
    expect(deriveTitle("*Why* `bun test` and __this__ [path C:\\\\dir\\\\](https://ex.com/p)")).toBe(
      "Why bun test and this path C:\\dir\\",
    );
  });

  test("a bare first line is unchanged, and the cap holds", () => {
    expect(deriveTitle("\n  Plain first line  \nsecond")).toBe("Plain first line");
    expect(deriveTitle(`[${"a".repeat(100)}](https://ex.com/p)`)).toBe(`${"a".repeat(77)}…`);
    expect(deriveTitle("**\n\n")).toBe("Untitled article");
  });

  test("a leading code fence is skipped to the first prose line", () => {
    expect(deriveTitle("```\nconst x = 1;\n```\nBody")).toBe("Body");
    expect(deriveTitle("```js\nconst x = 1;\n```\n\nBody line")).toBe("Body line");
    expect(deriveTitle("~~~\ncode\n~~~\nAfter tilde")).toBe("After tilde");
    expect(deriveTitle("````\n```\n````\nAfter long fence")).toBe("After long fence");
    expect(deriveTitle("```\nnever closed\n")).toBe("Untitled article");
    expect(deriveTitle("```\n~~~\n```\nAfter mixed")).toBe("After mixed");
    expect(deriveTitle("```\n```js\n```\nAfter info")).toBe("After info");
  });

  test("inline syntax is stripped only where it is paired", () => {
    expect(deriveTitle("`` a`b ``")).toBe("a`b");
    expect(deriveTitle("2**10 is big")).toBe("2**10 is big");
    expect(deriveTitle("a ` lone tick")).toBe("a ` lone tick");
    expect(deriveTitle("`[not](a link)` here")).toBe("[not](a link) here");
  });

  test("a leading quote, bullet or number marker is stripped", () => {
    expect(deriveTitle("> Quoted lede")).toBe("Quoted lede");
    expect(deriveTitle("- item one")).toBe("item one");
    expect(deriveTitle("1. first step")).toBe("first step");
  });

  test("runs of whitespace collapse to one space", () => {
    expect(deriveTitle("a  b\t c")).toBe("a b c");
  });

  test("a heading's content is never read as a list marker", () => {
    expect(deriveTitle("# 2024. The year agents shipped\n\nBody")).toBe("2024. The year agents shipped");
  });

  test("an inline code span or an indented block is not a fence", () => {
    expect(deriveTitle("```js const x``` is how you start\nBody")).toBe("js const x is how you start");
    expect(deriveTitle("    ```\n\nReal title")).toBe("Real title");
  });

  test("a fence inside a quote or a list item is skipped", () => {
    expect(deriveTitle("> ```\n> $ invented --help\n> ```\n\nInvented tool")).toBe("Invented tool");
    expect(deriveTitle("1. ```\n   step one code\n   ```")).toBe("Untitled article");
    expect(deriveTitle("1. ```\n   step one code\n   ```\n\nAfter the list")).toBe("After the list");
  });

  test("a table or an HTML block first is skipped", () => {
    expect(deriveTitle("| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table")).toBe("After the table");
    expect(deriveTitle("<div>\n<p>raw</p>\n</div>\n\nAfter the HTML")).toBe("After the HTML");
  });

  test("a setext heading gives its text", () => {
    expect(deriveTitle("Setext title\n============\n\nBody")).toBe("Setext title");
  });

  test("a heading with a link, emphasis and code gives its plain text", () => {
    expect(deriveTitle("## [The *real* `bun` story](https://ex.com/p)\n\nBody")).toBe("The real bun story");
  });

  // CommonMark reads `2024. A year` as an ordered list starting at 2024, and
  // marked does too, so the title is the item's text.
  test("a number-dot line is an ordered list", () => {
    expect(deriveTitle("2024. A year")).toBe("A year");
  });

  test("a Google Docs paste with a header table gives the heading after it", () => {
    const html =
      `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c">` +
      `<div><table><tbody><tr><td><p><span>Owner</span></p></td><td><p><span>Invented Team</span></p></td></tr></tbody></table></div>` +
      `<h1 dir="ltr"><span style="font-size:20pt;">An invented design note</span></h1>` +
      `<p dir="ltr"><span style="font-weight:700;">Status:</span><span> draft, see </span>` +
      `<a href="https://example.com/notes"><span>the notes</span></a><span>.</span></p></b>`;
    expect(deriveTitle(htmlToMarkdown(parseHtml(html)))).toBe("An invented design note");
  });

  test("a Substack paste gives the post title", () => {
    const html =
      `<div class="post"><div class="post-header"><h1 class="post-title">Why the <em>invented</em> harness won</h1>` +
      `<h3 class="subtitle">A subtitle</h3></div><div class="available-content">` +
      `<p>Body with <a href="https://invented.substack.com/p/x">a link</a>.</p></div></div>`;
    expect(deriveTitle(htmlToMarkdown(parseHtml(html)))).toBe("Why the invented harness won");
  });
});
