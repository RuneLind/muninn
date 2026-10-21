import { describe, expect, test } from "bun:test";
import { DIAGRAM_CHROME_CLASSES, diagramLabelSizes, diagramViewHtml, lifecycleRail, readDiagram } from "./diagram-block.ts";
import { DIAGRAM_ID_MARK, type DiagramSvgResult, type PageFiles } from "./query-block.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { PEEK_DIAGRAM_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";
import { diagramEdgeDimmed } from "../dashboard/views/components/wiki-visuals.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

const M = DIAGRAM_ID_MARK;

/** A synthetic lifecycle: the main lane out of col order, a side lane, a transition. */
const LIFECYCLE = {
  meta: {
    title: "Order",
    views: [
      { id: "rail", label: "Rail", focus: ["new", "paid", "sent"], note: "The happy path." },
      { id: "x", label: "Cancel", focus: ["cancelled"] },
    ],
  },
  lanes: [
    { id: "side", label: "Side" },
    { id: "main", label: "Main" },
  ],
  states: [
    { id: "sent", label: "Sent", lane: "main", col: 3 },
    { id: "new", label: "New", lane: "main", col: 1 },
    { id: "cancelled", label: "Cancelled", lane: "side", col: 2 },
    { id: "paid", label: "Paid", sublabel: "card", lane: "main", col: 2 },
  ],
  transitions: [{ from: "new", to: "cancelled", label: "abort" }],
};

const svgOf = (svg: string): DiagramSvgResult => ({ svg, unknownElements: [], unknownAttrs: [], unknownClasses: [] });
const PICTURE = `<svg viewBox="0 0 1 1"><defs><marker id="${M}arrowhead"/></defs><g id="${M}new" data-node-id="new"/><path marker-end="url(#${M}arrowhead)" data-edge-from="new" data-edge-to="paid"/></svg>`;

/** The narrowest the drawing renders, in CSS px: its `--dgm-floor`; a root
 *  without one (the shape before the floor) drew at its `width` and never
 *  narrower. */
function narrowest(open: string): number {
  const floor = /--dgm-floor:\s*(\d+)px/.exec(open)?.[1];
  return Number(floor ?? /\swidth="([\d.]+)"/.exec(open)?.[1] ?? 0);
}

describe("lifecycleRail", () => {
  test("joins the main lane's states in col order", () => {
    expect(lifecycleRail(LIFECYCLE)).toEqual(["New → Paid", "Paid → Sent"]);
  });
  test("falls back to the first lane when none is main", () => {
    const doc = { lanes: [{ id: "a" }], states: [{ id: "p", lane: "a", col: 2 }, { id: "q", lane: "a", col: 1 }] };
    expect(lifecycleRail(doc)).toEqual(["q → p"]);
  });
  test("one state is no rail", () => {
    expect(lifecycleRail({ lanes: [{ id: "main" }], states: [{ id: "a", lane: "main" }] })).toEqual([]);
  });
});

