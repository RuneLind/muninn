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

/** Nodes grouped by `key`, groups in `order` first, each group by `col`. */
function grouped(nodes: Obj[], key: string, labels: Map<string, string>, order: string[]): DiagramTextSection[] {
  const groups = new Map<string, Obj[]>();
  for (const id of order) groups.set(id, []);
  for (const n of nodes) {
    const g = str(n[key]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(n);
  }
  return [...groups]
    .filter(([, ns]) => ns.length > 0)
    .map(([g, ns]) => ({
      heading: labels.get(g) || g || "Other",
      lines: [...ns].sort((a, b) => num(a.col) - num(b.col)).map(nodeText),
    }));
}

/** The lifecycle's main rail: the edges between the main lane's states in
 *  `col` order. The main lane is the lane `main`, else the first lane. */
export function lifecycleRail(doc: Obj): string[] {
  const lanes = objs(doc.lanes);
  const main = lanes.some((l) => str(l.id) === "main") ? "main" : str(lanes[0]?.id);
  const states = objs(doc.states);
  const names = nameMap(states);
  const rail = states.filter((s) => str(s.lane) === main).sort((a, b) => num(a.col) - num(b.col));
  const out: string[] = [];
  for (let i = 1; i < rail.length; i++) {
    out.push(edgeLine({ from: rail[i - 1]!.id, to: rail[i]!.id }, names));
  }
  return out;
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

function architectureSections(doc: Obj): DiagramTextSection[] {
  const comps = objs(doc.components);
  const names = nameMap(comps);
  const sections = grouped(comps, "type", new Map(), []);
  for (const b of objs(doc.boundaries)) {
    const wraps = Array.isArray(b.wraps) ? b.wraps.map(str).filter(Boolean) : [];
    if (wraps.length === 0) continue;
    sections.push({ heading: `Inside ${str(b.label) || str(b.kind) || "boundary"}`, lines: wraps.map((id) => names.get(id) ?? id) });
  }
  const edges = objs(doc.connections);
  if (edges.length) sections.push({ heading: "Connections", lines: edges.map((e) => edgeLine(e, names)) });
  return sections;
}

function laneLabels(doc: Obj): { order: string[]; labels: Map<string, string> } {
  const lanes = objs(doc.lanes);
  return { order: lanes.map((l) => str(l.id)), labels: new Map(lanes.map((l) => [str(l.id), str(l.label) || str(l.id)])) };
}

function workflowSections(doc: Obj): DiagramTextSection[] {
  const nodes = objs(doc.nodes);
  const { order, labels } = laneLabels(doc);
  const sections = grouped(nodes, "lane", labels, order);
  const edges = objs(doc.edges);
  if (edges.length) sections.push({ heading: "Steps", lines: edges.map((e) => edgeLine(e, nameMap(nodes))) });
  return sections;
}

function lifecycleSections(doc: Obj): DiagramTextSection[] {
  const states = objs(doc.states);
  const { order, labels } = laneLabels(doc);
  const sections = grouped(states, "lane", labels, order);
  const rail = lifecycleRail(doc);
  if (rail.length) sections.push({ heading: "Main path", lines: rail });
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

/** The picture's drawn size: `width`/`height` from its viewBox, scaled up (never
 *  down) until its smallest `font-size` reaches {@link DIAGRAM_LABEL_MIN_PX}.
 *  Shrunk to the prose column instead, a 1160-wide map drew labels 4 px tall. */
function drawnSize(svg: string): string {
  const open = /^<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const box = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(open);
  const [w, h] = [Number(box?.[1]), Number(box?.[2])];
  if (!(w > 0 && h > 0)) return svg;
  const sizes = [...svg.matchAll(/<(?:text|tspan)\b[^>]*\sfont-size="([\d.]+)"/gi)].map((m) => Number(m[1])).filter((n) => n > 0);
  const k = sizes.length ? Math.max(1, DIAGRAM_LABEL_MIN_PX / Math.min(...sizes)) : 1;
  return `<svg width="${Math.round(w * k)}" height="${Math.round(h * k)}"` + svg.slice(4);
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
      `<div class="dgm-svg" role="region" aria-label="${escapeHtml(`${label} (drawing)`)}" tabindex="0" ${RO}>` +
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
    /* The picture keeps its natural size (width/height from the viewBox, see
       drawnSize) and fills a wider column; past the column it scrolls in this
       named region, whose scrollbar is styled so it is always drawn: an overlay
       scrollbar gives no sign that half the drawing is out of view. */
    ${scope} .dgm-svg { overflow-x: auto; overflow-y: hidden; border-radius: 4px; }
    ${scope} .dgm-svg:focus-visible { outline: 2px solid var(--accent-light); outline-offset: 2px; }
    ${scope} .dgm-svg::-webkit-scrollbar { height: 10px; }
    ${scope} .dgm-svg::-webkit-scrollbar-track { background: var(--bg-surface); border-radius: 5px; }
    ${scope} .dgm-svg::-webkit-scrollbar-thumb { background: var(--text-muted); border-radius: 5px; }
    @supports not selector(::-webkit-scrollbar) {
      ${scope} .dgm-svg { scrollbar-color: var(--text-muted) var(--bg-surface); }
    }
    ${scope} .dgm-svg > svg { display: block; max-width: none; min-width: 100%; height: auto; }
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
      ${scope} .dgm-svg > svg { width: 100%; min-width: 0; }
    }
    @media (forced-colors: active) {
      ${scope} .dgm-view[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
    }
    ${diagramClassStyles(`${scope} .dgm-svg`)}
  `;
}
