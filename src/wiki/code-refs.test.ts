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
  // The fence holds a PATH ref, which chips anywhere in prose: a bare `:12` never
  // chips outside a group, so it could not see the `<pre>` guard.
  test("inline code only — a language-less fence holding a path ref stays code", () => {
    const html = formatWebHtml("See `src/B.kt:12` and (`src/B.kt:12`, `:14`) here.\n\n```\nsrc/B.kt:12\n```");
    expect(html).toContain("<pre><code>src/B.kt:12</code></pre>");
    const out = chipLineRefs(html, AT);
    expect(out).toContain("<pre><code>src/B.kt:12</code></pre>");
    const pre = out.slice(out.indexOf("<pre>"));
    expect(pre).not.toContain("code-ref");
    expect(pre).not.toContain("<a ");
    const prose = out.slice(0, out.indexOf("<pre>"));
    expect(prose.match(/class="code-ref-link"/g)?.length).toBe(2);
    expect(prose).toContain('<span class="code-ref-group">');
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
    expect(out).toContain("<code>:5</code>");
  });
  test("an invalid code_at renders chips without links", () => {
    const out = renderWikiHtml(page("code_at: navikt/melosys-console@main\n"), () => undefined);
    expect(out).not.toContain("code-ref-link");
    expect(out.match(/class="code-ref"/g)?.length).toBe(1);
  });
  test("the chat formatter never chips", () =>
    expect(formatWebHtml("Se `:5`.")).not.toContain("code-ref"));
});

// ── Fix round 1 ────────────────────────────────────────────────────────────

const wiki = (body: string, fm = "code_at: navikt/melosys-console@9c09999\n") =>
  renderWikiHtml(`---\ntitle: P\n${fm}---\n\n${body}\n`, () => undefined);