describe("readDiagram", () => {
  test("lifecycle text form: states by lane in lane order, then the rail, transitions and view notes", () => {
    const r = readDiagram("lifecycle", JSON.stringify(LIFECYCLE))!;
    expect(r.title).toBe("Order");
    expect(r.sections).toEqual([
      { heading: "Side", lines: ["Cancelled"] },
      { heading: "Main", lines: ["New", "Paid — card", "Sent"] },
      { heading: "Main path", lines: ["New → Paid", "Paid → Sent"] },
      { heading: "Transitions", lines: ["New → Cancelled (abort)"] },
      { heading: "Views", lines: ["Rail: The happy path."] },
    ]);
    expect(r.views.map((v) => v.id)).toEqual(["rail", "x"]);
  });

  test("architecture text form: components by type, boundaries, then connections", () => {
    const doc = {
      components: [
        { id: "web", label: "Web", type: "frontend" },
        { id: "api", label: "API", type: "backend" },
        { id: "db", label: "DB", type: "backend", col: 0 },
      ],
      boundaries: [{ label: "VPC", wraps: ["api", "db"] }],
      connections: [{ from: "web", to: "api", label: "HTTPS" }],
    };
    expect(readDiagram("architecture", JSON.stringify(doc))!.sections).toEqual([
      { heading: "frontend", lines: ["Web"] },
      { heading: "backend", lines: ["API", "DB"] },
      { heading: "Inside VPC", lines: ["API", "DB"] },
      { heading: "Connections", lines: ["Web → API (HTTPS)"] },
    ]);
  });

  test("workflow text form: nodes by lane, then edges as steps", () => {
    const doc = { lanes: [{ id: "u", label: "User" }], nodes: [{ id: "a", label: "Ask", lane: "u" }, { id: "b", label: "Get", lane: "u", col: 1 }], edges: [{ from: "a", to: "b" }] };
    expect(readDiagram("workflow", JSON.stringify(doc))!.sections).toEqual([
      { heading: "User", lines: ["Ask", "Get"] },
      { heading: "Steps", lines: ["Ask → Get"] },
    ]);
  });

  test("not a JSON object reads as null; a wrong-shaped field as absent", () => {
    expect(readDiagram("workflow", "[1]")).toBeNull();
    expect(readDiagram("workflow", "{")).toBeNull();
    expect(readDiagram("workflow", JSON.stringify({ nodes: "x", meta: { views: 3 } }))).toEqual({ flavor: "workflow", title: "", views: [], sections: [] });
  });
});

describe("diagramViewHtml", () => {
  const ref = "./order.lifecycle.json";
  const text = JSON.stringify(LIFECYCLE);

  test("draws the picture with its id marks replaced, the view buttons, notes and the open link", () => {
    const html = diagramViewHtml({ ref, text, svg: svgOf(PICTURE), prefix: "dgm4-" });
    expect(html).not.toContain(M);
    expect(html).toContain('id="dgm4-arrowhead"');
    expect(html).toContain('marker-end="url(#dgm4-arrowhead)"');
    expect(html).toContain('data-dgm-view="rail" data-dgm-focus="new paid sent"');
    expect(html).toContain('data-dgm-note="rail" hidden');
    expect(html).toContain('data-dgm-html="./order.html"');
    expect(html).toContain("dgm-has-svg");
    expect(html).toContain('aria-label="Order"');
  });

  test("with no picture: the text form and a line naming the html, no view buttons", () => {
    const html = diagramViewHtml({ ref, text, svg: { ...svgOf(""), svg: null, problem: "missing" }, prefix: "dgm1-" });
    expect(html).toContain("Picture not shown: order.html");
    expect(html).not.toContain("dgm-views");
    expect(html).not.toContain("dgm-has-svg");
    expect(html).toContain("<li>New → Paid</li>");
  });

  test("«Open interactive» only when the html sibling was read", () => {
    const open = (svg?: DiagramSvgResult) => diagramViewHtml({ ref, text, svg, prefix: "dgm1-" }).includes("dgm-open");
    expect(open(svgOf(PICTURE))).toBe(true);
    // The file is there but drew nothing: its viewer still opens.
    expect(open({ ...svgOf(""), svg: null, problem: "unparsable" })).toBe(true);
    expect(open({ ...svgOf(""), svg: null, problem: "too-large" })).toBe(true);
    // No file, or nobody looked: no link to a 404.
    expect(open({ ...svgOf(""), svg: null, problem: "missing" })).toBe(false);
    expect(open(undefined)).toBe(false);
  });

  test("the server writes no tab stop: the client makes the region focusable only while it scrolls", () => {
    const wide = `<svg viewBox="0 0 1160 552" role="img"><text font-size="7">x</text></svg>`;
    const html = diagramViewHtml({ ref, text, svg: svgOf(wide), prefix: "dgm1-" });
    expect(html).toContain('<div class="dgm-svg" data-dgm-label="Order (drawing)"');
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain('role="region"');
  });

  test("an unreadable file is one line", () => {
    expect(diagramViewHtml({ ref, text: "nope", prefix: "dgm1-" })).toContain("Diagram file not readable: order.lifecycle.json");
  });
});

