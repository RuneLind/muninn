/**
 * `<Diagram src="./x.architecture.json" />` in the reader: the sanitized
 * archify SVG from the HTML sibling (`src/wiki/diagram-svg.ts` made it; this
 * module only receives the string), its `meta.views` as buttons, and a text
 * form built from the JSON. The text form is visually hidden beside the SVG for
 * a screen reader, and is all a peek shows. With no SVG it is the block.
 *
 * Pure: imported by the reader's render (`views: true`) only, through the
 * `diagramView` option of `formatWebHtml`, so the chat bundle never carries it.
 */
import { escapeHtml } from "./markdown-core.ts";
import { diagramClassStyles } from "./diagram-styles.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import {
  DIAGRAM_ID_MARK,
  diagramFlavor,
  diagramSiblingHtml,
  pageFileName,
  type DiagramFlavor,
  type DiagramSvgResult,
} from "./query-block.ts";

export interface DiagramView {
  id: string;
  label: string;
  focus: string[];
  note: string;
}

export interface DiagramTextSection {
  heading: string;
  lines: string[];
}

/** What the reader shows of one diagram file, read tolerantly: a field of the
 *  wrong shape reads as absent. Null when the file is not a JSON object. */
export interface DiagramRead {
  flavor: DiagramFlavor;
  title: string;
  views: DiagramView[];
  sections: DiagramTextSection[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `label — sublabel`, else the id. */
function nodeText(n: Obj): string {
  const label = str(n.label) || str(n.id);
  const sub = str(n.sublabel);
  return sub ? `${label} — ${sub}` : label;
}

function edgeLine(e: Obj, names: Map<string, string>): string {
  const from = str(e.from);
  const to = str(e.to);
  const label = str(e.label);
  return `${names.get(from) ?? from} → ${names.get(to) ?? to}${label ? ` (${label})` : ""}`;
}

function nameMap(nodes: Obj[]): Map<string, string> {
  return new Map(nodes.map((n) => [str(n.id), str(n.label) || str(n.id)]));
}

/** archify's own English legend names for an architecture component's `type`
 *  (`legend.architecture.*` in archify's `renderers/shared/i18n.mjs`), in its
 *  legend order. A file's `meta.legend.entries.<type>.label` overrides one. */
export const ARCHIFY_TYPE_LABELS: Readonly<Record<string, string>> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  cloud: "Cloud",
  security: "Security",
  messagebus: "Message bus",
  external: "External",
};

/** An id read as words, for an id archify names nothing for:
 *  `security-group` → `Security group`; empty stays empty. */
export function humanizeId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

/** One listed node: its line, the section it goes under, and where that
 *  section sorts (compared element by element, a prefix first). */
interface Placed {
  node: Obj;
  line: string;
  key: string;
  heading: string;
  rank: number[];
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Placed nodes as sections: one per key, sections by rank, each section's
 *  lines by `col` (stable). Every node is one line in one section. */
function sectionsOf(placed: Placed[]): DiagramTextSection[] {
  const groups = new Map<string, Placed[]>();
  for (const p of placed) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
  return [...groups.values()]
    .sort((a, b) => compareRank(a[0]!.rank, b[0]!.rank))
    .map((ps) => ({ heading: ps[0]!.heading, lines: [...ps].sort((a, b) => num(a.node.col) - num(b.node.col)).map((p) => p.line) }));
}

/** The containers a node is inside, outermost first: most members (widest
 *  column range) first. The last is its innermost; of two the same size, the
 *  one first in the file. */
function enclosing<T extends { index: number; size: number }>(all: T[], holds: (c: T) => boolean): T[] {
  return all.filter(holds).sort((a, b) => b.size - a.size || b.index - a.index);
}

function readViews(doc: Obj): DiagramView[] {
  const meta = isObj(doc.meta) ? doc.meta : {};
  return objs(meta.views)
    .map((v) => ({
      id: str(v.id),
      label: str(v.label) || str(v.id),
      focus: Array.isArray(v.focus) ? v.focus.map(str).filter(Boolean) : [],
      note: str(v.note),
    }))
    .filter((v) => v.id !== "");
}

/** Components outside every boundary by type, under the type's legend name;
 *  a component inside one or more boundaries once, under its innermost
 *  (`Inside VPC › Private`), with its type's name after it; then connections. */
function architectureSections(doc: Obj): DiagramTextSection[] {
  const comps = objs(doc.components);
  const names = nameMap(comps);
  const meta = isObj(doc.meta) ? doc.meta : {};
  const legend = isObj(meta.legend) && isObj(meta.legend.entries) ? meta.legend.entries : {};
  const typeName = (t: string) => {
    const override = isObj(legend[t]) ? str((legend[t] as Obj).label) : "";
    return override || ARCHIFY_TYPE_LABELS[t] || humanizeId(t) || "Other";
  };
  const catalog = Object.keys(ARCHIFY_TYPE_LABELS);
  const unknownTypes: string[] = [];
  const typeRank = (t: string) => {
    if (!t) return Number.MAX_SAFE_INTEGER;
    if (catalog.includes(t)) return catalog.indexOf(t);
    if (!unknownTypes.includes(t)) unknownTypes.push(t);
    return catalog.length + unknownTypes.indexOf(t);
  };
  const bounds = objs(doc.boundaries).map((b, index) => {
    const wraps = new Set(Array.isArray(b.wraps) ? b.wraps.map(str).filter(Boolean) : []);
    return { index, size: wraps.size, wraps, label: str(b.label) || humanizeId(str(b.kind)) || "Boundary" };
  });
  const placed = comps.map((c): Placed => {
    const id = str(c.id);
    const t = str(c.type);
    const inside = id ? enclosing(bounds, (b) => b.wraps.has(id)) : [];
    if (inside.length === 0) return { node: c, line: nodeText(c), key: `type:${t}`, heading: typeName(t), rank: [0, typeRank(t)] };
    return {
      node: c,
      line: t ? `${nodeText(c)} (${typeName(t)})` : nodeText(c),
      key: `in:${inside.map((b) => b.index).join(",")}`,
      heading: `Inside ${inside.map((b) => b.label).join(" › ")}`,
      rank: [1, ...inside.map((b) => b.index)],
    };
  });
  const sections = sectionsOf(placed);
  const edges = objs(doc.connections);
  if (edges.length) sections.push({ heading: "Connections", lines: edges.map((e) => edgeLine(e, names)) });
  return sections;
}

/** Each node under its lane (lanes in file order, a lane named in no `lanes`
 *  entry after them, no lane last as `Other`); a workflow node inside a
 *  group's column range is listed under `Lane › Group`, its innermost group. */
function laneSections(doc: Obj, nodes: Obj[], groups: Obj[]): DiagramTextSection[] {
  const lanes = objs(doc.lanes);
  const order = lanes.map((l) => str(l.id));
  const labels = new Map(lanes.map((l) => [str(l.id), str(l.label) || humanizeId(str(l.id))]));
  const laneRank = (lane: string) => {
    if (!lane) return Number.MAX_SAFE_INTEGER;
    if (!order.includes(lane)) order.push(lane);
    return order.indexOf(lane);
  };
  const ranges = groups.map((g, index) => {
    const from = num(g.fromCol);
    const to = num(g.toCol);
    return { index, size: to - from, lane: str(g.lane), from, to, label: str(g.label) || humanizeId(str(g.id)) || "Group" };
  });
  const placed = nodes.map((n): Placed => {
    const lane = str(n.lane);
    const laneName = labels.get(lane) || humanizeId(lane) || "Other";
    const col = typeof n.col === "number" && Number.isFinite(n.col) ? n.col : null;
    const inside = lane && col !== null ? enclosing(ranges, (g) => g.lane === lane && g.from <= col && col <= g.to) : [];
    return {
      node: n,
      line: nodeText(n),
      key: `${lane}\u0000${inside.map((g) => g.index).join(",")}`,
      heading: [laneName, ...inside.map((g) => g.label)].join(" › "),
      rank: [laneRank(lane), ...inside.map((g) => g.index + 1)],
    };
  });
  return sectionsOf(placed);
}

function workflowSections(doc: Obj): DiagramTextSection[] {
  const nodes = objs(doc.nodes);
  const sections = laneSections(doc, nodes, objs(doc.groups));
  const edges = objs(doc.edges);
  if (edges.length) sections.push({ heading: "Steps", lines: edges.map((e) => edgeLine(e, nameMap(nodes))) });
  return sections;
}

/** States by lane; the `main` lane, archify's phase rail, is in `col` order,
 *  which is the rail's order, so the rail is not listed again. */
function lifecycleSections(doc: Obj): DiagramTextSection[] {
  const states = objs(doc.states);
  const sections = laneSections(doc, states, []);
  const transitions = objs(doc.transitions);
  if (transitions.length) sections.push({ heading: "Transitions", lines: transitions.map((e) => edgeLine(e, nameMap(states))) });
  return sections;
}

/** Read one diagram file's text. Null when it is not a JSON object. */
export function readDiagram(flavor: DiagramFlavor, text: string): DiagramRead | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(doc)) return null;
  const meta = isObj(doc.meta) ? doc.meta : {};
  const views = readViews(doc);
  const sections =
    flavor === "architecture" ? architectureSections(doc) : flavor === "workflow" ? workflowSections(doc) : lifecycleSections(doc);
  const notes = views.filter((v) => v.note).map((v) => `${v.label}: ${v.note}`);
  if (notes.length) sections.push({ heading: "Views", lines: notes });
  return { flavor, title: str(meta.title), views, sections };
}

