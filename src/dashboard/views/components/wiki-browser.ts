/// <reference lib="dom" />
/**
 * Browser entrypoint for the /wiki reader page. Bundled by Bun.build()
 * (see wiki-client.ts) and injected as an IIFE into the wiki page's inline
 * `<script>`. A mechanical port of the former hand-written inline IIFE — same
 * DOM ids/classes, same `/api/wiki/*` fetches, same keyboard/click handling.
 *
 * Three panes: filterable page list · rendered article with clickable
 * wikilinks · connections panel (backlinks + outgoing links grouped by type).
 * The whole page listing loads once (/api/wiki/pages) and filters client-side;
 * article + connections come per-page from /api/wiki/page.
 */

import { escHtml as esc } from "./escape.ts";
import {
  filterPages,
  sortPages,
  tagCounts,
  typeCounts,
  TYPE_LABEL,
  TYPE_ORDER,
  type WikiFilters,
  type WikiListing,
  type WikiPageType,
  type WikiSortMode,
} from "./wiki-filter.ts";

// ── Data shapes (mirror src/dashboard/routes/wiki-routes.ts) ──────────
interface WikiPageDetail {
  meta: WikiListing;
  html: string;
  outgoing: WikiListing[];
  backlinks: WikiListing[];
  error?: string;
}

interface WikiPagesResponse {
  pages: WikiListing[];
  scannedAt: number | null;
  error?: string;
}

// ── Page state ────────────────────────────────────────────────────────
/** Which wiki is being browsed — the server injects the *canonical* wiki name
 *  (case-corrected, or the resolved default) as `window.__WIKI_NAME__`, so our
 *  `?wiki=` fetches and the picker's selected option always agree. Falls back to
 *  the raw `?wiki=` (or legacy `?bot=`) query if the global is somehow absent.
 *  Empty = default/env. */
const injectedName = (window as unknown as { __WIKI_NAME__?: unknown }).__WIKI_NAME__;
const params0 = new URLSearchParams(location.search);
const WIKI =
  typeof injectedName === "string" ? injectedName : params0.get("wiki") || params0.get("bot") || "";
/** Append the active `wiki` param to a URL so every /api/wiki/* fetch stays on-wiki. */
function withWiki(url: string): string {
  if (!WIKI) return url;
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "wiki=" + encodeURIComponent(WIKI);
}
/** Build a shareable in-page URL that preserves the active wiki. */
function pageUrl(name: string): string {
  const wiki = WIKI ? "wiki=" + encodeURIComponent(WIKI) + "&" : "";
  return "/wiki?" + wiki + "page=" + encodeURIComponent(name);
}

let allPages: WikiListing[] = [];
let currentName: string | null = null;
const filters: WikiFilters = { q: "", domain: "", type: "", tag: "" };
let startTab: "hubs" | "timeline" = "hubs";
let tagsExpanded = false;

function sortMode(): WikiSortMode {
  return (document.getElementById("wikiSort") as HTMLSelectElement).value as WikiSortMode;
}

// ── Left pane: filter + list ──────────────────────────────────────────
function renderTypeChips(): void {
  const counts = typeCounts(allPages, filters.domain);
  let html = `<button class="wiki-chip${filters.type === "" ? " active" : ""}" data-type="">All types</button>`;
  TYPE_ORDER.forEach((t) => {
    if (!counts[t]) return;
    html += `<button class="wiki-chip${filters.type === t ? " active" : ""}" data-type="${t}">${TYPE_LABEL[t]} ${counts[t]}</button>`;
  });
  document.getElementById("typeChips")!.innerHTML = html;
}

function renderTagChips(): void {
  const counts = tagCounts(allPages, filters.domain, filters.type);
  const tags = Object.keys(counts).sort((a, b) => counts[b]! - counts[a]! || a.localeCompare(b));
  const limit = tagsExpanded ? 36 : 8;
  const shown = tags.slice(0, limit);
  if (filters.tag && shown.indexOf(filters.tag) === -1) shown.unshift(filters.tag);
  let html = "";
  shown.forEach((t) => {
    html += `<button class="wiki-chip${filters.tag === t ? " active" : ""}" data-tag="${esc(t)}">#${esc(t)} ${counts[t] || 0}</button>`;
  });
  if (tags.length > shown.length || tagsExpanded) {
    html += `<button class="wiki-chip" data-tag-more="1">${tagsExpanded ? "less" : "+" + (tags.length - shown.length) + " tags"}</button>`;
  }
  document.getElementById("tagChips")!.innerHTML = html;
}

