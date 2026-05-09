/// <reference lib="dom" />
/**
 * Browser entrypoint for the traces-waterfall script. Bundled by Bun.build()
 * (see traces-waterfall-client.ts) and injected as an IIFE into the traces
 * page's inline `<script>`.
 *
 * Two cross-script bridges to mind:
 *  - Writes `currentWaterfallTraceId` and `waterfallSpans` onto `globalThis`
 *    because `traces-prompt-modal.ts` reads them as bare identifiers from the
 *    surrounding inline-script global scope.
 *  - Exposes the click handlers (`loadWaterfall`, `closeWaterfall`,
 *    `closeSpanDetails`) on `globalThis` so HTML inline `onclick=` attrs and
 *    `traces-list.ts`'s `loadWaterfall(traceId)` can call them by bare name.
 *
 * `renderToolDetail` and `__tdrState` are read off `globalThis` because their
 * source (`tool-detail-renderers.ts`) is still a JS-string component.
 */

import { escHtml } from "./escape.ts";
import { extractToolInputLabel } from "./tool-helpers.ts";
import { deriveSpanLabelHtml } from "./span-label.ts";
import { fmtDuration } from "./helpers.ts";

interface WaterfallSpan {
  id: string;
  parentId?: string | null;
  name: string;
  kind: string;
  status: string;
  startedAt: number;
  durationMs?: number | null;
  attributes?: {
    toolName?: unknown;
    toolId?: unknown;
    input?: unknown;
    synthesized?: boolean;
    connector?: string;
    model?: string;
    requestedModel?: string;
    [k: string]: unknown;
  };
}

interface WaterfallGlobals {
  currentWaterfallTraceId: string | null;
  waterfallSpans: WaterfallSpan[];
  loadWaterfall: (traceId: string) => Promise<void>;
  closeWaterfall: () => void;
  closeSpanDetails: () => void;
  renderToolDetail?: (span: WaterfallSpan) => string;
  __tdrState?: { showRaw: boolean; showResponse: boolean; attrs: unknown };
}

const g = globalThis as typeof globalThis & WaterfallGlobals;
g.currentWaterfallTraceId = null;
g.waterfallSpans = [];

let waterfallSpanById: Record<string, WaterfallSpan> = {};
let waterfallChildrenByParent: Record<string, WaterfallSpan[]> = {};
let collapsedSpanIds = new Set<string>();

function buildWaterfallState(spans: WaterfallSpan[]): {
  sorted: WaterfallSpan[];
  spanById: Record<string, WaterfallSpan>;
  childrenByParent: Record<string, WaterfallSpan[]>;
} {
  const spanById: Record<string, WaterfallSpan> = {};
  const childrenByParent: Record<string, WaterfallSpan[]> = {};
  spans.forEach((s) => {
    spanById[s.id] = s;
    if (s.parentId) {
      if (!childrenByParent[s.parentId]) childrenByParent[s.parentId] = [];
      childrenByParent[s.parentId]!.push(s);
    }
  });
  // The DB sort by startedAt is unstable when a synthesized stage span starts
  // at offset 0 from its tool parent — without explicit DFS the child renders
  // above the parent.
  const byStart = (a: WaterfallSpan, b: WaterfallSpan) => a.startedAt - b.startedAt;
  const roots = spans.filter((s) => !s.parentId || !spanById[s.parentId]).sort(byStart);
  Object.keys(childrenByParent).forEach((k) => childrenByParent[k]!.sort(byStart));

  const sorted: WaterfallSpan[] = [];
  const visited = new Set<string>();
  function visit(s: WaterfallSpan) {
    if (visited.has(s.id)) return;
    visited.add(s.id);
    sorted.push(s);
    childrenByParent[s.id]?.forEach(visit);
  }
  roots.forEach(visit);
  // Append unreachable nodes so a malformed tree doesn't silently drop spans.
  // An orphan means a parent_id pointed at a span that wasn't returned —
  // surface the count to the operator console.
  let orphans = 0;
  spans.forEach((s) => {
    if (!visited.has(s.id)) {
      sorted.push(s);
      orphans++;
    }
  });
  if (orphans > 0) {
    console.warn(
      "[trace] " + orphans + " orphan span(s) attached at root — parent_id missing from trace",
    );
  }
  return { sorted, spanById, childrenByParent };
}