/** The text form as HTML: one heading and one list per section. */
export function diagramTextHtml(read: DiagramRead): string {
  return read.sections
    .map((s) => `<p class="dgm-text-h">${escapeHtml(s.heading)}</p><ul>${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`)
    .join("");
}

export interface DiagramViewInput {
  /** The `src=` value as written. */
  ref: string;
  /** The JSON file's text. */
  text: string;
  /** What the loader made of the HTML sibling; absent when it never looked. */
  svg?: DiagramSvgResult;
  /** This block's id prefix, unique on the page (`dgm1-`). */
  prefix: string;
}

export type DiagramViewRenderer = (input: DiagramViewInput) => string;

/** The block's classes the reader adds; a peek strips all of them but the text. */
export const DIAGRAM_CHROME_CLASSES = ["dgm-views", "dgm-note", "dgm-svg", "dgm-foot", "dgm-missing"] as const;

const RO = READER_ONLY_ATTR;

/** The smallest label's font size the picture is drawn at, in CSS px. A 7 px
 *  archify label at 1:1 measured an 8 px text box; at 8.5 px it is ≥ 9 px. */
export const DIAGRAM_LABEL_MIN_PX = 8.5;
/** The most the floor grows a drawing past its viewBox width. archify's
 *  smallest label (7 px) needs 1.21 ×; 2 × reaches 8.5 px from 4.25 px labels,
 *  and past that a bigger drawing only adds scrolling. */