/**
 * The drawing's size rule: it fills the column (CSS `width: 100%`) and never
 * renders narrower than its legibility floor, written on the root as
 * `--dgm-floor`: the width at which its smallest label is drawn at 8.5 px,
 * `ceil(W × 8.5 / smallest)`, capped at 2 × W, from px or unitless font sizes
 * of 1 px and up, own or inherited; 0 with no such label. `width`/`height` are
 * the viewBox size.
 */
describe("diagramViewHtml: the picture's size", () => {
  const ref = "./order.lifecycle.json";
  const text = JSON.stringify(LIFECYCLE);
  const root = (svg: string) => {
    const html = diagramViewHtml({ ref, text, svg: svgOf(svg), prefix: "dgm1-" });
    const open = /<svg\b[^>]*>/.exec(html)![0];
    const attrs = [...open.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!] as const);
    return { open, names: attrs.map(([n]) => n), attr: (n: string) => attrs.find(([k]) => k === n)?.[1], floor: narrowest(open) };
  };
  const W = `viewBox="0 0 1160 552"`;
  const floorOf = (body: string, rootAttrs = W) => root(`<svg ${rootAttrs}>${body}</svg>`).floor;

  test("the floor is where the smallest label reaches 8.5 px, not the natural size: 900 wide, 12 px labels", () => {
    const r = root(`<svg viewBox="0 0 900 300"><text font-size="12">a</text><text font-size="14">b</text></svg>`);
    // 900 × 8.5 / 12 = 637.5: it fits a 734 px column at 734, and scrolls only below 638.
    expect(r.floor).toBe(638);
    expect([r.attr("width"), r.attr("height")]).toEqual(["900", "300"]);
  });

  test("archify's 7 px labels put the floor above the natural width; 8.5 px labels put it at it", () => {
    expect(floorOf(`<text font-size="12">a</text><text font-size="7">b</text>`)).toBe(1409);
    expect(floorOf(`<text font-size="8.5">a</text>`)).toBe(1160);
    expect(floorOf(`<text font-size="17">a</text>`)).toBe(580);
  });

  test("the upscale is capped at 2 ×", () => {
    expect(floorOf(`<text font-size="2">a</text>`)).toBe(2320);
    expect(floorOf(`<text font-size="4.25">a</text>`)).toBe(2320);
    expect(floorOf(`<text font-size="4.3">a</text>`)).toBe(2294);
  });

  test("a font size below 1 px is ignored, so it cannot blow the drawing up", () => {
    const r = root(`<svg ${W}><text font-size="0.01">a</text></svg>`);
    expect(r.floor).toBe(0);
    expect(r.attr("width")).toBe("1160");
    expect(floorOf(`<text font-size="0.01">a</text><text font-size="7">b</text>`)).toBe(1409);
    expect(floorOf(`<text font-size="0.99">a</text><text font-size="12">b</text>`)).toBe(822);
    expect(floorOf(`<text font-size="1">a</text>`)).toBe(2320);
  });

  test("px sizes count; em, % and other units are ignored rather than misread", () => {
    expect(floorOf(`<text font-size="7px">a</text>`)).toBe(1409);
    expect(floorOf(`<text font-size="0.5em">a</text>`)).toBe(0);
    expect(floorOf(`<text font-size="50%">a</text>`)).toBe(0);
    expect(floorOf(`<text font-size="7pt">a</text><text font-size="12">b</text>`)).toBe(822);
  });

  test("a label inherits its size from a <g> or the root; its own size overrides", () => {
    expect(floorOf(`<g font-size="7"><text>a</text></g><text font-size="12">b</text>`)).toBe(1409);
    expect(floorOf(`<g font-size="7px"><g><text><tspan>a</tspan></text></g></g>`)).toBe(1409);
    expect(floorOf(`<text>a</text>`, `${W} font-size="7"`)).toBe(1409);
    expect(floorOf(`<g font-size="7"><text font-size="12">a</text></g>`)).toBe(822);
    // A size on a <g> with no label in it, or on a self-closed one, reaches no label.
    expect(floorOf(`<g font-size="7"><rect width="1" height="1"/></g><text font-size="12">b</text>`)).toBe(822);
    expect(floorOf(`<g font-size="7"/><text>a</text><text font-size="12">b</text>`)).toBe(822);
    // An em <g> leaves its unsized labels unread; a px label inside it still counts.
    expect(floorOf(`<g font-size="2em"><text>a</text></g><text font-size="12">b</text>`)).toBe(822);
    expect(floorOf(`<g font-size="2em"><text font-size="7">a</text></g>`)).toBe(1409);
  });

  test("a root's own width and height are replaced, never duplicated", () => {
    const r = root(`<svg width="10" height="20" ${W}><text font-size="7">a</text></svg>`);
    expect(r.names.filter((n) => n === "width")).toHaveLength(1);
    expect(r.names.filter((n) => n === "height")).toHaveLength(1);
    expect([r.attr("width"), r.attr("height")]).toEqual(["1160", "552"]);
    expect(r.names.filter((n) => n === "style")).toHaveLength(1);
  });

  test("a closed <g>'s size reaches no label after it", () => {
    expect(diagramLabelSizes(`<svg><g font-size="7"><rect/></g><text>b</text></svg>`)).toEqual([]);
    expect(diagramLabelSizes(`<svg font-size="12"><g font-size="7"><rect/></g><text>b</text></svg>`)).toEqual([12]);
  });

  test("only a label that carries text counts toward the floor", () => {
    expect(diagramLabelSizes(`<svg><text font-size="7"/></svg>`)).toEqual([]);
    expect(diagramLabelSizes(`<svg><text font-size="7"></text></svg>`)).toEqual([]);
    expect(diagramLabelSizes(`<svg><text font-size="7">  </text></svg>`)).toEqual([]);
    expect(diagramLabelSizes(`<svg><text font-size="7">a</text></svg>`)).toEqual([7]);
    expect(floorOf(`<text font-size="2"></text><text font-size="12">b</text>`)).toBe(822);
  });

  test("the viewBox reads every SVG number form: sign, decimals, exponent, comma or space", () => {
    const sized = (box: string) => {
      const r = root(`<svg viewBox="${box}"><text font-size="12">a</text></svg>`);
      return [r.attr("width"), r.attr("height"), r.floor];
    };
    expect(sized("0 0 1e3 300")).toEqual(["1000", "300", 709]);
    expect(sized("-10 -2.5e1 1E3 3e+2")).toEqual(["1000", "300", 709]);
    expect(sized("+0,0,900,300")).toEqual(["900", "300", 638]);
    expect(sized("0, 0 .9e3 , 300.")).toEqual(["900", "300", 638]);
    expect(sized("  0 0 900 300  ")).toEqual(["900", "300", 638]);
  });

  test("a viewBox with a zero, negative or non-finite size, or not four numbers, sets no size", () => {
    for (const box of ["0 0 0 300", "0 0 900 -300", "0 0 1e999 300", "0 0 900 1e400", "1e999 0 900 300", "0 0 900", "0 0 900 300 1", "0 0 9e 300", "0 0 . 300", "0 0 900px 300"]) {
      const r = root(`<svg viewBox="${box}"><text font-size="12">a</text></svg>`);
      expect([box, r.attr("width"), r.attr("style")]).toEqual([box, undefined, undefined]);
    }
  });

  test("with no labels there is no floor; with no usable viewBox no size is invented", () => {
    expect(floorOf(`<rect width="1" height="1"/>`)).toBe(0);
    expect(diagramViewHtml({ ref, text, svg: svgOf("<svg><text>x</text></svg>"), prefix: "dgm1-" })).toContain("<svg><text>");
  });
});

