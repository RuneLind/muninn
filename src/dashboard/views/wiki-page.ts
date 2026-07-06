import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { wikiClientScript } from "./components/wiki-client.ts";

/**
 * /wiki — reader for the huginn-jarvis knowledge wiki.
 *
 * Three panes: filterable page list · rendered article with clickable
 * wikilinks · connections panel (backlinks + outgoing links grouped by type).
 * The whole page listing loads once (/api/wiki/pages) and filters client-side;
 * article + connections come per-page from /api/wiki/page.
 *
 * The client logic is a real bundled TS entrypoint (`components/wiki-browser.ts`),
 * injected below via `wikiClientScript()`.
 */
export async function renderWikiPage(): Promise<string> {
  const clientScript = await wikiClientScript();
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
    ${clientScript}
  </script>
</body>
</html>`;
}