export const DIAGRAM_SCALE_CAP = 2;
/** A font size under this is no label (`font-size="0.01"` passes the
 *  sanitizer) and does not set the floor. */
export const DIAGRAM_FONT_IGNORE_BELOW_PX = 1;

/** One element's `font-size`: px or unitless reads as px; em, %, any other
 *  unit or keyword is `"unread"` (never guessed); absent is undefined. */
function fontSizeAttr(attrs: string): number | "unread" | undefined {
  const v = /\sfont-size="([^"]*)"/.exec(attrs)?.[1];
  if (v === undefined) return undefined;
  const m = /^\s*(\d*\.?\d+)(px)?\s*$/i.exec(v);
  return m ? Number(m[1]) : "unread";
}

/** The px size of every label that carries text (`<text>` with a non-space
 *  character in it), its own or inherited from an ancestor (`<g>`, the root).
 *  Walks the sanitizer's output, which is well-formed with double-quoted
 *  attributes and keeps no `<tspan>`. A label whose size is unread, or under
 *  {@link DIAGRAM_FONT_IGNORE_BELOW_PX}, is left out. */
export function diagramLabelSizes(svg: string): number[] {
  const out: number[] = [];
  const stack: { size: number | "unread" | undefined; label: boolean; text: boolean }[] = [];
  let at = 0;
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+="[^"]*")*)\s*(\/?)>/g)) {
    if (/\S/.test(svg.slice(at, m.index))) {
      const label = stack.findLast((o) => o.label);
      if (label) label.text = true;
    }
    at = m.index + m[0].length;
    if (m[1]) {
      const o = stack.pop();
      if (o?.label && o.text && typeof o.size === "number" && o.size >= DIAGRAM_FONT_IGNORE_BELOW_PX) out.push(o.size);
      continue;
    }
    const size = fontSizeAttr(m[3]!) ?? stack[stack.length - 1]?.size;
    if (!m[4]) stack.push({ size, label: m[2]!.toLowerCase() === "text", text: false });
  }
  return out;
}

/** The narrowest the drawing may render, in CSS px: the width at which its
 *  smallest label reaches {@link DIAGRAM_LABEL_MIN_PX}, capped at
 *  {@link DIAGRAM_SCALE_CAP} × `width`; 0 with no label to read. */
