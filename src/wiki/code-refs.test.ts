import { test, expect, describe } from "bun:test";
import { chipLineRefs, codeAtFromPage, isLineRef, lineRefUrl, parseCodeAt } from "./code-refs.ts";
import { renderWikiHtml } from "./render.ts";
import { formatWebHtml } from "../web/web-format.ts";

const AT = { owner: "navikt", repo: "melosys-console", sha: "9c09999" };

describe("isLineRef", () => {
  for (const ok of [":1234", ":12-40", ":12, :34", ":12,:34-36, :99", "src/a/B.kt:12", "B.kt:3-9", "./x/y.test.ts:1"]) {
    test(`${ok} is a line ref`, () => expect(isLineRef(ok)).toBe(true));
  }
  for (const no of [":", "12", ":abc", "foo:12", "127.0.0.1:80", "src/a/B.kt", "B.kt:", ":12 :34", "a b.kt:1", "x.kt:12:3"]) {
    test(`${no} is not`, () => expect(isLineRef(no)).toBe(false));
  }
});

describe("parseCodeAt", () => {
  test("owner/repo@sha", () => expect(parseCodeAt("navikt/melosys-console@9c09999")).toEqual(AT));
  test("quoted", () => expect(parseCodeAt('"navikt/melosys-console@9c09999"')).toEqual(AT));
  for (const bad of [
    "navikt/melosys-console",
    "navikt/melosys-console@9c0999", // 6 hex
    "navikt/melosys-console@9C09999", // upper
    "navikt/melosys-console@" + "a".repeat(41),
    "navikt@9c09999",
    "-navikt/r@9c09999",
    "navikt/../x@9c09999",
    "navikt/..@9c09999",
    "nav ikt/r@9c09999",
    "navikt/r@9c09999 extra",
    "",
  ]) {
    test(`refuses ${JSON.stringify(bad)}`, () => expect(parseCodeAt(bad)).toBeNull());
  }
});

describe("codeAtFromPage", () => {
  test("reads the frontmatter line", () =>
    expect(codeAtFromPage("---\ntitle: x\ncode_at: navikt/melosys-console@9c09999\n---\nbody")).toEqual(AT));
  test("a body line is not frontmatter", () =>
    expect(codeAtFromPage("# x\n\ncode_at: navikt/melosys-console@9c09999\n")).toBeNull());
});

describe("lineRefUrl", () => {
  test("path ref with a range", () =>
    expect(lineRefUrl("src/a/B.kt:12-14", AT)).toBe(
      "https://github.com/navikt/melosys-console/blob/9c09999/src/a/B.kt#L12-L14",
    ));
  test("single line", () => expect(lineRefUrl("src/a/B.kt:12", AT)).toMatch(/#L12$/));
  test("leading ./ is dropped", () => expect(lineRefUrl("./src/B.kt:1", AT)).toMatch(/blob\/9c09999\/src\/B\.kt#L1$/));
  test("no / in the path → no link", () => expect(lineRefUrl("B.kt:12", AT)).toBeNull());
  test("bare :NNN → no link", () => expect(lineRefUrl(":12", AT)).toBeNull());
  test("no code_at → no link", () => expect(lineRefUrl("src/a/B.kt:12", null)).toBeNull());
  test("a .. segment → no link", () => expect(lineRefUrl("src/../B.kt:12", AT)).toBeNull());
});

describe("chipLineRefs", () => {
  test("inline code only — a fence holding the same text stays code", () => {
    const html = formatWebHtml("See `:12` here.\n\n```\n:12\n```");
    const out = chipLineRefs(html, null);
    expect(out).toContain('<code class="code-ref">:12</code>');
    expect(out).toContain("<pre><code>:12</code></pre>");
  });
  test("a non-ref span is untouched", () =>
    expect(chipLineRefs("<code>foo()</code>", AT)).toBe("<code>foo()</code>"));
  test("a linkable ref is wrapped in a new-tab link", () =>
    expect(chipLineRefs("<code>src/B.kt:3</code>", AT)).toBe(
      '<a class="code-ref-link" href="https://github.com/navikt/melosys-console/blob/9c09999/src/B.kt#L3" ' +
        'target="_blank" rel="noopener noreferrer"><code class="code-ref">src/B.kt:3</code></a>',
    ));
});

describe("renderWikiHtml wires the chips", () => {
  const page = (fm: string) => `---\ntitle: P\n${fm}---\n\nSe \`src/a/B.kt:12\` og \`:5\`.\n`;
  test("with a valid code_at the path ref links", () => {
    const out = renderWikiHtml(page("code_at: navikt/melosys-console@9c09999\n"), () => undefined);
    expect(out).toContain('href="https://github.com/navikt/melosys-console/blob/9c09999/src/a/B.kt#L12"');
    expect(out).toContain('<code class="code-ref">:5</code>');
  });
  test("an invalid code_at renders chips without links", () => {
    const out = renderWikiHtml(page("code_at: navikt/melosys-console@main\n"), () => undefined);
    expect(out).not.toContain("code-ref-link");
    expect(out.match(/class="code-ref"/g)?.length).toBe(2);
  });
  test("the chat formatter never chips", () =>
    expect(formatWebHtml("Se `:5`.")).not.toContain("code-ref"));
});
