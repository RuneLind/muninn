import { describe, expect, test } from "bun:test";
import { DIAGRAM_CHROME_CLASSES, diagramLabelSizes, diagramViewHtml, humanizeId, readDiagram, type DiagramTextSection } from "./diagram-block.ts";
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

describe("readDiagram", () => {
  test("lifecycle text form: states by lane in lane order (the main lane in col order), transitions, view notes", () => {
    const r = readDiagram("lifecycle", JSON.stringify(LIFECYCLE))!;
    expect(r.title).toBe("Order");
    expect(r.sections).toEqual([
      { heading: "Side", lines: ["Cancelled"] },
      { heading: "Main", lines: ["New", "Paid — card", "Sent"] },
      { heading: "Transitions", lines: ["New → Cancelled (abort)"] },
      { heading: "Views", lines: ["Rail: The happy path."] },
    ]);
    expect(r.views.map((v) => v.id)).toEqual(["rail", "x"]);
  });

  test("architecture text form: archify's legend names as headings, each component once under its innermost boundary", () => {
    const doc = {
      meta: { legend: { entries: { frontend: { label: "Screens" } } } },
      components: [
        { id: "web", label: "Web", type: "frontend" },
        { id: "q", label: "Queue", type: "messagebus" },
        { id: "w", label: "Worker", type: "job-runner" },
        { id: "api", label: "API", type: "backend" },
        { id: "db", label: "DB", type: "database", col: 0 },
      ],
      boundaries: [
        { kind: "region", label: "VPC", wraps: ["api", "db"] },
        { kind: "security-group", label: "", wraps: ["db"] },
      ],
      connections: [{ from: "web", to: "api", label: "HTTPS" }],
    };
    expect(readDiagram("architecture", JSON.stringify(doc))!.sections).toEqual([
      { heading: "Screens", lines: ["Web"] },
      { heading: "Message bus", lines: ["Queue"] },
      { heading: "Job runner", lines: ["Worker"] },
      { heading: "Inside VPC", lines: ["API (Backend)"] },
      { heading: "Inside VPC › Security group", lines: ["DB (Database)"] },
      { heading: "Connections", lines: ["Web → API (HTTPS)"] },
    ]);
  });

  test("workflow text form: nodes by lane, a group's nodes under the lane and group, then edges as steps", () => {
    const doc = {
      lanes: [{ id: "u", label: "User" }, { id: "back-office" }],
      groups: [{ id: "g", label: "Checkout", lane: "u", fromCol: 1, toCol: 2 }],
      nodes: [
        { id: "a", label: "Ask", lane: "u" },
        { id: "b", label: "Get", lane: "u", col: 1 },
        { id: "c", label: "File", lane: "back-office", col: 0 },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    expect(readDiagram("workflow", JSON.stringify(doc))!.sections).toEqual([
      { heading: "User", lines: ["Ask"] },
      { heading: "User › Checkout", lines: ["Get"] },
      { heading: "Back office", lines: ["File"] },
      { heading: "Steps", lines: ["Ask → Get"] },
    ]);
  });

  test("a type or legend entry named like an Object member reads as an unknown type", () => {
    for (const t of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const doc = { meta: { legend: { entries: {} } }, components: [{ id: "a", type: t }] };
      expect(readDiagram("architecture", JSON.stringify(doc))!.sections).toEqual([{ heading: humanizeId(t), lines: ["a"] }]);
    }
    const page = '<Diagram src="./x.architecture.json" />\n';
    for (const t of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const text = JSON.stringify({ components: [{ id: "a", type: t }] });
      const files: PageFiles = { get: (r) => (r === "./x.architecture.json" ? { ok: true, text } : undefined) };
      const html = renderWikiHtml(page, () => undefined, { files, views: true });
      expect(html).toContain(`<p class="dgm-text-h">${humanizeId(t)}</p>`);
    }
  });

  test("a lane named in no lanes entry sorts after the listed lanes, before no lane", () => {
    const doc = {
      lanes: [{ id: "a", label: "A" }],
      nodes: [
        { id: "n0", label: "Loose" },
        { id: "n1", label: "Stray", lane: "zz" },
        { id: "n2", label: "Listed", lane: "a" },
      ],
    };
    expect(readDiagram("workflow", JSON.stringify(doc))!.sections.map((s) => s.heading)).toEqual(["A", "Zz", "Other"]);
  });

  test("overlapping boundaries that do not nest are never chained: the smallest, first in the file on a tie", () => {
    const doc = {
      components: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
        { id: "z", label: "Z" },
        { id: "w", label: "W" },
      ],
      boundaries: [
        { label: "A", wraps: ["x", "y"] },
        { label: "B", wraps: ["y", "z"] },
        { label: "C", wraps: ["x", "y", "z", "w"] },
      ],
    };
    // y is in A, B and C; A and B overlap without nesting, and C wraps both.
    expect(readDiagram("architecture", JSON.stringify(doc))!.sections).toEqual([
      { heading: "Inside C", lines: ["W"] },
      { heading: "Inside C › A", lines: ["X", "Y"] },
      { heading: "Inside C › B", lines: ["Z"] },
    ]);
  });

  test("overlapping groups that do not nest are never chained either", () => {
    const doc = {
      lanes: [{ id: "u", label: "U" }],
      groups: [
        { id: "g1", label: "G1", lane: "u", fromCol: 0, toCol: 2 },
        { id: "g2", label: "G2", lane: "u", fromCol: 2, toCol: 4 },
      ],
      nodes: [{ id: "n", label: "N", lane: "u", col: 2 }],
    };
    expect(readDiagram("workflow", JSON.stringify(doc))!.sections).toEqual([{ heading: "U › G1", lines: ["N"] }]);
  });

  test("not a JSON object reads as null; a wrong-shaped field as absent", () => {
    expect(readDiagram("workflow", "[1]")).toBeNull();
    expect(readDiagram("workflow", "{")).toBeNull();
    expect(readDiagram("workflow", JSON.stringify({ nodes: "x", meta: { views: 3 } }))).toEqual({ flavor: "workflow", title: "", views: [], sections: [] });
  });
});

/**
 * The text form is the drawing's accessible alternative and its no-picture
 * fallback, so it must be complete: over seeded synthetic archify files of all
 * three kinds (known and unknown types, legend overrides, nested and
 * overlapping boundaries and groups, wraps of unknown ids, nodes in no lane or
 * an unknown one), every node is listed exactly once, under its innermost
 * boundary or group, every edge exactly once, and no heading is a raw id.
 */
describe("readDiagram: the text form is complete", () => {
  const EDGE_HEADINGS = new Set(["Connections", "Steps", "Transitions", "Views"]);
  const KNOWN_TYPES = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"];

  /** mulberry32: a small seeded PRNG, so a failure names its seed. */
  function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(next() * n);
    const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!;
    const subset = <T,>(xs: readonly T[]): T[] => xs.filter(() => next() < 0.4);
    return { next, int, pick, subset };
  }

  type Doc = Record<string, unknown>;
  interface Case { flavor: "architecture" | "workflow" | "lifecycle"; doc: Doc; nodes: Doc[]; edges: Doc[]; rawIds: Set<string>; innermost: Map<Doc, string> }

  function makeCase(seed: number): Case {
    const r = rng(seed);
    const flavor = r.pick(["architecture", "workflow", "lifecycle"] as const);
    const n = 1 + r.int(9);
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const rawIds = new Set<string>();
    const nodes: Doc[] = ids.map((id, i) => {
      const node: Doc = { label: `Node ${i}` };
      if (r.next() < 0.9) node.id = id;
      if (r.next() < 0.3) node.sublabel = `sub ${i}`;
      if (r.next() < 0.8) node.col = r.int(4);
      return node;
    });
    const edges: Doc[] = Array.from({ length: r.int(8) }, (_, i) => ({ from: r.pick([...ids, "ghost"]), to: r.pick(ids), label: `e${i}` }));
    const innermost = new Map<Doc, string>();
    let doc: Doc;
    if (flavor === "architecture") {
      const types = [...KNOWN_TYPES, "job-runner", "data_lake", ""];
      for (const node of nodes) {
        const t = r.pick(types);
        if (t || r.next() < 0.5) node.type = t;
        if (t) rawIds.add(t);
      }
      const entries: Doc = {};
      if (r.next() < 0.3) entries.backend = { label: "Our services" };
      const bounds: Doc[] = Array.from({ length: r.int(4) }, (_, i) => {
        const wraps = r.subset([...ids, "ghost"]);
        const kind = r.pick(["region", "security-group"]);
        rawIds.add(kind);
        return { kind, label: r.next() < 0.8 ? `Zone ${i}` : "", wraps };
      });
      // A nested boundary: a strict subset of an earlier one.
      if (bounds.length && r.next() < 0.5) {
        const outer = (bounds[0]!.wraps as string[]).filter((x) => x !== "ghost");
        if (outer.length > 1) bounds.push({ kind: "security-group", label: `Inner`, wraps: outer.slice(0, outer.length - 1) });
      }
      for (const node of nodes) {
        const id = node.id as string | undefined;
        const inside = id ? bounds.filter((b) => (b.wraps as string[]).includes(id)) : [];
        if (inside.length === 0) continue;
        // Innermost: the fewest wraps, the first listed on a tie.
        const best = inside.reduce((a, b) => ((b.wraps as string[]).length < (a.wraps as string[]).length ? b : a));
        const kindName = best.kind === "region" ? "Region" : "Security group";
        innermost.set(node, (best.label as string) || kindName);
      }
      doc = { meta: { legend: { entries } }, components: nodes, boundaries: bounds, connections: edges };
    } else {
      const laneIds = ["main", "side-lane", "ops_team"].slice(0, 1 + r.int(3));
      const lanes: Doc[] = laneIds.map((id) => (r.next() < 0.7 ? { id, label: `Lane ${id.toUpperCase()}` } : { id }));
      for (const id of laneIds) rawIds.add(id);
      for (const node of nodes) {
        const lane = r.pick([...laneIds, "stray-lane", ""]);
        if (lane) node.lane = lane;
        if (lane) rawIds.add(lane);
      }
      if (flavor === "workflow") {
        const groups: Doc[] = Array.from({ length: r.int(3) }, (_, i) => {
          const from = r.int(3);
          return { id: `g${i}`, label: `Group ${i}`, lane: r.pick(laneIds), fromCol: from, toCol: from + r.int(3) };
        });
        for (const node of nodes) {
          const inside = groups.filter((g) => g.lane === node.lane && typeof node.col === "number" && (g.fromCol as number) <= node.col && node.col <= (g.toCol as number));
          if (inside.length === 0) continue;
          const span = (g: Doc) => (g.toCol as number) - (g.fromCol as number);
          innermost.set(node, inside.reduce((a, b) => (span(b) < span(a) ? b : a)).label as string);
        }
        doc = { lanes, groups, nodes, edges };
      } else {
        doc = { lanes, states: nodes, transitions: edges };
      }
    }
    return { flavor, doc, nodes, edges, rawIds, innermost };
  }

  const nodeText = (node: Doc) => `${node.label}${node.sublabel ? ` — ${node.sublabel}` : ""}`;
  const edgeText = (e: Doc, nodes: Doc[]) => {
    const name = (id: unknown) => (nodes.find((x) => x.id === id)?.label as string | undefined) ?? (id as string);
    return `${name(e.from)} → ${name(e.to)} (${e.label})`;
  };
  const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

  test("every node is listed exactly once, and only nodes are listed outside the edge sections", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const sections: DiagramTextSection[] = readDiagram(c.flavor, JSON.stringify(c.doc))!.sections;
      const lines = sections.filter((s) => !EDGE_HEADINGS.has(s.heading)).flatMap((s) => s.lines);
      const hits = (node: Doc) => lines.filter((l) => l === nodeText(node) || l.startsWith(`${nodeText(node)} (`)).length;
      expect({ seed, counts: c.nodes.map(hits), lines: lines.length }).toEqual({ seed, counts: c.nodes.map(() => 1), lines: c.nodes.length });
    }
  });

  test("every edge is listed exactly once", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const sections = readDiagram(c.flavor, JSON.stringify(c.doc))!.sections;
      const edgeLines = sections.filter((s) => EDGE_HEADINGS.has(s.heading) && s.heading !== "Views").flatMap((s) => s.lines);
      expect({ seed, lines: edgeLines.toSorted() }).toEqual({ seed, lines: c.edges.map((e) => edgeText(e, c.nodes)).toSorted() });
    }
  });

  test("a node inside a boundary or group is listed under its innermost one", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const sections = readDiagram(c.flavor, JSON.stringify(c.doc))!.sections;
      for (const node of c.nodes) {
        const section = sections.find((s) => s.lines.some((l) => l === nodeText(node) || l.startsWith(`${nodeText(node)} (`)));
        const last = section?.heading.split(" › ").at(-1)?.replace(/^Inside /, "");
        expect({ seed, node: node.label, last }).toEqual({ seed, node: node.label, last: c.innermost.get(node) ?? last });
        if (!c.innermost.has(node)) expect({ seed, nested: section?.heading.includes(" › ") || section?.heading.startsWith("Inside ") }).toEqual({ seed, nested: false });
      }
    }
  });

  test("no heading, or part of one, is a raw archify id", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const parts = readDiagram(c.flavor, JSON.stringify(c.doc))!.sections.flatMap((s) => s.heading.replace(/^Inside /, "").split(" › "));
      for (const part of parts) {
        expect({ seed, part, raw: c.rawIds.has(part) || part === "" }).toEqual({ seed, part, raw: false });
      }
    }
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
    expect(html).toContain("<li>New → Cancelled (abort)</li>");
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

