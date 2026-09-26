/**
 * Graph mode in the article pane: the lanes markup, the side card, the `g`
 * key rule and the hover neighbourhood. Pure string building and set logic,
 * in its own module because `wiki-browser.ts` touches `document` at import
 * time and `bun test` cannot load it. The one DOM function here,
 * {@link drawGraphEdges}, runs only when the reader calls it.
 *
 * The data is `GET /api/wiki/graph` (`src/wiki/trackers/graph-types.ts`).
 */

import { escHtml as esc } from "./escape.ts";
import {
  GRAPH_DEPTH_MAX,
  GRAPH_NODES_MAX,
  GRAPH_SESSIONS_MAX,
  type GraphEdge,
  type GraphLane,
  type GraphLevel,
  type GraphNode,
  type GraphPayload,
} from "../../../wiki/trackers/graph-types.ts";

export const GRAPH_SECTION_ID = "wikiGraph";
export const GRAPH_TOGGLE_ID = "wikiGraphToggle";
export const GRAPH_CARD_ID = "wikiGraphCard";
export const GRAPH_LEVEL_ID = "wikiGraphLevel";
export const GRAPH_DEPTH_ID = "wikiGraphDepth";
/** A node button carries its id here. */
export const GRAPH_NODE_ATTR = "data-graph-node";
/** The card's Focus here carries the node id; Open carries a page's relPath. */
export const GRAPH_FOCUS_ATTR = "data-graph-focus";
export const GRAPH_OPEN_ATTR = "data-graph-open";
export const GRAPH_CARD_CLOSE_ATTR = "data-graph-card-close";

const LANE_TITLES: Record<GraphLane, string> = { issue: "Issues", page: "Pages", session: "Sessions", pr: "PRs" };

const LEVEL_TITLES: Record<GraphLevel, string> = {
  1: "Issues and pages",
  2: "+ sessions",
  3: "+ PRs",
};

// ── The `g` key ──────────────────────────────────────────────────────────────

export interface GraphKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  targetTag?: string | null;
  targetEditable?: boolean;
  targetInDialog?: boolean;
}

/**
 * Does this keydown toggle graph mode? Only a bare `g`: any modifier refuses it
 * (⌘G/Ctrl+G is the browser's find-next, and Shift makes it `G`), as do key
 * repeat, a modal dialog and focus in an input, textarea, select or
 * contenteditable element — the Ask box, the follow-up input and the series
 * editor are where a reader types a `g`. The pane toggles' rule
 * (`paneKeyAction`), which owns `]` and `f`; `t` is the theme's.
 */
export function graphKeyToggles(e: GraphKeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.targetInDialog) return false;
  const tag = (e.targetTag || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.targetEditable) return false;
  return e.key === "g";
}

// ── Markup ───────────────────────────────────────────────────────────────────

/** The article head's toggle — rendered only on a wiki with a tracker. */
export function graphToggleHtml(on: boolean): string {
  return (
    `<button type="button" id="${GRAPH_TOGGLE_ID}" class="wiki-graph-toggle${on ? " on" : ""}" ` +
    `aria-pressed="${on ? "true" : "false"}" title="Graph mode (g)">◇ Graph</button>`
  );
}

export function graphLoadingHtml(): string {
  return `<section id="${GRAPH_SECTION_ID}" class="wiki-graph" aria-busy="true"><div class="wiki-graph-note">Loading graph…</div></section>`;
}

export function graphErrorHtml(text: string): string {
  return `<section id="${GRAPH_SECTION_ID}" class="wiki-graph"><div class="wiki-graph-note" role="status">${esc(text)}</div></section>`;
}

/** What the banner says when the answer is a prefix, or `""`. */
export function graphTruncatedText(p: Pick<GraphPayload, "truncated" | "truncatedBy">): string {
  if (!p.truncated) return "";
  const by = p.truncatedBy ?? [];
  const parts: string[] = [];
  if (by.includes("sessions")) parts.push(`the first ${GRAPH_SESSIONS_MAX} sessions`);
  if (by.includes("nodes")) parts.push(`the first ${GRAPH_NODES_MAX} nodes`);
  return `Graph cut short: it shows ${parts.join(" and ") || "a part of the walk"}. Lower the depth or the lanes to see all of it.`;
}

/** The note under the bar when the ledger could not fill the session lane. */
export function graphLedgerText(p: GraphPayload): string {
  if (!p.lanes.includes("session")) return "";
  if (!p.nodes.some((n) => n.lane === "session")) return "";
  if (!p.ledger.configured) return "No session ledger on this host: sessions show their ids, and PRs come only from the pages.";
  if (p.ledger.timedOut) return "The session ledger timed out: some sessions show their ids only.";
  if (p.ledger.asked && !p.ledger.reachable) return "The session ledger did not answer: some sessions show their ids only.";
  return "";
}

function money(n: number | null): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "";
}