const chips = (html: string) => [...html.matchAll(/<code class="code-ref">([^<]*)<\/code>/g)].map((m) => m[1]);
const groups = (html: string) =>
  [...html.matchAll(/<span class="code-ref-group">(.*?)<\/span>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("pure ref groups", () => {
  test("a parenthesised run of refs is one group, the leading space and the parens inside it", () => {
    const out = wiki("tellerSomSignal (`:1732-1735`) og (`:2012`, `:2050`) og (`e2e.routes.ts:61`, `:1886-1892`).");
    expect(groups(out)).toEqual([" (:1732-1735)", " (:2012, :2050)", " (e2e.routes.ts:61, :1886-1892)"]);
    expect(chips(out)).toEqual([":1732-1735", ":2012", ":2050", "e2e.routes.ts:61", ":1886-1892"]);
  });
  test("og / and / ; separate refs in a group", () => {
    expect(groups(wiki("x (`:1`, `:2` og `:3`)"))).toEqual([" (:1, :2 og :3)"]);
    expect(groups(wiki("x (`a/B.kt:1`, `:2`; `c/D.kt:3` and `:4`)"))).toEqual([" (a/B.kt:1, :2; c/D.kt:3 and :4)"]);
  });
  test("a group at the start of a line has no space to take", () =>
    expect(groups(wiki("(`:608-618`)"))).toEqual(["(:608-618)"]));
  test("a group holding a non-ref span or prose is not a group, and its bare ref stays code", () => {
    const out = wiki("x (`fetchRunSummary`, `:620-694`) y (bare de kan berikes, `:551-553`)");
    expect(groups(out)).toEqual([]);
    expect(chips(out)).toEqual([]);
    expect(out).toContain("<code>:620-694</code>");
  });
  test("a path ref chips inside a non-pure group too, and is never hidden", () => {
    const out = wiki("x (`e2e-gate.yml:179-182`, `--ref main`)");
    expect(groups(out)).toEqual([]);
    expect(chips(out)).toEqual(["e2e-gate.yml:179-182"]);
  });
  test("a bare :N outside a group stays plain code (ports in prose)", () => {
    const out = wiki("API `:8080`, dashboard `:3000`, se `:12, :34` og `src/a/B.kt:3`.");
    expect(chips(out)).toEqual(["src/a/B.kt:3"]);
    for (const port of [":8080", ":3000", ":12, :34"]) expect(out).toContain(`<code>${port}</code>`);
  });
  test("groups in headings and table cells", () => {
    const out = wiki("## Tellere (`:5`)\n\n| a |\n|---|\n| x (`y.kt:2`) |");
    expect(groups(out)).toEqual([" (:5)", " (y.kt:2)"]);
  });
  test("a bare `:N, M` list is one ref inside a group", () =>
    expect(groups(wiki("x (`:227, 254`) og (`:50-55, 64-76`)"))).toEqual([" (:227, 254)", " (:50-55, 64-76)"]));
});

describe("F1: a span already inside a link is never wrapped again", () => {
  test("the author's link wins; chip styling stays", () => {
    const out = wiki("Se [`src/a/B.kt:3`](https://example.com/x).");
    expect(out).not.toContain("code-ref-link");
    expect(out).toMatch(/<a href="https:\/\/example\.com\/x"[^>]*><code class="code-ref">src\/a\/B\.kt:3<\/code><\/a>/);
    expect(out.match(/<a /g)?.length).toBe(1);
  });
  test("a path ref between two author links still links", () => {
    const out = wiki("[a](https://example.com/a) then `src/a/B.kt:3` then [b](https://example.com/b).");
    expect(out).toContain('<a class="code-ref-link" href="https://github.com/navikt/melosys-console/blob/9c09999/src/a/B.kt#L3"');
  });
});

describe("F2: host:port and dotted names are not refs", () => {
  for (const no of ["jarvis.local:8080", "api.example.com:443", "db.internal:5432", "host.docker.internal:5432", "java.lang:12", "v2.x:3", "foo.bar:1"]) {
    test(`${no} is not a ref`, () => expect(isLineRef(no)).toBe(false));
  }
  for (const ok of ["Service.kt:12", "a.test.ts:3", "build.gradle.kts:52", "Makefile:12", "Dockerfile:3", "Dockerfile.dev:4", "ops/Makefile:9", "a/b/c.weird:4", "V1__init.sql:3"]) {
    test(`${ok} is a ref`, () => expect(isLineRef(ok)).toBe(true));
  }
});

describe("F3: FileRef content is never chipped", () => {
  test("<FileRef>`src/a.ts:12`</FileRef>", () => {
    const out = wiki("<FileRef>`src/a.ts:12`</FileRef>");
    expect(chips(out)).toEqual([]);
    expect(out).toContain('<code class="fileref"><code>src/a.ts:12</code></code>');
  });
  test("a group inside a FileRef is not a group", () => {
    const out = wiki("<FileRef>(`:12`)</FileRef>");
    expect(groups(out)).toEqual([]);
    expect(chips(out)).toEqual([]);
  });
});

describe("F4: elided paths and the repo prefix", () => {
  test("a ... segment chips but does not link", () => {
    expect(isLineRef("domain/.../X.kt:34")).toBe(true);
    expect(lineRefUrl("domain/.../X.kt:34", AT)).toBeNull();
    expect(lineRefUrl("domain/…/X.kt:34", AT)).toBeNull();
    const out = wiki("Se `domain/.../X.kt:34`.");
    expect(chips(out)).toEqual(["domain/.../X.kt:34"]);
    expect(out).not.toContain("code-ref-link");
  });
  test("a first segment naming the code_at repo is stripped", () =>
    expect(lineRefUrl("melosys-console/backend/src/A.kt:3", AT)).toBe(
      "https://github.com/navikt/melosys-console/blob/9c09999/backend/src/A.kt#L3",
    ));
});

describe("F5: ranges", () => {
  test("a reversed range links in order", () => expect(lineRefUrl("src/B.kt:14-12", AT)).toMatch(/#L12-L14$/));
  test("line 0 chips but does not link", () => {
    expect(isLineRef("src/B.kt:0")).toBe(true);
    expect(lineRefUrl("src/B.kt:0", AT)).toBeNull();
    expect(lineRefUrl("src/B.kt:0-4", AT)).toBeNull();
    expect(lineRefUrl("a/B.kt:5-0", AT)).toBeNull();
  });
  test("a basename whose stem ends in a dot (`B..kt`) is not a ref", () => {
    for (const no of ["src/a..kt:12", "...kt:12", "src/B..kt:3"]) expect(isLineRef(no)).toBe(false);
  });
});

describe("F6: lists, en dash, Unicode", () => {
  for (const ok of ["build.gradle.kts:52,66-67,83", "WebConfig.java:22,44-51", "a/B.kt:377–400", ":377–400", "ÅrsavregningService.kt:39-47", "src/stegRekkefølge.ts:1-18", ":13, :46-51"]) {
    test(`${ok} is a ref`, () => expect(isLineRef(ok)).toBe(true));
  }
  test("a list links to its first line or range", () => {
    expect(lineRefUrl("app/build.gradle.kts:52,66-67,83", AT)).toMatch(/build\.gradle\.kts#L52$/);
    expect(lineRefUrl("app/build.gradle.kts:66-67,83", AT)).toMatch(/#L66-L67$/);
  });
  test("an en-dash range links", () => expect(lineRefUrl("a/B.kt:377–400", AT)).toMatch(/#L377-L400$/));
  test("non-ASCII path segments are percent-encoded", () =>
    expect(lineRefUrl("src/stegRekkefølge.ts:1-18", AT)).toBe(
      "https://github.com/navikt/melosys-console/blob/9c09999/src/stegRekkef%C3%B8lge.ts#L1-L18",
    ));
});

describe("F7: code_at", () => {
  test("an uppercase sha is accepted and lowercased", () =>
    expect(parseCodeAt("navikt/melosys-console@9C09999")).toEqual(AT));
});