describe("<Diagram> through the reader render", () => {
  const files = (svg: string): PageFiles => ({
    get: (r) => (r === "./a.lifecycle.json" || r === "./b.lifecycle.json" ? { ok: true, text: JSON.stringify(LIFECYCLE), svg: svgOf(svg) } : undefined),
  });
  const page = '<Diagram src="./a.lifecycle.json" />\n\n<Diagram src="./b.lifecycle.json" />\n';

  test("two diagrams on one page get distinct id prefixes", () => {
    const html = renderWikiHtml(page, () => undefined, { files: files(PICTURE), views: true });
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toContain("dgm1-arrowhead");
    expect(ids).toContain("dgm2-arrowhead");
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of html.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]);
  });

  test("a picture with blank lines between its tags gets no <br> inside the svg", () => {
    // archify writes indented, blank-line-separated markup; the web formatter turns
    // blank lines into <br>, which the HTML parser reads as leaving the <svg>.
    const spaced = PICTURE.replace("</defs>", "</defs>\n\n        \n").replace("<path", "\n  <path");
    const html = renderWikiHtml('<Diagram src="./a.lifecycle.json" />\n', () => undefined, { files: files(spaced), views: true });
    const svg = /<svg[\s\S]*?<\/svg>/.exec(html)![0];
    expect(svg).not.toContain("<br");
    expect(svg).toContain('marker-end="url(#dgm1-arrowhead)"');
  });

  test("the floor survives the reader render's string passes", () => {
    const sized = `<svg viewBox="0 0 900 300"><text font-size="12">a</text></svg>`;
    const html = renderWikiHtml('<Diagram src="./a.lifecycle.json" />\n', () => undefined, { files: files(sized), views: true });
    expect(narrowest(/<svg\b[^>]*>/.exec(html)![0])).toBe(638);
  });

  test("web chat (no files) prints the not-loaded line", () => {
    const html = formatWebHtml('<Diagram src="./a.lifecycle.json" />');
    expect(html).toContain("dgm-unavailable");
    expect(html).toContain("a.lifecycle.json");
    expect(html).not.toContain("<svg");
  });

  test("no src is its own line", () => {
    expect(formatWebHtml("<Diagram />")).toContain("Diagram without src");
  });
});