function renderList(): void {
  const mode = sortMode();
  const pages = sortPages(filterPages(allPages, filters), mode);
  let html = "";
  pages.forEach((p) => {
    const meta = mode === "backlinks" ? p.backlinkCount + " ←" : p.updated || p.created || "";
    html +=
      `<div class="wiki-list-item${p.name === currentName ? " active" : ""}" data-page="${esc(p.name)}">` +
      `<div class="wiki-type-dot type-${p.type}"></div>` +
      `<div class="wiki-list-title">${esc(p.title)}</div>` +
      `<div class="wiki-list-meta">${esc(meta)}</div>` +
      `</div>`;
  });
  document.getElementById("wikiList")!.innerHTML =
    html || '<div class="wiki-conn-empty">No pages match.</div>';
  document.getElementById("wikiCount")!.textContent = pages.length + " / " + allPages.length;
}

// ── Middle pane: article / start view ─────────────────────────────────
function badgeHtml(p: WikiListing): string {
  let html = `<span class="wiki-badge badge-${p.type}">${p.type}</span>`;
  if (p.domain === "life") html += '<span class="wiki-badge badge-life">life</span>';
  return html;
}

function hubsHtml(): string {
  let html = "";
  (["concept", "entity"] as WikiPageType[]).forEach((t) => {
    const top = allPages
      .filter((p) => p.type === t)
      .sort((a, b) => b.backlinkCount - a.backlinkCount)
      .slice(0, 12);
    if (!top.length) return;
    html += `<h2>Top ${TYPE_LABEL[t].toLowerCase()} by connections</h2><div class="wiki-hub-grid">`;
    top.forEach((p) => {
      html +=
        `<div class="wiki-hub-card" data-page="${esc(p.name)}">` +
        `<div class="wiki-hub-title">${esc(p.title)}</div>` +
        `<div class="wiki-hub-sub">${p.backlinkCount} pages link here</div>` +
        `</div>`;
    });
    html += "</div>";
  });
  return html;
}

function timelineHtml(): string {
  const groups: Record<string, { p: WikiListing; kind: "new" | "upd" }[]> = {};
  filterPages(allPages, filters).forEach((p) => {
    if (p.created) (groups[p.created] = groups[p.created] || []).push({ p, kind: "new" });
    if (p.updated && p.updated !== p.created) {
      (groups[p.updated] = groups[p.updated] || []).push({ p, kind: "upd" });
    }
  });
  const dates = Object.keys(groups).sort().reverse();
  if (!dates.length) {
    return '<div class="wiki-conn-empty">No dated pages match the current filters.</div>';
  }
  let html = "";
  dates.forEach((d) => {
    const items = groups[d]!;
    items.sort((a, b) =>
      a.kind === b.kind ? a.p.title.localeCompare(b.p.title) : a.kind === "new" ? -1 : 1,
    );
    let news = 0;
    let upds = 0;
    items.forEach((it) => {
      if (it.kind === "new") news++;
      else upds++;
    });
    html +=
      `<div class="wiki-day">${esc(d)} <span>· ` +
      (news ? news + " new" : "") +
      (news && upds ? " · " : "") +
      (upds ? upds + " updated" : "") +
      `</span></div>`;
    items.forEach((it) => {
      html +=
        `<div class="wiki-tl-item" data-page="${esc(it.p.name)}">` +
        `<div class="wiki-tl-kind ${it.kind}">${it.kind === "new" ? "+" : "~"}</div>` +
        `<div class="wiki-type-dot type-${it.p.type}"></div>` +
        `<div class="wiki-tl-title">${esc(it.p.title)}</div>` +
        `</div>`;
    });
  });
  return html;
}

