import { describe, expect, test } from "bun:test";
import { DIAGRAM_ID_MARK, diagramSvgFromHtml, extractSvgSlice, isWellFormedSanitizedSvg, sanitizeSvg } from "./diagram-svg.ts";
import { renderWikiHtml } from "./render.ts";

const M = DIAGRAM_ID_MARK;

/** A small archify-shaped picture: defs with a marker and a pattern, a node, an edge. */
const ARCHIFY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" role="img" lang="en" data-preset="x" aria-labelledby="t d">
<title id="t">T</title><desc id="d">D</desc>
<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" class="a-default"/></marker>
<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" class="c-grid"/></pattern></defs>
<rect width="200" height="100" fill="url(#grid)"/>
<g data-node-id="a" role="button" tabindex="0" aria-pressed="false" aria-label="A"><rect x="1" y="2" width="30" height="20" class="c-frontend"/><text x="5" y="15" class="t-primary">A</text></g>
<path d="M 0 0 L 10 10" class="a-default" marker-end="url(#arrowhead)" data-edge-from="a" data-edge-to="b"/>
</svg>`;

describe("sanitizeSvg", () => {
  test("keeps an archify picture whole, prefix-marking every id and local reference", async () => {
    const { svg, drops } = await sanitizeSvg(ARCHIFY);
    expect(svg).not.toBeNull();
    expect(drops.unknownElements.size + drops.unknownAttrs.size + drops.unknownClasses.size).toBe(0);
    expect(svg).toContain(`id="${M}arrowhead"`);
    expect(svg).toContain(`marker-end="url(#${M}arrowhead)"`);
    expect(svg).toContain(`fill="url(#${M}grid)"`);
    expect(svg).toContain(`aria-labelledby="${M}t ${M}d"`);
    // Original case survives serialization, so the browser reads markerWidth / refX.
    expect(svg).toContain('markerWidth="8"');
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain('data-node-id="a"');
    expect(svg).toContain('data-edge-from="a"');
  });

  test("keeps role on the root only; strips node interaction and preset hooks by design", async () => {
    const { svg, drops } = await sanitizeSvg(ARCHIFY);
    expect(svg!.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" role="img"')).toBe(true);
    expect(svg).not.toContain('role="button"');
    for (const a of ["tabindex", "aria-pressed", "aria-label", "lang", "data-preset"]) {
      expect(svg).not.toContain(`${a}=`);
      expect(drops.strippedAttrs.has(a)).toBe(true);
    }
    expect(drops.strippedAttrs.get("role")).toBe(1);
  });

  test("drops script, foreignObject and their content as unknown elements", async () => {
    const { svg, drops } = await sanitizeSvg(
      `<svg viewBox="0 0 1 1"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><rect width="1"/></svg>`,
    );
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("alert");
    expect(svg).not.toContain("foreignObject");
    expect(svg).not.toContain("<div");
    expect(svg).toContain('<rect width="1"');
    expect([...drops.unknownElements.keys()].sort()).toEqual(["div", "foreignobject", "script"]);
  });

  test("drops every on* handler as an unknown attribute", async () => {
    const { svg, drops } = await sanitizeSvg(`<svg onload="x()"><rect onclick="y()" ONMOUSEOVER="z()" width="1"/></svg>`);
    expect(svg).not.toMatch(/on\w+=/i);
    expect([...drops.unknownAttrs.keys()].sort()).toEqual(["onclick", "onload", "onmouseover"]);
  });

  test("refuses an external href, a remote url() and a javascript: value", async () => {
    const { svg, drops } = await sanitizeSvg(
      `<svg><g><path href="https://evil.test/x" d="M0 0"/><path xlink:href="javascript:alert(1)" d="M0 0"/>` +
        `<rect fill="url(https://evil.test/p.svg#g)" width="1"/><rect fill="url(#ok) red" width="1"/><path marker-end="url(#m)" d="M0 0"/></g></svg>`,
    );
    expect(svg).not.toContain("evil.test");
    expect(svg).not.toContain("javascript");
    expect(svg).not.toContain("url(#ok) red");
    expect(svg).toContain(`marker-end="url(#${M}m)"`);
    expect([...drops.unknownAttrs.keys()].sort()).toEqual(["fill=<value>", "href=<value>", "xlink:href=<value>"]);
  });

  test("keeps a local #href, marked", async () => {
    const { svg } = await sanitizeSvg(`<svg><use href="#a"/><a href="#b"><rect width="1"/></a></svg>`);
    // <use> and <a> are not kept elements: dropped with their content.
    expect(svg).toBe("<svg></svg>");
    const kept = await sanitizeSvg(`<svg><path href="#a" d="M0 0"/></svg>`);
    expect(kept.svg).toContain(`href="#${M}a"`);
  });

  test("drops an unknown class and reports it; keeps the archify ones", async () => {
    const { svg, drops } = await sanitizeSvg(`<svg><rect class="c-frontend t-primary mystery" width="1"/><rect class="mystery" width="1"/></svg>`);
    expect(svg).toContain('class="c-frontend t-primary"');
    expect(svg).toContain('<rect width="1"');
    expect(drops.unknownClasses.get("mystery")).toBe(2);
  });

  test("refuses an input that already carries the id marker", async () => {
    expect((await sanitizeSvg(`<svg id="${M}x"></svg>`)).svg).toBeNull();
  });

  test("drops comments", async () => {
    expect((await sanitizeSvg("<svg><!-- secret --><rect width='1'/></svg>")).svg).not.toContain("secret");
  });
});

describe("extractSvgSlice", () => {
  test("slices the one svg out of an html page", () => {
    expect(extractSvgSlice("<html><body><p>x</p><svg a='1'><g/></svg><script>1</script></body></html>")).toBe("<svg a='1'><g/></svg>");
  });
  test("refuses none, two pictures, or a stray marker", () => {
    expect(extractSvgSlice("<html></html>")).toBeNull();
    expect(extractSvgSlice("<svg></svg><svg></svg>")).toBeNull();
    expect(extractSvgSlice("<svg></svg><script>'</svg>'</script>")).toBeNull();
    expect(extractSvgSlice("</svg><svg>")).toBeNull();
  });
});

describe("diagramSvgFromHtml", () => {
  test("an html with no single svg is unparsable", async () => {
    const r = await diagramSvgFromHtml("<html><svg></svg><svg></svg></html>");
    expect(r).toEqual({ svg: null, problem: "unparsable", unknownElements: [], unknownAttrs: [], unknownClasses: [] });
  });

  test("lists unknown drops by name, sorted", async () => {
    const r = await diagramSvgFromHtml(`<p><svg><script/><rect onclick="x" class="zz c-frontend"/></svg></p>`);
    expect(r.problem).toBeUndefined();
    expect(r.unknownElements).toEqual(["script"]);
    expect(r.unknownAttrs).toEqual(["onclick"]);
    expect(r.unknownClasses).toEqual(["zz"]);
  });

  test("caches by path, mtime and size", async () => {
    const key = { path: "/x/a.html", mtimeMs: 1, size: 10 };
    const first = await diagramSvgFromHtml("<svg><rect width='1'/></svg>", key);
    expect(await diagramSvgFromHtml("<svg><circle r='1'/></svg>", key)).toBe(first);
    const moved = await diagramSvgFromHtml("<svg><circle r='1'/></svg>", { ...key, mtimeMs: 2 });
    expect(moved.svg).toContain("circle");
  });
});

/** Every start-tag name and attribute name in `html`, read by an HTML parser. */
async function liveMarkup(html: string): Promise<{ tags: string[]; attrs: string[] }> {
  const tags: string[] = [];
  const attrs: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        tags.push(el.tagName.toLowerCase());
        for (const [n] of el.attributes) attrs.push(n.toLowerCase());
      },
    })
    .transform(new Response(html))
    .text();
  return { tags, attrs };
}

describe("sanitized output is self-contained", () => {
  const PAGE = "# P\n\nIntro.\n\n<Glossary>\n\n- **Hold:** a book kept back\n\n</Glossary>\n\n<Diagram src=\"./x.architecture.json\" />\n";
  const render = async (body: string) => {
    const svg = await diagramSvgFromHtml(`<!doctype html><body>${body}</body>`);
    const json = JSON.stringify({ meta: { title: "T" }, components: [{ id: "a", label: "A" }] });
    const files = new Map([["./x.architecture.json", { ok: true as const, text: json, svg }]]);
    return { svg, html: renderWikiHtml(PAGE, () => undefined, { views: true, files }) };
  };

  test("a CDATA section is refused: no element escapes the picture through a glossary mark", async () => {
    const { svg, html } = await render(
      `<svg viewBox="0 0 100 100"><text x="1" y="10"><![CDATA[</div>]]> Hold <![CDATA[><img src=x onerror="window.__pwn='glossary'">]]></text></svg>`,
    );
    expect(svg.svg).toBeNull();
    expect(svg.problem).toBe("unparsable");
    expect(svg.unknownElements).toEqual(["#cdata"]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("CDATA");
    const live = await liveMarkup(html);
    expect(live.tags).not.toContain("img");
    expect(live.attrs.filter((a) => a.startsWith("on"))).toEqual([]);
  });

  test("text is re-escaped, so no markup-significant byte survives in it", async () => {
    const { svg } = await sanitizeSvg(`<svg viewBox="0 0 1 1"><text>a < b > c & d &amp; e &#x41;</text></svg>`);
    // Text is decoded (a closed set of references) and written back escaped.
    expect(svg).toBe(`<svg viewBox="0 0 1 1"><text>a &lt; b &gt; c &amp; d &amp; e A</text></svg>`);
  });

  test("escaped text reaches the reader as text, with the glossary term left unmarked inside the picture", async () => {
    const { svg, html } = await render(`<svg viewBox="0 0 100 100"><text x="1" y="10">Hold a < b</text></svg>`);
    expect(svg.svg).toBe(`<svg viewBox="0 0 100 100"><text x="1" y="10">Hold a &lt; b</text></svg>`);
    const picture = html.slice(html.indexOf('<div class="dgm-svg"'), html.indexOf("</svg>") + 6);
    expect(picture).toContain(`<text x="1" y="10">Hold a &lt; b</text>`);
    const live = await liveMarkup(picture);
    expect(live.tags).toEqual(["div", "svg", "text"]);
  });

  test("a CSS-escaped, commented or image() reference in a presentation value is refused", async () => {
    const E = "http://127.0.0.1:9/";
    const { svg, drops } = await sanitizeSvg(
      `<svg viewBox="0 0 10 10"><path d="M0 0L5 5" stroke="black" marker-end="u\\72 l(${E}m.svg#m)"/>` +
        `<rect width="5" height="5" fill="u\\72 l(${E}p.svg#p)"/><rect width="5" height="5" stroke="ur/**/l(${E}q.svg#p)"/>` +
        `<rect width="5" height="5" fill-opacity="image(${E}img.png)"/><path d="M0 0" marker-start="url(#m)"/>` +
        `<rect width="5" height="5" stroke-width="\\31"/><rect width="5" height="5" font-family="a/*b"/></svg>`,
    );
    expect(svg).not.toContain("127.0.0.1");
    expect(svg).not.toContain("\\");
    expect(svg).not.toContain("image(");
    expect(svg).toContain(`marker-start="url(#${M}m)"`);
    expect([...drops.unknownAttrs.entries()].sort()).toEqual([
      ["fill-opacity=<value>", 1],
      ["fill=<value>", 1],
      ["font-family=<value>", 1],
      ["marker-end=<value>", 1],
      ["stroke-width=<value>", 1],
      ["stroke=<value>", 1],
    ]);
  });

  test("an output that does not close its root svg is unparsable", async () => {
    const plain = `<svg viewBox="0 0 10 10"><text>a</text><plaintext><img src=x onerror="alert(1)"></svg>`;
    expect((await sanitizeSvg(plain)).svg).toBeNull();
    const r = await diagramSvgFromHtml(`<body>${plain}</body>`);
    expect(r.svg).toBeNull();
    expect(r.problem).toBe("unparsable");
  });
});

