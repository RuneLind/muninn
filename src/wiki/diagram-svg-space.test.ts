/**
 * The sanitizer and the picture's parking over the enumerated input space
 * (`src/test/diagram-svg-space.ts`), one rule per describe. The Chromium half
 * of the proof — that the browser parses each output as this tree — is
 * `e2e/wiki-diagram-sanitizer.spec.ts`; this file proves the string, the tree
 * and the self-check agree, and pins each rule on its smallest input.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTENT_MODEL,
  DIAGRAM_ID_MARK,
  decodeAttrValue,
  decodeText,
  isWellFormedSanitizedSvg,
  sanitizeSvg,
  serializeSvgTree,
  type SvgTreeNode,
} from "./diagram-svg.ts";
import { parkDiagramPictures, renderWikiHtml, restoreDiagramPictures, type ParkedPicture } from "./render.ts";
import { diagramSpaceCases, readSanitizedTree, type SvgNode } from "../test/diagram-svg-space.ts";
import { extractSvgSlice } from "./diagram-svg.ts";

const sorted = (n: SvgTreeNode): SvgNode => ({
  tag: n.tag,
  attrs: [...n.attrs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  kids: n.kids.map((k) => (typeof k === "string" ? k : sorted(k))),
});

describe("every case of the space: string, tree and self-check agree", () => {
  test("each drawn picture reads back as the sanitizer's own tree, with no line break", async () => {
    const counts = { cases: 0, drawn: 0, refused: 0 };
    for (const c of diagramSpaceCases()) {
      for (const slice of c.slices) {
        counts.cases++;
        const cut = extractSvgSlice(`<body>${slice}</body>`);
        if (!cut) continue;
        const { svg, tree } = await sanitizeSvg(cut);
        if (svg === null) {
          counts.refused++;
          expect(tree).toBeNull();
          continue;
        }
        counts.drawn++;
        expect(isWellFormedSanitizedSvg(svg)).toBe(true);
        expect(serializeSvgTree(tree!)).toBe(svg);
        expect(readSanitizedTree(svg)).toEqual(sorted(tree!));
        expect(svg).not.toContain("\n");
        expect(svg).not.toContain("/>");
      }
    }
    // The space is the size the spec reports, and most of it draws.
    expect(counts.cases).toBeGreaterThan(5000);
    expect(counts.drawn).toBeGreaterThan(counts.cases * 0.8);
  });
});

describe("rule 1: attribute values are checked decoded, and any & is refused", () => {
  test("a remote url() spelled with a character reference is refused", async () => {
    for (const v of ["url&#40;http://h/p.svg#p)", "url&lpar;http://h/p.svg#p)", "u&#92;72 l(http://h/p.svg#p)", "u&bsol;72 l(http://h/p.svg#p)", "url(&#35;ok)"]) {
      const { svg, drops } = await sanitizeSvg(`<svg><rect width="1" fill="${v}"></rect></svg>`);
      expect(svg).toBe('<svg><rect width="1"></rect></svg>');
      expect([...drops.unknownAttrs.keys()]).toEqual(["fill=<value>"]);
    }
  });

  test("a value without & is the raw value after CR and NUL, so every check reads what the browser holds", () => {
    expect(decodeAttrValue("a&amp;b")).toBeNull();
    expect(decodeAttrValue("a\r\nb\rc")).toBe("a b c");
    expect(decodeAttrValue("a\0b")).toBe("a�b");
  });

  test("a literal \" from a single-quoted value is written escaped, and the browser's value is the source's", async () => {
    const { svg, tree } = await sanitizeSvg(`<svg><rect x='1"2' width="1"></rect></svg>`);
    expect(svg).toBe('<svg><rect x="1&quot;2" width="1"></rect></svg>');
    expect((tree!.kids[0] as SvgTreeNode).attrs[0]).toEqual(["x", '1"2']);
  });

  test("a repeated attribute keeps its first value, as the tokenizer does", async () => {
    expect((await sanitizeSvg(`<svg><rect width="1" WIDTH="2"></rect></svg>`)).svg).toBe('<svg><rect width="1"></rect></svg>');
  });
});

describe("rule 2: the content model", () => {
  test("title and desc hold text only: an element inside is dropped with its subtree and counted", async () => {
    const desc = await sanitizeSvg(`<svg><desc><rect width="1"/>d</desc><rect width="2"/></svg>`);
    expect(desc.svg).toBe('<svg><desc>d</desc><rect width="2"></rect></svg>');
    expect([...desc.drops.unknownElements.keys()]).toEqual(["desc>rect"]);
    // A nested <title/> is where the tokenizer and the tree disagree on which
    // element </title> closes; the sanitizer keeps its own stack, so the shapes
    // after it stay inside the outer title and are dropped there, never emitted.
    const title = await sanitizeSvg(`<svg><title><title/>t</title><rect width="2"/></svg>`);
    expect(title.svg).toBe("<svg><title>t</title></svg>");
    expect([...title.drops.unknownElements.keys()].sort()).toEqual(["title>rect", "title>title"]);
  });

  test("a kept element out of place is dropped with its kept descendants", async () => {
    const { svg, drops } = await sanitizeSvg(`<svg><rect><g><circle r="1"></circle></g></rect><marker><text>x</text></marker></svg>`);
    expect(svg).toBe("<svg><rect></rect></svg>");
    expect([...drops.unknownElements.keys()].sort()).toEqual(["rect>g", "svg>marker"]);
  });

  test("every element is written paired, never self-closed", async () => {
    const { svg } = await sanitizeSvg(`<svg><g><rect width="1"/><path d="M0 0"/></g></svg>`);
    expect(svg).toBe('<svg><g><rect width="1"></rect><path d="M0 0"></path></g></svg>');
  });

  test("the kept set is the content model's, and no kept element holds both text and children", () => {
    for (const [tag, m] of Object.entries(CONTENT_MODEL)) if (m.text) expect([tag, m.children.size]).toEqual([tag, 0]);
    expect(Object.keys(CONTENT_MODEL).sort()).toEqual(
      ["#root", "circle", "defs", "desc", "ellipse", "g", "line", "marker", "path", "pattern", "polygon", "rect", "svg", "text", "title"],
    );
  });

  test("non-whitespace text where the model holds none is counted; whitespace between elements is dropped", async () => {
    const { svg, drops } = await sanitizeSvg("<svg>\n  <g> stray <rect></rect>\n</g>\n</svg>");
    expect(svg).toBe("<svg><g><rect></rect></g></svg>");
    expect([...drops.unknownElements.keys()]).toEqual(["g>#text"]);
  });
});

describe("rule 3: text is decoded for a closed set of references, else dropped", () => {
  test("decoded: the five XML names, nbsp, bull, and decimal or hex naming a plain scalar", () => {
    expect(decodeText("a &amp; b &lt;c&gt; &quot;&apos; &nbsp;&bull; &#65;&#x42;&#X43;&#0068;")).toBe("a & b <c> \"'  • ABCD");
  });

  test("a & that starts no reference is a literal &, as in the tokenizer", () => {
    expect(decodeText("a & b &")).toBe("a & b &");
  });

  test("refused: semicolon-less, unknown or table-dependent names, and numerics with a reading of their own", () => {
    for (const t of ["&lt b", "&ltx", "&amp", "&notit;", "&notin;", "&#65", "&#0;", "&#x110000;", "&#xD800;", "&#128;", "&#13;", "&#;", "&#x;", "&;"]) {
      expect([t, decodeText(t)]).toEqual([t, t === "&;" ? "&;" : null]);
    }
  });

  test("a refused text node is dropped and counted as #charref; the rest of the picture stays", async () => {
    const { svg, drops } = await sanitizeSvg(`<svg><text>&lt b</text><text>a &amp; b</text></svg>`);
    expect(svg).toBe("<svg><text></text><text>a &amp; b</text></svg>");
    expect([...drops.unknownElements.keys()]).toEqual(["#charref"]);
  });

  test("text is re-escaped: < > & \" are never raw in the output", async () => {
    const { svg } = await sanitizeSvg(`<svg viewBox="0 0 1 1"><text>a < b > c & d &amp; e &#x41; "q"</text></svg>`);
    expect(svg).toBe(`<svg viewBox="0 0 1 1"><text>a &lt; b &gt; c &amp; d &amp; e A &quot;q&quot;</text></svg>`);
  });

  test("a reference that decodes to the id mark is refused", async () => {
    const spelled = DIAGRAM_ID_MARK.replace("-", "&#45;");
    const { svg, drops } = await sanitizeSvg(`<svg><text>${spelled}</text></svg>`);
    expect(svg).toBe("<svg><text></text></svg>");
    expect(drops.unknownElements.get("#charref")).toBe(1);
  });
});

describe("rule 4: line breaks read as one space", () => {
  test("in text and in values, as the renderer's own collapse would", async () => {
    const { svg } = await sanitizeSvg(`<svg>\n<path d="M0 0\n   L1 1"></path><text>a\r\n  b</text></svg>`);
    expect(svg).toBe('<svg><path d="M0 0 L1 1"></path><text>a b</text></svg>');
  });
});

describe("rule 5: the self-check", () => {
  test("accepts exactly the serializer's shape", () => {
    expect(isWellFormedSanitizedSvg('<svg viewBox="0 0 1 1" role="img"><g><text>a &lt; b &amp; &quot;</text></g></svg>')).toBe(true);
  });

  test("refuses anything after the root, a second root, or text outside one", () => {
    expect(isWellFormedSanitizedSvg("<svg></svg>abc")).toBe(false);
    expect(isWellFormedSanitizedSvg("<svg></svg><svg></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg(" <svg></svg>")).toBe(false);
  });

  test("refuses a raw markup byte or a bare & in text or a value", () => {
    expect(isWellFormedSanitizedSvg("<svg><text>a > b</text></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg('<svg><text>a " b</text></svg>')).toBe(false);
    expect(isWellFormedSanitizedSvg("<svg><text>a & b</text></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg("<svg><text>&#40;</text></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg('<svg><rect fill="url&#40;x)"></rect></svg>')).toBe(false);
  });

  test("refuses a self-closed tag, a child its parent does not allow, and text where the model holds none", () => {
    expect(isWellFormedSanitizedSvg('<svg><rect width="1"/></svg>')).toBe(false);
    expect(isWellFormedSanitizedSvg("<svg><desc><rect></rect></desc></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg("<svg><g>x</g></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg('<svg><g role="img"></g></svg>')).toBe(false);
    expect(isWellFormedSanitizedSvg('<svg><rect onclick="x"></rect></svg>')).toBe(false);
  });

  test("refuses a stray, mis-nested or attribute-carrying end tag", () => {
    expect(isWellFormedSanitizedSvg("<svg><g></text></g></svg>")).toBe(false);
    expect(isWellFormedSanitizedSvg('<svg><g></g x="1"></svg>')).toBe(false);
    expect(isWellFormedSanitizedSvg("</svg>")).toBe(false);
  });

  test("sanitizeSvg runs it: a serialization it refuses draws nothing", async () => {
    const r = await sanitizeSvg("<svg><rect></rect></svg>", () => "<svg></svg>abc");
    expect(r.svg).toBeNull();
    expect(r.tree).toBeNull();
  });
});

describe("the picture's place in the page", () => {
  const JSON_TEXT = JSON.stringify({ meta: { title: "T" }, components: [{ id: "a", label: "A" }] });
  const picture = async () => {
    const { svg } = await sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="5" height="5"></rect></svg>');
    return { svg, unknownElements: [], unknownAttrs: [], unknownClasses: [] };
  };

  test("a NUL in the page body is dropped, so the page cannot spell a parking token", async () => {
    const files = new Map([["./d.architecture.json", { ok: true as const, text: JSON_TEXT, svg: await picture() }]]);
    const body = "Prose \0DGMPIC0\0 and [click](https://example.com/\0DGMPIC0\0) and `\0DGMPIC0\0`\n\n<Diagram src=\"./d.architecture.json\" />\n";
    const html = renderWikiHtml(body, () => undefined, { views: true, files });
    expect(html).not.toContain("\0");
    expect(html.split("<svg").length - 1).toBe(1);
    expect(html).toContain("Prose DGMPIC0 and");
    expect(html.indexOf("<svg")).toBeGreaterThan(html.indexOf('<div class="dgm-svg"'));
  });

  test("a NUL cannot forge a wikilink token either", () => {
    const html = renderWikiHtml("[[Real]] then \0WIKIPAGELINK0\0", () => undefined);
    expect(html.match(/wiki-link-missing/g)?.length).toBe(1);
    expect(html).toContain("then WIKIPAGELINK0");
  });

  const parkOne = () => {
    const parked: ParkedPicture[] = [];
    const html = parkDiagramPictures('<p>a</p><div class="dgm-svg" data-x="1"><svg></svg></div><p>b</p>', parked);
    return { html, parked };
  };

  test("restored where it was parked", () => {
    const { html, parked } = parkOne();
    expect(html).toBe('<p>a</p><div class="dgm-svg" data-x="1">\0DGMPIC0\0</div><p>b</p>');
    expect(restoreDiagramPictures(html, parked)).toBe('<p>a</p><div class="dgm-svg" data-x="1"><svg></svg></div><p>b</p>');
  });

  test("a token that moved, was copied, or sits in code drops the picture and leaves no token", () => {
    const { html, parked } = parkOne();
    const tok = "\0DGMPIC0\0";
    const moved = html.replace(tok, "") + `<a href="${tok}">x</a>`;
    const copied = html + `<span title="${tok}"></span>`;
    const inCode = `<pre><code>${tok}</code></pre>` + html.replace(tok, "");
    const stray = html + "\0DGMPIC7\0";
    for (const h of [moved, copied, inCode]) {
      const out = restoreDiagramPictures(h, parked);
      expect(out).not.toContain("<svg");
      expect(out).not.toContain("\0");
    }
    expect(restoreDiagramPictures(stray, parked)).toBe('<p>a</p><div class="dgm-svg" data-x="1"><svg></svg></div><p>b</p>');
  });

  test("a glossary term in the diagram's title leaves the picture in place", async () => {
    const json = JSON.stringify({ meta: { title: "Hold map" }, components: [{ id: "a", label: "A" }] });
    const files = new Map([["./d.architecture.json", { ok: true as const, text: json, svg: await picture() }]]);
    const body = '<Glossary>\n\n- **Hold:** a book kept back\n\n</Glossary>\n\n<Diagram src="./d.architecture.json" />\n';
    const html = renderWikiHtml(body, () => undefined, { views: true, files });
    expect(html).toMatch(/<div class="dgm-svg"[^>]*><svg /);
  });
});