/** A node's visible label and its one-line hint. */
export function graphNodeLabel(n: GraphNode): { label: string; hint: string } {
  if (n.lane === "issue") {
    const pages = `${n.pageCount} page${n.pageCount === 1 ? "" : "s"}`;
    return { label: n.key, hint: n.planPages.length ? `${pages} · plan` : pages };
  }
  if (n.lane === "page") return { label: n.title, hint: n.plan ? "plan" : n.type };
  if (n.lane === "session") {
    return { label: n.title || n.sessionId.slice(0, 8), hint: [n.provider ?? "", money(n.cost)].filter(Boolean).join(" · ") };
  }
  const short = n.ref.includes("/") ? n.ref.slice(n.ref.indexOf("/") + 1) : n.ref;
  return { label: short, hint: n.subject ?? "" };
}

export interface GraphRenderOptions {
  /** The lanes and depth the selects show as chosen. */
  level: GraphLevel;
  depth: number;
  /** What the bar names as the root. */
  rootLabel: string;
}

/** The whole section: bar, banner, lanes and an empty card. */
export function graphHtml(p: GraphPayload, opts: GraphRenderOptions): string {
  const byLane = new Map<GraphLane, GraphNode[]>(p.lanes.map((l) => [l, []]));
  for (const n of p.nodes) byLane.get(n.lane)?.push(n);
  const levelOpts = ([1, 2, 3] as GraphLevel[])
    .map((l) => `<option value="${l}"${l === opts.level ? " selected" : ""}>${esc(LEVEL_TITLES[l])}</option>`)
    .join("");
  const depthOpts = Array.from({ length: GRAPH_DEPTH_MAX }, (_, i) => i + 1)
    .map((d) => `<option value="${d}"${d === opts.depth ? " selected" : ""}>${d} hop${d === 1 ? "" : "s"}</option>`)
    .join("");
  const truncated = graphTruncatedText(p);
  const ledger = graphLedgerText(p);
  const lanes = p.lanes
    .map((lane) => {
      const nodes = byLane.get(lane) ?? [];
      const body = nodes.length
        ? nodes
            .map((n) => {
              const { label, hint } = graphNodeLabel(n);
              const cls = [
                "wiki-graph-node",
                `lane-${n.lane}`,
                n.hop === 0 ? "root" : "",
                n.lane === "session" && (n.missing || n.unresolved) ? "bare" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                `<button type="button" class="${cls}" ${GRAPH_NODE_ATTR}="${esc(n.id)}" data-hop="${n.hop}" title="${esc(label)}">` +
                `<span class="wiki-graph-node-label">${esc(label)}</span>` +
                (hint ? `<span class="wiki-graph-node-hint">${esc(hint)}</span>` : "") +
                `</button>`
              );
            })
            .join("")
        : `<div class="wiki-graph-empty">none</div>`;
      return (
        `<div class="wiki-graph-lane" data-lane="${lane}">` +
        `<div class="wiki-graph-lane-head">${LANE_TITLES[lane]} <span class="wiki-graph-count" data-lane-count="${lane}">${nodes.length}</span></div>` +
        body +
        `</div>`
      );
    })
    .join("");
  return (
    `<section id="${GRAPH_SECTION_ID}" class="wiki-graph" data-graph-scope="${esc(p.scope)}" data-graph-root="${esc(p.root)}" style="--graph-lanes:${p.lanes.length}">` +
    `<div class="wiki-graph-bar"><span class="wiki-graph-title">Rooted at <b>${esc(opts.rootLabel)}</b></span>` +
    `<label class="wiki-graph-ctl">Lanes <select id="${GRAPH_LEVEL_ID}">${levelOpts}</select></label>` +
    `<label class="wiki-graph-ctl">Depth <select id="${GRAPH_DEPTH_ID}">${depthOpts}</select></label></div>` +
    (truncated ? `<div class="wiki-graph-banner" data-graph-truncated role="status">${esc(truncated)}</div>` : "") +
    (ledger ? `<div class="wiki-graph-note" data-graph-ledger>${esc(ledger)}</div>` : "") +
    `<div class="wiki-graph-body"><div class="wiki-graph-canvas">` +
    `<svg class="wiki-graph-edges" aria-hidden="true"></svg>` +
    `<div class="wiki-graph-lanes">${lanes}</div></div>` +
    `<aside id="${GRAPH_CARD_ID}" class="wiki-graph-card" hidden></aside></div>` +
    `</section>`
  );
}

/** The side card for one node: its facts, Focus here (issues and pages that
 *  are not already the root), Open (a page) and the outward link. */