async function loadWaterfall(traceId: string): Promise<void> {
  try {
    g.currentWaterfallTraceId = traceId;
    const res = await fetch("/api/traces/" + traceId);
    const { spans } = (await res.json()) as { spans: WaterfallSpan[] };
    if (spans.length === 0) return;

    document.getElementById("waterfallContainer")!.classList.add("visible");

    const root = spans.find((s) => !s.parentId) || spans[0]!;
    document.getElementById("waterfallTitle")!.textContent =
      root.name + " (" + fmtDuration(root.durationMs) + ")";

    document
      .querySelectorAll(".trace-table tr")
      .forEach((r) => r.classList.remove("expanded"));
    document
      .querySelector('tr[data-trace="' + traceId + '"]')
      ?.classList.add("expanded");

    // Single index pass per trace load — renderWaterfall and the collapse
    // helpers all read from this cache, so chevron toggles don't re-walk.
    const built = buildWaterfallState(spans);
    g.waterfallSpans = built.sorted;
    waterfallSpanById = built.spanById;
    waterfallChildrenByParent = built.childrenByParent;

    // Auto-collapse parents whose children are synthesized stage spans
    // (index.fetch / boost.title / assemble). Same info is one click away
    // in the search detail panel.
    collapsedSpanIds = new Set();
    g.waterfallSpans.forEach((s) => {
      if (spanHasCollapsibleChildren(s.id)) collapsedSpanIds.add(s.id);
    });

    renderWaterfall();
    document.getElementById("spanDetails")!.classList.remove("visible");
  } catch (e) {
    console.error("Failed to load waterfall", e);
  }
}

function spanHasCollapsibleChildren(spanId: string): boolean {
  const kids = waterfallChildrenByParent[spanId] || [];
  return kids.some((k) => k.attributes?.synthesized === true);
}

function toggleCollapse(spanId: string): void {
  if (collapsedSpanIds.has(spanId)) collapsedSpanIds.delete(spanId);
  else collapsedSpanIds.add(spanId);
  renderWaterfall();
}

// The AI span is recorded internally as "claude" regardless of which
// connector handled the call. Render the label as "{connector}, {model}"
// (e.g. "copilot-sdk, claude-sonnet-4-6") so the waterfall reflects what
// actually ran.
function isAiSpan(s: WaterfallSpan): boolean {
  if (!s || s.name !== "claude") return false;
  const a = s.attributes ?? {};
  return !!(a.connector || a.model || a.requestedModel);
}
function aiSpanLabel(s: WaterfallSpan): string {
  const a = s.attributes ?? {};
  const conn = a.connector || "claude-cli";
  const model = a.model || a.requestedModel || "";
  return model ? conn + ", " + model : conn;
}

function isToolSpan(s: WaterfallSpan): boolean {
  return !!(s.attributes?.toolName || s.attributes?.toolId);
}