describe("<Diagram> and the glossary pass", () => {
  // Every text the block writes holds «Hold»: the file name, the title, the
  // labels, a view's label and note.
  const HELD = {
    meta: { title: "Hold board", views: [{ id: "h", label: "Hold view", focus: ["a"], note: "Hold the line." }] },
    lanes: [{ id: "main", label: "Hold lane" }],
    states: [
      { id: "a", label: "Hold", lane: "main", col: 1 },
      { id: "b", label: "Hold again", lane: "main", col: 2 },
    ],
    transitions: [{ from: "a", to: "b", label: "Hold on" }],
  };
  const glossary = "\n\n<Glossary>\n\n- **Hold:** a book kept back for one reader\n\n</Glossary>\n";
  const drawn = svgOf(`<svg viewBox="0 0 10 10"><g data-node-id="a"><text font-size="12">Hold</text></g></svg>`);
  const missing: DiagramSvgResult = { ...svgOf(""), svg: null, problem: "missing" };
  const filesOf = (r: PageFiles extends { get: (k: string) => infer R } ? R : never): PageFiles => ({ get: () => r });
  const STATES: [string, string, PageFiles | undefined][] = [
    ["drawn, with views", '<Diagram src="./Hold.lifecycle.json" />', filesOf({ ok: true, text: JSON.stringify(HELD), svg: drawn })],
    ["no picture", '<Diagram src="./Hold.lifecycle.json" />', filesOf({ ok: true, text: JSON.stringify(HELD), svg: missing })],
    ["not a JSON object", '<Diagram src="./Hold.lifecycle.json" />', filesOf({ ok: true, text: "[]", svg: missing })],
    ["file not available", '<Diagram src="./Hold.lifecycle.json" />', filesOf({ ok: false, reason: "unavailable" })],
    ["not loaded", '<Diagram src="./Hold.lifecycle.json" />', undefined],
  ];
  const render = (md: string, files: PageFiles | undefined) => renderWikiHtml(md + glossary, () => undefined, { files, views: true });
  const before = (html: string) => html.slice(0, html.indexOf('class="glossary'));

  test.each(STATES)("%s: nothing in the block is marked", (_name, md, files) => {
    const html = render(md, files);
    expect(before(html)).toContain("Hold");
    expect(before(html)).not.toContain("gl-mark");
  });

  test("the classes the block writes are the ones the glossary pass was decided for", () => {
    // A new class here is a new piece of block text: decide whether the
    // glossary pass may mark it (SKIP_CLASSES in glossary-view.ts), then add it.
    const seen = new Set<string>();
    for (const [, md, files] of STATES) {
      const block = before(render(md, files)).replace(/<svg[\s\S]*?<\/svg>/g, "");
      for (const m of block.matchAll(/\sclass="([^"]*)"/g)) for (const c of m[1]!.split(/\s+/)) seen.add(c);
    }
    expect([...seen].sort()).toEqual(
      [
        "dgm", "dgm-fallback", "dgm-foot", "dgm-has-svg", "dgm-lifecycle", "dgm-missing", "dgm-note", "dgm-open",
        "dgm-svg", "dgm-text", "dgm-text-h", "dgm-unavailable", "dgm-view", "dgm-views",
      ].sort(),
    );
  });
});