function startBodyHtml(): string {
  return startTab === "hubs" ? hubsHtml() : timelineHtml();
}

/** Re-render the hubs/timeline area in place when filters change on the start view. */
function refreshStartBody(): void {
  const el = document.getElementById("startBody");
  if (el && currentName === null) el.innerHTML = startBodyHtml();
}

function renderStart(): void {
  currentName = null;
  const counts = typeCounts(allPages, "");
  let html =
    '<div class="wiki-start"><div class="wiki-article-head"><h1>Knowledge Wiki</h1>' +
    '<div class="wiki-meta-row"><span class="wiki-dates">Browse by search and filters on the left, or start from a hub below. Click any wikilink to follow connections.</span></div></div>' +
    '<div class="wiki-start-stats">';
  TYPE_ORDER.forEach((t) => {
    if (!counts[t]) return;
    html += `<div class="wiki-stat"><b>${counts[t]}</b><span>${TYPE_LABEL[t]}</span></div>`;
  });
  html +=
    "</div>" +
    '<div class="wiki-tabs">' +
    `<button class="wiki-tab${startTab === "hubs" ? " active" : ""}" data-tab="hubs">Hubs</button>` +
    `<button class="wiki-tab${startTab === "timeline" ? " active" : ""}" data-tab="timeline">Timeline</button>` +
    "</div>" +
    `<div id="startBody">${startBodyHtml()}</div></div>`;
  document.getElementById("articleWrap")!.innerHTML = html;
  document.getElementById("connBody")!.innerHTML =
    '<div class="wiki-conn-empty">Select a page to see its connections.</div>';
  renderList();
}

interface MiniNode {
  p: WikiListing;
  out: boolean;
  inn: boolean;
  x?: number;
  y?: number;
}

/** 1-hop neighborhood as a small radial SVG: current page centered, top neighbors on a ring. */
function miniGraphHtml(data: WikiPageDetail): string {
  const byName: Record<string, MiniNode> = {};
  data.outgoing.forEach((p) => {
    byName[p.name] = { p, out: true, inn: false };
  });
  data.backlinks.forEach((p) => {
    if (byName[p.name]) byName[p.name]!.inn = true;
    else byName[p.name] = { p, out: false, inn: true };
  });
  const all = Object.keys(byName).map((k) => byName[k]!);
  if (!all.length) return "";
  all.sort((a, b) => {
    const ab = a.out && a.inn ? 1 : 0;
    const bb = b.out && b.inn ? 1 : 0;
    return bb - ab || b.p.backlinkCount - a.p.backlinkCount;
  });
  const shown = all.slice(0, 12);
  const W = 272;
  const H = 244;
  const cx = W / 2;
  const cy = H / 2 - 4;
  const r = 86;
  const short = (t: string) => (t.length > 15 ? t.slice(0, 14) + "…" : t);
  let edges = "";
  let nodes = "";
  shown.forEach((n, i) => {
    const ang = (2 * Math.PI * i) / shown.length - Math.PI / 2;
    n.x = cx + r * Math.cos(ang);
    n.y = cy + r * Math.sin(ang);
    edges +=
      `<line class="mini-edge${n.out && n.inn ? " both" : ""}"` +
      (n.inn && !n.out ? ' stroke-dasharray="3,3"' : "") +
      ` x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"/>`;
  });
  shown.forEach((n) => {
    const ly = n.y! + (n.y! >= cy ? 15 : -9);
    nodes +=
      `<g class="mini-node" data-page="${esc(n.p.name)}"><title>${esc(n.p.title)}</title>` +
      `<circle class="mini-hit" cx="${n.x!.toFixed(1)}" cy="${n.y!.toFixed(1)}" r="14" fill="transparent"></circle>` +
      `<circle class="t-${n.p.type}" cx="${n.x!.toFixed(1)}" cy="${n.y!.toFixed(1)}" r="5"></circle>` +
      `<text x="${n.x!.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(short(n.p.title))}</text></g>`;
  });
  nodes +=
    `<g class="mini-center"><circle class="t-${data.meta.type}" cx="${cx}" cy="${cy}" r="7"></circle>` +
    `<text x="${cx}" y="${cy + 21}" text-anchor="middle">${esc(short(data.meta.title))}</text></g>`;
  const more =
    all.length > shown.length
      ? `<div class="wiki-mini-more">strongest ${shown.length} of ${all.length} — full lists below</div>`
      : "";
  return `<div class="wiki-mini-graph"><svg viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg>${more}</div>`;
}

