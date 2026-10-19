import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { docPanelScript } from "./doc-panel.ts";
import { sumJobCardScript } from "./sum-job-card.ts";

/**
 * The SHIPPED client `renderMarkdown` copies (doc panel, summaries job card),
 * evaluated against the npm marked the CDN tag pins (doc-panel.test.ts checks
 * the versions match). A link whose href is not http(s), mailto or a local
 * path renders as its text: the body is model output or a fetched page, and
 * the dashboard has no CSP.
 *
 * Both copies install their overrides on ONE global marked under one
 * `__sanitized` flag, so the cases run per copy and in both install orders.
 */

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Render = (text: string) => string;

function docPanelRender(marked: unknown): Render {
  const document = { getElementById: () => null, addEventListener: () => {} };
  return new Function("document", "esc", "marked", `${docPanelScript()}; return renderMarkdown;`)(
    document,
    esc,
    marked,
  ) as Render;
}

function jobCardRender(marked: unknown): Render {
  const document = { getElementById: () => null, addEventListener: () => {} };
  return new Function(
    "document",
    "esc",
    "marked",
    "SOURCES",
    "VIMEO_MAX_DURATION_SEC",
    `${sumJobCardScript()}; return renderMarkdown;`,
  )(document, esc, marked, {}, 10800) as Render;
}

const UNSAFE: [string, string][] = [
  ["inline javascript:", "[x](javascript:alert(1))"],
  ["mixed-case scheme", "[x](JaVaScRiPt:alert(1))"],
  ["autolink", "<javascript:alert(1)>"],
  ["reference-style", "[x][r]\n\n[r]: javascript:alert(1)"],
  ["data: URL", "[x](data:text/html,<script>alert(1)</script>)"],
];

const SAFE: [string, string, string][] = [
  ["https", "[a](https://example.com)", "https://example.com"],
  ["mailto", "[m](mailto:a@b.c)", "mailto:a@b.c"],
  ["vimeo timestamp", "[t](https://vimeo.com/123#t=45)", "https://vimeo.com/123#t=45"],
  ["youtube timestamp", "[y](https://www.youtube.com/watch?v=abc&t=45s)", "https://www.youtube.com/watch?v=abc&t=45s"],
  ["relative path", "[r](/summaries/x)", "/summaries/x"],
  ["fragment", "[f](#sec)", "#sec"],
];

function assertCases(render: Render) {
  for (const [, md] of UNSAFE) {
    const html = render(md);
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/href=/i);
  }
  for (const [, md, href] of SAFE) {
    expect(render(md)).toContain(`<a href="${href}"`);
  }
}

describe("client renderMarkdown: unsafe link schemes render as text", () => {
  test("doc panel copy", () => {
    assertCases(docPanelRender(new Marked()));
  });

  test("summaries job card copy", () => {
    assertCases(jobCardRender(new Marked()));
  });

  test("doc panel installs first, job card renders on the same marked", () => {
    const marked = new Marked();
    const dp = docPanelRender(marked);
    dp("warm");
    assertCases(jobCardRender(marked));
    assertCases(dp);
  });

  test("job card installs first, doc panel renders on the same marked", () => {
    const marked = new Marked();
    const jc = jobCardRender(marked);
    jc("warm");
    assertCases(docPanelRender(marked));
    assertCases(jc);
  });

  test("the link text survives, and raw HTML stays escaped", () => {
    const render = docPanelRender(new Marked());
    expect(render("[les mer](javascript:fetch('/api/x'))")).toContain("les mer");
    expect(render("<b>x</b>")).toContain("&lt;b&gt;");
  });
});