test("the peek strips exactly the diagram chrome", () => {
  expect([...PEEK_DIAGRAM_CHROME]).toEqual([...DIAGRAM_CHROME_CLASSES]);
});

describe("diagramEdgeDimmed", () => {
  const focus = new Set(["a", "b"]);
  test("dims only an edge whose both ends are out of focus", () => {
    expect(diagramEdgeDimmed(focus, "c", "d")).toBe(true);
    expect(diagramEdgeDimmed(focus, "a", "d")).toBe(false);
    expect(diagramEdgeDimmed(focus, "c", "b")).toBe(false);
  });
  test("the All view dims nothing", () => {
    expect(diagramEdgeDimmed(new Set(), "c", "d")).toBe(false);
  });
});

describe("<Diagram> on the text surfaces (no file read)", () => {
  const md = '<Diagram src="./flows/x.architecture.json" />';
  test("telegram, slack and email print the file line with its interactive sibling", () => {
    expect(formatTelegramHtml(md)).toBe("Diagram: x.architecture.json (interactive: x.html)");
    expect(formatSlackMrkdwn(md)).toContain("x.architecture.json");
    expect(formatSlackMrkdwn(md)).toContain("x.html");
    expect(formatEmailHtml(md)).toContain("Diagram: x.architecture.json (interactive: x.html)");
  });
  test("no src", () => {
    expect(formatTelegramHtml("<Diagram />")).toBe("Diagram without src");
    expect(formatSlackMrkdwn("<Diagram />")).toBe("Diagram without src");
  });
});