function renderWaterfall(): void {
  const spans = g.waterfallSpans;
  const el = document.getElementById("waterfall")!;
  if (spans.length === 0) {
    el.innerHTML = '<div class="empty">No spans</div>';
    return;
  }

  // One DFS from each collapsed root marks every descendant — turns the
  // per-row ancestor walk into an O(1) Set lookup.
  const hiddenSpanIds = new Set<string>();
  function hideDescendants(parentId: string): void {
    const kids = waterfallChildrenByParent[parentId];
    if (!kids) return;
    for (const k of kids) {
      hiddenSpanIds.add(k.id);
      hideDescendants(k.id);
    }
  }
  collapsedSpanIds.forEach(hideDescendants);

  function nestingDepth(s: WaterfallSpan): number {
    let depth = 0;
    let current: WaterfallSpan = s;
    while (current.parentId && waterfallSpanById[current.parentId]) {
      depth++;
      current = waterfallSpanById[current.parentId]!;
    }
    return depth;
  }

  // spread + map allocates twice and risks "too many arguments" for traces
  // with thousands of spans, so fold min/max in one pass.
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const s of spans) {
    if (s.startedAt < minTime) minTime = s.startedAt;
    const end = s.startedAt + (s.durationMs || 0);
    if (end > maxTime) maxTime = end;
  }
  const totalRange = Math.max(maxTime - minTime, 1);

  el.innerHTML = spans
    .map((s, i) => {
      // Original index i is preserved on visible rows so the click-to-detail
      // handler can index back into waterfallSpans regardless of how many
      // rows the collapse filter dropped.
      if (hiddenSpanIds.has(s.id)) return "";

      const left = ((s.startedAt - minTime) / totalRange) * 100;
      const width =
        s.kind === "event" ? 0.3 : Math.max(((s.durationMs || 0) / totalRange) * 100, 0.3);
      const statusClass = s.status === "error" ? " status-error" : "";
      const indent = "  ".repeat(nestingDepth(s));
      const chip = isToolSpan(s) ? deriveSpanLabelHtml(s) : null;
      const aiLabel = !chip && isAiSpan(s) ? aiSpanLabel(s) : null;
      const fallbackName = aiLabel || s.name;
      // chip.html is already escaped; the indent is plain NBSPs so it doesn't
      // need escaping itself, but escHtml is a no-op on those characters.
      const labelInner = chip ? escHtml(indent) + chip.html : escHtml(indent + fallbackName);
      const labelTooltip = chip ? chip.tooltip : fallbackName;
      const isCollapsed = collapsedSpanIds.has(s.id);
      const toggleHtml = spanHasCollapsibleChildren(s.id)
        ? `<span class="waterfall-toggle" data-toggle-id="${s.id}" title="${
            isCollapsed ? "Expand stage spans" : "Collapse stage spans"
          }">${isCollapsed ? "▸" : "▾"}</span>`
        : '<span class="waterfall-toggle waterfall-toggle-spacer"></span>';
      const barKind = isToolSpan(s) ? "tool" : s.kind;
      const inputLabel = isToolSpan(s) ? extractToolInputLabel(s.attributes?.input) : "";
      const inputHtml = inputLabel
        ? `<span class="waterfall-input" title="${escHtml(inputLabel)}">${escHtml(inputLabel)}</span>`
        : "";
      return (
        `<div class="waterfall-row">` +
        `<div class="waterfall-label" title="${escHtml(labelTooltip)}">${toggleHtml}${labelInner}</div>` +
        `<div class="waterfall-bar-container">` +
        `<div class="waterfall-bar kind-${barKind}${statusClass}" ` +
        `style="left:${left}%;width:${width}%" data-span-index="${i}">` +
        `<span class="waterfall-duration">${fmtDuration(s.durationMs)}</span>` +
        inputHtml +
        `</div></div></div>`
      );
    })
    .join("");
}

// Delegated click handler: chevron toggles take priority over bar clicks.
document.getElementById("waterfall")!.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const toggle = target.closest<HTMLElement>("[data-toggle-id]");
  if (toggle) {
    event.stopPropagation();
    toggleCollapse(toggle.dataset.toggleId!);
    return;
  }
  const bar = target.closest<HTMLElement>("[data-span-index]");
  if (!bar) return;
  event.stopPropagation();
  const span = g.waterfallSpans[parseInt(bar.dataset.spanIndex!, 10)];
  if (!span) return;
  document.getElementById("spanDetails")!.classList.add("visible");
  const titleName = isAiSpan(span) ? aiSpanLabel(span) : span.name;
  document.getElementById("spanDetailsTitle")!.textContent =
    titleName + " (" + span.kind + ", " + span.status + ")";
  const host = document.getElementById("spanDetailsJson")!;
  // renderToolDetail picks the best panel: v1 search trace, per-tool renderer
  // (graph node, symbol context, list_files, read_source, search_pattern), or
  // smart generic. Reset the raw toggle on every span open so the panel
  // always opens in structured mode.
  if (typeof g.renderToolDetail === "function") {
    if (g.__tdrState) {
      g.__tdrState.showRaw = false;
      g.__tdrState.showResponse = false;
    }
    host.innerHTML = g.renderToolDetail(span);
  } else {
    host.innerHTML = "<pre>" + escHtml(JSON.stringify(span.attributes || {}, null, 2)) + "</pre>";
  }
});

function closeWaterfall(): void {
  document.getElementById("waterfallContainer")!.classList.remove("visible");
  document.getElementById("spanDetails")!.classList.remove("visible");
  document.querySelectorAll(".trace-table tr").forEach((r) => r.classList.remove("expanded"));
}

function closeSpanDetails(): void {
  document.getElementById("spanDetails")!.classList.remove("visible");
}

// Esc closes the drawer first if open, then the waterfall. Doesn't
// preventDefault unless something was actually closed, so other shortcuts
// are unaffected.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const det = document.getElementById("spanDetails");
  if (det?.classList.contains("visible")) {
    e.preventDefault();
    closeSpanDetails();
    return;
  }
  const wf = document.getElementById("waterfallContainer");
  if (wf?.classList.contains("visible")) {
    e.preventDefault();
    closeWaterfall();
  }
});

g.loadWaterfall = loadWaterfall;
g.closeWaterfall = closeWaterfall;
g.closeSpanDetails = closeSpanDetails;
