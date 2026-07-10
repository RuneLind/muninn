import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { gardenerClientScript } from "./components/wiki-gardener-client.ts";
import { escHtml, escAttr, escJsonScript } from "./components/escape.ts";

/**
 * /wiki/gardener — the wiki-gardener review gate.
 *
 * Lists a bot's drafted page proposals with a rendered markdown preview, a
 * current-file→draft diff (update mode), the source summaries each drew from, and
 * Approve / Reject buttons. Approve runs the apply step (muninn's first wiki
 * write); reject skips the topic on future runs. The client is a bundled TS
 * entrypoint (`components/wiki-gardener-browser.ts`), same pattern as /wiki.
 *
 * `?bot=<name>` selects which bot's proposals to review, mirroring the /wiki
 * reader; the canonical bot is injected as `window.__WIKI_BOT__` so the client's
 * `?bot=` fetches and the picker agree.
 */
export async function renderWikiGardenerPage(opts?: {
  wikiBots?: string[];
  selected?: string;
  envOverride?: boolean;
  /** True when `?wiki=` names a real but non-bot (extra) wiki — the gardener has
   *  no proposals for it, so render a clean "unavailable" state, not an error. */
  notBotWiki?: boolean;
}): Promise<string> {
  const clientScript = await gardenerClientScript();
  const wikiBots = opts?.wikiBots ?? [];
  const selected = opts?.selected ?? "";
  const envOverride = opts?.envOverride ?? false;
  const notBotWiki = opts?.notBotWiki ?? false;
  // A non-bot wiki matches no bot option — render its raw name as a disabled,
  // selected placeholder so the picker agrees with the "unavailable" body. Show
  // the picker for any non-empty bot registry so there's always a way back.
  const placeholder = notBotWiki && !!selected && !envOverride;
  const wikiSelector =
    wikiBots.length >= 1
      ? `<select id="wikiBot" class="wiki-sort" aria-label="Wiki">` +
        (envOverride ? `<option value="" selected disabled>env override</option>` : "") +
        (placeholder ? `<option value="" selected disabled>${escHtml(selected)}</option>` : "") +
        wikiBots
          .map(
            (b) =>
              `<option value="${escAttr(b)}"${!envOverride && !placeholder && b === selected ? " selected" : ""}>${escHtml(b)}</option>`,
          )
          .join("") +
        `</select>`
      : "";
  const gardListInit = notBotWiki
    ? `<div class="gard-empty"><strong>${escHtml(selected)}</strong> is a standalone wiki — the gardener is only available for bot wikis. Pick a bot wiki above.</div>`
    : `<div class="gard-empty">Loading proposals…</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wiki Gardener — Muninn</title>
  <style>
    ${SHARED_STYLES}

    .gard-wrap { max-width: 980px; margin: 0 auto; padding: 20px 24px 60px; }
    .gard-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .gard-head h1 { font-size: 20px; color: var(--text-primary); }
    .gard-head a { font-size: 12.5px; color: var(--status-info); text-decoration: none; }
    .gard-head a:hover { text-decoration: underline; }
    .gard-sub { font-size: 12.5px; color: var(--text-muted); margin-bottom: 18px; }
    .wiki-sort { background: var(--bg-inset); border: 1px solid var(--border-secondary); border-radius: 6px; color: var(--text-tertiary); font-size: 12px; font-family: inherit; padding: 4px 6px; }

    /* Ingest backlog strip (report-only "queued up" counter) */
    .gard-backlog {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px;
      padding: 11px 15px; margin-bottom: 16px;
      background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 10px;
      font-size: 13px; color: var(--text-secondary);
    }
    .gard-backlog .bk-label { color: var(--text-muted); }
    .gard-backlog .bk-sentence { color: var(--text-secondary); }
    .gard-backlog .bk-strong { font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .gard-backlog .bk-n { font-weight: 600; color: var(--accent-light); font-variant-numeric: tabular-nums; }
    .gard-backlog .bk-sep { color: var(--text-dim); }
    .gard-backlog .bk-err { color: var(--status-magenta); font-size: 12px; }
    .gard-backlog .bk-run-note { color: var(--text-muted); font-size: 12px; }
    .gard-backlog .bk-control { display: inline-flex; align-items: center; gap: 8px; }
    /* Primary run button — deliberately reads as a button, not inline stat text. */
    .gard-backlog .gard-btn.bk-run {
      background: var(--accent); border: 1px solid var(--accent); color: #fff;
      font-size: 13px; font-weight: 600; padding: 7px 16px; border-radius: 7px;
      font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-run:hover:not(:disabled) { background: var(--accent-light); border-color: var(--accent-light); }
    .gard-backlog .gard-btn.bk-run:disabled { opacity: 0.55; cursor: default; }
    .gard-backlog .gard-btn.bk-reset {
      background: transparent; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-size: 12px; padding: 4px 12px; border-radius: 7px; font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-reset:hover { border-color: var(--accent); color: var(--text-primary); }
    /* Inline informed-consent panel — full-width row below the strip, hidden until confirm. */
    .gard-backlog .bk-confirm {
      display: none; flex-basis: 100%; flex-direction: column; gap: 10px;
      margin-top: 4px; padding: 12px 14px;
      background: var(--bg-inset); border: 1px solid var(--border-primary); border-radius: 8px;
    }
    .gard-backlog .bk-confirm.open { display: flex; }
    .gard-backlog .bk-confirm-copy { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .gard-backlog .bk-confirm-copy strong { color: var(--text-primary); font-weight: 700; }
    .gard-backlog .bk-confirm-actions { display: flex; gap: 8px; }
    .gard-backlog .gard-btn.bk-start {
      background: var(--accent); border: 1px solid var(--accent); color: #fff;
      font-size: 13px; font-weight: 600; padding: 7px 16px; border-radius: 7px; font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-start:hover { background: var(--accent-light); border-color: var(--accent-light); }
    .gard-backlog .gard-btn.bk-cancel {
      background: transparent; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-size: 13px; padding: 7px 16px; border-radius: 7px; font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-cancel:hover { border-color: var(--accent); color: var(--text-primary); }
    /* Live-drain progress line (replaces the disabled "Running…" while a drain runs). */
    .gard-backlog .bk-progress { flex-wrap: wrap; gap: 6px 10px; }
    .gard-backlog .bk-progress-line { color: var(--text-secondary); font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .gard-backlog .gard-btn.bk-cancel-run {
      background: transparent; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-size: 12px; padding: 4px 12px; border-radius: 7px; font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-cancel-run:hover:not(:disabled) { border-color: var(--status-magenta); color: var(--text-primary); }
    .gard-backlog .gard-btn.bk-cancel-run:disabled { opacity: 0.55; cursor: default; }
    /* Interrupted-run recovery banner (PR 3) — full-width row above the strip. */
    .gard-backlog .bk-banner {
      flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
      margin-bottom: 4px; padding: 9px 13px;
      background: color-mix(in srgb, var(--status-warning, #d0a000) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-warning, #d0a000) 45%, transparent);
      border-radius: 8px;
    }
    .gard-backlog .bk-banner-msg { color: var(--text-secondary); font-size: 12.5px; }
    .gard-backlog .bk-banner-actions { display: inline-flex; gap: 8px; }
    .gard-backlog .gard-btn.bk-recover {
      background: var(--accent); border: 1px solid var(--accent); color: #fff;
      font-size: 12px; font-weight: 600; padding: 4px 13px; border-radius: 7px; font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-recover:hover { background: var(--accent-light); border-color: var(--accent-light); }
    .gard-backlog .gard-btn.bk-dismiss {
      background: transparent; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-size: 12px; padding: 4px 13px; border-radius: 7px; font-family: inherit; cursor: pointer;
    }
    .gard-backlog .gard-btn.bk-dismiss:hover { border-color: var(--accent); color: var(--text-primary); }

    .gard-filter-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
    .gard-filter {
      padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border-secondary);
      background: transparent; color: var(--text-muted); font-size: 12px; font-family: inherit; cursor: pointer;
    }
    .gard-filter:hover { color: var(--text-primary); border-color: var(--accent); }
    .gard-filter.active { background: color-mix(in srgb, var(--accent) 18%, transparent); border-color: var(--accent); color: var(--accent-light); }

    .gard-card {
      background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 10px;
      margin-bottom: 16px; overflow: hidden;
    }
    .gard-card-head { padding: 14px 18px; border-bottom: 1px solid var(--border-primary); }
    .gard-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
    .gard-title { font-size: 15.5px; color: var(--text-primary); font-weight: 600; }
    .gard-path { font-size: 11.5px; color: var(--text-dim); font-family: var(--font-mono, monospace); }
    .gard-meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-muted); }

    .gard-badge { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
    .badge-concept { background: var(--tint-purple); color: var(--accent-light); }
    .badge-entity { background: var(--tint-cyan); color: var(--status-cyan); }
    .badge-create { background: var(--tint-success); color: var(--status-success); }
    .badge-update { background: var(--tint-info); color: var(--status-info); }
    .chip-draft { background: var(--tint-neutral); color: var(--text-muted); }
    .chip-approved { background: var(--tint-info); color: var(--status-info); }
    .chip-applied { background: var(--tint-success); color: var(--status-success); }
    .chip-rejected { background: var(--tint-neutral); color: var(--text-dim); }
    .chip-stale { background: var(--tint-warning, var(--tint-neutral)); color: var(--status-warning, var(--text-muted)); }
    .chip-error { background: var(--tint-magenta); color: var(--status-magenta); }

    .gard-body { padding: 14px 18px; }
    .gard-section-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-faint); margin: 4px 0 8px; }
    .gard-rationale { font-size: 12.5px; color: var(--text-secondary); font-style: italic; margin-bottom: 14px; }
    .gard-stale-note {
      font-size: 12.5px; color: var(--text-muted); background: var(--bg-surface);
      border: 1px solid var(--border-secondary); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;
    }

    .gard-sources { list-style: none; margin: 0 0 14px; padding: 0; }
    .gard-sources li { font-size: 12.5px; margin: 3px 0; }
    .gard-sources a { color: var(--status-info); text-decoration: none; }
    .gard-sources a:hover { text-decoration: underline; }
    .gard-src-coll { color: var(--text-faint); font-size: 11px; }

    /* Toggle sections */
    .gard-toggle {
      background: none; border: 1px solid var(--border-secondary); border-radius: 6px;
      color: var(--text-muted); font-size: 11.5px; font-family: inherit; padding: 4px 10px; cursor: pointer; margin-right: 8px;
    }
    .gard-toggle:hover { color: var(--text-primary); border-color: var(--accent); }
    .gard-collapsible { display: none; margin-top: 12px; }
    .gard-collapsible.open { display: block; }

    /* Diff */
    .gard-diff { background: var(--bg-inset); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; }
    .gard-diff .d-add { color: var(--status-success); background: color-mix(in srgb, var(--status-success) 12%, transparent); display: block; white-space: pre-wrap; }
    .gard-diff .d-del { color: var(--status-magenta); background: color-mix(in srgb, var(--status-magenta) 12%, transparent); display: block; white-space: pre-wrap; }
    .gard-diff .d-ctx { color: var(--text-dim); display: block; white-space: pre-wrap; }

    /* Preview (mirrors the /wiki article styling, scoped) */
    .gard-preview { border: 1px solid var(--border-secondary); border-radius: 8px; padding: 16px 20px; background: var(--bg-surface); font-size: 13.5px; line-height: 1.6; color: var(--text-secondary); }
    .gard-preview h1, .gard-preview h2, .gard-preview h3, .gard-preview h4 { color: var(--text-primary); margin: 16px 0 7px; }
    .gard-preview h1 { font-size: 19px; }
    .gard-preview h2 { font-size: 16px; }
    .gard-preview h3 { font-size: 14px; }
    .gard-preview p { margin: 7px 0; }
    .gard-preview ul, .gard-preview ol { margin: 7px 0 7px 22px; }
    .gard-preview li { margin: 2px 0; }
    .gard-preview code { background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    .gard-preview pre { background: var(--bg-inset); padding: 12px; border-radius: 8px; overflow-x: auto; }
    .gard-preview blockquote { border-left: 3px solid var(--border-secondary); padding: 6px 12px; margin: 10px 0; color: var(--text-muted); }
    .gard-preview a { color: var(--status-info); }
    .gard-preview .wiki-link { color: var(--accent-light); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
    .gard-preview .wiki-link-missing { color: var(--text-muted); border-bottom: 1px dashed var(--text-disabled); }

    /* Actions */
    .gard-actions { display: flex; gap: 10px; align-items: center; padding: 12px 18px; border-top: 1px solid var(--border-primary); }
    .gard-btn { font-size: 13px; font-family: inherit; padding: 7px 16px; border-radius: 7px; border: 1px solid transparent; cursor: pointer; }
    .gard-btn:disabled { opacity: 0.5; cursor: default; }
    .gard-approve { background: color-mix(in srgb, var(--status-success) 20%, transparent); border-color: var(--status-success); color: var(--status-success); }
    .gard-approve:hover:not(:disabled) { background: color-mix(in srgb, var(--status-success) 32%, transparent); }
    .gard-reject { background: transparent; border-color: var(--border-secondary); color: var(--text-muted); }
    .gard-reject:hover:not(:disabled) { border-color: var(--status-magenta); color: var(--status-magenta); }
    .gard-outcome { font-size: 12.5px; color: var(--text-muted); }
    .gard-outcome.err { color: var(--status-magenta); }
    .gard-outcome.ok { color: var(--status-success); }

    .gard-empty { padding: 48px; text-align: center; color: var(--text-muted); font-size: 13.5px; }
    .gard-empty code { background: var(--bg-inset); padding: 2px 6px; border-radius: 4px; }

    /* Lint findings (report-only) */
    .lint-section { margin-top: 36px; }
    .lint-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
    .lint-head h2 { font-size: 16px; color: var(--text-primary); }
    .lint-sub { font-size: 12px; color: var(--text-muted); margin-bottom: 14px; }
    .lint-refresh {
      background: none; border: 1px solid var(--border-secondary); border-radius: 6px;
      color: var(--text-muted); font-size: 11.5px; font-family: inherit; padding: 4px 10px; cursor: pointer;
    }
    .lint-refresh:hover { color: var(--text-primary); border-color: var(--accent); }
    .lint-group {
      background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 10px;
      margin-bottom: 12px; overflow: hidden;
    }
    .lint-group-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 16px;
      border-bottom: 1px solid var(--border-primary); font-size: 13px; color: var(--text-primary); font-weight: 600;
    }
    .lint-count {
      font-size: 11px; padding: 1px 8px; border-radius: 999px;
      background: var(--tint-neutral); color: var(--text-muted); font-weight: 600;
    }
    .lint-items { list-style: none; margin: 0; padding: 6px 0; }
    .lint-items li { padding: 5px 16px; font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; }
    .lint-items li:hover { background: var(--bg-surface); }
    .lint-path { color: var(--text-secondary); font-family: var(--font-mono, monospace); font-size: 11.5px; }
    .lint-msg { color: var(--text-muted); }
  </style>
</head>
<body>
  ${renderNav("wiki")}
  <div class="gard-wrap">
    <div class="gard-head">
      <h1>🌱 Wiki Gardener</h1>
      <div style="display:flex; gap:10px; align-items:center;">
        ${wikiSelector}
        <a href="/wiki${selected ? "?wiki=" + escAttr(selected) : ""}">← Wiki reader</a>
      </div>
    </div>
    <div class="gard-sub">Drafted knowledge-wiki pages awaiting review. Approve writes the page into the wiki and triggers a reindex; reject skips the topic on future runs.</div>
    <div id="gardBacklog" class="gard-backlog"></div>
    <div class="gard-filter-row" id="gardFilters">
      <button class="gard-filter active" data-status="">All</button>
      <button class="gard-filter" data-status="draft">Pending</button>
      <button class="gard-filter" data-status="applied">Applied</button>
      <button class="gard-filter" data-status="rejected">Rejected</button>
      <button class="gard-filter" data-status="stale">Stale</button>
    </div>
    <div id="gardList">${gardListInit}</div>

    <div class="lint-section">
      <div class="lint-head">
        <h2>🧹 Lint findings</h2>
        <button id="lintRefresh" class="lint-refresh">Refresh</button>
      </div>
      <div class="lint-sub">Report-only wiki hygiene — broken links, orphan pages, missing <code>updated:</code>, and concepts citing no sources. Recomputed on demand; nothing is written.</div>
      <div id="lintList"><div class="gard-empty">Loading lint findings…</div></div>
    </div>
  </div>

  <script>
    window.__WIKI_BOT__ = ${escJsonScript(selected)};
    window.__WIKI_GARDENER_UNAVAILABLE__ = ${notBotWiki ? "true" : "false"};
  </script>
  <script>
    ${clientScript}
  </script>
</body>
</html>`;
}