test("the peek strips exactly the diagram chrome", () => {
  expect([...PEEK_DIAGRAM_CHROME]).toEqual([...DIAGRAM_CHROME_CLASSES]);
});

describe("diagramEdgeDimmed", () => {
  // archify's guided-view rule: an edge stays lit only when both its ends are in focus.
  const focus = new Set(["a", "b"]);
  test("the All view (empty focus) dims nothing", () => {
    expect(diagramEdgeDimmed(new Set(), "c", "d")).toBe(false);
    expect(diagramEdgeDimmed(new Set(), "a", "a")).toBe(false);
  });
  test("an edge with both ends in focus stays lit", () => {
    expect(diagramEdgeDimmed(focus, "a", "b")).toBe(false);
    expect(diagramEdgeDimmed(focus, "b", "a")).toBe(false);
  });
  test("an edge with only its from end in focus dims", () => {
    expect(diagramEdgeDimmed(focus, "a", "d")).toBe(true);
  });
  test("an edge with only its to end in focus dims", () => {
    expect(diagramEdgeDimmed(focus, "c", "b")).toBe(true);
  });
  test("an edge with neither end in focus dims", () => {
    expect(diagramEdgeDimmed(focus, "c", "d")).toBe(true);
  });
  test("a self-edge follows its one node", () => {
    expect(diagramEdgeDimmed(focus, "a", "a")).toBe(false);
    expect(diagramEdgeDimmed(focus, "c", "c")).toBe(true);
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
