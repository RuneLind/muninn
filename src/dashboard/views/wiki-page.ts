import { SHARED_STYLES, renderNav } from "./shared-styles.ts";

/**
 * /wiki — reader for the huginn-jarvis knowledge wiki.
 *
 * Three panes: filterable page list · rendered article with clickable
 * wikilinks · connections panel (backlinks + outgoing links grouped by type).
 * The whole page listing loads once (/api/wiki/pages) and filters client-side;
 * article + connections come per-page from /api/wiki/page.
 *
 * NB: the client script below lives inside this ONE template literal — no
 * backticks or dollar-brace in client code (string concat only).
 */
export function renderWikiPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wiki — Muninn</title>
  <style>
    ${SHARED_STYLES}

    .wiki-layout {
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr) 300px;
      gap: 16px;
      padding: 16px 24px;
      height: calc(100vh - 63px);
    }
    .wiki-pane {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    /* ── Left: browse pane ─────────────────────────────── */
    .wiki-browse-head { padding: 12px; border-bottom: 1px solid var(--border-primary); display: flex; flex-direction: column; gap: 10px; }
    .wiki-search {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-inset);
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
    }
    .wiki-search:focus { outline: none; border-color: var(--accent); }
    .wiki-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .wiki-chip {
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--border-secondary);
      background: transparent;
      color: var(--text-muted);
      font-size: 11.5px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }
    .wiki-chip:hover { color: var(--text-primary); border-color: var(--accent); }
    .wiki-chip.active { background: color-mix(in srgb, var(--accent) 18%, transparent); border-color: var(--accent); color: var(--accent-light); }
    .wiki-sort-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .wiki-sort {
      background: var(--bg-inset);
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      color: var(--text-tertiary);
      font-size: 12px;
      font-family: inherit;
      padding: 4px 6px;
    }
    .wiki-count { font-size: 11.5px; color: var(--text-dim); }

    .wiki-list { flex: 1; overflow-y: auto; padding: 6px; }
    .wiki-list-item {
      padding: 7px 10px;
      border-radius: 7px;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .wiki-list-item:hover { background: var(--bg-surface); }
    .wiki-list-item.active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .wiki-list-title { font-size: 12.5px; color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wiki-list-item.active .wiki-list-title { color: var(--text-primary); }
    .wiki-list-meta { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }

    .wiki-type-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
    .type-concept { background: var(--accent); }
    .type-entity { background: var(--status-cyan); }
    .type-source { background: var(--status-info); }
    .type-analysis { background: var(--status-magenta); }
    .type-note { background: var(--text-dim); }

    /* Start-view tabs (Hubs / Timeline) */
    .wiki-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border-primary); margin: 18px 0 10px; }
    .wiki-tab {
      padding: 6px 14px;
      font-size: 12.5px;
      color: var(--text-muted);
      cursor: pointer;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      font-family: inherit;
    }
    .wiki-tab:hover { color: var(--text-primary); }
    .wiki-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    /* Timeline */
    .wiki-day { margin: 16px 4px 6px; font-size: 12px; color: var(--text-tertiary); font-weight: 600; }
    .wiki-day span { color: var(--text-dim); font-weight: 400; }
    .wiki-tl-item { display: flex; align-items: center; gap: 8px; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
    .wiki-tl-item:hover { background: var(--bg-surface); }
    .wiki-tl-kind { font-size: 11px; width: 24px; flex-shrink: 0; text-align: center; }
    .wiki-tl-kind.new { color: var(--status-success); }
    .wiki-tl-kind.upd { color: var(--text-dim); }
    .wiki-tl-title { font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Connections mini-graph (1-hop neighborhood) */
    .wiki-mini-graph { border-bottom: 1px solid var(--border-primary); padding: 6px 6px 2px; margin-bottom: 8px; }
    .wiki-mini-graph svg { width: 100%; height: auto; display: block; }
    .mini-edge { stroke: var(--border-secondary); stroke-width: 1; }
    .mini-edge.both { stroke: var(--accent-muted); stroke-width: 1.6; }
    .mini-node { cursor: pointer; }
    .mini-node text { fill: var(--text-muted); font-size: 9px; }
    .mini-node:hover text { fill: var(--text-primary); }
    .mini-center text { fill: var(--text-primary); font-size: 9.5px; font-weight: 600; }
    circle.t-concept { fill: var(--accent); }
    circle.t-entity { fill: var(--status-cyan); }
    circle.t-source { fill: var(--status-info); }
    circle.t-analysis { fill: var(--status-magenta); }
    circle.t-note { fill: var(--text-dim); }
    .wiki-mini-more { font-size: 10.5px; color: var(--text-dim); text-align: center; padding: 2px 0 4px; }

    /* ── Middle: article pane ──────────────────────────── */
    .wiki-article-wrap { flex: 1; overflow-y: auto; padding: 24px 32px; }
    .wiki-article-head { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border-primary); }
    .wiki-article-head h1 { font-size: 22px; color: var(--text-primary); margin-bottom: 10px; }
    .wiki-meta-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .wiki-badge {
      font-size: 10.5px;
      padding: 2px 8px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-weight: 600;
    }
    .badge-concept { background: var(--tint-purple); color: var(--accent-light); }
    .badge-entity { background: var(--tint-cyan); color: var(--status-cyan); }
    .badge-source { background: var(--tint-info); color: var(--status-info); }
    .badge-analysis { background: var(--tint-magenta); color: var(--status-magenta); }
    .badge-note { background: var(--tint-neutral); color: var(--text-muted); }
    .badge-life { background: var(--tint-success); color: var(--status-success); }
    .wiki-tag { font-size: 11px; color: var(--text-muted); background: var(--bg-surface); padding: 2px 8px; border-radius: 999px; }
    .wiki-dates { font-size: 11.5px; color: var(--text-dim); }
    .wiki-source-url { font-size: 11.5px; color: var(--status-info); text-decoration: none; }
    .wiki-source-url:hover { text-decoration: underline; }

    .wiki-article { font-size: 14px; line-height: 1.65; color: var(--text-secondary); }
    .wiki-article h1, .wiki-article h2, .wiki-article h3, .wiki-article h4 { color: var(--text-primary); margin: 20px 0 8px; }
    .wiki-article h2 { font-size: 18px; }
    .wiki-article h3 { font-size: 15.5px; }
    .wiki-article p { margin: 8px 0; }
    .wiki-article ul, .wiki-article ol { margin: 8px 0 8px 22px; }
    .wiki-article li { margin: 3px 0; }
    .wiki-article blockquote { border-left: 3px solid var(--border-secondary); padding: 6px 12px; margin: 10px 0; color: var(--text-muted); background: var(--bg-surface); border-radius: 0 6px 6px 0; }
    .wiki-article code { background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
    .wiki-article pre { background: var(--bg-inset); padding: 12px; border-radius: 8px; overflow-x: auto; margin: 10px 0; }
    .wiki-article table { border-collapse: collapse; margin: 12px 0; width: 100%; font-size: 13px; }
    .wiki-article th, .wiki-article td { border: 1px solid var(--border-secondary); padding: 6px 10px; text-align: left; }
    .wiki-article th { background: var(--bg-surface); color: var(--text-primary); }
    .wiki-article hr { border: none; border-top: 1px solid var(--border-primary); margin: 16px 0; }
    .wiki-article a[target="_blank"] { color: var(--status-info); }

    .wiki-link { color: var(--accent-light); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
    .wiki-link:hover { color: var(--accent); border-bottom-color: var(--accent); }
    .wiki-link-missing { color: var(--text-muted); border-bottom: 1px dashed var(--text-disabled); cursor: default; }

    /* Start view (no page selected) */
    .wiki-start h2 { font-size: 16px; color: var(--text-primary); margin: 18px 0 10px; }
    .wiki-start-stats { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
    .wiki-stat { background: var(--bg-surface); border: 1px solid var(--border-primary); border-radius: 8px; padding: 10px 16px; }
    .wiki-stat b { display: block; font-size: 20px; color: var(--text-primary); }
    .wiki-stat span { font-size: 11.5px; color: var(--text-muted); }
    .wiki-hub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
    .wiki-hub-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .wiki-hub-card:hover { border-color: var(--accent); }
    .wiki-hub-title { font-size: 13px; color: var(--text-primary); }
    .wiki-hub-sub { font-size: 11px; color: var(--text-dim); }

    /* ── Right: connections pane ───────────────────────── */
    .wiki-conn-head { padding: 12px 14px; border-bottom: 1px solid var(--border-primary); font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-muted); }
    .wiki-conn-body { flex: 1; overflow-y: auto; padding: 10px; }
    .wiki-conn-section { margin-bottom: 14px; }
    .wiki-conn-title { font-size: 12px; color: var(--text-tertiary); font-weight: 600; margin: 4px 4px 6px; }
    .wiki-conn-group { font-size: 10.5px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.4px; margin: 8px 4px 3px; }
    .wiki-conn-item { display: flex; align-items: center; gap: 7px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
    .wiki-conn-item:hover { background: var(--bg-surface); }
    .wiki-conn-item span { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wiki-conn-empty { font-size: 12px; color: var(--text-dim); padding: 4px 8px; }

    .wiki-empty-state { padding: 40px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .wiki-empty-state code { background: var(--bg-inset); padding: 2px 6px; border-radius: 4px; }

    @media (max-width: 1100px) {
      .wiki-layout { grid-template-columns: 260px minmax(0, 1fr); }
      .wiki-conn-pane { display: none; }
    }
  </style>
</head>
<body>
  ${renderNav("wiki")}
  <div class="wiki-layout">
    <div class="wiki-pane">
      <div class="wiki-browse-head">
        <input type="text" id="wikiSearch" class="wiki-search" placeholder="Search titles, aliases, tags…">
        <div class="wiki-chip-row" id="domainChips">
          <button class="wiki-chip active" data-domain="">All</button>
          <button class="wiki-chip" data-domain="ai">AI</button>
          <button class="wiki-chip" data-domain="life">Life</button>
        </div>
        <div class="wiki-chip-row" id="typeChips"></div>
        <div class="wiki-chip-row" id="tagChips"></div>
        <div class="wiki-sort-row">
          <select id="wikiSort" class="wiki-sort">
            <option value="updated">Recently updated</option>
            <option value="backlinks">Most linked</option>
            <option value="title">Title A–Z</option>
          </select>
          <span class="wiki-count" id="wikiCount"></span>
        </div>
      </div>
      <div class="wiki-list" id="wikiList"></div>
    </div>

    <div class="wiki-pane">
      <div class="wiki-article-wrap" id="articleWrap">
        <div class="wiki-empty-state">Loading wiki…</div>
      </div>
    </div>

    <div class="wiki-pane wiki-conn-pane">
      <div class="wiki-conn-head">Connections</div>
      <div class="wiki-conn-body" id="connBody">
        <div class="wiki-conn-empty">Select a page to see its connections.</div>
      </div>
    </div>
  </div>

  <script>
  (function() {
    var allPages = [];
    var currentName = null;
    var filters = { q: '', domain: '', type: '', tag: '' };
    var startTab = 'hubs';
    var tagsExpanded = false;
    var TYPE_ORDER = ['concept', 'entity', 'source', 'analysis', 'note'];
    var TYPE_LABEL = { concept: 'Concepts', entity: 'Entities', source: 'Sources', analysis: 'Analyses', note: 'Notes' };

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Left pane: filter + list ─────────────────────────
    function filtered() {
      var q = filters.q.toLowerCase();
      return allPages.filter(function(p) {
        if (filters.domain && p.domain !== filters.domain) return false;
        if (filters.type && p.type !== filters.type) return false;
        if (filters.tag && p.tags.indexOf(filters.tag) === -1) return false;
        if (!q) return true;
        if (p.title.toLowerCase().indexOf(q) !== -1) return true;
        if (p.name.toLowerCase().indexOf(q) !== -1) return true;
        for (var i = 0; i < p.aliases.length; i++) {
          if (p.aliases[i].toLowerCase().indexOf(q) !== -1) return true;
        }
        for (var j = 0; j < p.tags.length; j++) {
          if (p.tags[j].toLowerCase().indexOf(q) !== -1) return true;
        }
        return false;
      });
    }

    function sortPages(pages) {
      var mode = document.getElementById('wikiSort').value;
      var copy = pages.slice();
      if (mode === 'title') {
        copy.sort(function(a, b) { return a.title.localeCompare(b.title); });
      } else if (mode === 'backlinks') {
        copy.sort(function(a, b) { return b.backlinkCount - a.backlinkCount; });
      } else {
        copy.sort(function(a, b) { return (b.updated || b.created || '').localeCompare(a.updated || a.created || ''); });
      }
      return copy;
    }

    function renderTypeChips() {
      var counts = {};
      allPages.forEach(function(p) {
        if (filters.domain && p.domain !== filters.domain) return;
        counts[p.type] = (counts[p.type] || 0) + 1;
      });
      var html = '<button class="wiki-chip' + (filters.type === '' ? ' active' : '') + '" data-type="">All types</button>';
      TYPE_ORDER.forEach(function(t) {
        if (!counts[t]) return;
        html += '<button class="wiki-chip' + (filters.type === t ? ' active' : '') + '" data-type="' + t + '">'
          + TYPE_LABEL[t] + ' ' + counts[t] + '</button>';
      });
      document.getElementById('typeChips').innerHTML = html;
    }

    function renderTagChips() {
      var counts = {};
      allPages.forEach(function(p) {
        if (filters.domain && p.domain !== filters.domain) return;
        if (filters.type && p.type !== filters.type) return;
        p.tags.forEach(function(t) { counts[t] = (counts[t] || 0) + 1; });
      });
      var tags = Object.keys(counts).sort(function(a, b) {
        return counts[b] - counts[a] || a.localeCompare(b);
      });
      var limit = tagsExpanded ? 36 : 8;
      var shown = tags.slice(0, limit);
      if (filters.tag && shown.indexOf(filters.tag) === -1) shown.unshift(filters.tag);
      var html = '';
      shown.forEach(function(t) {
        html += '<button class="wiki-chip' + (filters.tag === t ? ' active' : '') + '" data-tag="' + esc(t) + '">#'
          + esc(t) + ' ' + (counts[t] || 0) + '</button>';
      });
      if (tags.length > shown.length || tagsExpanded) {
        html += '<button class="wiki-chip" data-tag-more="1">'
          + (tagsExpanded ? 'less' : '+' + (tags.length - shown.length) + ' tags') + '</button>';
      }
      document.getElementById('tagChips').innerHTML = html;
    }

    function renderList() {
      var pages = sortPages(filtered());
      var mode = document.getElementById('wikiSort').value;
      var html = '';
      pages.forEach(function(p) {
        var meta = mode === 'backlinks'
          ? (p.backlinkCount + ' \\u2190')
          : (p.updated || p.created || '');
        html += '<div class="wiki-list-item' + (p.name === currentName ? ' active' : '') + '" data-page="' + esc(p.name) + '">'
          + '<div class="wiki-type-dot type-' + p.type + '"></div>'
          + '<div class="wiki-list-title">' + esc(p.title) + '</div>'
          + '<div class="wiki-list-meta">' + esc(meta) + '</div>'
          + '</div>';
      });
      document.getElementById('wikiList').innerHTML = html || '<div class="wiki-conn-empty">No pages match.</div>';
      document.getElementById('wikiCount').textContent = pages.length + ' / ' + allPages.length;
    }

    // ── Middle pane: article / start view ────────────────
    function badgeHtml(p) {
      var html = '<span class="wiki-badge badge-' + p.type + '">' + p.type + '</span>';
      if (p.domain === 'life') html += '<span class="wiki-badge badge-life">life</span>';
      return html;
    }

    function hubsHtml() {
      var html = '';
      ['concept', 'entity'].forEach(function(t) {
        var top = allPages.filter(function(p) { return p.type === t; })
          .sort(function(a, b) { return b.backlinkCount - a.backlinkCount; })
          .slice(0, 12);
        if (!top.length) return;
        html += '<h2>Top ' + TYPE_LABEL[t].toLowerCase() + ' by connections</h2><div class="wiki-hub-grid">';
        top.forEach(function(p) {
          html += '<div class="wiki-hub-card" data-page="' + esc(p.name) + '">'
            + '<div class="wiki-hub-title">' + esc(p.title) + '</div>'
            + '<div class="wiki-hub-sub">' + p.backlinkCount + ' pages link here</div>'
            + '</div>';
        });
        html += '</div>';
      });
      return html;
    }

    function timelineHtml() {
      var groups = {};
      filtered().forEach(function(p) {
        if (p.created) (groups[p.created] = groups[p.created] || []).push({ p: p, kind: 'new' });
        if (p.updated && p.updated !== p.created) {
          (groups[p.updated] = groups[p.updated] || []).push({ p: p, kind: 'upd' });
        }
      });
      var dates = Object.keys(groups).sort().reverse();
      if (!dates.length) return '<div class="wiki-conn-empty">No dated pages match the current filters.</div>';
      var html = '';
      dates.forEach(function(d) {
        var items = groups[d];
        items.sort(function(a, b) {
          return a.kind === b.kind ? a.p.title.localeCompare(b.p.title) : (a.kind === 'new' ? -1 : 1);
        });
        var news = 0, upds = 0;
        items.forEach(function(it) { if (it.kind === 'new') news++; else upds++; });
        html += '<div class="wiki-day">' + d + ' <span>\\u00b7 '
          + (news ? news + ' new' : '') + (news && upds ? ' \\u00b7 ' : '') + (upds ? upds + ' updated' : '')
          + '</span></div>';
        items.forEach(function(it) {
          html += '<div class="wiki-tl-item" data-page="' + esc(it.p.name) + '">'
            + '<div class="wiki-tl-kind ' + it.kind + '">' + (it.kind === 'new' ? '+' : '~') + '</div>'
            + '<div class="wiki-type-dot type-' + it.p.type + '"></div>'
            + '<div class="wiki-tl-title">' + esc(it.p.title) + '</div>'
            + '</div>';
        });
      });
      return html;
    }

    function startBodyHtml() {
      return startTab === 'hubs' ? hubsHtml() : timelineHtml();
    }

    /** Re-render the hubs/timeline area in place when filters change on the start view. */
    function refreshStartBody() {
      var el = document.getElementById('startBody');
      if (el && currentName === null) el.innerHTML = startBodyHtml();
    }

    function renderStart() {
      currentName = null;
      var counts = {};
      allPages.forEach(function(p) { counts[p.type] = (counts[p.type] || 0) + 1; });
      var html = '<div class="wiki-start"><div class="wiki-article-head"><h1>Knowledge Wiki</h1>'
        + '<div class="wiki-meta-row"><span class="wiki-dates">Browse by search and filters on the left, or start from a hub below. Click any wikilink to follow connections.</span></div></div>'
        + '<div class="wiki-start-stats">';
      TYPE_ORDER.forEach(function(t) {
        if (!counts[t]) return;
        html += '<div class="wiki-stat"><b>' + counts[t] + '</b><span>' + TYPE_LABEL[t] + '</span></div>';
      });
      html += '</div>'
        + '<div class="wiki-tabs">'
        + '<button class="wiki-tab' + (startTab === 'hubs' ? ' active' : '') + '" data-tab="hubs">Hubs</button>'
        + '<button class="wiki-tab' + (startTab === 'timeline' ? ' active' : '') + '" data-tab="timeline">Timeline</button>'
        + '</div>'
        + '<div id="startBody">' + startBodyHtml() + '</div></div>';
      document.getElementById('articleWrap').innerHTML = html;
      document.getElementById('connBody').innerHTML = '<div class="wiki-conn-empty">Select a page to see its connections.</div>';
      renderList();
    }

    /** 1-hop neighborhood as a small radial SVG: current page centered, top neighbors on a ring. */
    function miniGraphHtml(data) {
      var byName = {};
      data.outgoing.forEach(function(p) { byName[p.name] = { p: p, out: true, inn: false }; });
      data.backlinks.forEach(function(p) {
        if (byName[p.name]) byName[p.name].inn = true;
        else byName[p.name] = { p: p, out: false, inn: true };
      });
      var all = Object.keys(byName).map(function(k) { return byName[k]; });
      if (!all.length) return '';
      all.sort(function(a, b) {
        var ab = (a.out && a.inn) ? 1 : 0;
        var bb = (b.out && b.inn) ? 1 : 0;
        return bb - ab || b.p.backlinkCount - a.p.backlinkCount;
      });
      var shown = all.slice(0, 12);
      var W = 272, H = 244, cx = W / 2, cy = H / 2 - 4, r = 86;
      function short(t) { return t.length > 15 ? t.slice(0, 14) + '\\u2026' : t; }
      var edges = '', nodes = '';
      shown.forEach(function(n, i) {
        var ang = (2 * Math.PI * i) / shown.length - Math.PI / 2;
        n.x = cx + r * Math.cos(ang);
        n.y = cy + r * Math.sin(ang);
        edges += '<line class="mini-edge' + (n.out && n.inn ? ' both' : '') + '"'
          + (n.inn && !n.out ? ' stroke-dasharray="3,3"' : '')
          + ' x1="' + cx + '" y1="' + cy + '" x2="' + n.x.toFixed(1) + '" y2="' + n.y.toFixed(1) + '"/>';
      });
      shown.forEach(function(n) {
        var ly = n.y + (n.y >= cy ? 15 : -9);
        nodes += '<g class="mini-node" data-page="' + esc(n.p.name) + '"><title>' + esc(n.p.title) + '</title>'
          + '<circle class="mini-hit" cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="14" fill="transparent"></circle>'
          + '<circle class="t-' + n.p.type + '" cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="5"></circle>'
          + '<text x="' + n.x.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle">' + esc(short(n.p.title)) + '</text></g>';
      });
      nodes += '<g class="mini-center"><circle class="t-' + data.meta.type + '" cx="' + cx + '" cy="' + cy + '" r="7"></circle>'
        + '<text x="' + cx + '" y="' + (cy + 21) + '" text-anchor="middle">' + esc(short(data.meta.title)) + '</text></g>';
      var more = all.length > shown.length
        ? '<div class="wiki-mini-more">strongest ' + shown.length + ' of ' + all.length + ' \\u2014 full lists below</div>'
        : '';
      return '<div class="wiki-mini-graph"><svg viewBox="0 0 ' + W + ' ' + H + '">' + edges + nodes + '</svg>' + more + '</div>';
    }

    function renderConnections(data) {
      function section(title, items) {
        var html = '<div class="wiki-conn-section"><div class="wiki-conn-title">' + title + ' (' + items.length + ')</div>';
        if (!items.length) {
          return html + '<div class="wiki-conn-empty">None</div></div>';
        }
        TYPE_ORDER.forEach(function(t) {
          var group = items.filter(function(p) { return p.type === t; });
          if (!group.length) return;
          html += '<div class="wiki-conn-group">' + TYPE_LABEL[t] + '</div>';
          group.sort(function(a, b) { return b.backlinkCount - a.backlinkCount; }).forEach(function(p) {
            html += '<div class="wiki-conn-item" data-page="' + esc(p.name) + '">'
              + '<div class="wiki-type-dot type-' + p.type + '"></div><span>' + esc(p.title) + '</span></div>';
          });
        });
        return html + '</div>';
      }
      document.getElementById('connBody').innerHTML =
        miniGraphHtml(data) + section('Linked from', data.backlinks) + section('Links to', data.outgoing);
    }

    function loadPage(name, push) {
      fetch('/api/wiki/page?name=' + encodeURIComponent(name))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            document.getElementById('articleWrap').innerHTML =
              '<div class="wiki-empty-state">' + esc(data.error) + '</div>';
            return;
          }
          currentName = data.meta.name;
          if (push) {
            history.pushState({ page: currentName }, '', '/wiki?page=' + encodeURIComponent(currentName));
          }
          var m = data.meta;
          var head = '<div class="wiki-article-head"><h1>' + esc(m.title) + '</h1><div class="wiki-meta-row">'
            + badgeHtml(m);
          m.tags.forEach(function(t) { head += '<span class="wiki-tag">' + esc(t) + '</span>'; });
          if (m.created || m.updated) {
            head += '<span class="wiki-dates">' + esc(m.created || '') + (m.updated && m.updated !== m.created ? ' \\u00b7 upd ' + esc(m.updated) : '') + '</span>';
          }
          if (m.url) head += '<a class="wiki-source-url" href="' + esc(m.url) + '" target="_blank" rel="noopener">Open source \\u2197</a>';
          head += '</div></div>';
          document.getElementById('articleWrap').innerHTML = head + '<div class="wiki-article">' + data.html + '</div>';
          document.getElementById('articleWrap').scrollTop = 0;
          renderConnections(data);
          renderList();
        })
        .catch(function(err) {
          document.getElementById('articleWrap').innerHTML =
            '<div class="wiki-empty-state">Failed to load page: ' + esc(err.message) + '</div>';
        });
    }

    // ── Event wiring (all clicks delegated) ──────────────
    document.body.addEventListener('click', function(e) {
      var tab = e.target.closest ? e.target.closest('.wiki-tab') : null;
      if (tab) {
        startTab = tab.getAttribute('data-tab') || 'hubs';
        renderStart();
        return;
      }
      var link = e.target.closest ? e.target.closest('[data-wiki-page], [data-page]') : null;
      if (!link) return;
      var name = link.getAttribute('data-wiki-page') || link.getAttribute('data-page');
      if (!name) return;
      e.preventDefault();
      loadPage(name, true);
    });

    document.getElementById('wikiSearch').addEventListener('input', function(e) {
      filters.q = e.target.value;
      renderList();
      refreshStartBody();
    });
    document.getElementById('domainChips').addEventListener('click', function(e) {
      var chip = e.target.closest ? e.target.closest('.wiki-chip') : null;
      if (!chip) return;
      filters.domain = chip.getAttribute('data-domain') || '';
      this.querySelectorAll('.wiki-chip').forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      renderTypeChips();
      renderTagChips();
      renderList();
      refreshStartBody();
    });
    document.getElementById('typeChips').addEventListener('click', function(e) {
      var chip = e.target.closest ? e.target.closest('.wiki-chip') : null;
      if (!chip) return;
      filters.type = chip.getAttribute('data-type') || '';
      renderTypeChips();
      renderTagChips();
      renderList();
      refreshStartBody();
    });
    document.getElementById('tagChips').addEventListener('click', function(e) {
      var chip = e.target.closest ? e.target.closest('.wiki-chip') : null;
      if (!chip) return;
      if (chip.hasAttribute('data-tag-more')) {
        tagsExpanded = !tagsExpanded;
        renderTagChips();
        return;
      }
      var tag = chip.getAttribute('data-tag') || '';
      filters.tag = filters.tag === tag ? '' : tag;
      renderTagChips();
      renderList();
      refreshStartBody();
    });
    document.getElementById('wikiSort').addEventListener('change', renderList);

    window.addEventListener('popstate', function() {
      var params = new URLSearchParams(location.search);
      var page = params.get('page');
      if (page) loadPage(page, false);
      else renderStart();
    });

    // ── Boot ─────────────────────────────────────────────
    fetch('/api/wiki/pages')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error && !(data.pages || []).length) {
          document.getElementById('articleWrap').innerHTML =
            '<div class="wiki-empty-state">Wiki directory not found. Set <code>WIKI_DIR</code> in .env to the huginn-jarvis wiki path.</div>';
          return;
        }
        allPages = data.pages;
        renderTypeChips();
        renderTagChips();
        var params = new URLSearchParams(location.search);
        var page = params.get('page');
        if (page) loadPage(page, false);
        else renderStart();
      })
      .catch(function(err) {
        document.getElementById('articleWrap').innerHTML =
          '<div class="wiki-empty-state">Failed to load wiki: ' + esc(err.message) + '</div>';
      });
  })();
  </script>
</body>
</html>`;
}
