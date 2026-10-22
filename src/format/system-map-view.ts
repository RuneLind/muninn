/**
 * The wiki reader's `<SystemMap>` view: a server-drawn SVG over the edge table
 * `system-map.ts` reads. `renderWikiHtml` passes it to `formatWebHtml` as
 * `systemMapView`, so this module never ships in the chat bundle, and the
 * page runs no client code for it: no state, no toggles.
 *
 * The section keeps source order: the blocks before the table, the map, any
 * findings, the table as written, the blocks after it. The map and the
 * findings carry `READER_ONLY_ATTR`, so an Explain selection, a peek and every
 * other surface read the table. Columns are the node groups (D11); a node with
 * a page is an SVG link carrying `data-relpath`, which the reader's navigation
 * delegate opens like any wikilink. A `wrong` edge is dashed in the error tone
 * and its title names the reason; an unresolved node is drawn dashed with no
 * link.
 */

import { escapeHtml } from "./markdown-core.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { nodeKey, type SystemMapNode, type SystemMapRow, type SystemMapViewInput } from "./system-map.ts";

/** The chrome a peek drops (`PEEK_SYSTEM_MAP_CHROME` in wiki-ref-links.ts,
 *  pinned equal by a test). */
export const SYSTEM_MAP_CHROME_CLASSES = ["sm-map", "sm-notes"] as const;

const RO = `${READER_ONLY_ATTR}=""`;

/** Geometry, in SVG px. The SVG fills the column up to its own width and never
 *  shrinks below its legibility floor ({@link LABEL_MIN_PX}); a column
 *  narrower than the floor scrolls inside `.sm-map`. */
const COL_W = 150;
const GAP_X = 60;
const NODE_H = 34;
const GAP_Y = 14;
const HEAD_H = 30;
const PAD = 12;
/** Room right of the last column for a same-column edge's loop. */
const LOOP_W = 36;
/** Node labels are drawn at 12px and never scale below this. */
const LABEL_PX = 12;
const LABEL_MIN_PX = 9;
/** Longest node name drawn whole; a longer one is cut with `…` (the full name
 *  is in its title and the table). */
const NAME_MAX = 20;

interface Box {
  node: SystemMapNode;
  col: number;
  x: number;
  y: number;
}

function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Lay out the boxes: one column per group, nodes in first-appearance order. */
export function layoutSystemMap(nodes: readonly SystemMapNode[], columns: readonly string[]): { boxes: Map<string, Box>; width: number; height: number } {
  const boxes = new Map<string, Box>();
  const perCol = columns.map(() => 0);
  for (const node of nodes) {
    const col = Math.max(0, columns.indexOf(node.group));
    const k = perCol[col]!++;
    boxes.set(node.key, { node, col, x: PAD + col * (COL_W + GAP_X), y: PAD + HEAD_H + k * (NODE_H + GAP_Y) });
  }
  const rows = Math.max(1, ...perCol);
  return {
    boxes,
    width: PAD * 2 + columns.length * COL_W + (columns.length - 1) * GAP_X + LOOP_W,
    height: PAD * 2 + HEAD_H + rows * NODE_H + (rows - 1) * GAP_Y,
  };
}

/** One edge's path: across columns from the facing sides, within a column as
 *  a loop out to the right. Several rows between one pair are fanned apart. */
