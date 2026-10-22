/**
 * The wiki reader's `<SystemMap>` view: a server-drawn SVG over the edge table
 * `system-map.ts` reads. `renderWikiHtml` passes it to `formatWebHtml` as
 * `systemMapView`, so this module never ships in the chat bundle, and the
 * page runs no client code for it: no state, no toggles.
 *
 * The section keeps source order: the blocks before the table, the map, any
 * findings, the table as written, the blocks after it; the map is the caption,
 * the drawing, a legend of the styles it draws and a node list by column (the
 * text form of what the table does not say: each node's group and kind). All
 * of it carries `READER_ONLY_ATTR`, so an Explain selection, a peek and every
 * other surface read the table. Columns are the node groups (D11); a node with
 * a page is an SVG link carrying `data-relpath`, which the reader's navigation
 * delegate opens like any wikilink. A `wrong` edge is dashed in the error tone
 * and its title names the reason.
 */

import { escapeHtml } from "./markdown-core.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { nodeKey, type SystemMapNode, type SystemMapRow, type SystemMapViewInput } from "./system-map.ts";

/** The chrome a peek drops (`PEEK_SYSTEM_MAP_CHROME` in wiki-ref-links.ts,
 *  pinned equal by a test). */
export const SYSTEM_MAP_CHROME_CLASSES = ["sm-caption", "sm-map", "sm-legend", "sm-list", "sm-notes"] as const;

const RO = `${READER_ONLY_ATTR}=""`;

/** Geometry, in SVG px. The SVG fills the column up to its own width and never
 *  shrinks below its legibility floor ({@link LABEL_MIN_PX} for the smallest
 *  font drawn); a column narrower than the floor scrolls inside `.sm-map`. */
const COL_MIN = 150;
/** A column grows to its longest label up to here; a longer one is cut. */
const COL_MAX = 240;
const NODE_PAD_X = 10;
const GAP_X = 60;
const NODE_H = 34;
const GAP_Y = 14;
const HEAD_H = 30;
const PAD = 12;
/** Room right of the last column for a same-column edge's loop, and left of
 *  the first column when a self-loop is drawn on that side. */
const LOOP_W = 36;
/** How far a loop reaches out from its side (the curve's widest point). The
 *  nearest trunk lane sits 24px from a side, so every loop stays short of it:
 *  a self-loop reaches 15px, the edges within one column 12, 15, 18 or 21px. */
const SELF_REACH = 15;
const WITHIN_REACH = [12, 15, 18, 21];
/** Node labels are 12px, column heads 11px; neither scales below 9px. */
const LABEL_PX = 12;
const HEAD_PX = 11;
const LABEL_MIN_PX = 9;
/** Corner radius of a routed edge. */
const CORNER = 6;

interface Box {
  node: SystemMapNode;
  col: number;
  x: number;
  y: number;
}

/**
 * A text's drawn width in px, estimated per character class (em widths of a
 * system UI sans, rounded up), so a label is cut only when it would not fit.
 */
export function textWidthPx(s: string, px: number, letterSpacingEm = 0): number {
  let em = 0;
  for (const ch of s) {
    if (ch === " " || "il.,:;'|!jI".includes(ch)) em += 0.3;
    else if ("frt()[]/-".includes(ch)) em += 0.4;
    else if ("WM".includes(ch)) em += 0.98;
    else if ("mw@%ÆæŒœ".includes(ch)) em += 0.88;
    else if (/[A-ZÅØÄÖ]/.test(ch)) em += 0.72;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else if (/[a-zåøäöé]/.test(ch)) em += 0.58;
    else em += 0.7;
    em += letterSpacingEm;
  }
  return em * px;
}

