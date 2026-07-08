import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { wikiClientScript } from "./components/wiki-client.ts";
import { escHtml, escAttr, escJsonScript } from "./components/escape.ts";

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
 *
 * `wikis` populates the wiki picker — every registered wiki (bot wikis with a
 * `wikiDir` plus `WIKI_EXTRA` standalone wikis). `selected` is the canonical
 * name of the currently-browsed wiki (from `?wiki=`/`?bot=`, or the default) — it
 * also drives the client's `?wiki=` fetches via an injected global, so content
 * and picker state can't disagree. `envOverride` marks the legacy `WIKI_DIR`
 * bare-`/wiki` case, where no wiki is claimed in the picker. `gardener` gates the
 * (bot-only) Gardener link. Switching wiki is a full navigation to
 * `/wiki?wiki=<name>` so links stay shareable.
 */
export async function renderWikiPage(opts?: {
  wikis?: string[];
  /** Per-wiki freshness date (`YYYY-MM-DD`) shown in the picker label. */
  wikiDates?: Record<string, string>;
  selected?: string;
  envOverride?: boolean;
  unknownWiki?: boolean;
  gardenerPending?: number;
  gardener?: boolean;
}): Promise<string> {
  const clientScript = await wikiClientScript();
  const wikis = opts?.wikis ?? [];
  const wikiDates = opts?.wikiDates ?? {};
  const selected = opts?.selected ?? "";
  const envOverride = opts?.envOverride ?? false;
  const unknownWiki = opts?.unknownWiki ?? false;
  const gardenerPending = opts?.gardenerPending ?? 0;
  const gardener = opts?.gardener ?? true;
  const gardenerHref = `/wiki/gardener${selected ? "?wiki=" + encodeURIComponent(selected) : ""}`;
  const gardenerLink = gardener
    ? `<a href="${gardenerHref}" class="wiki-gardener-link" title="Wiki gardener — review drafted pages">🌱 Gardener${gardenerPending > 0 ? `<span class="wiki-gardener-badge">${gardenerPending}</span>` : ""}</a>`
    : "";
  // An unknown `?wiki=` matches no real option — render its raw name as a
  // disabled, selected placeholder so the picker and the "No wiki named X" pane
  // agree instead of the browser highlighting the first wiki. Show the picker for
  // any non-empty registry so a single-wiki deploy with a typo'd `?wiki=` still
  // has an in-page way back.
  const unknownSel = unknownWiki && !!selected && !envOverride;
  const wikiSelector =
    wikis.length >= 1
      ? `<select id="wikiSelect" class="wiki-sort" aria-label="Wiki">` +
        (envOverride ? `<option value="" selected disabled>env override</option>` : "") +
        (unknownSel ? `<option value="" selected disabled>${escHtml(selected)}</option>` : "") +
        wikis
          .map((w) => {
            // Annotate the label (not the value — the client navigates by value)
            // with the wiki's freshness date when known: `mimir · 2026-07-08`.
            const date = wikiDates[w];
            const label = date ? `${w} · ${date}` : w;
            return `<option value="${escAttr(w)}"${!envOverride && !unknownSel && w === selected ? " selected" : ""}>${escHtml(label)}</option>`;
          })
          .join("") +
        `</select>`
      : "";
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

    .wiki-gardener-link {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--text-muted); text-decoration: none;
      padding: 4px 10px; border: 1px solid var(--border-secondary); border-radius: 6px;
    }
    .wiki-gardener-link:hover { color: var(--accent-light); border-color: var(--accent); }
    .wiki-gardener-badge {
      background: var(--accent); color: #fff; font-size: 10.5px; font-weight: 600;
      min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
      display: inline-flex; align-items: center; justify-content: center;
    }

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
    .type-explainer { background: var(--status-warning); }
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
    circle.t-explainer { fill: var(--status-warning); }
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
    .badge-explainer { background: var(--tint-warning); color: var(--status-warning); }
    .badge-note { background: var(--tint-neutral); color: var(--text-muted); }
    .badge-life { background: var(--tint-success); color: var(--status-success); }
    .wiki-tag { font-size: 11px; color: var(--text-muted); background: var(--bg-surface); padding: 2px 8px; border-radius: 999px; }
    .wiki-dates { font-size: 11.5px; color: var(--text-dim); }
    .wiki-source-url { font-size: 11.5px; color: var(--status-info); text-decoration: none; }
    .wiki-source-url:hover { text-decoration: underline; }

    /* Standalone HTML explainer rendered in an iframe filling the article pane. */
    .wiki-explainer-frame {
      width: 100%;
      height: calc(100vh - 200px);
      min-height: 480px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: #fff;
    }

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

    /* "What's new" digest card (start view) */
    .wiki-whatsnew {
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 12px 16px;
      margin: 18px 0 6px;
    }
    .wiki-wn-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .wiki-wn-title { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
    .wiki-wn-range { font-size: 11.5px; color: var(--text-dim); }
    .wiki-wn-refresh {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1;
      padding: 4px 8px;
      cursor: pointer;
      font-family: inherit;
    }
    .wiki-wn-refresh:hover { color: var(--accent-light); border-color: var(--accent); }
    .wiki-wn-refresh:disabled { opacity: 0.5; cursor: default; }
    .wiki-wn-refresh.spinning { animation: wikiWnSpin 0.7s linear infinite; }
    @keyframes wikiWnSpin { to { transform: rotate(360deg); } }
    .wiki-wn-bullets { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
    .wiki-wn-bullets ul { margin: 4px 0 4px 20px; }
    .wiki-wn-bullets li { margin: 3px 0; }
    .wiki-wn-bullets p { margin: 4px 0; }
    .wiki-wn-gen { font-size: 10.5px; color: var(--text-faint); margin-top: 8px; }
    .wiki-wn-error { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--text-dim); }
    .wiki-wn-retry {
      background: transparent;
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1;
      padding: 3px 9px;
      cursor: pointer;
      font-family: inherit;
    }
    .wiki-wn-retry:hover { color: var(--accent-light); border-color: var(--accent); }

    /* ── Right: connections + ask pane ─────────────────── */
    .wiki-conn-head { padding: 12px 14px; border-bottom: 1px solid var(--border-primary); font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-muted); }
    .wiki-conn-tabs { display: flex; border-bottom: 1px solid var(--border-primary); }
    .wiki-conn-tab {
      flex: 1;
      padding: 10px 8px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--text-muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-family: inherit;
    }
    .wiki-conn-tab:hover { color: var(--text-primary); }
    .wiki-conn-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .wiki-conn-body { flex: 1; overflow-y: auto; padding: 10px; }

    /* Ask tab */
    .wiki-ask-body { display: flex; flex-direction: column; }
    .wiki-ask-turns { display: flex; flex-direction: column; gap: 14px; }
    .wiki-ask-hint { font-size: 12px; color: var(--text-dim); padding: 6px 4px; line-height: 1.5; }
    .wiki-ask-card { border-bottom: 1px solid var(--border-primary); padding-bottom: 12px; }
    .wiki-ask-card:last-child { border-bottom: none; }
    .wiki-ask-q { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.45; margin-bottom: 8px; }
    .wiki-ask-q::before { content: '› '; color: var(--accent); font-weight: 700; }
    .wiki-ask-status { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); margin-bottom: 8px; }
    .wiki-ask-status .spinner { width: 12px; height: 12px; border: 2px solid var(--border-secondary); border-top-color: var(--accent); border-radius: 50%; animation: wikiAskSpin 0.7s linear infinite; }
    @keyframes wikiAskSpin { to { transform: rotate(360deg); } }
    .wiki-ask-status.done .spinner { display: none; }
    .wiki-ask-status.error { color: var(--status-error); }
    .wiki-ask-answer { font-size: 13px; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; word-wrap: break-word; }
    .wiki-ask-cite {
      display: inline-block; cursor: pointer; color: var(--accent-light);
      font-size: 0.78em; font-weight: 600; vertical-align: super; line-height: 0; padding: 0 1px;
    }
    .wiki-ask-cite:hover { text-decoration: underline; }
    .wiki-ask-sources { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
    .wiki-ask-src-head { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-faint); margin-bottom: 2px; }
    .wiki-ask-src {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 8px; border-radius: 6px;
      background: var(--bg-surface); border: 1px solid var(--border-primary);
    }
    .wiki-ask-src.linked { cursor: pointer; }
    .wiki-ask-src.linked:hover { border-color: var(--accent); }
    .wiki-ask-src.uncited { opacity: 0.55; }
    .wiki-ask-src-num { flex-shrink: 0; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; border-radius: 5px; background: var(--bg-inset); color: var(--text-secondary); font-size: 10px; font-weight: 700; }
    .wiki-ask-src-badge { flex-shrink: 0; font-size: 9.5px; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-light); }
    .wiki-ask-src-title { flex: 1; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wiki-ask-src-page { flex-shrink: 0; font-size: 10px; color: var(--accent-light); }
    .wiki-ask-compose { display: flex; gap: 6px; margin-top: 12px; }
    .wiki-ask-input {
      flex: 1; padding: 8px 10px; border-radius: 7px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-primary); font-size: 12.5px; font-family: inherit;
      resize: none; line-height: 1.4;
    }
    .wiki-ask-input:focus { outline: none; border-color: var(--accent); }
    .wiki-ask-btn {
      padding: 0 14px; border-radius: 7px; border: none;
      background: var(--accent); color: #fff; font-size: 12.5px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .wiki-ask-btn:hover { opacity: 0.9; }
    .wiki-ask-btn:disabled { opacity: 0.5; cursor: default; }
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
        ${wikiSelector ? `<div class="wiki-sort-row"><span class="wiki-count">Wiki</span>${wikiSelector}</div>` : ""}
        ${gardenerLink ? `<div class="wiki-sort-row">${gardenerLink}</div>` : ""}
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
            <option value="updated" selected>Recently updated</option>
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
      <div class="wiki-conn-tabs">
        <button class="wiki-conn-tab active" data-conntab="conn">Connections</button>
        <button class="wiki-conn-tab" data-conntab="ask">Ask</button>
      </div>
      <div class="wiki-conn-body" id="connBody">
        <div class="wiki-conn-empty">Select a page to see its connections.</div>
      </div>
      <div class="wiki-conn-body wiki-ask-body" id="askBody" style="display:none">
        <div class="wiki-ask-turns" id="wikiAskTurns"></div>
        <div class="wiki-ask-hint" id="wikiAskHint">Ask a question and this wiki answers with citations you can open as pages.</div>
        <div class="wiki-ask-compose">
          <textarea class="wiki-ask-input" id="wikiAskInput" rows="2" placeholder="Ask this wiki…"></textarea>
          <button class="wiki-ask-btn" id="wikiAskBtn">Ask</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    window.__WIKI_NAME__ = ${escJsonScript(selected)};
  </script>
  <script>
    ${clientScript}
  </script>
</body>
</html>`;
}
