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

/** Character references marked leaves undecoded in `token.href`: the browser
 *  decodes them in the attribute, so each is a live `javascript:` link unless
 *  the override decodes before the check or escapes on output. */
const ENTITY_UNSAFE: [string, string][] = [
  ["decimal reference", "[x](&#106;avascript:alert(1))"],
  ["hex references", "[x](&#x6A;avascript&#x3A;alert(1))"],
  ["named colon", "[x](javascript&colon;alert(1))"],
  ["named tab", "[x](java&Tab;script:alert(1))"],
  ["hex tab", "[x](java&#x09;script:x)"],
  ["leading space reference", "[x](&#32;javascript:alert(1))"],
  ["reference definition", "[x][r]\n\n[r]: &#106;avascript:alert(1)"],
];

/** No semicolon, so CommonMark keeps it literal, but a browser decodes it in an
 *  attribute: only the output escaping keeps this link inert. */
const SEMICOLONLESS = "[x](&#106avascript:alert(1))";

/**
 * The browser-decoded value of every `<a href="…">`. The decode is exact only
 * for the form the override writes, so it first asserts the raw value holds no
 * character reference beyond the five escapes (a numeric or `name;` reference
 * is what can spell a scheme; a bare `&b=` stays literal in a browser too).
 */
function decodedHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)].map(([, raw]) => {
    expect(raw).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)(#|[a-z][a-z0-9]*;)/i);
    return raw!
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  });
}

/** What the WHATWG URL parser strips before it reads the scheme. */
const urlParserView = (href: string) => href.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");

const SAFE: [string, string, string][] = [
  ["https", "[a](https://example.com)", "https://example.com"],
  ["mailto", "[m](mailto:a@b.c)", "mailto:a@b.c"],
  ["vimeo timestamp", "[t](https://vimeo.com/123#t=45)", "https://vimeo.com/123#t=45"],
  ["youtube timestamp", "[y](https://www.youtube.com/watch?v=abc&t=45s)", "https://www.youtube.com/watch?v=abc&t=45s"],
  ["relative path", "[r](/summaries/x)", "/summaries/x"],
  ["fragment", "[f](#sec)", "#sec"],
  ["https query with &", "[q](https://example.com/s?a=1&b=2)", "https://example.com/s?a=1&b=2"],
  ["&amp; reference in the destination", "[q](https://example.com/s?a=1&amp;b=2)", "https://example.com/s?a=1&b=2"],
  ["bare URL", "see https://example.com/p?x=1&y=2 now", "https://example.com/p?x=1&y=2"],
  ["angle autolink", "<https://example.com/a>", "https://example.com/a"],
  ["email autolink", "<a@b.c>", "mailto:a@b.c"],
  ["space in destination", "[s](</a b>)", "/a%20b"],
];

function assertCases(render: Render) {
  for (const [, md] of UNSAFE) {
    const html = render(md);
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/href=/i);
  }
  for (const [, md] of ENTITY_UNSAFE) {
    const html = render(md);
    for (const href of decodedHrefs(html)) expect(urlParserView(href)).not.toMatch(/^(javascript|data|vbscript):/i);
    expect(html).not.toContain("<a");
  }
  expect(decodedHrefs(render(SEMICOLONLESS))).toEqual(["&#106avascript:alert(1)"]);
  for (const [, md, href] of SAFE) {
    expect(decodedHrefs(render(md))).toEqual([href]);
  }
  const titled = render('[t](https://example.com/x "Say &quot;hi&quot; & go")');
  expect(decodedHrefs(titled)).toEqual(["https://example.com/x"]);
  expect(titled).toContain('title="Say &quot;hi&quot; &amp; go"');
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

describe("client renderMarkdown: a character-reference scheme never reaches the browser live", () => {
  const copies = [["doc panel", docPanelRender], ["job card", jobCardRender]] as const;
  const cases: [string, string][] = [...ENTITY_UNSAFE, ["semicolon-less reference", SEMICOLONLESS]];
  for (const [copy, makeRender] of copies) {
    for (const [label, md] of cases) {
      test(`${copy}: ${label}`, () => {
        for (const href of decodedHrefs(makeRender(new Marked())(md))) {
          expect(urlParserView(href)).not.toMatch(/^(javascript|data|vbscript):/i);
        }
      });
    }
  }
});