/** Every tag token in `html`, start and end, as an HTML tokenizer sees it. The
 *  sanitized output never puts a `>` inside an attribute value (escaped), so a
 *  `<[^>]*>` split is exact on well-formed output and still catches a malformed
 *  one (a stray/attribute end tag becomes a token that fails these tests). */
function tagTokens(html: string): { starts: string[]; ends: { name: string; raw: string }[] } {
  const starts: string[] = [];
  const ends: { name: string; raw: string }[] = [];
  for (const m of html.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    const raw = m[0];
    if (raw[1] === "/") ends.push({ name: raw.slice(2, -1).trim().split(/[\s>]/)[0]!.toLowerCase(), raw });
    else starts.push(raw);
  }
  return { starts, ends };
}

describe("sanitized output is well-formed by construction (fix round 2)", () => {
  test("a stray end tag never reaches the output", async () => {
    // A </div> that matches no opened element, inside the svg.
    const { svg } = await sanitizeSvg(`<svg viewBox="0 0 1 1"><g><text>a</text></g></div><rect width="1"/></svg>`);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain("</div>");
    expect(svg).not.toContain("<div");
    const { ends } = tagTokens(svg!);
    expect(ends.map((e) => e.name)).toEqual(["text", "g", "rect", "svg"]);
  });

  test("an end tag carrying attributes never reaches the output", async () => {
    // The verify-pass vector: an end tag whose quoted attribute value holds a > ,
    // so a naive tokenizer closes the tag early and the rest becomes live text.
    const { svg } = await sanitizeSvg(`<svg viewBox="0 0 1 1"><g><text>a</text></g></g data-x="z>Hold y"></svg>`);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain("data-x");
    expect(svg).not.toContain("z>Hold");
    // No end tag in the output carries any attribute (text past its name).
    for (const e of tagTokens(svg!).ends) expect(e.raw).toBe(`</${e.name}>`);
  });

  test("an unmatched extra end tag never reaches the output", async () => {
    const { svg } = await sanitizeSvg(`<svg viewBox="0 0 1 1"><text>a</text></text></text></svg>`);
    expect(svg).not.toBeNull();
    // One <text> opened, so exactly one </text> and the root </svg>.
    expect(tagTokens(svg!).ends.map((e) => e.name)).toEqual(["text", "svg"]);
  });

  test("every kept element pairs and nests in order", async () => {
    const { svg } = await sanitizeSvg(
      `<svg viewBox="0 0 1 1"><defs><marker id="m"><polygon points="0 0"/></marker></defs><g><rect width="1"/><text>a</text></g></svg>`,
    );
    expect(svg).toBe(
      `<svg viewBox="0 0 1 1"><defs><marker id="${DIAGRAM_ID_MARK}m"><polygon points="0 0"></polygon></marker></defs><g><rect width="1"></rect><text>a</text></g></svg>`,
    );
    expect(isWellFormedSanitizedSvg(svg!)).toBe(true);
  });
});

