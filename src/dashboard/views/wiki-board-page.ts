import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escHtml, escAttr, escJsonScript } from "./components/escape.ts";
import { boardClientScript } from "./components/wiki-board-client.ts";
import { ISSUE_STATUS_STYLES } from "./components/wiki-issue-rows.ts";
import { withWikiParam } from "./components/wiki-param.ts";

/**
 * `/wiki/issues?wiki=` — the issue board: one row per key a page of the wiki
 * counts, and the pages that count none. A shell; the rows are drawn by
 * `components/wiki-board-browser.ts` from one `GET /api/wiki/graph`.
 *
 * `refusal` renders the page a wiki with no board gets (404 from the route):
 * no filters, no client, and a way back to the reader.
 */
export async function renderWikiBoardPage(opts: { wiki: string; label: string; refusal?: string }): Promise<string> {
  const readerHref = withWikiParam("/wiki", opts.wiki);
  const body = opts.refusal
    ? `<p class="board-note board-error" id="boardRefusal">${escHtml(opts.refusal)}</p>`
    : `<p class="board-sub">One row per key a page of this wiki relates to through a counting relation. A row opens the graph rooted at its key. Sessions and cost are per key and never summed: one session counts under every key it mentions.</p>
    <div class="board-kpis" id="boardKpis"></div>
    <div class="board-bar"><div id="boardFilters" class="board-filters"></div><span id="boardShown" class="board-shown" aria-live="polite"></span></div>
    <div id="boardNotes"></div>
    <div class="board-scroll" id="boardTableWrap"><p class="board-note">Loading…</p></div>
    <h2 class="board-h2">Pages with no key</h2>
    <p class="board-sub">No counting relation ties these pages to an issue. Bookkeeping pages are left out.</p>
    <div class="board-scroll" id="boardKeylessWrap"></div>`;
  const script = opts.refusal
    ? ""
    : `<script>window.__WIKI_BOARD__ = ${escJsonScript({ wiki: opts.wiki })};</script>
  <script>${await boardClientScript()}</script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>${escHtml(opts.label)} board — ${escHtml(opts.wiki)} — Muninn</title>
  <style>
    ${SHARED_STYLES}
    ${ISSUE_STATUS_STYLES}
    .board-wrap { max-width: 1280px; margin: 0 auto; padding: 20px 24px 60px; }
    .board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
    .board-head h1 { font-size: 20px; color: var(--text-primary); }
    .board-head a { font-size: 12.5px; color: var(--status-info); text-decoration: none; }
    .board-head a:hover { text-decoration: underline; }
    .board-sub { font-size: 12.5px; color: var(--text-muted); margin: 0 0 14px; }
    .board-kpis { display: flex; gap: 22px; flex-wrap: wrap; margin: 6px 0 14px; }
    .board-kpi b { display: block; font-size: 20px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .board-kpi span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; }
    .board-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .board-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .board-shows { display: flex; flex-wrap: wrap; gap: 4px; }
    .board-show {
      background: var(--bg-inset); border: 1px solid var(--border-secondary); border-radius: 999px;
      color: var(--text-secondary); font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
    }
    .board-show:hover { border-color: var(--accent); }
    .board-show.active { background: color-mix(in srgb, var(--accent) 18%, transparent); border-color: var(--accent); color: var(--accent-light); }
    .board-query {
      background: var(--bg-inset); border: 1px solid var(--border-secondary); border-radius: 6px;
      color: var(--text-primary); font: inherit; font-size: 12.5px; padding: 4px 8px; min-width: 0; width: 220px; max-width: 100%;
    }
    .board-shown { font-size: 12px; color: var(--text-muted); }
    .board-note { font-size: 12.5px; color: var(--text-secondary); margin: 0 0 8px; }
    /* Light theme on --bg-page: 5.53:1 (--status-error alone is 4.39:1); dark 8.26:1. */
    .board-error { color: color-mix(in srgb, var(--status-error) 85%, var(--text-primary)); }
    .board-scroll { overflow-x: auto; border: 1px solid var(--border-primary); border-radius: 10px; }
    .board-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .board-table th {
      text-align: left; font-weight: 600; color: var(--text-muted); font-size: 11px; text-transform: uppercase;
      letter-spacing: .05em; padding: 6px 8px; border-bottom: 1px solid var(--border-primary); white-space: nowrap;
    }
    .board-table td { padding: 7px 8px; border-bottom: 1px solid var(--border-primary); vertical-align: top; color: var(--text-secondary); }
    .board-table tbody tr:last-child td { border-bottom: none; }
    .board-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    #boardTable tbody tr[data-graph-href] { cursor: pointer; }
    #boardTable tbody tr[data-graph-href]:hover td { background: var(--bg-hover); }
    .board-key { white-space: nowrap; font-weight: 600; }
    .board-key a { color: var(--accent-light); text-decoration: none; }
    .board-key a:hover, .board-plan:hover { text-decoration: underline; }
    .board-ext { font-weight: 400; margin-left: 2px; }
    .board-title { min-width: 180px; overflow-wrap: anywhere; color: var(--text-primary); }
    /* --tok-str: 5.77:1 light, 11.33:1 dark on --bg-page (--status-success is 3.00:1 light). */
    .board-plan {
      color: var(--tok-str); text-decoration: none; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .board-plan-cell { min-width: 140px; max-width: 240px; }
    .board-table .wiki-issue-status { white-space: nowrap; }
    .board-date { white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* --text-soft: 5.90:1 light, 8.50:1 dark (--text-muted is 4.49:1 light). The
       td form outranks .board-table td, which would otherwise win. */
    .board-dim, .board-table td.board-dim { color: var(--text-soft); }
    .board-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .board-pr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; white-space: nowrap; }
    .board-flag {
      display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 999px; white-space: nowrap;
      background: var(--tint-warning); color: var(--text-primary);
    }
    .board-flag[data-flag="unknown key"] { background: var(--tint-error); }
    .board-empty { text-align: center; color: var(--text-muted); }
    .board-h2 { font-size: 16px; color: var(--text-primary); margin: 26px 0 4px; }
    .board-path { font-size: 11px; color: var(--text-muted); overflow-wrap: anywhere; }
    .board-keyless a { color: var(--text-primary); text-decoration: none; }
    .board-keyless a:hover { text-decoration: underline; }
    @media (max-width: 700px) { .board-wrap { padding: 16px 16px 48px; } .board-query { width: 100%; } }
  </style>
</head>
<body>
  ${renderNav("wiki")}
  <main class="board-wrap">
    <div class="board-head">
      <h1>${escHtml(opts.label)} board · ${escHtml(opts.wiki)}</h1>
      <a href="${escAttr(readerHref)}">← Wiki reader</a>
    </div>
    ${body}
  </main>
  ${script}
</body>
</html>`;
}
