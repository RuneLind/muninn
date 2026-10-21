import { describe, expect, test } from "bun:test";
import { DIAGRAM_ID_MARK, diagramSvgFromHtml, extractSvgSlice, sanitizeSvg } from "./diagram-svg.ts";

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
