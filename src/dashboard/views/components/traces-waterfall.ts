/** Traces waterfall — span visualization with bar chart and detail panel.
 *  The script side lives in `traces-waterfall-browser.ts` (canonical TS)
 *  bundled via `tracesWaterfallClientScript()`. */
export { tracesWaterfallClientScript } from "./traces-waterfall-client.ts";

export function tracesWaterfallStyles(): string {
  return `
    /* Waterfall */
    .waterfall-container {
      display: none;
      padding: 16px 24px;
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      margin: 8px 0 16px;
    }
    .waterfall-container.visible { display: block; }
    /* When docked under a clicked row (see traces-waterfall-browser.ts) the
       panel lives inside a full-width <td>. Strip the trace-table cell
       defaults so it lays out the same as it does at the top of the page. */
    .trace-table td.waterfall-host-cell {
      padding: 0;
      border-bottom: none;
      white-space: normal;
    }
    #waterfallHostRow,
    #waterfallHostRow:hover { background: transparent; cursor: default; }
    .waterfall-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .waterfall-header h3 { font-size: 14px; color: var(--text-primary); }
    .waterfall-close {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 18px;
      padding: 4px;
    }
    .waterfall-close:hover { color: var(--text-primary); }

    .waterfall {
      position: relative;
      min-height: 40px;
    }
    .waterfall-row {
      display: grid;
      grid-template-columns: 300px 1fr;
      align-items: center;
      height: 28px;
      gap: 12px;
    }
    .waterfall-label {
      font-size: 12px;
      color: var(--text-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Collapse-toggle chevron on parent rows that have synthesized stage
       children (search trace stages). The spacer variant keeps non-collapsible
       rows aligned with collapsible ones so the chip column stays straight. */
    .waterfall-toggle {
      display: inline-block;
      width: 16px;
      text-align: center;
      color: var(--text-soft);
      font-size: 14px;
      line-height: 16px;
      cursor: pointer;
      user-select: none;
      margin-right: 4px;
    }
    .waterfall-toggle:hover { color: var(--text-primary); }
    .waterfall-toggle-spacer { cursor: default; visibility: hidden; }
    /* Chip-rendered labels for tool spans with discoverable collections.
       Verb + first-collection + (+N) — color stable per collection name (HSL hash). */
    .wf-chip {
      display: inline-block;
      padding: 0 6px;
      margin-right: 4px;
      border-radius: 3px;
      font-size: 10px;
      line-height: 16px;
      vertical-align: middle;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .wf-verb { font-weight: 600; }
    .wf-verb-search { background: color-mix(in srgb, var(--status-tool) 18%, transparent); color: var(--status-tool); border: 1px solid color-mix(in srgb, var(--status-tool) 40%, transparent); }
    .wf-verb-get    { background: color-mix(in srgb, var(--status-info) 18%, transparent); color: var(--status-info); border: 1px solid color-mix(in srgb, var(--status-info) 40%, transparent); }
    .wf-verb-list   { background: color-mix(in srgb, var(--status-cyan) 18%, transparent); color: var(--status-cyan); border: 1px solid color-mix(in srgb, var(--status-cyan) 40%, transparent); }
    .wf-verb-read   { background: color-mix(in srgb, var(--status-cyan) 14%, transparent); color: var(--status-cyan); border: 1px solid color-mix(in srgb, var(--status-cyan) 35%, transparent); }
    .wf-verb-symbol { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-light); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
    .wf-verb-analyze { background: color-mix(in srgb, var(--status-magenta) 18%, transparent); color: var(--status-magenta); border: 1px solid color-mix(in srgb, var(--status-magenta) 40%, transparent); }
    .wf-verb-other  { background: color-mix(in srgb, white 6%, transparent); color: var(--text-soft); border: 1px solid color-mix(in srgb, white 12%, transparent); }
    /* Generic extra chip — used for ids, path tails, and patterns alongside
       a repo/kind chip so the row carries the most distinguishing info. */
    .wf-chip.wf-extra {
      background: color-mix(in srgb, white 5%, transparent);
      color: var(--text-soft);
      border: 1px solid color-mix(in srgb, white 10%, transparent);
      max-width: 200px;
    }
    .wf-chip.wf-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .wf-coll-more {
      background: color-mix(in srgb, white 5%, transparent);
      color: var(--text-dim);
      border: 1px solid color-mix(in srgb, white 10%, transparent);
    }
    /* Counts chip — kept/fetched candidate count for search tool spans. The
       low-conf variant flips to the warning palette so a "you got nothing
       useful" search is visible without expanding the trace panel. */
    .wf-chip.wf-counts {
      background: color-mix(in srgb, white 6%, transparent);
      color: var(--text-soft);
      border: 1px solid color-mix(in srgb, white 12%, transparent);
      font-variant-numeric: tabular-nums;
    }
    .wf-chip.wf-counts.wf-low-conf {
      background: color-mix(in srgb, var(--status-warning) 14%, transparent);
      color: var(--status-warning);
      border-color: color-mix(in srgb, var(--status-warning) 35%, transparent);
    }
    /* "0 hits" chip — the search returned nothing usable to the model, even if
       the pipeline kept candidates. Replaces the kept/fetched count in that case. */
    .wf-chip.wf-no-hits {
      background: color-mix(in srgb, var(--status-error, var(--status-magenta)) 14%, transparent);
      color: var(--status-error, var(--status-magenta));
      border: 1px solid color-mix(in srgb, var(--status-error, var(--status-magenta)) 35%, transparent);
      font-weight: 600;
    }
    .waterfall-bar-container {
      position: relative;
      height: 16px;
      background: color-mix(in srgb, white 3%, transparent);
      border-radius: 3px;
    }
    .waterfall-bar {
      position: absolute;
      height: 100%;
      border-radius: 3px;
      min-width: 2px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .waterfall-bar:hover { opacity: 0.8; }
    .waterfall-bar.kind-root { background: var(--accent); }
    .waterfall-bar.kind-span { background: var(--status-cyan); }
    .waterfall-bar.kind-tool { background: var(--status-tool); }
    .waterfall-bar.kind-event { background: var(--status-warning); width: 3px !important; }
    .waterfall-bar.status-error { background: var(--status-error); }
    .waterfall-duration {
      position: absolute;
      right: -60px;
      top: 0;
      font-size: 10px;
      color: var(--text-dim);
      line-height: 16px;
      width: 55px;
    }
    .waterfall-input {
      position: absolute;
      left: calc(100% + 65px);
      top: 0;
      font-size: 10px;
      color: var(--text-faint);
      line-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }

    /* Span Details — inline panel below the waterfall on narrow viewports.
       Promoted to a fixed right-side drawer at ≥1200px (see media query below). */
    .span-details {
      position: relative;
      margin-top: 16px;
      background: var(--bg-page);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
      display: none;
    }
    .span-details.visible { display: block; }
    .span-details h4 { color: var(--accent-light); margin-bottom: 8px; font-size: 13px; padding-right: 32px; }
    .span-details pre {
      background: var(--bg-panel);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      color: var(--text-tertiary);
      font-size: 11px;
      line-height: 1.5;
    }
    .span-details-close {
      position: absolute;
      top: 8px;
      right: 10px;
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px 8px;
      border-radius: 4px;
      display: none;
    }
    .span-details-close:hover { color: var(--text-primary); background: color-mix(in srgb, white 5%, transparent); }

    @media (min-width: 1200px) {
      .span-details {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: clamp(560px, 55vw, 920px);
        margin: 0;
        z-index: 50;
        border-radius: 0;
        border: none;
        border-left: 1px solid var(--border-primary);
        padding: 20px 20px 24px;
        overflow-y: auto;
        background: var(--bg-page);
        box-shadow: -8px 0 24px rgba(0,0,0,0.35);
      }
      .span-details-close { display: block; }
      /* Title can be long inside a narrow drawer column; let it shrink hard
         and rely on the cell's title attribute for the full string. */
      .span-details .stt-cands td.stt-title { max-width: 220px; }
    }

    /* View Prompt button in waterfall header */
    .btn-view-prompt {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--accent-light);
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      margin-right: 8px;
    }
    .btn-view-prompt:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); border-color: var(--accent); }
  `;
}

export function tracesWaterfallHtml(): string {
  return `
    <div class="waterfall-container" id="waterfallContainer">
      <div class="waterfall-header">
        <h3 id="waterfallTitle">Trace Details</h3>
        <div>
          <button class="btn-view-prompt" id="btnViewPrompt" onclick="openPromptModal()">View Prompt</button>
          <button class="waterfall-close" onclick="closeWaterfall()">&times;</button>
        </div>
      </div>
      <div class="waterfall" id="waterfall"></div>
      <div class="span-details" id="spanDetails">
        <button class="span-details-close" onclick="closeSpanDetails()" title="Close (Esc)" aria-label="Close span detail">&times;</button>
        <h4 id="spanDetailsTitle"></h4>
        <div id="spanDetailsJson"></div>
      </div>
    </div>`;
}