export function graphCardHtml(n: GraphNode, opts: { isRoot: boolean }): string {
  const { label } = graphNodeLabel(n);
  const facts: string[] = [];
  const actions: string[] = [];
  const focus = `<button type="button" class="wiki-graph-card-btn" ${GRAPH_FOCUS_ATTR}="${esc(n.id)}">Focus here</button>`;
  if (n.lane === "issue") {
    facts.push(`${n.pageCount} page${n.pageCount === 1 ? "" : "s"} count it`);
    facts.push(n.planPages.length ? `plan: ${n.planPages.map((p) => p.title).join(", ")}` : "no plan");
    if (!opts.isRoot) actions.push(focus);
    if (n.url) {
      actions.push(
        `<a class="wiki-graph-card-btn" data-graph-tracker href="${esc(n.url)}" target="_blank" rel="noopener">Open in ${esc(n.label)} ↗</a>`,
      );
    }
  } else if (n.lane === "page") {
    facts.push(n.relPath);
    if (n.plan) facts.push("plan");
    if (!opts.isRoot) actions.push(focus);
    actions.push(`<button type="button" class="wiki-graph-card-btn" ${GRAPH_OPEN_ATTR}="${esc(n.relPath)}">Open</button>`);
  } else if (n.lane === "session") {
    facts.push(n.ref);
    if (typeof n.cost === "number") facts.push(`cost ${money(n.cost)}`);
    if (n.first) facts.push(`from ${n.first.slice(0, 10)}`);
    if (n.missing) facts.push("not in the ledger");
    else if (n.unresolved) facts.push("not looked up");
    if (n.url && !n.missing && !n.unresolved) {
      actions.push(`<a class="wiki-graph-card-btn" href="${esc(n.url)}" target="_blank" rel="noopener">Open session ↗</a>`);
    }
  } else {
    facts.push(n.ref);
    if (n.subject) facts.push(n.subject);
    if (n.mergedAt) facts.push(`merged ${n.mergedAt.slice(0, 10)}`);
    if (n.url) actions.push(`<a class="wiki-graph-card-btn" href="${esc(n.url)}" target="_blank" rel="noopener">Open PR ↗</a>`);
  }
  return (
    `<div class="wiki-graph-card-head"><span class="wiki-graph-card-lane">${esc(LANE_TITLES[n.lane].replace(/s$/, ""))}</span>` +
    `<button type="button" class="wiki-graph-card-close" ${GRAPH_CARD_CLOSE_ATTR} aria-label="Close">✕</button></div>` +
    `<div class="wiki-graph-card-title">${esc(label)}</div>` +
    `<ul class="wiki-graph-card-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
    (actions.length ? `<div class="wiki-graph-card-actions">${actions.join("")}</div>` : "")
  );
}

// ── Hover ────────────────────────────────────────────────────────────────────

export const edgeKey = (e: Pick<GraphEdge, "source" | "target">): string => `${e.source}|${e.target}`;

/**
 * What hovering a node lights: the node, its neighbours and their edges, plus
 * one shortest path back to a root (each step to a neighbour one hop nearer).
 */
export function graphLit(p: Pick<GraphPayload, "nodes" | "edges">, id: string): { nodes: Set<string>; edges: Set<string> } {
  const hop = new Map(p.nodes.map((n) => [n.id, n.hop]));
  const adj = new Map<string, GraphEdge[]>();
  for (const e of p.edges) {
    for (const end of [e.source, e.target]) {
      const list = adj.get(end);
      if (list) list.push(e);
      else adj.set(end, [e]);
    }
  }
  const nodes = new Set<string>([id]);
  const edges = new Set<string>();
  for (const e of adj.get(id) ?? []) {
    edges.add(edgeKey(e));
    nodes.add(e.source === id ? e.target : e.source);
  }
  let at = id;
  for (let guard = 0; guard < 16 && (hop.get(at) ?? 0) > 0; guard++) {
    const h = hop.get(at)!;
    const step = (adj.get(at) ?? []).find((e) => hop.get(e.source === at ? e.target : e.source) === h - 1);
    if (!step) break;
    edges.add(edgeKey(step));
    at = step.source === at ? step.target : step.source;
    nodes.add(at);
  }
  return { nodes, edges };
}

// ── Edges (DOM) ──────────────────────────────────────────────────────────────

/**
 * Draw every edge as a curve from the right edge of its left node to the left
 * edge of its right node, in the canvas's own coordinates. Called after the
 * lanes are laid out and again on resize; an edge whose node is not on screen
 * is skipped.
 */
export function drawGraphEdges(section: HTMLElement, edges: readonly GraphEdge[]): void {
  const canvas = section.querySelector<HTMLElement>(".wiki-graph-canvas");
  const svg = section.querySelector<SVGSVGElement>(".wiki-graph-edges");
  if (!canvas || !svg) return;
  const box = canvas.getBoundingClientRect();
  const w = canvas.scrollWidth;
  const h = canvas.scrollHeight;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const at = new Map<string, DOMRect>();
  section.querySelectorAll<HTMLElement>(`[${GRAPH_NODE_ATTR}]`).forEach((el) => {
    at.set(el.getAttribute(GRAPH_NODE_ATTR) || "", el.getBoundingClientRect());
  });
  const paths: string[] = [];
  for (const e of edges) {
    const s = at.get(e.source);
    const t = at.get(e.target);
    if (!s || !t) continue;
    const x1 = s.right - box.left + canvas.scrollLeft;
    const y1 = s.top + s.height / 2 - box.top + canvas.scrollTop;
    const x2 = t.left - box.left + canvas.scrollLeft;
    const y2 = t.top + t.height / 2 - box.top + canvas.scrollTop;
    const dx = Math.max(24, (x2 - x1) / 2);
    paths.push(
      `<path class="wiki-graph-edge kind-${e.kind}" data-edge="${esc(edgeKey(e))}" ` +
        `d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`,
    );
  }
  svg.innerHTML = paths.join("");
}
