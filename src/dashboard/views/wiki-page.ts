import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { componentBlockCss } from "../../format/component-styles.ts";
import { wikiClientScript } from "./components/wiki-client.ts";
import { escHtml, escAttr, escJsonScript } from "./components/escape.ts";
import { agentPresenceStyles, agentPresenceHtml, agentPresenceScript } from "./components/agent-presence.ts";

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
  /** Resolved synthesis bot for this wiki's Ask tab + What's-new digest
   *  (owner-routing, `resolveWikiSynthesisBot`). Null ⇒ no line rendered
   *  (env-override / unknown wiki / no bots discovered). */
  askBot?: {
    bot: string;
    connector: string;
    model: string;
    origin: "pinned" | "owner" | "fallback";
  } | null;
}): Promise<string> {
  const clientScript = await wikiClientScript();
  const wikis = opts?.wikis ?? [];
  const wikiDates = opts?.wikiDates ?? {};
  const selected = opts?.selected ?? "";
  const envOverride = opts?.envOverride ?? false;
  const unknownWiki = opts?.unknownWiki ?? false;
  const gardenerPending = opts?.gardenerPending ?? 0;
  const gardener = opts?.gardener ?? true;
  const askBot = opts?.askBot ?? null;
  // "Answered by …" line under the Ask hint — who synthesizes this wiki's
  // answers and why (wiki owner vs the shared research-bot fallback).
  const askBotLine = askBot
    ? `<div class="wiki-ask-bot">Answered by <strong>${escHtml(askBot.bot)}</strong> <code>${escHtml(askBot.connector)} · ${escHtml(askBot.model)}</code> — ${askBot.origin === "pinned" ? "explicit synthesisBot pin" : askBot.origin === "owner" ? "this wiki's owner" : "research-bot fallback (steered by the Research synthesizer role on /models)"}</div>`
    : "";
  const gardenerHref = `/wiki/gardener${selected ? "?wiki=" + encodeURIComponent(selected) : ""}`;
  const gardenerLink = gardener
    ? `<a href="${gardenerHref}" class="wiki-gardener-icon" title="Wiki gardener — review drafted pages" aria-label="Wiki gardener${gardenerPending > 0 ? ` (${gardenerPending} pending)` : ""}">🌱${gardenerPending > 0 ? `<span class="wiki-gardener-badge">${gardenerPending}</span>` : ""}</a>`
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
    .wiki-folder { flex: 1; }
    .wiki-count { font-size: 11.5px; color: var(--text-dim); }

    .wiki-gardener-badge {
      background: var(--accent); color: #fff; font-size: 10.5px; font-weight: 600;
      min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
      display: inline-flex; align-items: center; justify-content: center;
    }

    /* Compact head: wiki picker + gardener icon share the top row. */
    .wiki-head-top { display: flex; align-items: center; gap: 8px; }
    .wiki-head-top .wiki-sort { flex: 1; min-width: 0; }
    .wiki-head-label { flex-shrink: 0; }
    .wiki-gardener-icon {
      position: relative; margin-left: auto; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 7px;
      border: 1px solid var(--border-secondary); text-decoration: none; font-size: 15px;
    }
    .wiki-gardener-icon:hover { border-color: var(--accent); }
    .wiki-gardener-icon .wiki-gardener-badge { position: absolute; top: -5px; right: -5px; }

    /* Domain segmented control (All / AI / Life). */
    .wiki-segmented {
      display: inline-flex; width: fit-content; overflow: hidden;
      border: 1px solid var(--border-secondary); border-radius: 7px;
    }
    .wiki-segmented .wiki-chip {
      border: none; border-radius: 0; border-right: 1px solid var(--border-secondary);
      padding: 5px 14px;
    }
    .wiki-segmented .wiki-chip:last-child { border-right: none; }
    .wiki-segmented .wiki-chip.active {
      background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-light);
    }

    /* Filters disclosure — holds the secondary facets (folder + type + tag chips)
       so the head stays compact. Auto-opened by JS whenever a filter is active. */
    .wiki-filters { border: 1px solid var(--border-secondary); border-radius: 7px; background: var(--bg-inset); }
    .wiki-filters-summary {
      list-style: none; cursor: pointer; user-select: none;
      display: flex; align-items: center; gap: 7px;
      padding: 7px 10px; font-size: 12px; color: var(--text-muted);
    }
    .wiki-filters-summary::-webkit-details-marker { display: none; }
    .wiki-filters-summary::before { content: '▸'; font-size: 10px; color: var(--text-dim); transition: transform 0.15s; }
    .wiki-filters[open] .wiki-filters-summary::before { transform: rotate(90deg); }
    .wiki-filters-summary:hover { color: var(--text-primary); }
    .wiki-filter-count {
      background: var(--accent); color: #fff; font-size: 10px; font-weight: 600;
      min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .wiki-filters-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 10px 10px; }

    /* Coverage footer under the page list — links the full Index card. */
    .wiki-coverage-foot {
      flex-shrink: 0; border-top: 1px solid var(--border-primary);
      padding: 8px 12px; font-size: 11.5px; color: var(--text-dim);
    }
    .wiki-cov-link { cursor: pointer; }
    .wiki-cov-link:hover { color: var(--accent-light); }

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

    /* Neutral default so a custom type (no dedicated type-* rule) still shows a
       dot; the specific rules below override for the built-in types. */
    .wiki-type-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; background: var(--text-dim); }
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
    /* Neutral default for a custom type's mini-graph node; circle.t-* (higher
       specificity) overrides for the built-in types, the hit circle keeps its own. */
    .mini-dot { fill: var(--text-dim); }
    circle.t-concept { fill: var(--accent); }
    circle.t-entity { fill: var(--status-cyan); }
    circle.t-source { fill: var(--status-info); }
    circle.t-analysis { fill: var(--status-magenta); }
    circle.t-explainer { fill: var(--status-warning); }
    circle.t-note { fill: var(--text-dim); }
    .wiki-mini-more { font-size: 10.5px; color: var(--text-dim); text-align: center; padding: 2px 0 4px; }

    /* ── Middle: article pane ──────────────────────────── */
    /* Breadcrumb bar above the article (wiki / folder / page · updated), also the
       stable home for the Explain affordance — shown only while a selection exists. */
    .wiki-breadcrumb {
      flex-shrink: 0; display: flex; align-items: center; gap: 8px;
      padding: 9px 24px; border-bottom: 1px solid var(--border-primary);
      font-size: 12px; color: var(--text-muted);
    }
    .wiki-bc-trail { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wiki-bc-sep { color: var(--text-dim); margin: 0 5px; }
    .wiki-bc-cur { color: var(--text-secondary); }
    .wiki-bc-date { color: var(--text-dim); flex-shrink: 0; }
    .wiki-bc-explain {
      flex-shrink: 0; padding: 4px 11px; border-radius: 999px;
      background: var(--accent); color: #fff;
      border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
      font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer; font-family: inherit;
    }
    .wiki-bc-explain:hover { background: var(--accent-light); }
    .wiki-article-wrap { flex: 1; overflow-y: auto; padding: 24px 32px; }
    .wiki-article-head { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border-primary); }
    .wiki-article-head h1 { font-size: 22px; color: var(--text-primary); margin-bottom: 10px; }
    /* Explainer-style subtitle (blog pages only) — muted lede under the H1. */
    .wiki-subtitle { font-size: 14.5px; line-height: 1.5; color: var(--text-muted); margin: -4px 0 12px; max-width: 68ch; }
    .wiki-meta-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .wiki-badge {
      font-size: 10.5px;
      padding: 2px 8px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-weight: 600;
      /* Neutral default so a custom type (no dedicated badge-* rule) still gets a
         readable pill; the specific rules below override for the built-in types. */
      background: var(--tint-neutral);
      color: var(--text-muted);
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
    ${componentBlockCss(".wiki-article")}

    /* Blog-type article chrome (native .mdx pages with type: blog):
       explainer-style h2 underline for stronger section separation. The accent
       tint itself rides the --accent / --accent-light tokens, overridden per-page
       on this scope by a style block the client injects (blogAccentStyleBlock) —
       so wikilinks and callouts (which already read those tokens) pick up the
       page brand color without any extra hookup here. */
    .wiki-article-blog h2 { border-bottom: 1px solid var(--border-primary); padding-bottom: 4px; }

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

    /* Index coverage card (start view) */
    .wiki-index-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 12px 16px;
      margin: 6px 0 6px;
    }
    .wiki-ix-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .wiki-ix-title { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
    .wiki-ix-refresh {
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
    .wiki-ix-refresh:hover { color: var(--accent-light); border-color: var(--accent); }
    .wiki-ix-reindex {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1;
      padding: 4px 8px;
      cursor: pointer;
      font-family: inherit;
    }
    .wiki-ix-reindex:hover:not(:disabled) { color: var(--accent-light); border-color: var(--accent); }
    .wiki-ix-reindex:disabled { opacity: 0.55; cursor: default; }
    .wiki-ix-reindex-status:not(:empty) { margin: 6px 0 2px; }
    .wiki-ix-reindex-msg { font-size: 12px; color: var(--text-muted); }
    .wiki-ix-reindex-list { display: flex; flex-direction: column; gap: 3px; }
    .wiki-ix-reindex-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .wiki-ix-reindex-row code { font-size: 11.5px; background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; color: var(--text-secondary); }
    .wiki-ix-reindex-row.running span { color: var(--accent-light); }
    .wiki-ix-reindex-row.ok span { color: var(--status-success); }
    .wiki-ix-reindex-row.error span { color: var(--status-error); }
    .wiki-ix-reindex-row.warn span { color: var(--status-warning); }
    .wiki-ix-summary { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
    .wiki-ix-summary b { color: var(--text-primary); }
    .wiki-ix-details { margin-top: 6px; }
    .wiki-ix-details summary { font-size: 12px; color: var(--text-muted); cursor: pointer; padding: 2px 0; }
    .wiki-ix-details summary:hover { color: var(--accent-light); }
    .wiki-ix-details[open] summary { color: var(--text-secondary); }
    .wiki-ix-list { margin: 4px 0 4px 18px; max-height: 200px; overflow-y: auto; }
    .wiki-ix-list li { font-size: 12px; color: var(--text-muted); margin: 2px 0; }
    .wiki-ix-list code { font-size: 11.5px; background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; }
    .wiki-ix-link { color: var(--accent-light); cursor: pointer; text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
    .wiki-ix-link:hover { color: var(--accent); }
    .wiki-ix-unavailable { font-size: 12px; color: var(--text-dim); }

    /* ── Right: Connections | Ask tabbed pane ──────────── */
    .wiki-conn-head { padding: 12px 14px; border-bottom: 1px solid var(--border-primary); font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-muted); }
    .wiki-conn-tabs { display: flex; border-bottom: 1px solid var(--border-primary); flex-shrink: 0; }
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

    /* Ask tab — owns the full rail when active (no 48% clamp; the tab owns the
       height). The controls live here; the answer renders in the article pane.
       Connections/Similar render in .wiki-conn-body on the other tab. */
    .wiki-ask-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow-y: auto;
      padding: 12px 12px 10px;
    }
    .wiki-ask-hint { font-size: 12px; color: var(--text-dim); padding: 6px 4px; line-height: 1.5; }
    .wiki-ask-bot { font-size: 11px; color: var(--text-dim); padding: 0 4px 6px; line-height: 1.5; }
    .wiki-ask-bot code { font-size: 10px; background: var(--bg-hover); padding: 1px 4px; border-radius: 4px; }
    /* Session history — one clickable line per asked question, newest first. */
    .wiki-ask-history { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
    .wiki-ask-hist-head { display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-faint); margin: 4px 4px 4px; }
    .wiki-ask-hist-clear { cursor: pointer; color: var(--text-dim); font-weight: 600; padding: 1px 4px; border-radius: 4px; }
    .wiki-ask-hist-clear:hover { color: var(--status-error); background: var(--bg-hover); }
    .wiki-ask-hist-item {
      font-size: 12.5px; color: var(--text-secondary); line-height: 1.4;
      padding: 6px 9px; border-radius: 6px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wiki-ask-hist-item::before { content: '› '; color: var(--accent); font-weight: 700; }
    .wiki-ask-hist-item:hover { background: var(--bg-surface); color: var(--text-primary); }
    .wiki-ask-status { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); margin: 6px 4px; }
    .wiki-ask-status .spinner { width: 12px; height: 12px; border: 2px solid var(--border-secondary); border-top-color: var(--accent); border-radius: 50%; animation: wikiAskSpin 0.7s linear infinite; }
    @keyframes wikiAskSpin { to { transform: rotate(360deg); } }
    .wiki-ask-status.done .spinner { display: none; }
    .wiki-ask-status.error { color: var(--status-error); }
    /* Select-to-Explain affordance now lives in the breadcrumb bar (see
       .wiki-bc-explain below) — shown only while a selection exists, so there is
       no permanently-dead button and no floating pill to position. */
    /* Answer rendered in the article pane — reuses .wiki-article typography. */
    .wiki-ask-article { margin-top: 4px; }
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
    /* Follow-up bar under the answer (in the article pane). */
    .wiki-followup { display: flex; gap: 8px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-primary); }
    .wiki-followup-input {
      flex: 1; padding: 9px 12px; border-radius: 8px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-primary); font-size: 13px; font-family: inherit; line-height: 1.4;
    }
    .wiki-followup-input:focus { outline: none; border-color: var(--accent); }
    .wiki-followup-input:disabled { opacity: 0.6; }
    .wiki-followup-btn {
      padding: 0 16px; border-radius: 8px; border: none;
      background: var(--accent); color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .wiki-followup-btn:hover { opacity: 0.9; }
    .wiki-followup-btn:disabled { opacity: 0.5; cursor: default; }
    /* "Remember this" bar under the follow-up bar. */
    .wiki-remember { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
    .wiki-remember-btn {
      padding: 6px 12px; border-radius: 8px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-primary); font-size: 12px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .wiki-remember-btn:hover { border-color: var(--accent); }
    .wiki-remember-btn:disabled { opacity: 0.5; cursor: default; }
    .wiki-remember-msg { font-size: 12px; color: var(--text-secondary); }
    .wiki-remember-msg.error { color: var(--status-error); }
    .wiki-remember-done { font-size: 12px; color: var(--accent-light); font-weight: 600; }
    .wiki-ask-compose { display: flex; gap: 6px; margin: 0 0 4px; }
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
    ${agentPresenceStyles()}
  </style>
</head>
<body>
  ${renderNav("wiki")}
  <div class="wiki-layout">
    <div class="wiki-pane">
      <div class="wiki-browse-head">
        ${
          wikiSelector || gardenerLink
            ? `<div class="wiki-head-top">${wikiSelector ? `<span class="wiki-count wiki-head-label">Wiki</span>${wikiSelector}` : ""}${gardenerLink}</div>`
            : ""
        }
        <div class="wiki-sort-row">${agentPresenceHtml("wikiPresence")}</div>
        <input type="text" id="wikiSearch" class="wiki-search" placeholder="Search titles, aliases, tags…">
        <div class="wiki-chip-row wiki-segmented" id="domainChips">
          <button class="wiki-chip active" data-domain="">All</button>
          <button class="wiki-chip" data-domain="ai">AI</button>
          <button class="wiki-chip" data-domain="life">Life</button>
        </div>
        <div class="wiki-sort-row">
          <select id="wikiSort" class="wiki-sort">
            <option value="updated" selected>Recently updated</option>
            <option value="backlinks">Most linked</option>
            <option value="title">Title A–Z</option>
          </select>
          <span class="wiki-count" id="wikiCount"></span>
        </div>
        <details class="wiki-filters" id="wikiFilters">
          <summary class="wiki-filters-summary">Filters<span class="wiki-filter-count" id="wikiFilterCount" style="display:none"></span></summary>
          <div class="wiki-filters-body">
            <div class="wiki-sort-row" id="wikiFolderRow" style="display:none">
              <select id="wikiFolder" class="wiki-sort wiki-folder"></select>
            </div>
            <div class="wiki-chip-row" id="typeChips"></div>
            <div class="wiki-chip-row" id="tagChips"></div>
          </div>
        </details>
      </div>
      <div class="wiki-list" id="wikiList"></div>
      <div class="wiki-coverage-foot" id="wikiCoverageFoot" style="display:none"></div>
    </div>

    <div class="wiki-pane">
      <div class="wiki-breadcrumb" id="wikiBreadcrumb" style="display:none"></div>
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
        <div class="wiki-ask-compose">
          <textarea class="wiki-ask-input" id="wikiAskInput" rows="2" placeholder="Ask this wiki…"></textarea>
          <button class="wiki-ask-btn" id="wikiAskBtn">Ask</button>
        </div>
        <div class="wiki-ask-status" id="wikiAskStatus" style="display:none"><span class="spinner"></span><span class="st"></span></div>
        <div class="wiki-ask-hint" id="wikiAskHint">Ask a question and this wiki answers in the main pane, with citations you can open as pages.</div>
        ${askBotLine}
        <div class="wiki-ask-history" id="wikiAskHistory"></div>
      </div>
    </div>
  </div>

  <script>
    window.__WIKI_NAME__ = ${escJsonScript(selected)};
  </script>
  <script>
    ${clientScript}
  </script>
  <script>
    ${agentPresenceScript("wikiPresence", { kinds: ["gardener_drain", "research"] })}
  </script>
</body>
</html>`;
}