describe("isWellFormedSanitizedSvg (fix round 2)", () => {
  test("accepts well-formed sanitized output", () => {
    expect(isWellFormedSanitizedSvg(`<svg viewBox="0 0 1 1"><g><text>a &lt; b</text></g></svg>`)).toBe(true);
    expect(isWellFormedSanitizedSvg(`<svg><rect width="1"></rect></svg>`)).toBe(true);
    // Never self-closed: the serializer pairs every element.
    expect(isWellFormedSanitizedSvg(`<svg><rect width="1"/></svg>`)).toBe(false);
  });

  test("refuses a stray or unmatched end tag", () => {
    expect(isWellFormedSanitizedSvg(`<svg><text>a</text></div></svg>`)).toBe(false);
    expect(isWellFormedSanitizedSvg(`<svg><text>a</text></text></svg>`)).toBe(false);
    expect(isWellFormedSanitizedSvg(`</svg>`)).toBe(false);
  });

  test("refuses an end tag that carries attributes", () => {
    expect(isWellFormedSanitizedSvg(`<svg><g>a</g data-x="y"></svg>`)).toBe(false);
  });

  test("refuses an unknown element or an attribute outside the allowlist", () => {
    expect(isWellFormedSanitizedSvg(`<svg><script>x</script></svg>`)).toBe(false);
    expect(isWellFormedSanitizedSvg(`<svg><rect onclick="x" width="1"/></svg>`)).toBe(false);
  });

  test("refuses raw markup-significant bytes in text", () => {
    expect(isWellFormedSanitizedSvg(`<svg><text>a < b</text></svg>`)).toBe(false);
    expect(isWellFormedSanitizedSvg(`<svg><!-- c --><rect width="1"/></svg>`)).toBe(false);
  });

  test("refuses output not wrapped in a single root svg", () => {
    expect(isWellFormedSanitizedSvg(`<g></g>`)).toBe(false);
    expect(isWellFormedSanitizedSvg(`<svg></svg><svg></svg>`)).toBe(false);
  });
});