export function diagramFloorWidth(width: number, sizes: number[]): number {
  if (sizes.length === 0) return 0;
  return Math.ceil(width * Math.min(DIAGRAM_SCALE_CAP, DIAGRAM_LABEL_MIN_PX / Math.min(...sizes)));
}

/** An SVG number: sign, integer or decimal part, exponent. */
const SVG_NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
/** Comma-or-whitespace between two numbers. */
const SVG_SEP = String.raw`(?:\s*,\s*|\s+)`;
/** A root `viewBox` of exactly four numbers. */
const VIEWBOX = new RegExp(
  String.raw`\sviewBox="\s*(${SVG_NUMBER})${SVG_SEP}(${SVG_NUMBER})${SVG_SEP}(${SVG_NUMBER})${SVG_SEP}(${SVG_NUMBER})\s*"`,
  "i",
);

/** The root's size: `width`/`height` from the viewBox (replacing any it had)
 *  and the floor as `--dgm-floor`, when the viewBox is four SVG numbers with a
 *  finite, positive width and height; otherwise the root stays as written,
 *  with no floor. The CSS fills the column (`width: 100%`)
 *  with `min-width: var(--dgm-floor)`, so the drawing scrolls only in a column
 *  narrower than its floor. */
function drawnSize(svg: string): string {
  const open = /^<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const box = VIEWBOX.exec(open)?.slice(1).map(Number);
  if (!box || !box.every(Number.isFinite)) return svg;
  const [, , w, h] = box as [number, number, number, number];
  if (!(w > 0 && h > 0)) return svg;
  const rest = open.slice(4).replace(/\s(?:width|height|style)="[^"]*"/gi, "");
  const floor = diagramFloorWidth(w, diagramLabelSizes(svg));
  return `<svg width="${Math.round(w)}" height="${Math.round(h)}" style="--dgm-floor:${floor}px"${rest}${svg.slice(open.length)}`;
}

/** The html sibling is worth a link: it was read, whether or not it drew. */
const siblingRead = (svg: DiagramSvgResult | undefined) => !!svg && (svg.svg !== null || svg.problem !== "missing");

/** The reader's `<Diagram>`. */
export const diagramViewHtml: DiagramViewRenderer = (input) => {
  const flavor = diagramFlavor(input.ref);
  const read = flavor ? readDiagram(flavor, input.text) : null;
  const name = pageFileName(input.ref);
  if (!flavor || !read) {
    return `<figure class="dgm dgm-fallback"><p class="dgm-unavailable">${escapeHtml(`Diagram file not readable: ${name}`)}</p></figure>`;
  }
  const svg = input.svg?.svg ?? null;
  const html = diagramSiblingHtml(input.ref);
  const label = read.title || name;
  const views =
    svg && read.views.length
      ? `<div class="dgm-views" role="group" aria-label="Views" ${RO}>` +
        `<button type="button" class="dgm-view" data-dgm-view="" aria-pressed="true">All</button>` +
        read.views
          .map(
            (v) =>
              `<button type="button" class="dgm-view" data-dgm-view="${escapeHtml(v.id)}" data-dgm-focus="${escapeHtml(v.focus.join(" "))}" aria-pressed="false">${escapeHtml(v.label)}</button>`,
          )
          .join("") +
        `</div>` +
        read.views
          .filter((v) => v.note)
          .map((v) => `<p class="dgm-note" data-dgm-note="${escapeHtml(v.id)}" hidden ${RO}>${escapeHtml(v.note)}</p>`)
          .join("")
      : "";
  const picture = svg
    ? // One line: the web formatter turns a blank line into <br>, which ends the <svg> in an HTML parser.
      // No tab stop here: the client makes it a named, focusable region only while it scrolls (wiki-visuals.ts).
      `<div class="dgm-svg" data-dgm-label="${escapeHtml(`${label} (drawing)`)}" ${RO}>` +
      `${drawnSize(svg.replace(/\s*\n\s*/g, " ").replaceAll(DIAGRAM_ID_MARK, input.prefix))}</div>`
    : `<p class="dgm-missing" ${RO}>${escapeHtml(`Picture not shown: ${html ? pageFileName(html) : name}`)}</p>`;
  const foot = html && siblingRead(input.svg)
    ? `<figcaption class="dgm-foot" ${RO}><a class="dgm-open" data-dgm-html="${escapeHtml(html)}" target="_blank" rel="noopener" hidden>Open interactive ↗</a></figcaption>`
    : "";
  return (
    `<figure class="dgm dgm-${flavor}${svg ? " dgm-has-svg" : ""}" role="group" aria-label="${escapeHtml(label)}">` +
    views +
    picture +
    `<div class="dgm-text">${diagramTextHtml(read)}</div>` +
    foot +
    `</figure>`
  );
};

