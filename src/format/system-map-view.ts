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
/** Least room right of the last column, besides {@link PAD}. */
const LOOP_W = 36;
/** A loop (a self-loop or an edge within one column) reaches out this far
 *  from its side, {@link LOOP_STEP} further per level of loops inside it. */
const LOOP_REACH = 12;
const LOOP_STEP = 4;
/** Trunk lanes start at least this far from a side, and at least one
 *  {@link LOOP_STEP} past the loops on it. */
const LANE_ROOM = 24;
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

/** East Asian Wide and Fullwidth blocks (Hangul, CJK, kana, fullwidth forms):
 *  1.05em, since Chromium on Linux draws 14 CJK characters at 12px 168.7px wide. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
/** An emoji or any astral character: drawn from a colour or fallback font. */
const PICTO = /\p{Extended_Pictographic}|[\u{10000}-\u{10FFFF}]/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * A text's drawn width in px, estimated per character class from em widths
 * of a system UI sans, so a label is cut only when it would not fit. A
 * grapheme counts once: an emoji with a variation selector, a ZWJ sequence or
 * a letter with a combining mark is one character.
 */
export function textWidthPx(s: string, px: number, letterSpacingEm = 0): number {
  let em = 0;
  for (const { segment } of graphemes.segment(s)) {
    const ch = segment[0]!;
    if (PICTO.test(segment)) em += 1.25;
    else if (WIDE.test(ch)) em += 1.05;
    else if (ch === " " || "il.,:;'|!jI".includes(ch)) em += 0.3;
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
/** Row-gap lanes: five positions, 2.5px apart, inside the 14px gap. Edges
 *  whose runs across do not overlap share a position; past the five, a row
 *  gap overflows into lanes under the last row, {@link LANE_STEP} apart. */
const CHANNEL_STEP = 2.5;
const CHANNEL_SLOTS = 5;
/** Attachment points on one side of a box sit at least this far apart. */
const PORT_MIN = 4;
/** The points a {@link NODE_H} side holds at {@link PORT_MIN} spacing. */
const MAX_PORTS = Math.floor(NODE_H / PORT_MIN) - 1;

/** Where every edge end attaches: its side, and its point's place on it. */
interface Ports {
  /** `key|L` / `key|R` → that side's point ids, top to bottom. */
  sides: Map<string, string[]>;
  /** `${row index}a` (source) / `${row index}b` (target) → `[side, point id]`. */
  ends: Map<string, [string, string]>;
}

/** A loop's side and how far it reaches out from it, by row index. */
type Loops = Map<number, { side: "L" | "R"; reach: number }>;

interface Layout {
  boxes: Map<string, Box>;
  width: number;
  /** Down to the last row's bottom and a margin; routing grows it to hold
   *  the lowest lane it draws. */
  height: number;
  colW: number;
  /** Box height: {@link NODE_H}, taller when a side needs more points. */
  nodeH: number;
  ports: Ports;
  /** Left edge of each column. */
  colX: number[];
  /** Width of the gap after each column. */
  gapW: number[];
  /** Room kept clear of trunk lanes at each gap's left and right side. */
  laneRoom: [number, number][];
  loops: Loops;
  /** Pairs of partly overlapping loops left on one side, so drawn crossing. */
  loopCrossings: number;
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

/** Each gap's lanes: the left column's nodes' lanes, then the right column's,
 *  so a stub from one side never runs along a stub from the other; within a
 *  side, first-use order, sources before targets. */
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
  return lanes.map((l, g) => [...l].sort((p, q) => Number(colOf.get(p.slice(2)) !== g) - Number(colOf.get(q.slice(2)) !== g)));
}

/**
 * Plan every side's attachment points. A self-loop end, an edge within a
 * column and an edge to the next column each get a point of their own; the
 * edges that leave by one source trunk share one point, as do the edges that
 * arrive by one target trunk, since they share the line from there. A side
 * that still holds more than {@link MAX_PORTS} points also merges its edges
 * to the next column into one outgoing and one incoming point. Points sort by
 * the mean row of the other ends, so lines cross as little as they can; the
 * ends of edges within the column go above them (upward) or below (downward).
 */
function planPorts(rows: readonly SystemMapRow[], colOf: Map<string, number>, rowOf: Map<string, number>, loopSide: Map<number, "L" | "R">): Ports {
  // group 0: an edge within the column leaving upward; 2: downward; 1: the rest.
  const ends: { id: string; side: string; port: string; other: number; i: number; group: number; adjacent?: "out" | "in" }[] = [];
  rows.forEach((r, i) => {
    const [fk, tk] = [nodeKey(r.from), nodeKey(r.to)];
    const [ca, cb] = [colOf.get(fk), colOf.get(tk)];
    if (ca === undefined || cb === undefined) return;
    if (fk === tk) {
      const side = `${fk}|${loopSide.get(i)}`;
      for (const end of ["a", "b"]) ends.push({ id: `${i}${end}`, side, port: `${side}#${i}${end}`, other: rowOf.get(fk)!, i, group: 1 });
      return;
    }
    if (ca === cb) {
      for (const [end, me, other] of [["a", fk, tk], ["b", tk, fk]] as const) {
        const side = `${me}|${loopSide.get(i)}`;
        ends.push({ id: `${i}${end}`, side, port: `${side}#${i}`, other: rowOf.get(other)!, i, group: rowOf.get(other)! < rowOf.get(me)! ? 0 : 2 });
      }
      return;
    }
    const span = Math.abs(ca - cb);
    for (const end of ["a", "b"] as const) {
      const [me, mine, theirs, other] = end === "a" ? [fk, ca, cb, tk] : [tk, cb, ca, fk];
      const side = `${me}|${theirs >= mine ? "R" : "L"}`;
      const port = span >= 2 ? `${side}#${end === "a" ? "s" : "t"}` : `${side}#${i}`;
      ends.push({ id: `${i}${end}`, side, port, other: rowOf.get(other)!, i, group: 1, adjacent: span === 1 ? (end === "a" ? "out" : "in") : undefined });
    }
  });
  const bySide = new Map<string, typeof ends>();
  for (const e of ends) bySide.set(e.side, [...(bySide.get(e.side) ?? []), e]);
  const sides = new Map<string, string[]>();
  for (const [side, list] of bySide) {
    if (new Set(list.map((e) => e.port)).size > MAX_PORTS) for (const e of list) if (e.adjacent) e.port = `${side}#${e.adjacent}`;
    const at = new Map<string, { sum: number; n: number; i: number; group: number }>();
    for (const e of list) {
      const p = at.get(e.port) ?? { sum: 0, n: 0, i: e.i, group: e.group };
      at.set(e.port, { sum: p.sum + e.other, n: p.n + 1, i: Math.min(p.i, e.i), group: e.group });
    }
    const key = (id: string) => at.get(id)!;
    // Loops nest: upward ends first, the nearest other end on top, so a
    // shorter loop starts inside a longer one; downward ends last, the
    // farthest on top; equal spans nest by row order.
    const loopOrder = (p: string, q: string) => {
      const [a, b] = [key(p), key(q)];
      return b.sum - a.sum || (a.group === 0 ? b.i - a.i : a.i - b.i);
    };
    sides.set(
      side,
      [...at.keys()].sort(
        (p, q) =>
          key(p).group - key(q).group ||
          (key(p).group !== 1 ? loopOrder(p, q) : key(p).sum / key(p).n - key(q).sum / key(q).n || key(p).i - key(q).i || (p < q ? -1 : 1)),
      ),
    );
  }
  return { sides, ends: new Map(ends.map((e) => [e.id, [e.side, e.port]])) };
}

/** Lay out the boxes: one column per group, nodes in first-appearance order,
 *  every column as wide as the longest label or head (within the bounds),
 *  every gap wide enough for the lanes `rows` route through it. */
export function layoutSystemMap(nodes: readonly SystemMapNode[], columns: readonly string[], rows: readonly SystemMapRow[] = []): Layout {
  const widest = Math.max(0, ...nodes.map((n) => labelWidth(n.label)), ...columns.map(headWidth));
  const colW = Math.min(COL_MAX, Math.max(COL_MIN, Math.ceil(widest + 2 * NODE_PAD_X)));
  const colOf = new Map(nodes.map((n) => [n.key, Math.max(0, columns.indexOf(n.group))]));
  const perCol = columns.map(() => 0);
  const rowOf = new Map(nodes.map((n) => [n.key, perCol[colOf.get(n.key)!]!++]));
  const { sides: loopSide, crossings } = planLoopSides(rows, colOf, rowOf);
  const ports = planPorts(rows, colOf, rowOf, loopSide);
  const nodeH = Math.max(NODE_H, PORT_MIN * (Math.max(0, ...[...ports.sides.values()].map((p) => p.length)) + 1));
  const rowY = (key: string) => PAD + HEAD_H + rowOf.get(key)! * (nodeH + GAP_Y);
  const loops = loopReaches(rows, colOf, loopSide, (id) => portY(ports, nodeH, rowY, id));
  // The farthest reach on each column's left and right side.
  const reachOut = columns.map(() => ({ L: 0, R: 0 }));
  rows.forEach((r, i) => {
    const l = loops.get(i);
    const side = l && reachOut[colOf.get(nodeKey(r.from))!]!;
    if (l && side) side[l.side] = Math.max(side[l.side], l.reach);
  });
  const room = (reach: number) => (reach ? Math.max(LANE_ROOM, reach + LOOP_STEP) : LANE_ROOM);
  const laneRoom = reachOut.slice(1).map((next, g): [number, number] => [room(reachOut[g]!.R), room(next.L)]);
  const gapW = gapLanes(rows, colOf, Math.max(0, columns.length - 1)).map((l, g) => Math.max(GAP_X, laneRoom[g]![0] + laneRoom[g]![1] + Math.max(0, l.length - 1) * LANE_STEP));
  const left = reachOut[0]?.L ? reachOut[0].L + PAD : PAD;
  const right = Math.max(PAD + LOOP_W, (reachOut.at(-1)?.R ?? 0) + PAD);
  const colX = columns.map((_, i) => left + i * colW + gapW.slice(0, i).reduce((x, g) => x + g, 0));
  const boxes = new Map<string, Box>();
  for (const node of nodes) {
    const col = colOf.get(node.key)!;
    boxes.set(node.key, { node, col, x: colX[col]!, y: rowY(node.key) });
  }
  const rowCount = Math.max(1, ...perCol);
  return {
    boxes,
    colW,
    nodeH,
    ports,
    colX,
    gapW,
    laneRoom,
    loops,
    loopCrossings: crossings,
    rows: rowCount,
    width: left + columns.length * colW + gapW.reduce((x, g) => x + g, 0) + right,
    // The last row's bottom; routing grows it to the lowest lane it draws.
    height: PAD * 2 + HEAD_H + rowCount * (nodeH + GAP_Y) - GAP_Y,
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

/** The y of an edge end's attachment point (`${row index}a` or `b`). */
function portY(ports: Ports, nodeH: number, nodeY: (key: string) => number, id: string): number {
  const [side, port] = ports.ends.get(id)!;
  const list = ports.sides.get(side)!;
  return nodeY(side.slice(0, side.lastIndexOf("|"))) + (nodeH * (list.indexOf(port) + 1)) / (list.length + 1);
}

/**
 * The side of every loop, by row index. A self-loop takes {@link selfLoopSide}.
 * Edges within one column whose row spans partly overlap would cross on one
 * side, so they take opposite sides: each, in breadth-first order over the
 * overlaps, takes the side where fewer of its overlapping edges already are,
 * the right on a tie. That leaves no pair on one side when the overlaps
 * 2-colour; otherwise the pairs left on one side cross, and are counted.
 */
function planLoopSides(rows: readonly SystemMapRow[], colOf: Map<string, number>, rowOf: Map<string, number>): { sides: Map<number, "L" | "R">; crossings: number } {
  const sides = new Map<number, "L" | "R">();
  const spans: { i: number; col: number; lo: number; hi: number }[] = [];
  rows.forEach((r, i) => {
    const [fk, tk] = [nodeKey(r.from), nodeKey(r.to)];
    const col = colOf.get(fk);
    if (col === undefined || colOf.get(tk) !== col) return;
    if (fk === tk) sides.set(i, selfLoopSide(r, rows, colOf)!);
    else spans.push({ i, col, lo: Math.min(rowOf.get(fk)!, rowOf.get(tk)!), hi: Math.max(rowOf.get(fk)!, rowOf.get(tk)!) });
  });
  const overlap = (p: (typeof spans)[number], q: (typeof spans)[number]) =>
    p.col === q.col && ((p.lo < q.lo && q.lo < p.hi && p.hi < q.hi) || (q.lo < p.lo && p.lo < q.hi && q.hi < p.hi));
  for (const root of spans) {
    const queue = [root];
    while (queue.length) {
      const s = queue.shift()!;
      if (sides.has(s.i)) continue;
      const near = spans.filter((o) => overlap(s, o));
      const on = (side: "L" | "R") => near.filter((o) => sides.get(o.i) === side).length;
      sides.set(s.i, on("L") < on("R") ? "L" : "R");
      queue.push(...near.filter((o) => !sides.has(o.i)));
    }
  }
  let crossings = 0;
  for (const [n, p] of spans.entries()) for (const q of spans.slice(n + 1)) if (overlap(p, q) && sides.get(p.i) === sides.get(q.i)) crossings++;
  return { sides, crossings };
}

/**
 * Every loop's reach, from its level on its column side: 0 for a loop with
 * no other loop's span overlapping its own and shorter, else one more than
 * the highest such loop. A loop inside another is shorter, so it always
 * reaches less far, however deep the nesting.
 */
function loopReaches(rows: readonly SystemMapRow[], colOf: Map<string, number>, loopSide: Map<number, "L" | "R">, y: (id: string) => number): Loops {
  const bySide = new Map<string, { i: number; lo: number; hi: number }[]>();
  for (const [i, side] of loopSide) {
    const [ya, yb] = [y(`${i}a`), y(`${i}b`)];
    const k = `${colOf.get(nodeKey(rows[i]!.from))}|${side}`;
    bySide.set(k, [...(bySide.get(k) ?? []), { i, lo: Math.min(ya, yb), hi: Math.max(ya, yb) }]);
  }
  const loops: Loops = new Map();
  for (const list of bySide.values()) {
    list.sort((p, q) => p.hi - p.lo - (q.hi - q.lo) || p.lo - q.lo || p.i - q.i);
    const level: number[] = [];
    list.forEach((l, n) => {
      level[n] = Math.max(0, ...list.slice(0, n).flatMap((o, m) => (o.lo < l.hi && l.lo < o.hi ? [level[m]! + 1] : [])));
      loops.set(l.i, { side: loopSide.get(l.i)!, reach: LOOP_REACH + level[n]! * LOOP_STEP });
    });
  }
  return loops;
}

interface RoutedEdge {
  row: SystemMapRow;
  a: Box;
  b: Box;
  d: string;
}

/**
 * Route every edge. Each end attaches at its side's point (see
 * {@link planPorts}), the points spread evenly over the side. An edge between
 * adjacent columns is a curve across the gap between them. One that spans
 * more columns runs down its source's trunk in the gap it leaves by, across
 * the intermediate columns in a row gap near the straight line (never under a
 * box), and up or down its target's trunk into the target. A loop goes out
 * its side as far as {@link loopReaches} says, short of the trunk lanes. The
 * drawing grows taller when a run across overflows under the last row.
 */
export function routeSystemMapEdges(rows: readonly SystemMapRow[], layout: Layout): { edges: RoutedEdge[]; height: number } {
  const { boxes, colW, colX, gapW, laneRoom, loops, nodeH, ports } = layout;
  const items = rows.flatMap((row, i) => {
    const a = boxes.get(nodeKey(row.from));
    const b = boxes.get(nodeKey(row.to));
    return a && b ? [{ row, a, b, i }] : [];
  });
  const yAt = (i: number, end: "a" | "b") => portY(ports, nodeH, (key) => boxes.get(key)!.y, `${i}${end}`);
  const colOf = new Map([...boxes.values()].map((b) => [b.node.key, b.col]));
  const lanes = gapLanes(rows, colOf, gapW.length);
  // A gap's lanes, centred between the room kept clear at its sides.
  const laneX = (g: number, key: string) => {
    const l = lanes[g]!;
    const [inL, inR] = laneRoom[g]!;
    return colX[g]! + colW + inL + (gapW[g]! - inL - inR - (l.length - 1) * LANE_STEP) / 2 + l.indexOf(key) * LANE_STEP;
  };
  const gapY = (k: number) => PAD + HEAD_H + (k + 1) * (nodeH + GAP_Y) - GAP_Y / 2;
  // Row-gap lane "k:slot" → the x runs already on it.
  const runs = new Map<string, [number, number][]>();
  const free = (k: number, slot: number, lo: number, hi: number) => !(runs.get(`${k}:${slot}`) ?? []).some(([l, h]) => lo < h + LANE_STEP && l < hi + LANE_STEP);
  const slotY = (k: number, slot: number) =>
    slot < CHANNEL_SLOTS ? gapY(k) + (slot % 2 === 1 ? 1 : -1) * Math.ceil(slot / 2) * CHANNEL_STEP : gapY(k) + 2 * CHANNEL_STEP + (slot - CHANNEL_SLOTS + 1) * LANE_STEP;
  let bottom = layout.height;
  const edges = items.map(({ a, b, row, i }) => {
    const ay = yAt(i, "a");
    const by = yAt(i, "b");
    const loop = loops.get(i);
    if (loop) {
      // Out from the side, along it, and back: a rectangle, so loops nest.
      const x = loop.side === "R" ? a.x + colW : a.x;
      const out = x + (loop.side === "R" ? loop.reach : -loop.reach);
      return { row, a, b, d: roundedPath([[x, ay], [out, ay], [out, by], [x, by]]) };
    }
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
    const [lo, hi] = [Math.min(t1, t2), Math.max(t1, t2)];
    // The row gap nearest the straight line with a free position; when every
    // position is taken, the next free lane under the last row.
    const want = (ay + by) / 2;
    const gaps = Array.from({ length: layout.rows }, (_, k) => k).sort((p, q) => Math.abs(gapY(p) - want) - Math.abs(gapY(q) - want) || p - q);
    let at: [number, number] | undefined;
    for (const k of gaps) {
      const slot = Array.from({ length: CHANNEL_SLOTS }, (_, s) => s).find((s) => free(k, s, lo, hi));
      if (slot !== undefined) {
        at = [k, slot];
        break;
      }
    }
    if (!at) {
      let slot = CHANNEL_SLOTS;
      while (!free(layout.rows - 1, slot, lo, hi)) slot++;
      at = [layout.rows - 1, slot];
    }
    runs.set(`${at[0]}:${at[1]}`, [...(runs.get(`${at[0]}:${at[1]}`) ?? []), [lo, hi]]);
    const cy = slotY(at[0], at[1]);
    bottom = Math.max(bottom, Math.ceil(cy + PAD));
    return { row, a, b, d: roundedPath([[x1, ay], [t1, ay], [t1, cy], [t2, cy], [t2, by], [x2, by]]) };
  });
  return { edges, height: bottom };
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
  // A drawn map with a caption takes its name from the caption, which is then
  // hidden from assistive tech so it is announced once (aria-labelledby still
  // reads a hidden element). The fallback shows no caption, so it keeps a label.
  const capId = `${prefix}caption`;
  const figure = (cls: string, named: boolean) =>
    named
      ? `<section class="${cls}" role="figure" aria-labelledby="${capId}">`
      : `<section class="${cls}" role="figure" aria-label="${escapeHtml(input.caption ? `System map: ${input.caption}` : "System map")}">`;
  const notes = read.findings.length
    ? `<ul class="sm-notes" ${RO}>${read.findings.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}</ul>`
    : "";
  if (!read.drawable) {
    return `${figure("sm sm-fallback", false)}${input.beforeHtml}${notes}${input.tableHtml}${input.afterHtml}</section>`;
  }
  const layout = layoutSystemMap(read.nodes, read.columns, read.rows);
  const { boxes, width, colW, colX, nodeH } = layout;
  const heads = read.columns
    .map((c, i) => {
      const shown = fitText(c, colW, headWidth);
      const title = shown === c ? "" : `<title>${escapeHtml(c)}</title>`;
      return `<text class="sm-col" x="${colX[i]! + colW / 2}" y="${PAD + 16}" text-anchor="middle">${title}${escapeHtml(shown)}</text>`;
    })
    .join("");

  const tones = new Set<string>();
  const routed = routeSystemMapEdges(read.rows, layout);
  const height = routed.height;
  const edges = routed.edges
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
        `<rect x="${box.x}" y="${box.y}" width="${colW}" height="${nodeH}" rx="6"/>` +
        `<text x="${box.x + colW / 2}" y="${box.y + nodeH / 2}" text-anchor="middle" dominant-baseline="central">${escapeHtml(fitText(node.label, colW - 2 * NODE_PAD_X, labelWidth))}</text>`;
      const title = `<title>${escapeHtml(node.label + what)}</title>`;
      // A node with no page is one named image (Chromium exposes no name from
      // a <title> on a plain <g>), so its kind is in its name like a link's.
      if (!link) return `<g class="${cls}" role="img" aria-label="${escapeHtml(node.label + what)}" data-sm-node="${escapeHtml(node.key)}">${title}${shape}</g>`;
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
  const caption = input.caption ? `<div class="sm-caption" id="${capId}" aria-hidden="true" ${RO}>${escapeHtml(input.caption)}</div>` : "";
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
  return `${figure("sm", !!input.caption)}${input.beforeHtml}${caption}${map}${legend}${list}${notes}${input.tableHtml}${input.afterHtml}</section>`;
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
