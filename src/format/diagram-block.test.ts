import { describe, expect, test } from "bun:test";
import { DIAGRAM_CHROME_CLASSES, diagramViewHtml, lifecycleRail, readDiagram } from "./diagram-block.ts";
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

  test("the picture keeps its natural size inside a named, focusable scroll region", () => {
    const wide = `<svg viewBox="0 0 1160 552" role="img"><text>x</text></svg>`;
    const html = diagramViewHtml({ ref, text, svg: svgOf(wide), prefix: "dgm1-" });
    expect(html).toContain('<svg width="1160" height="552" viewBox="0 0 1160 552"');
    expect(html).toMatch(/<div class="dgm-svg" role="region" aria-label="Order \(drawing\)" tabindex="0"/);
    // A 7 px label scales the drawing up until it is drawn at 8.5 px; 12 px labels never shrink it.
    const fine = `<svg viewBox="0 0 1160 552"><text font-size="12">a</text><text x="1" font-size="7">b</text></svg>`;
    expect(diagramViewHtml({ ref, text, svg: svgOf(fine), prefix: "dgm1-" })).toContain('<svg width="1409" height="670"');
    const big = `<svg viewBox="0 0 600 200"><text font-size="12">a</text></svg>`;
    expect(diagramViewHtml({ ref, text, svg: svgOf(big), prefix: "dgm1-" })).toContain('<svg width="600" height="200"');
    // No usable viewBox: no size is invented.
    expect(diagramViewHtml({ ref, text, svg: svgOf("<svg><text>x</text></svg>"), prefix: "dgm1-" })).toContain("<svg><text>");
  });

  test("an unreadable file is one line", () => {
    expect(diagramViewHtml({ ref, text: "nope", prefix: "dgm1-" })).toContain("Diagram file not readable: order.lifecycle.json");
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