/** `s` whole when it fits `maxPx`, else cut with `…` to fit. */
function fitText(s: string, maxPx: number, width: (t: string) => number): string {
  if (width(s) <= maxPx) return s;
  const chars = Array.from(s);
  while (chars.length > 1 && width(`${chars.join("")}…`) > maxPx) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

const labelWidth = (t: string) => textWidthPx(t, LABEL_PX);
/** Column heads are uppercase, semibold (≈ +6%) and spaced 0.04em. */
const headWidth = (t: string) => textWidthPx(t.toUpperCase(), HEAD_PX, 0.04) * 1.06;

/** Spacing of the vertical lanes in a gap between two columns. */
const LANE_STEP = 5;
/** Row-gap lanes: five positions, 2.5px apart, inside the 14px gap. */
const CHANNEL_STEP = 2.5;
const CHANNEL_SLOTS = 5;

interface Layout {
  boxes: Map<string, Box>;
  width: number;
  height: number;
  colW: number;
  /** Left edge of each column. */
  colX: number[];
  /** Width of the gap after each column. */
  gapW: number[];
  rows: number;
}

/**
 * One edge that spans more than one column, as its two vertical lanes see it:
 * a trunk per source in the gap it leaves by, a trunk per target in the gap
 * it arrives by, so edges sharing an end share a line and every lane in a gap
 * belongs to one node.
 */
function spanLanes(a: { key: string; col: number }, b: { key: string; col: number }): { g1: number; k1: string; g2: number; k2: string } {
  const forward = b.col > a.col;
  return { g1: forward ? a.col : a.col - 1, k1: `s:${a.key}`, g2: forward ? b.col - 1 : b.col, k2: `t:${b.key}` };
}

/** Each gap's lanes, in first-use order, sources before targets. */
function gapLanes(rows: readonly SystemMapRow[], colOf: Map<string, number>, gaps: number): string[][] {
  const lanes = Array.from({ length: gaps }, () => [] as string[]);
  for (const pass of ["s", "t"] as const) {
    for (const r of rows) {
      const a = { key: nodeKey(r.from), col: colOf.get(nodeKey(r.from)) };
      const b = { key: nodeKey(r.to), col: colOf.get(nodeKey(r.to)) };
      if (a.col === undefined || b.col === undefined || Math.abs(a.col - b.col) < 2) continue;
      const l = spanLanes(a as { key: string; col: number }, b as { key: string; col: number });
      const [g, k] = pass === "s" ? [l.g1, l.k1] : [l.g2, l.k2];
      if (!lanes[g]!.includes(k)) lanes[g]!.push(k);
    }
  }
  return lanes;
}

/** Lay out the boxes: one column per group, nodes in first-appearance order,
 *  every column as wide as the longest label or head (within the bounds),
 *  every gap wide enough for the lanes `rows` route through it. */
export function layoutSystemMap(nodes: readonly SystemMapNode[], columns: readonly string[], rows: readonly SystemMapRow[] = []): Layout {
  const widest = Math.max(0, ...nodes.map((n) => labelWidth(n.label)), ...columns.map(headWidth));
  const colW = Math.min(COL_MAX, Math.max(COL_MIN, Math.ceil(widest + 2 * NODE_PAD_X)));
  const colOf = new Map(nodes.map((n) => [n.key, Math.max(0, columns.indexOf(n.group))]));
  const gapW = gapLanes(rows, colOf, Math.max(0, columns.length - 1)).map((l) => Math.max(GAP_X, 2 * 24 + (l.length - 1) * LANE_STEP));
  const left = rows.some((r) => selfLoopSide(r, rows, colOf) === "L" && colOf.get(nodeKey(r.from)) === 0) ? LOOP_W : PAD;
  const colX = columns.map((_, i) => left + i * colW + gapW.slice(0, i).reduce((x, g) => x + g, 0));
  const boxes = new Map<string, Box>();
  const perCol = columns.map(() => 0);
  for (const node of nodes) {
    const col = colOf.get(node.key)!;
    const k = perCol[col]!++;
    boxes.set(node.key, { node, col, x: colX[col]!, y: PAD + HEAD_H + k * (NODE_H + GAP_Y) });
  }
  const rowCount = Math.max(1, ...perCol);
  return {
    boxes,
    colW,
    colX,
    gapW,
    rows: rowCount,
    width: left + PAD + columns.length * colW + gapW.reduce((x, g) => x + g, 0) + LOOP_W,
    // One gap more than the rows need: the lane under the last row.
    height: PAD * 2 + HEAD_H + rowCount * (NODE_H + GAP_Y),
  };
}

/** An orthogonal polyline with rounded corners. */
function roundedPath(pts: readonly [number, number][]): string {
  const f = (n: number) => String(Math.round(n * 10) / 10);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    if (!inLen || !outLen) continue;
    const r = Math.min(CORNER, inLen / 2, outLen / 2);
    d += ` L${f(x - ((x - px) / inLen) * r)} ${f(y - ((y - py) / inLen) * r)} Q${f(x)} ${f(y)} ${f(x + ((nx - x) / outLen) * r)} ${f(y + ((ny - y) / outLen) * r)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${f(last[0])} ${f(last[1])}`;
}

/**
 * The side a self-loop takes: the one with fewer of the node's other edges,
 * the right on a tie. Null for a row that is not a self-loop.
 */
function selfLoopSide(row: SystemMapRow, rows: readonly SystemMapRow[], colOf: Map<string, number>): "L" | "R" | null {
  const key = nodeKey(row.from);
  const col = colOf.get(key);
  if (key !== nodeKey(row.to) || col === undefined) return null;
  let l = 0;
  let r = 0;
  for (const o of rows) {
    const [f, t] = [nodeKey(o.from), nodeKey(o.to)];
    if (f === t || (f !== key && t !== key)) continue;
    const other = colOf.get(f === key ? t : f);
    if (other === undefined) continue;
    if (other >= col) r++;
    else l++;
  }
  return l < r ? "L" : "R";
}

interface RoutedEdge {
  row: SystemMapRow;
  a: Box;
  b: Box;
  d: string;
}

/**
 * Route every edge. A node's edges leave each side at their own point, spread
 * over the side in the order of the other end's height. An edge between
 * adjacent columns is a curve across the gap between them. One that spans
 * more columns runs down its source's trunk in the gap it leaves by, across
 * the intermediate columns in a row gap near the straight line (never under a
 * box), and up or down its target's trunk into the target. Within a column an
 * edge loops out right, short of the trunk lanes; a self-loop leaves and
 * re-enters its side at two points of its own, between the edges to higher
 * and to lower nodes, so it meets none of them.
 */
export function routeSystemMapEdges(rows: readonly SystemMapRow[], layout: Layout): RoutedEdge[] {
  const { boxes, colW, colX, gapW } = layout;
  const items = rows.flatMap((row) => {
    const a = boxes.get(nodeKey(row.from));
    const b = boxes.get(nodeKey(row.to));
    return a && b ? [{ row, a, b }] : [];
  });
  const centre = (x: Box) => x.y + NODE_H / 2;
  // "key|L" / "key|R" → the edges attached on that side.
  const sideOf = (i: number, end: "a" | "b"): string => {
    const { a, b } = items[i]!;
    const [me, other] = end === "a" ? [a, b] : [b, a];
    return `${me.node.key}|${other.col >= me.col ? "R" : "L"}`;
  };
  const colOf = new Map([...boxes.values()].map((b) => [b.node.key, b.col]));
  // A self-loop's two ends sort as a level edge would, so they sit together.
  const sides = new Map<string, { id: string; i: number; otherY: number }[]>();
  const attach = (k: string, id: string, i: number, otherY: number) => sides.set(k, [...(sides.get(k) ?? []), { id, i, otherY }]);
  items.forEach((e, i) => {
    if (e.a === e.b) {
      const k = `${e.a.node.key}|${selfLoopSide(e.row, rows, colOf)}`;
      for (const end of ["a", "b"]) attach(k, `${k}#${i}${end}`, i, centre(e.a));
      return;
    }
    for (const end of ["a", "b"] as const) {
      const k = sideOf(i, end);
      attach(k, `${k}#${i}`, i, centre(end === "a" ? e.b : e.a));
    }
  });
  const slotY = new Map<string, number>();
  for (const [k, list] of sides) {
    const box = boxes.get(k.slice(0, k.lastIndexOf("|")))!;
    const sorted = [...list].sort((p, q) => p.otherY - q.otherY || p.i - q.i || (p.id < q.id ? -1 : 1));
    sorted.forEach(({ id }, n) => slotY.set(id, box.y + (NODE_H * (n + 1)) / (sorted.length + 1)));
  }
  const yAt = (i: number, end: "a" | "b") => slotY.get(`${sideOf(i, end)}#${i}`)!;
  // Edges within one column, shortest first, take the reaches inside out.
  const reach = new Map<number, number>();
  const within = items.flatMap((e, i) => (e.a !== e.b && e.a.col === e.b.col ? [{ i, col: e.a.col, span: Math.abs(yAt(i, "a") - yAt(i, "b")) }] : []));
  for (const col of new Set(within.map((w) => w.col))) {
    within
      .filter((w) => w.col === col)
      .sort((p, q) => p.span - q.span || p.i - q.i)
      .forEach((w, n) => reach.set(w.i, WITHIN_REACH[n % WITHIN_REACH.length]!));
  }
  const lanes = gapLanes(rows, colOf, gapW.length);
  const laneX = (g: number, key: string) => {
    const l = lanes[g]!;
    return colX[g]! + colW + gapW[g]! / 2 + (l.indexOf(key) - (l.length - 1) / 2) * LANE_STEP;
  };
  const gapY = (k: number) => PAD + HEAD_H + (k + 1) * (NODE_H + GAP_Y) - GAP_Y / 2;
  const channelUse = new Map<number, number>();
  // A cubic bulge out from a side; its widest point is 3/4 of the control offset.
  const bulge = (x: number, y1: number, y2: number, out: number) => {
    const c = Math.round(x + (out * 4) / 3);
    return `M${x} ${y1} C${c} ${y1} ${c} ${y2} ${x} ${y2}`;
  };

  return items.map((e, i) => {
    const { a, b, row } = e;
    if (a === b) {
      const k = `${a.node.key}|${selfLoopSide(row, rows, colOf)}`;
      const right = k.endsWith("|R");
      return { row, a, b, d: bulge(right ? a.x + colW : a.x, slotY.get(`${k}#${i}a`)!, slotY.get(`${k}#${i}b`)!, right ? SELF_REACH : -SELF_REACH) };
    }
    const ay = yAt(i, "a");
    const by = yAt(i, "b");
    if (a.col === b.col) return { row, a, b, d: bulge(a.x + colW, ay, by, reach.get(i)!) };
    const forward = b.col > a.col;
    const x1 = forward ? a.x + colW : a.x;
    const x2 = forward ? b.x : b.x + colW;
    if (Math.abs(b.col - a.col) === 1) {
      const mid = (x1 + x2) / 2;
      return { row, a, b, d: `M${x1} ${ay} C${mid} ${ay} ${mid} ${by} ${x2} ${by}` };
    }
    const l = spanLanes({ key: a.node.key, col: a.col }, { key: b.node.key, col: b.col });
    const t1 = laneX(l.g1, l.k1);
    const t2 = laneX(l.g2, l.k2);
    // The row gap nearest the straight line that still has a free position.
    const want = (ay + by) / 2;
    const gaps = Array.from({ length: layout.rows }, (_, k) => k).sort((p, q) => Math.abs(gapY(p) - want) - Math.abs(gapY(q) - want) || p - q);
    const k = gaps.find((g) => (channelUse.get(g) ?? 0) < CHANNEL_SLOTS) ?? gaps[0]!;
    const n = channelUse.get(k) ?? 0;
    channelUse.set(k, n + 1);
    const slot = n % CHANNEL_SLOTS;
    const cy = gapY(k) + (slot % 2 === 1 ? 1 : -1) * Math.ceil(slot / 2) * CHANNEL_STEP;
    return { row, a, b, d: roundedPath([[x1, ay], [t1, ay], [t1, cy], [t2, cy], [t2, by], [x2, by]]) };
  });
}

/** A node's drawn kind: its class, its words in a name, its legend entry. */
const KINDS = {
  repo: { cls: "sm-repo", says: "repo, opens its page", legend: "Repo, opens its page" },
  external: { cls: "sm-external", says: "external, opens its page", legend: "External, opens its page" },
  nopage: { cls: "sm-external sm-nopage", says: "external, no page", legend: "External, no page" },
  unresolved: { cls: "sm-unresolved", says: "names no repos/ page", legend: "Names no repos/ page" },
} as const;
const EDGE_LEGEND = [
  ["sm-ok", "Edge: ok"],
  ["sm-wrong", "Edge: wrong"],
  ["sm-none", "Edge: no status"],
] as const;

const swatch = (inner: string) => `<svg class="sm-swatch" viewBox="0 0 24 14" aria-hidden="true" focusable="false">${inner}</svg>`;

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
  const figure = (cls: string) => `<section class="${cls}" role="figure" aria-label="${escapeHtml(label)}">`;
  const notes = read.findings.length
    ? `<ul class="sm-notes" ${RO}>${read.findings.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}</ul>`
    : "";
  if (!read.drawable) {
    return `${figure("sm sm-fallback")}${input.beforeHtml}${notes}${input.tableHtml}${input.afterHtml}</section>`;
  }
  const layout = layoutSystemMap(read.nodes, read.columns, read.rows);
  const { boxes, width, height, colW, colX } = layout;
  const heads = read.columns
    .map((c, i) => {
      const shown = fitText(c, colW, headWidth);
      const title = shown === c ? "" : `<title>${escapeHtml(c)}</title>`;
      return `<text class="sm-col" x="${colX[i]! + colW / 2}" y="${PAD + 16}" text-anchor="middle">${title}${escapeHtml(shown)}</text>`;
    })
    .join("");

  const tones = new Set<string>();
  const edges = routeSystemMapEdges(read.rows, layout)
    .map(({ row: r, a, b, d }) => {
      const tone = r.status === "wrong" ? "sm-wrong" : r.status === "ok" ? "sm-ok" : "sm-none";
      tones.add(tone);
      const marker = r.status === "wrong" ? "wrong" : "ok";
      return `<path class="sm-edge ${tone}" d="${d}" marker-end="url(#${prefix}arr-${marker})" data-sm-from="${escapeHtml(a.node.key)}" data-sm-to="${escapeHtml(b.node.key)}"><title>${escapeHtml(edgeTitle(r))}</title></path>`;
    })
    .join("");

  const kindOf = new Map(
    read.nodes.map((node) => {
      const { kind, link } = input.resolveNode(node);
      return [node.key, { kind: kind === "external" && !link ? ("nopage" as const) : kind, link }];
    }),
  );
  const nodes = read.nodes
    .map((node) => {
      const box = boxes.get(node.key)!;
      const { kind, link } = kindOf.get(node.key)!;
      const cls = `sm-node ${KINDS[kind].cls}`;
      const what = ` — ${KINDS[kind].says}`;
      const shape =
        `<rect x="${box.x}" y="${box.y}" width="${colW}" height="${NODE_H}" rx="6"/>` +
        `<text x="${box.x + colW / 2}" y="${box.y + NODE_H / 2}" text-anchor="middle" dominant-baseline="central">${escapeHtml(fitText(node.label, colW - 2 * NODE_PAD_X, labelWidth))}</text>`;
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
  // The figure carries the name; the scroll box (a tab stop) says what it
  // holds; the SVG is an unnamed group (not an unlabelled image), so no name is
  // announced twice.
  const svg =
    `<svg class="sm-svg" role="group" viewBox="0 0 ${width} ${height}" style="max-width:${width}px;min-width:${Math.ceil((width * LABEL_MIN_PX) / Math.min(LABEL_PX, HEAD_PX))}px">` +
    `${markers}${heads}<g class="sm-edges">${edges}</g><g class="sm-nodes">${nodes}</g></svg>`;
  const caption = input.caption ? `<div class="sm-caption" ${RO}>${escapeHtml(input.caption)}</div>` : "";
  const map = `<div class="sm-map" ${RO} role="region" tabindex="0" aria-label="Map drawing">${svg}</div>`;
  const present = new Set([...kindOf.values()].map((k) => k.kind));
  const legend =
    `<ul class="sm-legend" ${RO}>` +
    (Object.keys(KINDS) as (keyof typeof KINDS)[])
      .filter((k) => present.has(k))
      .map((k) => `<li>${swatch(`<g class="sm-key-box ${KINDS[k].cls}"><rect x="1" y="1" width="22" height="12" rx="3"/></g>`)}${KINDS[k].legend}</li>`)
      .join("") +
    EDGE_LEGEND.filter(([t]) => tones.has(t))
      .map(([t, words]) => `<li>${swatch(`<path class="sm-key-line ${t}" d="M1 7 L23 7"/>`)}${words}</li>`)
      .join("") +
    `</ul>`;
  const list =
    `<details class="sm-list" ${RO}><summary>Systems by column</summary><ul>` +
    read.columns
      .map((c) => {
        const inCol = read.nodes.filter((n) => boxes.get(n.key)!.col === read.columns.indexOf(c));
        return `<li>${escapeHtml(c)}<ul>${inCol.map((n) => `<li>${escapeHtml(n.label)} — ${KINDS[kindOf.get(n.key)!.kind].says}</li>`).join("")}</ul></li>`;
      })
      .join("") +
    `</ul></details>`;
  return `${figure("sm")}${input.beforeHtml}${caption}${map}${legend}${list}${notes}${input.tableHtml}${input.afterHtml}</section>`;
}

/** Reader CSS. Theme tokens only, so both themes follow the page. */
export function systemMapCss(scope: string): string {
  return `
    ${scope} section.sm { margin: 1rem 0; }
    ${scope} .sm-map { overflow-x: auto; margin: 0 0 0.75rem; border: 1px solid var(--border-primary); border-radius: 8px; background: var(--bg-panel); }
    ${scope} .sm-caption { font-weight: 600; color: var(--text-primary); margin: 0 0 0.4rem; }
    ${scope} .sm-map:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    ${scope} .sm-svg { display: block; width: 100%; height: auto; font-family: inherit; }
    ${scope} .sm-col { fill: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    ${scope} .sm-node rect, ${scope} .sm-key-box rect { fill: var(--bg-surface); stroke: var(--border-primary); stroke-width: 1.5; }
    ${scope} .sm-node text { fill: var(--text-primary); font-size: 12px; }
    ${scope} a.sm-node { cursor: pointer; }
    ${scope} a.sm-node:hover rect { stroke: var(--accent); stroke-width: 2; }
    /* Focus is a thick solid ring in the text colour: unlike hover in colour, width and dash. */
    ${scope} a.sm-node:focus-visible rect { stroke: var(--text-primary); stroke-width: 3.5; stroke-dasharray: none; }
    ${scope} a.sm-node:focus { outline: none; }
    ${scope} .sm-external rect { fill: var(--bg-panel); stroke: var(--text-soft); stroke-dasharray: 4 3; }
    ${scope} .sm-nopage rect { fill: transparent; stroke-dasharray: 1.5 3; }
    ${scope} .sm-unresolved rect { stroke: var(--tone-err); stroke-dasharray: 5 3; }
    /* A node with no page reads in italics: the kind without hovering. */
    ${scope} .sm-nopage text, ${scope} .sm-unresolved text { font-style: italic; }
    ${scope} .sm-edge, ${scope} .sm-key-line { fill: none; stroke-width: 1.6; }
    ${scope} .sm-legend { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; list-style: none; margin: 0 0 0.5rem; padding: 0; font-size: 0.85em; color: var(--text-secondary); }
    ${scope} .sm-legend li { display: inline-flex; align-items: center; gap: 0.35rem; margin: 0; }
    ${scope} .sm-swatch { width: 24px; height: 14px; flex: none; overflow: visible; }
    ${scope} .sm-list { margin: 0 0 0.75rem; font-size: 0.9em; }
    ${scope} .sm-list summary { cursor: pointer; color: var(--text-secondary); }
    ${scope} .sm-ok, ${scope} .sm-none { stroke: var(--text-secondary); }
    ${scope} .sm-none { stroke-dasharray: 1 3; }
    ${scope} .sm-wrong { stroke: var(--tone-err); stroke-dasharray: 6 4; stroke-width: 2; }
    ${scope} .sm-arrow-ok path { fill: var(--text-secondary); }
    ${scope} .sm-arrow-wrong path { fill: var(--tone-err); }
    ${scope} .sm-notes { margin: 0 0 0.75rem; padding-left: 1.2rem; color: var(--text-soft); font-size: 0.9em; }
    @media print { ${scope} .sm-svg { min-width: 0 !important; } ${scope} .sm-map { overflow: visible; border: none; } }
    @media (forced-colors: active) {
      ${scope} .sm-node rect, ${scope} .sm-key-box rect { fill: Canvas; stroke: CanvasText; }
      ${scope} a.sm-node:focus-visible rect { stroke: Highlight; }
      ${scope} .sm-node text, ${scope} .sm-col { fill: CanvasText; }
      ${scope} .sm-edge, ${scope} .sm-key-line { stroke: CanvasText; }
      ${scope} .sm-arrow-ok path, ${scope} .sm-arrow-wrong path { fill: CanvasText; }
    }
  `;
}
