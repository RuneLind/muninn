/// <reference lib="dom" />
/**
 * Atlas tab for the /wiki reader — a hybrid graph view over the wiki's own
 * `GET /api/wiki/atlas` projection (PR 1). One selection model, two projections:
 *
 *  • Types  — pages laid out in type columns (source hubs · sources · concepts ·
 *             entities · analyses), rendered in the payload's own `types` order.
 *  • Months — dated source pages laid out by month, chronological within column.
 *
 * Curated trails and auto topic-trails work in BOTH projections and the current
 * selection SURVIVES the Types↔Months toggle (steps renumber, the story list
 * re-sorts to match the badges, and steps absent from the active projection stay
 * as greyed "not in this view" ghosts). Selection-only bezier edges are drawn
 * from live DOM node positions (never all edges), redrawn on resize + toggle.
 *
 * This is a client module bundled into the reader IIFE (see wiki-client.ts),
 * NOT a server-rendered `*Styles/*Html/*Script` component — its CSS lives in
 * `wiki-page.ts` alongside the other reader styles. A mechanical descendant of
 * the mockup at mimir `archive/muninn/wiki-atlas-mockups/wiki-combined-mockup.html`.
 *
 * Keys are the payload's normalized relPaths (collision-proof); `node.name` is
 * display-only. Node clicks open the page by relPath (`deps.openPage`), so a
 * same-stem page in another folder can't shadow the intended one.
 */

import { escHtml as esc } from "./escape.ts";
import {
  computeClusters,
  computeColoring,
  neighborsFor,
  stemOf,
  SEM_OTHER_SLOT,
  SEM_THRESHOLD_DEFAULT,
  SEM_THRESHOLD_MAX,
  SEM_THRESHOLD_MIN,
  SEM_THRESHOLD_STEP,
  type RailCluster,
  type SemanticOverlay,
  type SemColoring,
} from "./wiki-atlas-semantic.ts";

// ── Payload shape (mirrors src/wiki/atlas.ts — redefined here to keep the
//    client bundle free of the server module's filesystem imports) ──────────
interface AtlasType {
  key: string;
  label: string;
}
interface AtlasNode {
  name: string;
  t: string;
  hub: boolean;
  in: number;
  date?: string;
  tags: string[];
  desc?: string;
  links: string[];
}
interface AtlasTopic {
  name: string;
  count: number;
  perMonth: number[];
  desc?: string;
}
interface AtlasTrailStep {
  page: string;
  note: string;
  resolved: boolean;
}
interface AtlasTrail {
  title: string;
  blurb: string;
  steps: AtlasTrailStep[];
}
interface AtlasPayload {
  types: AtlasType[];
  nodes: Record<string, AtlasNode>;
  monthKeys: string[];
  months: Record<string, string[]>;
  topics: AtlasTopic[];
  trails: AtlasTrail[];
  omitted: { byType: Record<string, number>; byMonth: Record<string, number> };
  /** Optional huginn semantic overlay — present only when the atlas was fetched
   *  with `?semantic=1` AND the wiki has backing collections huginn could reach.
   *  Absent ⇒ the whole overlay UI (toggle/slider/dots/legend/edges) is omitted
   *  and the tab renders byte-identically to the pre-overlay behaviour. */
  semantic?: SemanticOverlay | null;
  error?: string;
}

export interface AtlasDeps {
  /** Append the active `?wiki=` param to a fetch URL. */
  withWiki(url: string): string;
  /** Open a wiki page in the reader by its normalized relPath (+ display name). */
  openPage(relPath: string, name: string): void;
}

type Selection =
  | { kind: "curated"; idx: number }
  | { kind: "topic"; idx: number }
  | { kind: "node"; key: string };

type Projection = "types" | "months";

// ── Module state (WIKI is fixed per page load, so a cache never goes stale) ──
let payload: AtlasPayload | null = null;
let selection: Selection | null = null;
let proj: Projection = "types";
let resizeBound = false;

// ── Semantic overlay state (all inert unless `payload.semantic` is present) ──
/** Overlay toggle — defaults OFF; the `semantic=1` fetch is eager on tab open so
 *  flipping this is instant (no refetch). */
let semanticOn = false;
/** Semantic-EDGE similarity gate (node colouring is fixed, never keyed off this). */
let threshold = SEM_THRESHOLD_DEFAULT;
/** Community colouring for the current build (recomputed per build; null off). */
let coloring: SemColoring | null = null;
/** Active dim-others community filter (legend click), by colour slot. */
let dimSlot: number | null = null;
/** Cluster rail: union-find components at the current threshold (recomputed on
 *  slider change). Distinct from the FIXED communities — see wiki-atlas-semantic.ts. */
let clustersNow: RailCluster[] = [];
/** Selected cluster id (rail click) — dims non-members in the active projection.
 *  Mutually exclusive with `selection` and `dimSlot`. */
let clusterSel: string | null = null;

/** Container markup for #startBody when the Atlas tab is active. */
export function atlasBodyHtml(): string {
  return '<div class="wiki-atlas" id="wikiAtlasRoot"><div class="wiki-atlas-empty">Loading atlas…</div></div>';
}

/** Fetch (once) + build the Atlas into #wikiAtlasRoot, re-applying any selection. */
export function initAtlas(deps: AtlasDeps): void {
  const root = document.getElementById("wikiAtlasRoot");
  if (!root) return;
  if (payload) {
    buildAtlas(root, payload, deps);
    return;
  }
  // Eager `semantic=1` on tab open so the overlay toggle is instant. The server
  // omits `semantic` for collection-less wikis / when huginn is unreachable, so
  // the field is simply absent there and the tab degrades to today's behaviour.
  fetch(deps.withWiki("/api/wiki/atlas?semantic=1"))
    .then((r) => r.json())
    .then((data: AtlasPayload) => {
      payload = data;
      buildAtlas(root, data, deps);
    })
    .catch((err: Error) => {
      root.innerHTML = `<div class="wiki-atlas-empty">Failed to load atlas: ${esc(err.message)}</div>`;
    });
}

// ── Build ───────────────────────────────────────────────────────────────────

const MONTH_VISIBLE_STEPS = 14; // chronicle rows before the "…and N more" tail