// ── Right pane: connections ───────────────────────────────────────────
function renderConnections(data: WikiPageDetail): void {
  function section(title: string, items: WikiListing[]): string {
    let html = `<div class="wiki-conn-section"><div class="wiki-conn-title">${title} (${items.length})</div>`;
    if (!items.length) {
      return html + '<div class="wiki-conn-empty">None</div></div>';
    }
    TYPE_ORDER.forEach((t) => {
      const group = items.filter((p) => p.type === t);
      if (!group.length) return;
      html += `<div class="wiki-conn-group">${TYPE_LABEL[t]}</div>`;
      group
        .sort((a, b) => b.backlinkCount - a.backlinkCount)
        .forEach((p) => {
          html +=
            `<div class="wiki-conn-item" data-page="${esc(p.name)}">` +
            `<div class="wiki-type-dot type-${p.type}"></div><span>${esc(p.title)}</span></div>`;
        });
    });
    return html + "</div>";
  }
  document.getElementById("connBody")!.innerHTML =
    miniGraphHtml(data) + section("Linked from", data.backlinks) + section("Links to", data.outgoing);
}

/** Article-head block (title, badges, tags, dates, source link) — shared by
 *  markdown pages and HTML explainers. */
function articleHeadHtml(m: WikiListing): string {
  let head = `<div class="wiki-article-head"><h1>${esc(m.title)}</h1><div class="wiki-meta-row">` + badgeHtml(m);
  m.tags.forEach((t) => {
    head += `<span class="wiki-tag">${esc(t)}</span>`;
  });
  if (m.created || m.updated) {
    head += `<span class="wiki-dates">${esc(m.created || "")}${m.updated && m.updated !== m.created ? " · upd " + esc(m.updated) : ""}</span>`;
  }
  if (m.url) {
    head += `<a class="wiki-source-url" href="${esc(m.url)}" target="_blank" rel="noopener">Open source ↗</a>`;
  }
  head += "</div></div>";
  return head;
}

/** Standalone HTML explainers aren't markdown and don't join the wikilink graph,
 *  so render them in a sandboxed <iframe> (scripts allowed — they use inline
 *  JS/mermaid and are trusted local docs on a loopback-only dashboard) instead
 *  of fetching /api/wiki/page. Connections panel shows a "no wikilinks" note. */
function loadExplainer(m: WikiListing, push: boolean): void {
  currentName = m.name;
  if (push) {
    history.pushState({ page: currentName }, "", pageUrl(currentName));
  }
  const src = withWiki("/api/wiki/html?name=" + encodeURIComponent(m.name));
  document.getElementById("articleWrap")!.innerHTML =
    articleHeadHtml(m) +
    `<iframe class="wiki-explainer-frame" src="${esc(src)}" sandbox="allow-scripts allow-popups" title="${esc(m.title)}"></iframe>`;
  document.getElementById("articleWrap")!.scrollTop = 0;
  document.getElementById("connBody")!.innerHTML =
    '<div class="wiki-conn-empty">Explainer — standalone HTML, no wikilinks.</div>';
  renderList();
}

function loadPage(name: string, push: boolean): void {
  const listing = allPages.find((p) => p.name === name);
  if (listing && listing.type === "explainer") {
    loadExplainer(listing, push);
    return;
  }
  fetch(withWiki("/api/wiki/page?name=" + encodeURIComponent(name)))
    .then((r) => r.json())
    .then((data: WikiPageDetail) => {
      if (data.error) {
        document.getElementById("articleWrap")!.innerHTML =
          `<div class="wiki-empty-state">${esc(data.error)}</div>`;
        return;
      }
      currentName = data.meta.name;
      if (push) {
        history.pushState({ page: currentName }, "", pageUrl(currentName));
      }
      document.getElementById("articleWrap")!.innerHTML =
        articleHeadHtml(data.meta) + `<div class="wiki-article">${data.html}</div>`;
      document.getElementById("articleWrap")!.scrollTop = 0;
      renderConnections(data);
      renderList();
    })
    .catch((err: Error) => {
      document.getElementById("articleWrap")!.innerHTML =
        `<div class="wiki-empty-state">Failed to load page: ${esc(err.message)}</div>`;
    });
}