export function edgePath(a: Box, b: Box, fan: number): string {
  const ay = a.y + NODE_H / 2 + fan;
  const by = b.y + NODE_H / 2 + fan;
  if (a.col === b.col) {
    const x = a.x + COL_W;
    const out = x + 28 + Math.abs(fan);
    return `M${x} ${ay} C${out} ${ay} ${out} ${by} ${x} ${by}`;
  }
  const forward = b.col > a.col;
  const x1 = forward ? a.x + COL_W : a.x;
  const x2 = forward ? b.x : b.x + COL_W;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${ay} C${mid} ${ay} ${mid} ${by} ${x2} ${by}`;
}

function edgeTitle(r: SystemMapRow): string {
  const parts = [`${r.from} → ${r.to}`];
  if (r.protocol) parts.push(r.protocol);
  parts.push(r.status ?? (r.statusRaw ? `status ${r.statusRaw}` : "no status"));
  if (r.evidence) parts.push(r.evidence);
  return parts.join(" · ");
}

export function systemMapViewHtml(input: SystemMapViewInput): string {
  const { read, prefix } = input;
  const label = input.caption ? `System map: ${input.caption}` : "System map";
  const notes = read.findings.length
    ? `<ul class="sm-notes" ${RO}>${read.findings.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}</ul>`
    : "";
  if (!read.drawable) {
    return `<section class="sm sm-fallback">${input.beforeHtml}${notes}${input.tableHtml}${input.afterHtml}</section>`;
  }
  const { boxes, width, height } = layoutSystemMap(read.nodes, read.columns);
  const heads = read.columns
    .map((c, i) => `<text class="sm-col" x="${PAD + i * (COL_W + GAP_X) + COL_W / 2}" y="${PAD + 16}" text-anchor="middle">${escapeHtml(c)}</text>`)
    .join("");

  // Rows between one unordered pair are fanned 6px apart so none hides another.
  const pairCount = new Map<string, number>();
  const edges = read.rows
    .map((r) => {
      const a = boxes.get(nodeKey(r.from));
      const b = boxes.get(nodeKey(r.to));
      if (!a || !b) return "";
      const pair = [a.node.key, b.node.key].sort().join("\u0000");
      const n = pairCount.get(pair) ?? 0;
      pairCount.set(pair, n + 1);
      const fan = n === 0 ? 0 : (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * 6;
      const tone = r.status === "wrong" ? "sm-wrong" : r.status === "ok" ? "sm-ok" : "sm-none";
      const marker = r.status === "wrong" ? "wrong" : "ok";
      const d = a === b ? selfLoop(a, fan) : edgePath(a, b, fan);
      return `<path class="sm-edge ${tone}" d="${d}" marker-end="url(#${prefix}arr-${marker})" data-sm-from="${escapeHtml(a.node.key)}" data-sm-to="${escapeHtml(b.node.key)}"><title>${escapeHtml(edgeTitle(r))}</title></path>`;
    })
    .join("");

  const nodes = read.nodes
    .map((node) => {
      const box = boxes.get(node.key)!;
      const { kind, link } = input.resolveNode(node);
      const cls = `sm-node sm-${kind}`;
      const what = kind === "unresolved" ? " — names no repos/ page" : kind === "external" ? " — external" : "";
      const shape =
        `<rect x="${box.x}" y="${box.y}" width="${COL_W}" height="${NODE_H}" rx="6"/>` +
        `<text x="${box.x + COL_W / 2}" y="${box.y + NODE_H / 2}" text-anchor="middle" dominant-baseline="central">${escapeHtml(cut(node.label, NAME_MAX))}</text>`;
      const title = `<title>${escapeHtml(node.label + what)}</title>`;
      if (!link) return `<g class="${cls}" data-sm-node="${escapeHtml(node.key)}">${title}${shape}</g>`;
      return (
        `<a class="${cls}" href="${escapeHtml(link.href)}" data-relpath="${escapeHtml(link.relPath)}" data-wiki-page="${escapeHtml(link.name)}" ` +
        `data-sm-node="${escapeHtml(node.key)}" aria-label="${escapeHtml(node.label + what)}">${title}${shape}</a>`
      );
    })
    .join("");

  const markers =
    `<defs>` +
    ["ok", "wrong"]
      .map((m) => `<marker id="${prefix}arr-${m}" class="sm-arrow sm-arrow-${m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker>`)
      .join("") +
    `</defs>`;
  const svg =
    `<svg class="sm-svg" viewBox="0 0 ${width} ${height}" style="max-width:${width}px;min-width:${Math.ceil((width * LABEL_MIN_PX) / LABEL_PX)}px" aria-label="${escapeHtml(label)}">` +
    `<title>${escapeHtml(label)}</title>${markers}${heads}<g class="sm-edges">${edges}</g><g class="sm-nodes">${nodes}</g></svg>`;
  const map = `<div class="sm-map" ${RO} role="region" tabindex="0" aria-label="${escapeHtml(label)}">${svg}</div>`;
  return `<section class="sm" role="figure" aria-label="${escapeHtml(label)}">${input.beforeHtml}${map}${notes}${input.tableHtml}${input.afterHtml}</section>`;
}

function selfLoop(a: Box, fan: number): string {
  const x = a.x + COL_W;
  const y = a.y + NODE_H / 2;
  const out = x + 30 + Math.abs(fan);
  return `M${x} ${y - 8} C${out} ${y - 24} ${out} ${y + 24} ${x} ${y + 8}`;
}

/** Reader CSS. Theme tokens only, so both themes follow the page. */
export function systemMapCss(scope: string): string {
  return `
    ${scope} section.sm { margin: 1rem 0; }
    ${scope} .sm-map { overflow-x: auto; margin: 0 0 0.75rem; border: 1px solid var(--border-primary); border-radius: 8px; background: var(--bg-panel); }
    ${scope} .sm-map:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    ${scope} .sm-svg { display: block; width: 100%; height: auto; font-family: inherit; }
    ${scope} .sm-col { fill: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    ${scope} .sm-node rect { fill: var(--bg-surface); stroke: var(--border-primary); stroke-width: 1.5; }
    ${scope} .sm-node text { fill: var(--text-primary); font-size: 12px; }
    ${scope} a.sm-node { cursor: pointer; }
    ${scope} a.sm-node:hover rect, ${scope} a.sm-node:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
    ${scope} a.sm-node:focus { outline: none; }
    ${scope} .sm-external rect { fill: var(--bg-panel); stroke: var(--text-soft); stroke-dasharray: 2 3; }
    ${scope} .sm-unresolved rect { stroke: var(--tone-err); stroke-dasharray: 5 3; }
    ${scope} .sm-edge { fill: none; stroke-width: 1.6; }
    ${scope} .sm-ok, ${scope} .sm-none { stroke: var(--text-secondary); }
    ${scope} .sm-none { stroke-dasharray: 1 3; }
    ${scope} .sm-wrong { stroke: var(--tone-err); stroke-dasharray: 6 4; stroke-width: 2; }
    ${scope} .sm-arrow-ok path { fill: var(--text-secondary); }
    ${scope} .sm-arrow-wrong path { fill: var(--tone-err); }
    ${scope} .sm-notes { margin: 0 0 0.75rem; padding-left: 1.2rem; color: var(--text-soft); font-size: 0.9em; }
    @media print { ${scope} .sm-map { overflow: visible; border: none; } }
    @media (forced-colors: active) {
      ${scope} .sm-node rect { fill: Canvas; stroke: CanvasText; }
      ${scope} .sm-node text, ${scope} .sm-col { fill: CanvasText; }
      ${scope} .sm-edge { stroke: CanvasText; }
      ${scope} .sm-arrow-ok path, ${scope} .sm-arrow-wrong path { fill: CanvasText; }
    }
  `;
}