/** A `<Glossary>` whose term appears in a hostile position inside the svg. The
 *  reader marks glossary terms over the fully rendered page; the picture must be
 *  opaque to that pass. Parse the result with a real HTML parser (HTMLRewriter). */
describe("the glossary pass treats the picture as opaque (fix round 2)", () => {
  const PAGE = '# P\n\n<Glossary>\n\n- **Hold:** a book kept back\n\n</Glossary>\n\n<Diagram src="./x.architecture.json" />\n';
  const render = async (slice: string) => {
    const svg = await diagramSvgFromHtml(`<!doctype html><body>${slice}</body>`);
    const json = JSON.stringify({ meta: { title: "T" }, components: [{ id: "a", label: "A" }] });
    const files = new Map([["./x.architecture.json", { ok: true as const, text: json, svg }]]);
    return { svg, html: renderWikiHtml(PAGE, () => undefined, { views: true, files }) };
  };

  test("a hostile end tag cannot smuggle a glossary span into the picture", async () => {
    const { html } = await render(
      `<svg viewBox="0 0 100 100"><text x="1" y="10">a</text></div></g data-x="z>Hold y"></svg>`,
    );
    const pictureStart = html.indexOf('<div class="dgm-svg"');
    const svgClose = html.indexOf("</svg>", pictureStart);
    const picture = html.slice(pictureStart, svgClose + 6);
    expect(picture).not.toContain("gl-mark");
    expect(picture).not.toContain("gl-term");
    const live = await allTagsAndOnAttrs(picture);
    // Only the picture's own elements: the wrapper div and the kept svg subtree.
    expect(live.tags.filter((t) => !["div", "svg", "g", "text"].includes(t))).toEqual([]);
    expect(live.onAttrs).toEqual([]);
  });

  test("no gl-mark span lands anywhere inside the svg, and nothing live after the picture", async () => {
    // The glossary term is drawn as escaped text inside the picture; it must not be marked.
    const { html } = await render(`<svg viewBox="0 0 100 100"><text x="1" y="10">Hold this</text></svg>`);
    const open = html.indexOf("<svg");
    const close = html.indexOf("</svg>", open);
    const inside = html.slice(open, close);
    expect(inside).not.toContain("gl-mark");
    const live = await allTagsAndOnAttrs(html);
    expect(live.onAttrs).toEqual([]);
    expect(live.tags).not.toContain("img");
    expect(live.tags).not.toContain("script");
  });
});

/** Every element name and every `on*` attribute an HTML parser reads. */
async function allTagsAndOnAttrs(html: string): Promise<{ tags: string[]; onAttrs: string[] }> {
  const tags: string[] = [];
  const onAttrs: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        tags.push(el.tagName.toLowerCase());
        for (const [n] of el.attributes) if (n.toLowerCase().startsWith("on")) onAttrs.push(n.toLowerCase());
      },
    })
    .transform(new Response(html))
    .text();
  return { tags, onAttrs };
}

// The seeded soup that stood here passed against the unfixed sanitizer too; the
// input space in src/test/diagram-svg-space.ts (its soup dimension included) and
// diagram-svg-space.test.ts + e2e/wiki-diagram-sanitizer.spec.ts replace it.