// ── Event wiring (all clicks delegated) ───────────────────────────────
document.body.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const tab = target.closest ? target.closest(".wiki-tab") : null;
  if (tab) {
    startTab = (tab.getAttribute("data-tab") as "hubs" | "timeline") || "hubs";
    renderStart();
    return;
  }
  const link = target.closest ? target.closest("[data-wiki-page], [data-page]") : null;
  if (!link) return;
  const name = link.getAttribute("data-wiki-page") || link.getAttribute("data-page");
  if (!name) return;
  e.preventDefault();
  loadPage(name, true);
});

(document.getElementById("wikiSearch") as HTMLInputElement).addEventListener("input", (e) => {
  filters.q = (e.target as HTMLInputElement).value;
  renderList();
  refreshStartBody();
});

document.getElementById("domainChips")!.addEventListener("click", function (this: HTMLElement, e) {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  filters.domain = chip.getAttribute("data-domain") || "";
  this.querySelectorAll(".wiki-chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  renderTypeChips();
  renderTagChips();
  renderList();
  refreshStartBody();
});

document.getElementById("typeChips")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  filters.type = chip.getAttribute("data-type") || "";
  renderTypeChips();
  renderTagChips();
  renderList();
  refreshStartBody();
});

document.getElementById("tagChips")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  if (chip.hasAttribute("data-tag-more")) {
    tagsExpanded = !tagsExpanded;
    renderTagChips();
    return;
  }
  const tag = chip.getAttribute("data-tag") || "";
  filters.tag = filters.tag === tag ? "" : tag;
  renderTagChips();
  renderList();
  refreshStartBody();
});

document.getElementById("wikiSort")!.addEventListener("change", renderList);

// Switching wiki is a full navigation — resets browse context and keeps the URL shareable.
const wikiSel = document.getElementById("wikiSelect") as HTMLSelectElement | null;
if (wikiSel) {
  wikiSel.addEventListener("change", () => {
    const value = wikiSel.value;
    location.href = value ? "/wiki?wiki=" + encodeURIComponent(value) : "/wiki";
  });
}

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  const page = params.get("page");
  if (page) loadPage(page, false);
  else renderStart();
});

// ── Boot ──────────────────────────────────────────────────────────────
fetch(withWiki("/api/wiki/pages"))
  .then((r) => r.json())
  .then((data: WikiPagesResponse) => {
    if (data.error && !(data.pages || []).length) {
      // Distinguish the two WIKI-set failures the server reports: an unknown wiki
      // ("no wiki configured…") vs. a registered wiki whose directory is missing
      // on disk ("wiki directory not found") — different, accurate hints.
      const configured = /directory not found/i.test(data.error);
      const hint = WIKI
        ? configured
          ? `Wiki directory not found for <code>${esc(WIKI)}</code>. Check its configured path exists on disk.`
          : `No wiki named <code>${esc(WIKI)}</code>. Add it as a bot <code>wikiDir</code> or a <code>WIKI_EXTRA</code> entry.`
        : "Wiki directory not found. Set <code>WIKI_DIR</code> in .env to the wiki path.";
      document.getElementById("articleWrap")!.innerHTML =
        `<div class="wiki-empty-state">${hint}</div>`;
      return;
    }
    allPages = data.pages;
    renderTypeChips();
    renderTagChips();
    const params = new URLSearchParams(location.search);
    const page = params.get("page");
    if (page) loadPage(page, false);
    else renderStart();
  })
  .catch((err: Error) => {
    document.getElementById("articleWrap")!.innerHTML =
      `<div class="wiki-empty-state">Failed to load wiki: ${esc(err.message)}</div>`;
  });