/** The reader's `<Diagram>` CSS: the archify class rules themed with reader
 *  tokens (`diagram-styles.ts`, generated), the view buttons, the dimming, and
 *  the text form visually hidden beside a drawn SVG (shown in a peek). Here, not
 *  in `component-styles.ts`, which the chat bundle carries. */
export function diagramCss(scope: string): string {
  const live = `${scope} .dgm:not(.wiki-ref-peek *)`;
  return `
    ${scope} .dgm {
      margin: 0.8rem 0 1rem; padding: 0.6rem 0.8rem; border-radius: 8px; max-width: 100%;
      box-sizing: border-box; background: var(--bg-panel); border: 1px solid var(--border-primary);
    }
    ${scope} .dgm-views { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.5rem; }
    ${scope} .dgm-view {
      font: inherit; font-size: 0.8em; padding: 0.15rem 0.6rem; cursor: pointer; border-radius: 6px;
      color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--text-muted);
    }
    ${scope} .dgm-view[aria-pressed="true"] { background: var(--accent-hover); border-color: var(--accent-hover); color: #fff; }
    ${scope} .dgm-view:focus-visible { outline: 2px solid var(--accent-light); outline-offset: 1px; }
    ${scope} .dgm-note { margin: 0 0 0.5rem; font-size: 0.85em; color: var(--text-soft); }
    ${scope} .dgm-note[hidden], ${scope} .dgm-open[hidden] { display: none; }
    /* The picture fills the column and never renders narrower than its floor
       (--dgm-floor, see drawnSize); past the column it scrolls in this box, a
       named tab stop only while it scrolls (wiki-visuals.ts). The scrollbar is
       styled so WebKit and Blink draw it always: an overlay scrollbar gives no
       sign that half the drawing is out of view. Firefox takes only the colours. */
    ${scope} .dgm-svg { overflow-x: auto; overflow-y: hidden; border-radius: 4px; }
    ${scope} .dgm-svg:focus-visible { outline: 2px solid var(--accent-light); outline-offset: 2px; }
    ${scope} .dgm-svg::-webkit-scrollbar { height: 10px; }
    ${scope} .dgm-svg::-webkit-scrollbar-track { background: var(--bg-surface); border-radius: 5px; }
    ${scope} .dgm-svg::-webkit-scrollbar-thumb { background: var(--text-muted); border-radius: 5px; }
    @supports not selector(::-webkit-scrollbar) {
      ${scope} .dgm-svg { scrollbar-color: var(--text-muted) var(--bg-surface); }
    }
    ${scope} .dgm-svg > svg { display: block; width: 100%; max-width: none; min-width: var(--dgm-floor, 0px); height: auto; }
    ${scope} .dgm-svg [data-node-id], ${scope} .dgm-svg [data-edge-from] { transition: opacity 0.2s; }
    ${scope} .dgm-svg .dgm-dim { opacity: 0.18; }
    ${scope} .dgm-text { font-size: 0.9em; }
    ${scope} .dgm-text-h { margin: 0.5rem 0 0.2rem; font-weight: 600; color: var(--text-primary); }
    ${scope} .dgm-text ul { margin: 0 0 0.3rem; }
    ${scope} .dgm-foot { margin-top: 0.4rem; font-size: 0.85em; }
    ${scope} .dgm-missing, ${scope} .dgm-unavailable { color: var(--text-soft); font-size: 0.9em; }
    @media screen {
      ${live}.dgm-has-svg > .dgm-text:not(:focus-within) {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
        clip-path: inset(50%); white-space: nowrap; border: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      ${scope} .dgm-svg [data-node-id], ${scope} .dgm-svg [data-edge-from] { transition: none; }
    }
    @media print {
      ${scope} .dgm-views, ${scope} .dgm-foot { display: none; }
      ${scope} .dgm-svg { overflow: visible; }
      ${scope} .dgm-svg > svg { min-width: 0; }
    }
    @media (forced-colors: active) {
      ${scope} .dgm-view[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
    }
    ${diagramClassStyles(`${scope} .dgm-svg`)}
  `;
}