function monthLabel(mk: string): string {
  // `mk` is YYYY-MM; the -02 avoids a UTC/local day-rollover into the prev month.
  const d = new Date(mk + "-02");
  return isNaN(d.getTime())
    ? mk
    : d.toLocaleDateString("en", { month: "short", year: "2-digit" });
}

function buildAtlas(root: HTMLElement, data: AtlasPayload, deps: AtlasDeps): void {
  const nodes = data.nodes;
  const keys = Object.keys(nodes);
  const hasTypes = data.types.length > 0 && keys.length > 0;
  const hasMonths = data.monthKeys.length > 0;

  // Community colouring against the RENDERED node set (`data.nodes` IS the capped
  // projection the columns draw). Legend gating + slot ranking key off this, so a
  // community capped entirely out of the projection colours nothing and gets no
  // legend row (its dim-others click would otherwise dim everything).
  coloring = data.semantic ? computeColoring(data.semantic, keys) : null;
  if (!coloring) semanticOn = false; // no overlay data ⇒ toggle inert + hidden
  dimSlot = null; // els are rebuilt — any prior dim-others filter is stale
  clusterSel = null; // els are rebuilt — any prior cluster highlight is stale

  if (data.error) {
    root.innerHTML = `<div class="wiki-atlas-empty">${esc(data.error)}</div>`;
    return;
  }
  if (!hasTypes && !hasMonths) {
    root.innerHTML =
      '<div class="wiki-atlas-empty">This wiki has no linked pages to map yet — the Atlas needs typed pages with internal links.</div>';
    return;
  }

  // A projection with no data can't be the active one.
  if (proj === "months" && !hasMonths) proj = "types";
  if (proj === "types" && !hasTypes) proj = "months";

  root.innerHTML = shellHtml(data, hasTypes, hasMonths);

  // Inbound-within-atlas adjacency (for ego networks) — nodes that link TO a key.
  const inA: Record<string, string[]> = {};
  for (const k of keys) inA[k] = [];
  for (const k of keys) for (const l of nodes[k]!.links) if (inA[l]) inA[l]!.push(k);

  // name → key lookups (first registered wins on a collision — display-only).
  const keyByName = new Map<string, string>();
  const conceptKeyByName = new Map<string, string>();
  for (const k of keys) {
    const n = nodes[k]!.name.toLowerCase();
    if (!keyByName.has(n)) keyByName.set(n, k);
    if (nodes[k]!.t === "concept" && !conceptKeyByName.has(n)) conceptKeyByName.set(n, k);
  }

  const elsTypes: Record<string, HTMLElement> = {};
  const elsMonths: Record<string, HTMLElement> = {};

  if (hasTypes) buildTypeColumns(root, data, elsTypes);
  if (hasMonths) buildMonthColumns(root, data, elsMonths);
  buildTrails(root, data);
  buildTopics(root, data);

  const activeEls = () => (proj === "types" ? elsTypes : elsMonths);
  // The semantic legend + `.semantic-on` chrome are built here but populated only
  // when the overlay exists; the calls are placed after the `render`/helper defs.
  const activeCanvas = () =>
    root.querySelector(`.wiki-atlas-canvas[data-view="${proj}"]`) as HTMLElement | null;

  // ── Selection render ────────────────────────────────────────────────────
  const clearHighlights = () => {
    root.querySelectorAll(".wiki-atlas-canvas").forEach((cv) => {
      cv.classList.remove("sel");
      const svg = cv.querySelector("svg");
      if (svg) svg.innerHTML = "";
    });
    for (const el of [...Object.values(elsTypes), ...Object.values(elsMonths)]) {
      el.classList.remove("on", "center");
      const b = el.querySelector(".wiki-atlas-badge");
      if (b) b.textContent = "";
    }
    root
      .querySelectorAll(".wiki-atlas-trail.on, .wiki-atlas-topic.on")
      .forEach((e) => e.classList.remove("on"));
  };

  const stepsEl = () => root.querySelector(".wiki-atlas-steps") as HTMLElement;
  const titleEl = () => root.querySelector(".wiki-atlas-story-title") as HTMLElement;

  // ── Semantic overlay chrome (all no-ops when `coloring` is null) ──────────
  const slotCls = (slot: number) => (slot === SEM_OTHER_SLOT ? "sx" : "s" + slot);

  const setSemCount = (text: string) => {
    const el = root.querySelector(".wiki-atlas-semcount") as HTMLElement | null;
    if (el) el.textContent = text;
  };

  /** Fill the community legend from the (Types-gated) coloring. Rows come ONLY
   *  from communities colouring ≥1 rendered pill (the gating invariant), so a
   *  dim-others click can never dim everything. */
  const buildSemLegend = () => {
    const leg = root.querySelector(".wiki-atlas-semlegend") as HTMLElement | null;
    if (!leg || !coloring) return;
    const rows = coloring.legend
      .map((r) => {
        const c = slotCls(r.slot);
        return (
          `<button class="wiki-atlas-semrow" data-slotn="${r.slot}" title="${esc(r.label)} · ${r.count} page${r.count === 1 ? "" : "s"}">` +
          `<i class="wiki-atlas-dot ${c}"></i><span>${esc(r.label)}</span><em>${r.count}</em></button>`
        );
      })
      .join("");
    leg.innerHTML = '<span class="wiki-atlas-semhdr">Communities <i>fixed</i></span>' + rows;
  };

  /** Apply / clear the dim-others community filter over the active view. */
  const applyDim = () => {
    const target = dimSlot === null ? null : slotCls(dimSlot);
    for (const el of Object.values(activeEls())) {
      el.classList.toggle("semdim", target !== null && el.getAttribute("data-slot") !== target);
    }
    root
      .querySelectorAll(".wiki-atlas-semrow")
      .forEach((b) =>
        b.classList.toggle("on", dimSlot !== null && Number(b.getAttribute("data-slotn")) === dimSlot),
      );
  };

  /** Root `.semantic-on` (drives dot visibility) + Types-only legend visibility +
   *  cluster-rail visibility (shown in BOTH projections — it operates on the full
   *  graph, not the rendered columns). */
  const updateSemChrome = () => {
    root.classList.toggle("semantic-on", semanticOn && !!coloring);
    const leg = root.querySelector(".wiki-atlas-semlegend") as HTMLElement | null;
    if (leg) leg.style.display = semanticOn && coloring && proj === "types" ? "flex" : "none";
    const rail = root.querySelector(".wiki-atlas-clusters") as HTMLElement | null;
    if (rail) rail.style.display = semanticOn && coloring ? "block" : "none";
  };

  // ── Cluster rail (recomputed on threshold change; full-graph union-find) ────
  /** Recompute the components at the current threshold + repaint the rail body.
   *  Drops a stale cluster selection whose component no longer exists. */
  const buildClusterRail = () => {
    const body = root.querySelector(".wiki-atlas-clusters-body") as HTMLElement | null;
    if (!body) return;
    clustersNow = data.semantic ? computeClusters(data.semantic, threshold) : [];
    if (clusterSel && !clustersNow.some((c) => c.id === clusterSel)) clusterSel = null;
    const renderedSet = new Set(Object.keys(activeEls()));
    body.innerHTML = clusterRailHtml(clustersNow, renderedSet);
  };

  /** Dim non-members of the selected cluster in the active projection (reuses the
   *  legend's `.semdim` dim-others mechanism) + light the selected rail row. When
   *  no cluster is selected this is a no-op — `applyDim` has already reset semdim. */
  const applyClusterHighlight = () => {
    root
      .querySelectorAll(".wiki-atlas-cluster")
      .forEach((c) => c.classList.toggle("on", clusterSel !== null && c.getAttribute("data-cid") === clusterSel));
    if (clusterSel === null) return;
    const cluster = clustersNow.find((c) => c.id === clusterSel);
    const memberSet = new Set(cluster?.members ?? []);
    const els = Object.entries(activeEls());
    // Same guard as the node/topic path: a cluster whose members are ALL capped
    // out of the rendered projection would dim every visible pill with nothing
    // lit, and a fully-greyed canvas with no anchor reads as broken. The story
    // panel's "0 shown · N off-canvas" line carries the message instead.
    if (!els.some(([k]) => memberSet.has(k))) return;
    for (const [k, el] of els) {
      if (!memberSet.has(k)) el.classList.add("semdim");
    }
  };

  /** Draw dashed semantic-neighbour edges for a selected node (Types only),
   *  APPENDING to the wikilink edges already in the svg. Neighbour pills are lit
   *  so they escape the `.sel` dim; capped-out neighbours become "+N not shown". */
  const drawSemanticEdges = (cv: HTMLElement, center: string, steps: HTMLElement) => {
    if (!coloring || !data.semantic) return;
    const rk = Object.keys(elsTypes);
    const { rendered, hidden } = neighborsFor(
      data.semantic,
      center,
      threshold,
      rk,
      coloring.slotByKey,
    );
    const svg = cv.querySelector("svg") as SVGSVGElement | null;
    if (svg) {
      const ar = cv.getBoundingClientRect();
      const cEl = elsTypes[center];
      const cr = cEl?.getBoundingClientRect();
      let html = "";
      if (cr) {
        for (const nb of rendered) {
          const el = elsTypes[nb.key];
          if (!el) continue;
          el.classList.add("on");
          const r = el.getBoundingClientRect();
          const ny = r.top - ar.top + r.height / 2;
          const cy = cr.top - ar.top + cr.height / 2;
          const leftOf = r.right < cr.left;
          const x1 = leftOf ? r.right - ar.left : cr.right - ar.left;
          const y1 = leftOf ? ny : cy;
          const x2 = leftOf ? cr.left - ar.left : r.left - ar.left;
          const y2 = leftOf ? cy : ny;
          const mx = (x1 + x2) / 2;
          html += `<path class="wiki-atlas-sedge ${slotCls(nb.slot)}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
        }
      }
      svg.insertAdjacentHTML("beforeend", html);
    }
    setSemCount(
      `${rendered.length} similar${hidden > 0 ? " · +" + hidden + " not shown" : ""}`,
    );
    if (rendered.length || hidden > 0) {
      steps.insertAdjacentHTML(
        "beforeend",
        `<div class="wiki-atlas-seminfo">${rendered.length} semantic link${rendered.length === 1 ? "" : "s"} ≥ ${threshold.toFixed(3)} shown` +
          (hidden > 0 ? ` · +${hidden} similar not shown (capped out of view)` : "") +
          "</div>",
      );
    }
  };

  const render = () => {
    clearHighlights();
    applyDim();
    applyClusterHighlight();
    setSemCount("");
    const steps = stepsEl();
    const title = titleEl();
    if (!steps || !title) return;
    // A cluster selection owns the story panel + canvas dim (supersedes node/legend).
    if (clusterSel) {
      const cluster = clustersNow.find((c) => c.id === clusterSel);
      title.textContent = "Cluster";
      if (!cluster) {
        steps.innerHTML = '<div class="wiki-atlas-hint">Cluster gone at this threshold.</div>';
        return;
      }
      const renderedSet = new Set(Object.keys(activeEls()));
      const shown = cluster.members.filter((m) => renderedSet.has(m)).length;
      const badge = cluster.candidate
        ? '<div class="wiki-atlas-meta">✦ synthesis candidate — no synthesis page yet</div>'
        : "";
      steps.innerHTML =
        '<div class="wiki-atlas-step"><div class="wiki-atlas-num">◆</div><div>' +
        `<b>${esc(cluster.label || "cluster")}</b>` +
        `<div class="wiki-atlas-meta">${cluster.size} pages · ${shown} shown in this view · ` +
        `${cluster.members.length - shown} off-canvas</div>` +
        badge +
        '<div class="wiki-atlas-desc">Members are listed in the Clusters rail — every row opens its page.</div>' +
        "</div></div>";
      return;
    }
    if (!selection) {
      title.textContent = "Story";
      steps.innerHTML = '<div class="wiki-atlas-hint">Pick a trail or topic, or click a node.</div>';
      return;
    }
    const cv = activeCanvas();
    const els = activeEls();

    if (selection.kind === "curated") {
      renderCurated(root, data, selection.idx, cv, els, keyByName, steps, title, nodes);
    } else if (selection.kind === "topic") {
      renderTopic(root, data, selection.idx, cv, els, elsTypes, inA, conceptKeyByName, steps, title, nodes);
    } else {
      renderNode(root, selection.key, cv, els, elsTypes, inA, steps, title, nodes);
    }

    // Only dim the canvas when the renderer actually lit ≥1 node there — a topic
    // whose concept was capped out of `nodes`, or a Months selection whose hits
    // are all in the omitted tail, light nothing, and a fully-greyed canvas with
    // no anchor reads as broken. Leave it undimmed + note it in the story panel.
    if (cv) {
      const lit = cv.querySelectorAll(".wiki-atlas-node.on").length > 0;
      cv.classList.toggle("sel", lit);
      if (!lit) {
        steps.insertAdjacentHTML(
          "afterbegin",
          '<div class="wiki-atlas-hint">Not in this view — try the other projection.</div>',
        );
      }
    }

    // Semantic dashed edges — a Types-view, node-selection feature. Drawn AFTER
    // the wikilink edges (append), so the two edge kinds coexist in one svg.
    if (semanticOn && coloring && proj === "types" && cv && selection.kind === "node") {
      drawSemanticEdges(cv, selection.key, steps);
    }
  };

  // ── Events (scoped to this Atlas root) ──────────────────────────────────
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const projBtn = t.closest?.(".wiki-atlas-toggle button") as HTMLElement | null;
    if (projBtn) {
      const next = (projBtn.getAttribute("data-proj") as Projection) || "types";
      if (next !== proj && (next === "types" ? hasTypes : hasMonths)) {
        proj = next;
        dimSlot = null; // the dim-others filter is driven from the Types-only legend
        root.querySelectorAll(".wiki-atlas-toggle button").forEach((b) =>
          b.classList.toggle("on", b.getAttribute("data-proj") === proj),
        );
        root.querySelectorAll(".wiki-atlas-canvas").forEach((c) =>
          c.classList.toggle("active", c.getAttribute("data-view") === proj),
        );
        updateSemChrome(); // legend is Types-only
        buildClusterRail(); // refresh member "rendered in this view" marks
        render(); // redraw edges against the new projection's DOM positions
      }
      return;
    }
    // Semantic overlay toggle — flips the overlay on/off (data is already loaded).
    if (t.closest?.(".wiki-atlas-semtoggle")) {
      semanticOn = !semanticOn && !!coloring;
      if (!semanticOn) {
        dimSlot = null;
        clusterSel = null;
      }
      (t.closest(".wiki-atlas-semtoggle") as HTMLElement).classList.toggle("on", semanticOn);
      updateSemChrome();
      render();
      return;
    }
    // Community legend row — dim-others filter (mutually exclusive with a node
    // selection, so the two dimming intents never fight).
    const semRow = t.closest?.(".wiki-atlas-semrow") as HTMLElement | null;
    if (semRow) {
      const s = Number(semRow.getAttribute("data-slotn"));
      dimSlot = dimSlot === s ? null : s;
      if (dimSlot !== null) selection = null;
      render();
      return;
    }
    // Cluster rail collapse toggle.
    if (t.closest?.(".wiki-atlas-clusters-toggle")) {
      const card = root.querySelector(".wiki-atlas-clusters");
      const collapsed = card?.classList.toggle("collapsed");
      const btn = card?.querySelector(".wiki-atlas-clusters-toggle");
      if (btn) btn.textContent = collapsed ? "▸" : "▾";
      return;
    }
    // A cluster member row — deep-links to the reader page (rendered or not).
    const cmember = t.closest?.(".wiki-atlas-cmember") as HTMLElement | null;
    if (cmember) {
      const key = cmember.getAttribute("data-key");
      if (key) deps.openPage(key, stemOf(key));
      return;
    }
    // A cluster row — toggle its highlight (dims non-members in the active view).
    // Blob-guarded clusters aren't selectable (they'd dim ~everything).
    const clusterEl = t.closest?.(".wiki-atlas-cluster") as HTMLElement | null;
    if (clusterEl) {
      const cid = clusterEl.getAttribute("data-cid");
      const c = cid ? clustersNow.find((x) => x.id === cid) : null;
      if (c && !c.tooBroad) {
        clusterSel = clusterSel === cid ? null : cid;
        if (clusterSel) {
          selection = null; // a cluster supersedes a node/topic/trail selection
          dimSlot = null; // …and the legend dim-others filter
        }
        render();
      }
      return;
    }
    if (t.closest?.(".wiki-atlas-clear")) {
      selection = null;
      clusterSel = null;
      render();
      return;
    }
    const open = t.closest?.(".wiki-atlas-open") as HTMLElement | null;
    if (open) {
      const key = open.getAttribute("data-key");
      if (key && nodes[key]) deps.openPage(key, nodes[key]!.name);
      return;
    }
    const trail = t.closest?.(".wiki-atlas-trail") as HTMLElement | null;
    if (trail) {
      const idx = Number(trail.getAttribute("data-idx"));
      // Clicking the already-selected trail toggles it off.
      selection =
        selection?.kind === "curated" && selection.idx === idx ? null : { kind: "curated", idx };
      clusterSel = null; // a trail selection supersedes a cluster highlight
      render();
      return;
    }
    const topic = t.closest?.(".wiki-atlas-topic") as HTMLElement | null;
    if (topic) {
      const idx = Number(topic.getAttribute("data-idx"));
      selection =
        selection?.kind === "topic" && selection.idx === idx ? null : { kind: "topic", idx };
      clusterSel = null; // a topic selection supersedes a cluster highlight
      render();
      return;
    }
    const node = t.closest?.(".wiki-atlas-node") as HTMLElement | null;
    if (node) {
      const key = node.getAttribute("data-key");
      if (key) {
        dimSlot = null; // a node selection supersedes any dim-others filter
        clusterSel = null; // …and any cluster highlight
        selection = selection?.kind === "node" && selection.key === key ? null : { kind: "node", key };
        render();
      }
      return;
    }
    // Click on empty canvas background (not a node) clears the selection —
    // same effect as the Clear button.
    if (t.closest?.(".wiki-atlas-canvas") && (selection || clusterSel)) {
      selection = null;
      clusterSel = null;
      render();
    }
  });

  // Redraw selection edges on resize — bound once for the page lifetime; it
  // reads the live module `selection`/`proj`, so a rebuilt Atlas stays covered.
  if (!resizeBound) {
    resizeBound = true;
    let raf = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = document.getElementById("wikiAtlasRoot");
        if (r) r.dispatchEvent(new CustomEvent("wiki-atlas-redraw"));
      });
    });
  }
  root.addEventListener("wiki-atlas-redraw", () => render());

  // Threshold slider — the semantic-EDGE gate (node colours are fixed). Live:
  // updates the readout + redraws the selected node's dashed edges each tick.
  root.addEventListener("input", (e) => {
    const inp = (e.target as HTMLElement)?.closest?.(
      ".wiki-atlas-semthresh input",
    ) as HTMLInputElement | null;
    if (!inp) return;
    threshold = Number(inp.value);
    const val = root.querySelector(".wiki-atlas-semval") as HTMLElement | null;
    if (val) val.textContent = threshold.toFixed(3);
    buildClusterRail(); // union-find components recompute at the new threshold
    render();
  });

  buildSemLegend();
  buildClusterRail();
  updateSemChrome();
  render();
}

// ── Shell + columns ───────────────────────────────────────────────────────

export function shellHtml(data: AtlasPayload, hasTypes: boolean, hasMonths: boolean): string {
  const legend = data.types
    .map((t) => `<span><i class="wiki-atlas-swatch type-${esc(t.key)}"></i>${esc(t.label)}</span>`)
    .join("");
  const hubSwatch = Object.values(data.nodes).some((n) => n.hub)
    ? '<span><i class="wiki-atlas-swatch type-hub"></i>Source hub</span>'
    : "";
  const typesBtn = `<button data-proj="types"${proj === "types" ? ' class="on"' : ""}${hasTypes ? "" : " disabled"}>Types</button>`;
  const monthsBtn = `<button data-proj="months"${proj === "months" ? ' class="on"' : ""}${hasMonths ? "" : " disabled"}>Months</button>`;
  // Semantic overlay controls — rendered ONLY when the payload carries an overlay,
  // so a no-overlay wiki's head is byte-identical to the pre-overlay markup.
  const sem = data.semantic
    ? '<div class="wiki-atlas-semctl">' +
      `<button class="wiki-atlas-semtoggle${semanticOn ? " on" : ""}" title="Overlay huginn semantic communities + similarity edges">semantic</button>` +
      '<label class="wiki-atlas-semthresh"><span>similar ≥</span>' +
      `<input type="range" min="${SEM_THRESHOLD_MIN}" max="${SEM_THRESHOLD_MAX}" step="${SEM_THRESHOLD_STEP}" value="${threshold}">` +
      `<b class="wiki-atlas-semval">${threshold.toFixed(3)}</b></label>` +
      '<span class="wiki-atlas-semcount"></span>' +
      "</div>"
    : "";
  // Community legend (second head row, Types-only, hidden until the toggle is on).
  const semLegend = data.semantic ? '<div class="wiki-atlas-semlegend"></div>' : "";
  // Cluster rail card (side column, both projections, hidden until the toggle is
  // on). Header copy is deliberately "Clusters at threshold" — the two-partition
  // split from the fixed "Communities" legend must stay legible.
  const clusterRail = data.semantic
    ? '<div class="wiki-atlas-card wiki-atlas-clusters" style="display:none">' +
      '<h2 class="wiki-atlas-clusters-hdr">Clusters at threshold' +
      '<button class="wiki-atlas-clusters-toggle" title="Collapse cluster rail">▾</button></h2>' +
      '<div class="wiki-atlas-clusters-body"></div></div>'
    : "";
  return (
    '<div class="wiki-atlas-head">' +
    `<div class="wiki-atlas-toggle">${typesBtn}${monthsBtn}</div>` +
    `<div class="wiki-atlas-legend">${hubSwatch}${legend}</div>` +
    sem +
    "</div>" +
    semLegend +
    '<div class="wiki-atlas-body">' +
    '<div class="wiki-atlas-canvas-wrap">' +
    `<div class="wiki-atlas-canvas${proj === "types" ? " active" : ""}" data-view="types"><svg></svg><div class="wiki-atlas-cols"></div></div>` +
    `<div class="wiki-atlas-canvas${proj === "months" ? " active" : ""}" data-view="months"><svg></svg><div class="wiki-atlas-cols"></div></div>` +
    "</div>" +
    '<div class="wiki-atlas-side">' +
    '<div class="wiki-atlas-card wiki-atlas-trails"><h2>Trails</h2>' +
    '<div class="wiki-atlas-sect wiki-atlas-sect-curated">Curated</div><div class="wiki-atlas-curated"></div>' +
    '<div class="wiki-atlas-sect wiki-atlas-sect-topics">Topics · auto</div><div class="wiki-atlas-topics"></div>' +
    '<button class="wiki-atlas-clear">Clear selection</button></div>' +
    '<div class="wiki-atlas-card wiki-atlas-story"><h2 class="wiki-atlas-story-title">Story</h2>' +
    '<div class="wiki-atlas-steps"><div class="wiki-atlas-hint">Pick a trail or topic, or click a node.</div></div></div>' +
    clusterRail +
    "</div>" +
    "</div>"
  );
}

/**
 * Render the cluster rail body from the union-find components at the current
 * threshold. Each ≥3-member cluster shows a label + size + an optional synthesis-
 * candidate badge, then its member rows (each deep-links regardless of whether it
 * is rendered on the canvas — off-canvas members are muted). A blob-guarded
 * cluster (> RAIL_BLOB_MAX) shows only a header + "raise the threshold" note.
 *
 * Follow-up seam (no code): a `candidate` cluster's `{ members, label }` is exactly
 * the input shape a future consolidation-gardener "Draft synthesis" button would
 * post into the `wiki_proposals` gate as one clustered proposal.
 */
function clusterRailHtml(clusters: RailCluster[], renderedSet: Set<string>): string {
  if (!clusters.length) {
    return '<div class="wiki-atlas-hint">No clusters at this threshold — lower the “similar ≥” slider.</div>';
  }
  return clusters
    .map((c) => {
      const badge = c.candidate
        ? '<span class="wiki-atlas-cbadge" title="≥3 narrative-type pages and no synthesis page yet — a consolidation candidate">synthesis candidate</span>'
        : "";
      const head =
        '<div class="wiki-atlas-cluster-head">' +
        `<b>${esc(c.label || "cluster")}</b><em>${c.size}</em>${badge}</div>`;
      if (c.tooBroad) {
        return (
          `<div class="wiki-atlas-cluster broad" data-cid="${esc(c.id)}">${head}` +
          '<div class="wiki-atlas-cbroad">too broad — raise the threshold</div></div>'
        );
      }
      const members = c.members
        .map((m) => {
          const muted = renderedSet.has(m) ? "" : " muted";
          return `<button class="wiki-atlas-cmember${muted}" data-key="${esc(m)}" title="${esc(m)}">${esc(stemOf(m))}</button>`;
        })
        .join("");
      return (
        `<div class="wiki-atlas-cluster" data-cid="${esc(c.id)}">${head}` +
        `<div class="wiki-atlas-cluster-members">${members}</div></div>`
      );
    })
    .join("");
}

export function nodeHtml(key: string, n: AtlasNode, dataT: string): string {
  const sub = (n.tags || []).slice(0, 3).join(" · ") || n.date || "";
  // Community dot + slot class (fixed Louvain colour; CSS-hidden unless the
  // overlay toggle is on). Emitted only when the node carries a community, so a
  // no-overlay payload produces byte-identical pill markup.
  const slot = coloring ? coloring.slotByKey[key] : undefined;
  let dot = "";
  let slotCls = "";
  if (slot !== undefined) {
    const scls = slot === SEM_OTHER_SLOT ? "sx" : `s${slot}`;
    const label = coloring!.labelByKey[key] ?? "";
    dot = `<i class="wiki-atlas-dot ${scls}" title="${esc(label)}"></i>`;
    slotCls = ` data-slot="${scls}"`;
  }
  return (
    `<div class="wiki-atlas-node" data-t="${esc(dataT)}"${slotCls} data-key="${esc(key)}" title="${esc(n.name)}">` +
    '<span class="wiki-atlas-badge"></span>' +
    dot +
    `<b>${esc(n.name)}</b>` +
    `<small>${esc(sub)}</small>` +
    "</div>"
  );
}

function buildTypeColumns(
  root: HTMLElement,
  data: AtlasPayload,
  els: Record<string, HTMLElement>,
): void {
  const nodes = data.nodes;
  const keys = Object.keys(nodes);
  const colsEl = root.querySelector('.wiki-atlas-canvas[data-view="types"] .wiki-atlas-cols');
  if (!colsEl) return;

  interface Col {
    label: string;
    t: string;
    keys: string[];
    omitted: number;
  }
  const cols: Col[] = [];
  const hubKeys = keys.filter((k) => nodes[k]!.hub);
  if (hubKeys.length) cols.push({ label: "Source hubs", t: "hub", keys: hubKeys, omitted: 0 });
  // Columns in the payload's own (source-first) order; source excludes hubs.
  for (const ty of data.types) {
    let colKeys = keys.filter((k) => nodes[k]!.t === ty.key);
    if (ty.key === "source") colKeys = colKeys.filter((k) => !nodes[k]!.hub);
    cols.push({
      label: ty.label,
      t: ty.key,
      keys: colKeys,
      omitted: data.omitted.byType[ty.key] ?? 0,
    });
  }

  for (const col of cols) {
    const sorted = col.keys.slice().sort((a, b) => nodes[b]!.in - nodes[a]!.in);
    const colEl = document.createElement("div");
    colEl.className = "wiki-atlas-col";
    colEl.innerHTML = `<h3>${esc(col.label)} <span class="wiki-atlas-count">· ${sorted.length}</span></h3>`;
    for (const k of sorted) {
      colEl.insertAdjacentHTML("beforeend", nodeHtml(k, nodes[k]!, col.t));
      els[k] = colEl.lastElementChild as HTMLElement;
    }
    if (col.omitted > 0) {
      colEl.insertAdjacentHTML(
        "beforeend",
        `<div class="wiki-atlas-more">+ ${col.omitted} more not shown</div>`,
      );
    }
    colsEl.appendChild(colEl);
  }
}

function buildMonthColumns(
  root: HTMLElement,
  data: AtlasPayload,
  els: Record<string, HTMLElement>,
): void {
  const nodes = data.nodes;
  const colsEl = root.querySelector('.wiki-atlas-canvas[data-view="months"] .wiki-atlas-cols');
  if (!colsEl) return;
  const fullCounts = data.monthKeys.map(
    (mk) => (data.months[mk]?.length ?? 0) + (data.omitted.byMonth[mk] ?? 0),
  );
  const maxMonth = Math.max(1, ...fullCounts);

  data.monthKeys.forEach((mk, i) => {
    const visible = (data.months[mk] ?? [])
      .slice()
      .sort((a, b) => (nodes[a]?.date ?? "").localeCompare(nodes[b]?.date ?? ""));
    const omitted = data.omitted.byMonth[mk] ?? 0;
    const colEl = document.createElement("div");
    colEl.className = "wiki-atlas-col";
    const barW = Math.round((100 * fullCounts[i]!) / maxMonth);
    colEl.innerHTML =
      `<h3>${esc(monthLabel(mk))} <span class="wiki-atlas-count">· ${fullCounts[i]}</span></h3>` +
      `<div class="wiki-atlas-bar" style="width:${barW}%"></div>`;
    for (const k of visible) {
      if (!nodes[k]) continue;
      colEl.insertAdjacentHTML("beforeend", nodeHtml(k, nodes[k]!, nodes[k]!.hub ? "hub" : nodes[k]!.t));
      els[k] = colEl.lastElementChild as HTMLElement;
    }
    if (omitted > 0) {
      colEl.insertAdjacentHTML("beforeend", `<div class="wiki-atlas-more">+ ${omitted} more</div>`);
    }
    colsEl.appendChild(colEl);
  });
}

function buildTrails(root: HTMLElement, data: AtlasPayload): void {
  const list = root.querySelector(".wiki-atlas-curated") as HTMLElement | null;
  const sect = root.querySelector(".wiki-atlas-sect-curated") as HTMLElement | null;
  if (!list) return;
  if (!data.trails.length) {
    if (sect) sect.style.display = "none";
    list.innerHTML = "";
    return;
  }
  list.innerHTML = data.trails
    .map(
      (t, i) =>
        `<div class="wiki-atlas-trail" data-idx="${i}">` +
        `<span class="wiki-atlas-len">${t.steps.length} steps</span>` +
        `<b>${esc(t.title)}</b><small>${esc(t.blurb)}</small></div>`,
    )
    .join("");
}

function buildTopics(root: HTMLElement, data: AtlasPayload): void {
  const list = root.querySelector(".wiki-atlas-topics") as HTMLElement | null;
  const sect = root.querySelector(".wiki-atlas-sect-topics") as HTMLElement | null;
  if (!list) return;
  if (!data.topics.length) {
    if (sect) sect.style.display = "none";
    list.innerHTML = "";
    return;
  }
  list.innerHTML = data.topics
    .map((tp, i) => {
      const mx = Math.max(1, ...tp.perMonth);
      const spark = tp.perMonth
        .map((v) => `<i style="height:${Math.max(2, Math.round(14 * (v / mx)))}px"></i>`)
        .join("");
      return (
        `<div class="wiki-atlas-topic" data-idx="${i}">` +
        `<b>${esc(tp.name)}</b>` +
        `<span class="wiki-atlas-spark">${spark}</span>` +
        `<span class="wiki-atlas-n">${tp.count}</span></div>`
      );
    })
    .join("");
}

// ── Selection renderers ─────────────────────────────────────────────────────

function renderCurated(
  root: HTMLElement,
  data: AtlasPayload,
  idx: number,
  cv: HTMLElement | null,
  els: Record<string, HTMLElement>,
  keyByName: Map<string, string>,
  steps: HTMLElement,
  title: HTMLElement,
  nodes: Record<string, AtlasNode>,
): void {
  const trail = data.trails[idx];
  if (!trail) return;
  root.querySelector(`.wiki-atlas-trail[data-idx="${idx}"]`)?.classList.add("on");
  title.textContent = "Story";

  // Resolve each step to a node key; a step present in the active projection is
  // "visible", otherwise it stays as a greyed ghost in the panel.
  const stepKeys = trail.steps.map((s) => keyByName.get(s.page.toLowerCase()));
  let path = stepKeys.filter((k): k is string => !!k && !!els[k]);
  if (proj === "months") {
    path = path.slice().sort((a, b) => (nodes[a]?.date ?? "").localeCompare(nodes[b]?.date ?? ""));
  }
  const stepNo = new Map<string, number>();
  path.forEach((k, j) => {
    stepNo.set(k, j + 1);
    els[k]!.classList.add("on");
    const b = els[k]!.querySelector(".wiki-atlas-badge");
    if (b) b.textContent = String(j + 1);
  });
  if (cv) drawPath(cv, els, path);

  let html = `<div class="wiki-atlas-intro"><b>${esc(trail.title)}</b> — ${esc(trail.blurb)}</div>`;
  // Sort panel rows to match badge numbers; ghosts (no number) sink to the end.
  const ordered = trail.steps
    .map((s, i) => ({ s, k: stepKeys[i] }))
    .sort((a, b) => {
      const na = a.k ? (stepNo.get(a.k) ?? 1e9) : 1e9;
      const nb = b.k ? (stepNo.get(b.k) ?? 1e9) : 1e9;
      return na - nb;
    });
  for (const { s, k } of ordered) {
    const num = k ? stepNo.get(k) : undefined;
    const vis = num !== undefined;
    const node = k ? nodes[k] : undefined;
    const meta = node
      ? `${esc(node.t)}${node.date ? " · " + esc(node.date) : ""}`
      : s.resolved
        ? "page"
        : "unresolved";
    html +=
      `<div class="wiki-atlas-step${vis ? "" : " ghost"}">` +
      `<div class="wiki-atlas-num">${vis ? num : "·"}</div><div>` +
      `<b>${esc(s.page)}</b>` +
      `<div class="wiki-atlas-meta">${meta}${vis ? "" : " · not in this view"}</div>` +
      `<div class="wiki-atlas-note">${esc(s.note)}</div></div></div>`;
  }
  steps.innerHTML = html;
  if (path.length && els[path[0]!]) {
    els[path[0]!]!.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

function renderTopic(
  root: HTMLElement,
  data: AtlasPayload,
  idx: number,
  cv: HTMLElement | null,
  els: Record<string, HTMLElement>,
  elsTypes: Record<string, HTMLElement>,
  inA: Record<string, string[]>,
  conceptKeyByName: Map<string, string>,
  steps: HTMLElement,
  title: HTMLElement,
  nodes: Record<string, AtlasNode>,
): void {
  const topic = data.topics[idx];
  if (!topic) return;
  root.querySelector(`.wiki-atlas-topic[data-idx="${idx}"]`)?.classList.add("on");
  title.textContent = "Chronicle";

  const conceptKey = conceptKeyByName.get(topic.name.toLowerCase());
  // Inbound sources linking to the concept, chronological (the topic's captures).
  const hits = conceptKey
    ? (inA[conceptKey] ?? [])
        .filter((k) => nodes[k]?.t === "source")
        .sort((a, b) => (nodes[a]?.date ?? "").localeCompare(nodes[b]?.date ?? ""))
    : [];

  if (proj === "months") {
    const visible = hits.filter((k) => els[k]);
    visible.forEach((k, i) => {
      els[k]!.classList.add("on");
      const b = els[k]!.querySelector(".wiki-atlas-badge");
      if (b) b.textContent = String(i + 1);
    });
    if (cv) drawPath(cv, els, visible);
    if (visible.length && els[visible[0]!]) {
      els[visible[0]!]!.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  } else if (conceptKey) {
    // Types projection: ego-network star around the concept node.
    drawEgoStar(cv, elsTypes, inA, nodes, conceptKey);
  }

  // Chronicle panel — always chronological (dates carry the story in both views).
  const first = hits[0] ? nodes[hits[0]]?.date ?? "" : "";
  const last = hits.length ? nodes[hits[hits.length - 1]!]?.date ?? "" : "";
  let html =
    '<div class="wiki-atlas-step"><div class="wiki-atlas-num">★</div><div>' +
    `<b>${esc(topic.name)}</b>` +
    `<div class="wiki-atlas-meta">${hits.length} captures${first ? " · " + esc(first) + " → " + esc(last) : ""}</div>` +
    (topic.desc ? `<div class="wiki-atlas-desc">${esc(topic.desc)}</div>` : "") +
    "</div></div>";
  let prevMonth: string | null = null;
  hits.slice(0, MONTH_VISIBLE_STEPS).forEach((k, i) => {
    const date = nodes[k]?.date ?? "";
    const m = date.slice(0, 7);
    if (prevMonth && m && m > prevMonth) {
      // True month arithmetic (both keys are YYYY-MM) — count the EMPTY months
      // between the two captures, immune to 28/30/31-day drift. `quiet ≥ 1` ⇒ at
      // least one fully silent month.
      const [py, pm] = prevMonth.split("-").map(Number);
      const [cy, cm] = m.split("-").map(Number);
      const quiet = (cy! - py!) * 12 + (cm! - pm!) - 1;
      if (quiet >= 1) {
        html += `<div class="wiki-atlas-gap">— quiet for ~${quiet} month${quiet === 1 ? "" : "s"} —</div>`;
      }
    }
    if (m) prevMonth = m;
    const d = nodes[k];
    html +=
      `<div class="wiki-atlas-step"><div class="wiki-atlas-num">${i + 1}</div><div>` +
      `<b>${esc(d?.name ?? k)}</b>` +
      `<div class="wiki-atlas-meta">${esc(date)}</div>` +
      (d?.desc ? `<div class="wiki-atlas-desc">${esc(d.desc.slice(0, 130))}</div>` : "") +
      "</div></div>";
  });
  if (hits.length > MONTH_VISIBLE_STEPS) {
    html += `<div class="wiki-atlas-hint">…and ${hits.length - MONTH_VISIBLE_STEPS} more captures.</div>`;
  } else if (!hits.length) {
    html += '<div class="wiki-atlas-hint">No mapped source captures for this topic in the current view.</div>';
  }
  steps.innerHTML = html;
}

function renderNode(
  root: HTMLElement,
  key: string,
  cv: HTMLElement | null,
  els: Record<string, HTMLElement>,
  elsTypes: Record<string, HTMLElement>,
  inA: Record<string, string[]>,
  steps: HTMLElement,
  title: HTMLElement,
  nodes: Record<string, AtlasNode>,
): void {
  const n = nodes[key];
  if (!n) return;
  title.textContent = "Page";

  // Ego star only meaningful in the Types projection (all types present there);
  // in Months just highlight the node in the active-view els (elsMonths) if it
  // lives there — passing the ACTIVE els is what makes the Months click light up.
  if (proj === "types" && elsTypes[key]) {
    drawEgoStar(cv, elsTypes, inA, nodes, key);
  } else {
    els[key]?.classList.add("on", "center");
    els[key]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  steps.innerHTML =
    '<div class="wiki-atlas-step"><div class="wiki-atlas-num">★</div><div>' +
    `<b>${esc(n.name)}</b>` +
    `<div class="wiki-atlas-meta">${esc(n.t)}${n.hub ? " · hub" : ""} · ${n.in} inbound${n.date ? " · " + esc(n.date) : ""}</div>` +
    (n.desc ? `<div class="wiki-atlas-desc">${esc(n.desc)}</div>` : "") +
    `<button class="wiki-atlas-open" data-key="${esc(key)}">Open in reader →</button>` +
    "</div></div>";
}

// ── SVG edge drawing (selection-only, from live DOM positions) ───────────────

function sizeSvg(cv: HTMLElement, svg: SVGSVGElement): void {
  svg.setAttribute("width", String(cv.scrollWidth));
  svg.setAttribute("height", String(cv.scrollHeight));
  svg.style.width = cv.scrollWidth + "px";
  svg.style.height = cv.scrollHeight + "px";
}

function drawPath(cv: HTMLElement, els: Record<string, HTMLElement>, pathKeys: string[]): void {
  const svg = cv.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  sizeSvg(cv, svg);
  const ar = cv.getBoundingClientRect();
  let html = "";
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const ea = els[pathKeys[i]!];
    const eb = els[pathKeys[i + 1]!];
    if (!ea || !eb) continue;
    const a = ea.getBoundingClientRect();
    const b = eb.getBoundingClientRect();
    const sameCol = Math.abs(a.left - b.left) < 5;
    const goRight = b.left >= a.right;
    const x1 = (sameCol ? a.left + 4 : goRight ? a.right : a.left) - ar.left;
    const y1 = a.top - ar.top + a.height / 2;
    const x2 = (sameCol ? b.left + 4 : goRight ? b.left : b.right) - ar.left;
    const y2 = b.top - ar.top + b.height / 2;
    const mx = sameCol ? x1 - 16 : (x1 + x2) / 2;
    html += `<path class="wiki-atlas-edge" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
  }
  svg.innerHTML = html;
}

/** Light + anchor an ego-network star around `center` in the Types projection:
 *  mark the center + its 1-hop hood `.on`, flag the center `.center`, draw the
 *  star edges, and scroll it into view. Shared verbatim by the topic (concept ego)
 *  and node selection renderers. */
function drawEgoStar(
  cv: HTMLElement | null,
  elsTypes: Record<string, HTMLElement>,
  inA: Record<string, string[]>,
  nodes: Record<string, AtlasNode>,
  center: string,
): void {
  const hood = new Set<string>([center, ...(nodes[center]?.links ?? []), ...(inA[center] ?? [])]);
  for (const k of hood) elsTypes[k]?.classList.add("on");
  elsTypes[center]?.classList.add("center");
  if (cv) drawStar(cv, elsTypes, center, hood);
  elsTypes[center]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function drawStar(
  cv: HTMLElement,
  els: Record<string, HTMLElement>,
  center: string,
  hood: Set<string>,
): void {
  const svg = cv.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  sizeSvg(cv, svg);
  const ar = cv.getBoundingClientRect();
  const cEl = els[center];
  if (!cEl) return;
  const cr = cEl.getBoundingClientRect();
  const cx = { l: cr.left - ar.left, r: cr.right - ar.left, y: cr.top - ar.top + cr.height / 2 };
  let html = "";
  for (const k of hood) {
    if (k === center) continue;
    const el = els[k];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const ny = r.top - ar.top + r.height / 2;
    const leftOf = r.right < cr.left;
    const x1 = leftOf ? r.right - ar.left : cx.r;
    const y1 = leftOf ? ny : cx.y;
    const x2 = leftOf ? cx.l : r.left - ar.left;
    const y2 = leftOf ? cx.y : ny;
    const mx = (x1 + x2) / 2;
    html += `<path class="wiki-atlas-edge wiki-atlas-edge-star" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
  }
  svg.innerHTML = html;
}
