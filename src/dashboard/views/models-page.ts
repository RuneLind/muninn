import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { pageHeaderHtml, pageHeaderScript, pageHeaderStyles } from "./components/page-header.ts";
import { summaryTilesHtml, summaryTilesScript } from "./components/summary-tiles.ts";
import { statusChipsScript } from "./components/status-chips.ts";

/**
 * Models overview page (dashboard redesign, PR 3). The effective model /
 * connector / Haiku backend for every AI job, next to what actually ran. The
 * server renders the shell (page header + persisted help panel, empty tile row,
 * empty card containers); the client fetches `/api/models/overview?bot=<sel>`
 * and renders:
 *   - Bot cards (3-up) with a mismatch warning border/callout and a
 *     "▸ why this Haiku backend?" expandable resolution chain (from the payload's
 *     `chain` — NEVER placeholder rows),
 *   - Roles + Wiki synthesis as side-by-side list cards (shared origin chips),
 *   - a Pipeline jobs list card with live runtime chips.
 *
 * Editing is preserved: the "Edit" ghost button opens an in-card config editor
 * (applies on restart); role rows carry a hot DB-override select + Apply.
 *
 * Consumes the PR 1 shared primitives: `pageHeader*`, `summaryTiles*`/`tileHtml`,
 * and `statusChipsScript`'s `originChip`. Runtime-chip merge is a hand-mirror of
 * `src/dashboard/models-runtime.ts` (kept in sync, like the agent-eta mirror).
 */
export async function renderModelsPage(): Promise<string> {
  const helpers = await helpersClientScript();

  const helpHtml = `The <strong>effective</strong> model, connector, and Haiku backend for every AI job after all
      defaults resolve — next to the models <strong>actually seen</strong> in the last 7 days
      (<code>haiku_usage</code> + <code>traces</code>). A mismatch between the two is the
      <code>#191</code> silent-fallback class of bug. Per-bot fields edit <code>config.json</code>
      (<strong>applies on restart</strong>); role overrides are <strong>hot</strong> (take effect immediately).`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Muninn - Models</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}
    ${pageHeaderStyles()}

    .page { padding: 22px 28px 56px; max-width: 1560px; margin: 0 auto; }
    .pghdr-help code { background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .empty { color: var(--text-disabled); }
    .err-note { color: var(--status-warning); font-size: 12px; margin: 8px 0; }
    .empty-msg { color: var(--text-faint); padding: 24px; text-align: center; }

    .section { margin-bottom: 26px; }
    .section > h2 { font-size: 15px; color: var(--text-primary); font-weight: 600; margin: 0 0 4px; }
    .section > .sub { font-size: 12px; color: var(--text-dim); margin-bottom: 12px; }

    /* --- Bot cards (3-up) --------------------------------------------------- */
    .bot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
    .bot-card {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column;
    }
    .bot-card.mismatch { border-color: color-mix(in srgb, var(--status-warning) 35%, transparent); }

    .bc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
    .bc-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .bc-name { font-size: 15px; font-weight: 600; color: var(--text-primary); }
    .bc-conn {
      font-size: 11px; color: var(--text-soft); background: var(--bg-surface);
      border: 1px solid var(--border-primary); padding: 2px 8px; border-radius: 6px; white-space: nowrap;
    }
    .ghost-btn {
      background: transparent; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-size: 11px; padding: 3px 10px; border-radius: 6px; cursor: pointer; font-family: inherit;
      transition: color 0.15s, border-color 0.15s;
    }
    .ghost-btn:hover { color: var(--text-primary); border-color: var(--accent); }

    .bc-fields { display: flex; flex-direction: column; }
    .bc-field {
      display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
      padding: 7px 0; border-bottom: 1px solid var(--border-subtle);
    }
    .bc-flabel { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
    .bc-fval { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .bc-fval code { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Why-this-backend toggle + resolution chain. */
    .bc-why {
      font-size: 11px; color: var(--accent-muted); padding: 9px 0 0; cursor: pointer; user-select: none;
      display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
    }
    .bc-why:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .bc-chain[hidden] { display: none; }
    .bc-chain {
      background: var(--bg-inset); border: 1px solid var(--border-primary); border-radius: 8px;
      padding: 10px 12px; margin-top: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    .chain-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
    .chain-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-disabled); flex-shrink: 0; }
    .chain-row.win .chain-dot { background: var(--status-success); }
    .chain-text { color: var(--text-dim); min-width: 0; }
    .chain-row.win .chain-text { color: var(--text-secondary); }
    .chain-text .cv { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-soft); }
    .chain-row.win .chain-text .cv { color: var(--text-primary); }
    .chain-text .cd { color: var(--text-faint); }
    .chain-wins {
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 8px;
      background: color-mix(in srgb, var(--status-success) 14%, transparent); color: var(--status-success); flex-shrink: 0;
    }

    /* Seen-in-traces section. */
    .bc-seen { margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--border-primary); }
    .bc-seen-label { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-dim); font-weight: 600; margin-bottom: 7px; }
    .seen-rows { display: flex; flex-direction: column; gap: 4px; }
    .seen-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
    .seen-kind { color: var(--text-dim); width: 36px; flex-shrink: 0; }
    .seen-model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-soft); }
    .seen-model.warn { color: var(--status-warning); }
    .mismatch-callout {
      margin-top: 10px; background: color-mix(in srgb, var(--status-warning) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-warning) 30%, transparent); border-radius: 8px;
      padding: 8px 11px; font-size: 11px; color: var(--status-warning); line-height: 1.5;
    }
    .mismatch-callout .mono { color: var(--status-warning); }

    /* In-card config editor. */
    .bc-editor[hidden] { display: none; }
    .bc-editor {
      margin-top: 10px; padding: 12px; background: color-mix(in srgb, var(--accent) 5%, transparent);
      border: 1px solid var(--border-primary); border-radius: 8px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .editor-fld { display: flex; flex-direction: column; gap: 3px; }
    .editor-fld label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-dim); }
    .m-select, .m-input {
      background: var(--bg-surface); border: 1px solid var(--border-primary); color: var(--text-primary);
      font-size: 12px; padding: 4px 7px; border-radius: 5px; font-family: inherit; width: 100%;
    }
    .editor-actions { display: flex; gap: 10px; align-items: center; }
    .editor-actions .hint { font-size: 11px; color: var(--text-dim); }
    .btn-save {
      background: var(--accent); border: none; color: #fff; font-size: 12px; font-weight: 600;
      padding: 5px 14px; border-radius: 6px; cursor: pointer;
    }
    .btn-save:hover { filter: brightness(1.08); }
    .btn-save:disabled { opacity: 0.5; cursor: default; }

    /* --- Roles + Wiki synthesis: side-by-side list cards -------------------- */
    .lc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
    @media (max-width: 900px) { .lc-grid { grid-template-columns: 1fr; } }
    .list-card { background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 12px; overflow: hidden; }
    .lc-head { padding: 13px 18px 4px; }
    .lc-head h3 { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .lc-head .lc-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; line-height: 1.5; }
    .lc-body { padding: 6px 6px 8px; }
    .lc-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; }
    .lc-main { flex: 1; min-width: 0; }
    .lc-title { font-size: 13px; color: var(--text-secondary); }
    .lc-note { font-size: 11px; color: var(--text-dim); margin-top: 1px; }
    .lc-note.bad { color: var(--status-error); }
    .lc-note.ok { color: var(--status-success); }
    .lc-note.warn { color: var(--status-warning); }
    .lc-val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-secondary); flex-shrink: 0; }
    .lc-val.none { color: var(--text-disabled); }
    /* Tone classes for the Pipeline ledger rows — the row VALUE is the number a
       reader scans, so the tone lands there as well as on the note. */
    .lc-val.warn { color: var(--status-warning); }
    .lc-val.bad { color: var(--status-error); }
    .lc-val.ok { color: var(--status-success); }
    .role-edit { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .role-edit .m-select { width: auto; }
    .lc-wiki { font-size: 13px; font-weight: 600; color: var(--text-primary); width: 150px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lc-arrow { color: var(--text-faint); font-size: 11px; flex-shrink: 0; }
    .lc-via { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--text-dim); margin-top: 1px; }
    .lc-right { text-align: right; flex-shrink: 0; }
    .lc-reason { font-size: 10px; color: var(--text-faint); margin-top: 2px; }
    .lc-reason.bad { color: var(--status-error); }

    /* --- Repo sync card ------------------------------------------------------
       "Behind 0 · dirty 0 · not blocked" is the whole question this card exists
       to answer: do I have everything from both machines? The remote-seen age is
       beside it because that answer is only as fresh as the last fetch. */
    .sync-state { font-size: 12px; font-weight: 600; flex-shrink: 0; }
    .sync-state.ok { color: var(--status-success); }
    .sync-state.warn { color: var(--status-warning); }
    .sync-state.bad { color: var(--status-error); }
    /* Never-synced is NOT healthy — it is "no evidence yet", so it must not
       borrow the green that means "in sync with both machines". */
    .sync-state.neutral { color: var(--text-dim); }
    .sync-warn { font-size: 11px; color: var(--status-warning); margin-top: 2px; }
    /* Head actions sit in the head's own flex row rather than a floated span:
       a float escapes the head box and overlapped the sub-line at narrow widths. */
    .lc-head.lc-head-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .lc-head.lc-head-actions .lc-head-text { min-width: 0; }
    .sync-counts { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-dim); }
    .sync-counts .hot { color: var(--status-warning); }
    .btn-sync {
      background: var(--bg-surface); border: 1px solid var(--border-primary); color: var(--text-secondary);
      font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; flex-shrink: 0;
    }
    .btn-sync:hover { border-color: var(--accent); color: var(--text-primary); }
    .btn-sync:disabled { opacity: 0.5; cursor: default; }
    .sync-head-actions { display: flex; gap: 8px; align-items: center; }
    .sync-out {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--text-dim);
      white-space: pre-wrap; margin: 2px 12px 8px; line-height: 1.5;
    }

    /* --- Pipeline jobs list card ------------------------------------------- */
    .pl-card { background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 12px; overflow-x: auto; }
    .pl-head, .pl-row {
      display: grid; grid-template-columns: minmax(280px, 2fr) minmax(150px, 1fr) minmax(180px, 1.2fr) minmax(140px, 1fr);
      gap: 14px; align-items: start; padding: 10px 16px;
    }
    .pl-head { border-bottom: 1px solid var(--border-primary); font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-faint); }
    .pl-row { border-bottom: 1px solid var(--border-subtle); }
    .pl-row:last-child { border-bottom: none; }
    .pl-job { font-size: 13px; color: var(--text-secondary); }
    .pl-backend { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-soft); }
    .pl-model code { font-size: 12px; color: var(--text-secondary); }
    .note { font-size: 11px; color: var(--text-dim); margin-top: 3px; }
    .used { display: flex; flex-direction: column; gap: 2px; }
    .used code { font-size: 11px; color: var(--text-soft); }
    .used .empty { color: var(--text-disabled); }

    /* Live runtime chips (hand-mirror of models-runtime.ts). */
    .rt-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .rt-chip {
      display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 10px;
      font-size: 10px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap;
    }
    .rt-chip.rt-run { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
    .rt-chip.rt-run .pulse-dot { width: 7px; height: 7px; background: var(--status-success); }
    .rt-chip.rt-next { background: color-mix(in srgb, var(--status-warning) 14%, transparent); color: var(--status-warning); }
    .rt-chip.rt-last { background: var(--tint-neutral); color: var(--text-muted); font-weight: 500; }

    /* Toast (unchanged behavior). */
    .toast {
      position: fixed; right: 18px; bottom: 18px; max-width: 380px; z-index: 50;
      padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.4;
      box-shadow: 0 6px 24px rgba(0,0,0,0.28); display: none;
    }
    .toast.show { display: block; }
    .toast.ok  { background: color-mix(in srgb, var(--status-success) 20%, var(--bg-surface)); color: var(--text-primary); border: 1px solid var(--status-success); }
    .toast.warn{ background: color-mix(in srgb, var(--status-warning) 20%, var(--bg-surface)); color: var(--text-primary); border: 1px solid var(--status-warning); }
    .toast.bad { background: color-mix(in srgb, var(--status-error) 20%, var(--bg-surface)); color: var(--text-primary); border: 1px solid var(--status-error); }
  </style>
</head>
<body>
  ${renderNav("models", { headerLeftExtra: botSelectorHtml() })}

  <div class="page">
    ${pageHeaderHtml({
      title: "Models",
      metaHtml: `<span id="modelsMeta">loading…</span>`,
      helpHtml,
    })}

    ${summaryTilesHtml("modelTiles")}

    <div id="errBox"></div>

    <div class="section">
      <div class="bot-grid" id="botGrid"><div class="empty-msg">Loading…</div></div>
    </div>

    <div class="section">
      <div class="list-card">
        <div class="lc-head">
          <h3>Machine</h3>
          <div class="lc-sub">Which muninn instance this is. Muninn runs on more than one host against the same wikis — the profile is env-only, so it is shown rather than implied.</div>
        </div>
        <div class="lc-body" id="machineBody"><div class="empty-msg">Loading…</div></div>
      </div>
    </div>

    <div class="section" id="usageSection" hidden>
      <div class="list-card">
        <div class="lc-head">
          <h3>Pipeline ledger</h3>
          <div class="lc-sub">Headline numbers from the claude-usage aggregator (served on port 8787 of the host running muninn). Fetched server-side — this page never reaches that port from your browser, so there is no link to follow from here.</div>
        </div>
        <div class="lc-body" id="usageBody"><div class="empty-msg">Loading…</div></div>
      </div>
    </div>

    <div class="section" id="syncSection" hidden>
      <div class="list-card">
        <div class="lc-head lc-head-actions">
          <div class="lc-head-text">
            <h3>Repo sync</h3>
            <div class="lc-sub">Shared repos converge only through GitHub. Behind 0 · dirty 0 · not blocked means this machine has everything from both — but only as fresh as the last fetch, so the fetch age is shown beside it.</div>
          </div>
          <span class="sync-head-actions">
            <button class="btn-sync" id="syncDryBtn" title="Report what would be committed, rebased and pushed — changes nothing">Dry run</button>
            <button class="btn-sync" id="syncAllBtn" title="Run the same endpoint the 15-minute launchd job curls">Sync all</button>
          </span>
        </div>
        <div class="lc-body" id="syncBody"><div class="empty-msg">Loading…</div></div>
        <div class="sync-out" id="syncOut" hidden></div>
      </div>
    </div>

    <div class="section">
      <div class="lc-grid">
        <div class="list-card">
          <div class="lc-head">
            <h3>Role assignments</h3>
            <div class="lc-sub">Global roles. Overrides live in the DB and beat env — hot, no restart.</div>
          </div>
          <div class="lc-body" id="rolesBody"><div class="empty-msg">Loading…</div></div>
        </div>
        <div class="list-card">
          <div class="lc-head">
            <h3>Wiki synthesis</h3>
            <div class="lc-sub">Which bot answers each wiki's Ask + What's-new digest. Read-only — steered by pins &amp; owners.</div>
          </div>
          <div class="lc-body" id="wikiSynthBody"><div class="empty-msg">Loading…</div></div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Pipeline jobs <span id="pipelineBot" class="lc-note"></span></h2>
      <div class="sub">Fixed background jobs. Per-bot rows follow the selected bot; watcher rows list every configured watcher. Live runtime chips update every 15s.</div>
      <div class="pl-card">
        <div class="pl-head"><div>Job</div><div>Backend</div><div>Model</div><div>Used · 7d</div></div>
        <div id="pipelineBody"><div class="empty-msg">Loading…</div></div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    ${helpers}
    ${summaryTilesScript()}
    ${statusChipsScript()}
    ${pageHeaderScript("models")}

    let selectedBot = '';
    try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}

    let botNames = [];      // all discovered bot names (for role selectors)
    let lastData = null;    // last overview payload
    let agentsData = null;  // last /api/agents/overview payload (runtime chips)

    // Expansion state — survives the pipeline poll (only user actions re-render cards).
    const whyOpen = new Set();
    const editOpen = new Set();

    const CONNECTORS = ['claude-cli', 'copilot-sdk', 'openai-compat', 'claude-sdk'];
    const BACKENDS = ['cli', 'anthropic', 'copilot'];

    // --- Runtime merge (hand-mirror of src/dashboard/models-runtime.ts) ---
    function rowMatches(row, kind, bot, name) {
      if (!row.matchKind) return false;
      if ((kind || 'chat') !== row.matchKind) return false;
      if (row.matchBot != null && (bot || '') !== row.matchBot) return false;
      if (row.matchName != null) {
        var n = name || '';
        if (n !== row.matchName && (row.matchRecentName == null || n !== row.matchRecentName)) return false;
      }
      return true;
    }
    function computeRowRuntime(row, agents) {
      const out = { runningNow: false };
      if (!row.matchKind || !agents) return out;
      out.runningNow = (agents.running || []).some(r => !r.completed && rowMatches(row, r.kind, r.botName, r.name));
      let earliest;
      for (const u of (agents.upNext || [])) {
        if (rowMatches(row, u.kind, u.bot, u.name) && (earliest == null || u.nextRunAt < earliest)) earliest = u.nextRunAt;
      }
      if (earliest != null) out.nextRunAt = earliest;
      let newest;
      for (const rec of (agents.recent || [])) {
        if (rec.durationMs == null) continue;
        if (rowMatches(row, rec.kind, rec.bot, rec.name) && (newest == null || rec.finishedAt > newest.finishedAt)) newest = rec;
      }
      if (newest && newest.durationMs != null) out.lastDurationMs = newest.durationMs;
      return out;
    }
    function fmtUntilShort(ts) {
      const diff = ts - Date.now();
      if (diff <= 0) return 'due now';
      const mins = Math.round(diff / 60000);
      if (mins < 1) return 'in <1m';
      if (mins < 60) return 'in ' + mins + 'm';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return 'in ' + hrs + 'h ' + (mins % 60) + 'm';
      return new Date(ts).toLocaleDateString();
    }
    function runtimeChips(row) {
      const rt = computeRowRuntime(row, agentsData);
      const chips = [];
      if (rt.runningNow) chips.push('<span class="rt-chip rt-run"><span class="pulse-dot"></span>running now</span>');
      else if (rt.nextRunAt != null) chips.push('<span class="rt-chip rt-next">next: ' + esc(fmtUntilShort(rt.nextRunAt)) + '</span>');
      if (rt.lastDurationMs != null) chips.push('<span class="rt-chip rt-last">last ' + esc(fmtMs(rt.lastDurationMs)) + '</span>');
      return chips.length ? '<div class="rt-row">' + chips.join('') + '</div>' : '';
    }

    function usedCell(models) {
      if (!models || models.length === 0) return '<span class="empty">—</span>';
      return '<div class="used">' + models.map(m => '<code>' + esc(m) + '</code>').join('') + '</div>';
    }

    function showToast(kind, msg) {
      const el = document.getElementById('toast');
      el.className = 'toast show ' + kind;
      el.textContent = msg;
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.className = 'toast'; }, 6000);
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try { data = await res.json(); } catch {}
      return { ok: res.ok, data };
    }

    // --- Bot selector (re-scopes the per-bot pipeline rows) ---
    (function initBotSelector() { loadBotList(); })();

    async function loadBotList() {
      try {
        const res = await fetch('/api/bots').then(r => r.json());
        const container = document.getElementById('botSelector');
        const bots = res.bots || [];
        botNames = bots.slice();
        if (!selectedBot && bots.length > 0) selectedBot = bots[0];
        container.innerHTML = bots.map(b =>
          '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + esc(b) + '">' +
            esc(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>'
        ).join('');
      } catch {}
      load();
    }

    document.getElementById('botSelector').addEventListener('click', (e) => {
      const pill = e.target.closest('.bot-pill');
      if (!pill) return;
      selectedBot = pill.dataset.bot;
      try { localStorage.setItem('muninn-selected-bot', selectedBot); } catch {}
      document.querySelectorAll('.bot-pill').forEach(p => p.classList.toggle('active', p.dataset.bot === selectedBot));
      load();
    });

    async function load() {
      try {
        const url = '/api/models/overview' + (selectedBot ? '?bot=' + encodeURIComponent(selectedBot) : '');
        const [data] = await Promise.all([
          fetch(url).then(r => r.json()),
          refreshAgents(),
        ]);
        lastData = data;
        render(data);
      } catch (e) {
        document.getElementById('errBox').innerHTML =
          '<div class="err-note">Failed to load overview: ' + esc(String(e)) + '</div>';
      }
    }

    // Fetch the live runtime (cheap; degraded/failed fetch just drops the chips).
    async function refreshAgents() {
      try { agentsData = await fetch('/api/agents/overview').then(r => r.json()); }
      catch { agentsData = null; }
    }

    // Keep the runtime chips fresh without re-fetching the whole models overview.
    setInterval(async () => {
      await refreshAgents();
      if (lastData) renderPipeline(lastData);
    }, 15000);

    function render(data) {
      document.getElementById('errBox').innerHTML = (data.errors && data.errors.length)
        ? '<div class="err-note">Degraded sources: ' + esc(data.errors.join('; ')) + '</div>'
        : '';

      // Prune expansion state for bots no longer present.
      const present = new Set((data.bots || []).map(b => b.name));
      whyOpen.forEach(n => { if (!present.has(n)) whyOpen.delete(n); });
      editOpen.forEach(n => { if (!present.has(n)) editOpen.delete(n); });

      renderMeta(data);
      renderTiles(data);
      renderBots(data);
      renderMachine(data);
      renderRoles(data);
      renderWiki(data);
      renderPipeline(data);
    }

    function renderMeta(data) {
      const bots = data.bots || [];
      const mismatches = bots.filter(b => b.mismatch).length;
      const meta = document.getElementById('modelsMeta');
      if (meta) {
        meta.textContent = bots.length + ' bot' + (bots.length === 1 ? '' : 's') +
          ' · ' + mismatches + ' mismatch' + (mismatches === 1 ? '' : 'es') +
          ' · config edits apply on restart, overrides are hot';
      }
      const pb = document.getElementById('pipelineBot');
      if (pb) pb.textContent = data.selectedBot ? '· ' + data.selectedBot : '';
    }

    function renderTiles(data) {
      const bots = data.bots || [];
      const roles = data.roles || [];
      const wikis = data.wikiSynthesis || [];
      const mismatchBots = bots.filter(b => b.mismatch).map(b => b.name);
      const overrides = roles.filter(r => r.origin === 'override').length;
      const tiles = [
        { label: 'Bots', value: String(bots.length), sub: 'discovered' },
        {
          label: 'Mismatches', value: String(mismatchBots.length),
          tone: mismatchBots.length > 0 ? 'warning' : undefined,
          sub: mismatchBots.length > 0 ? mismatchBots.join(', ') : 'all aligned',
        },
        { label: 'Hot overrides', value: String(overrides), sub: 'role overrides active' },
        { label: 'Wikis', value: String(wikis.length), sub: 'synthesis routing' },
      ];
      document.getElementById('modelTiles').innerHTML = tiles.map(tileHtml).join('');
    }

    // ---- Bot cards --------------------------------------------------------

    function fieldRow(label, value, origin) {
      var chip = origin ? originChip(origin) : '';
      var val = (value == null || value === '')
        ? '<span class="empty">—</span>'
        : '<code>' + esc(value) + '</code>';
      return '<div class="bc-field"><span class="bc-flabel">' + esc(label) + '</span>' +
        '<span class="bc-fval">' + val + chip + '</span></div>';
    }

    function chainHtml(chain) {
      return (chain || []).map(function (c) {
        var val = c.value != null ? '<span class="cv">' + esc(c.value) + '</span>' : '<span class="empty">unset</span>';
        var det = c.detail ? ' <span class="cd">(' + esc(c.detail) + ')</span>' : '';
        var wins = c.wins ? '<span class="chain-wins">WINS</span>' : '';
        return '<div class="chain-row' + (c.wins ? ' win' : '') + '">' +
          '<span class="chain-dot"></span>' +
          '<span class="chain-text">' + esc(c.label) + ' — ' + val + det + '</span>' + wins +
        '</div>';
      }).join('');
    }

    function seenHtml(b) {
      var mm = new Set(b.mismatchModels || []);
      var rows = [];
      (b.usedChatModels || []).forEach(function (m) {
        var cls = mm.has(m) ? ' warn' : '';
        rows.push('<div class="seen-row"><span class="seen-kind">chat</span><span class="seen-model' + cls + '">' + esc(m) + '</span></div>');
      });
      (b.usedHaikuModels || []).forEach(function (m) {
        rows.push('<div class="seen-row"><span class="seen-kind">haiku</span><span class="seen-model">' + esc(m) + '</span></div>');
      });
      if (rows.length === 0) rows.push('<div class="seen-row"><span class="seen-model empty">— none seen —</span></div>');
      var callout = '';
      if (b.mismatch && (b.mismatchModels || []).length) {
        callout = '<div class="mismatch-callout">⚠ used ≠ configured — chat traffic saw ' +
          (b.mismatchModels || []).map(function (m) { return '<span class="mono">' + esc(m) + '</span>'; }).join(', ') +
          ' alongside configured <span class="mono">' + esc(b.model.value) + '</span></div>';
      }
      return '<div class="bc-seen"><div class="bc-seen-label">Seen in traces · 7d</div>' +
        '<div class="seen-rows">' + rows.join('') + '</div>' + callout + '</div>';
    }

    function editorHtml(b) {
      var rc = b.rawConfig || {};
      function sel(label, name, options, current, allowClear) {
        var h = '<div class="editor-fld"><label>' + esc(label) + '</label><select class="m-select" data-field="' + esc(name) + '">';
        if (allowClear) h += '<option value="">— unset (default) —</option>';
        options.forEach(function (o) {
          h += '<option value="' + esc(o) + '"' + (o === current ? ' selected' : '') + '>' + esc(o) + '</option>';
        });
        return h + '</select></div>';
      }
      var h = '<div class="bc-editor" data-editor="' + esc(b.name) + '"' + (editOpen.has(b.name) ? '' : ' hidden') + '>';
      h += sel('Connector', 'connector', CONNECTORS, rc.connector || 'claude-cli', false);
      h += '<div class="editor-fld"><label>Model</label><input class="m-input" data-field="model" value="' + esc(rc.model || '') + '" placeholder="(default)"></div>';
      h += '<div class="editor-fld"><label>Thinking max tokens</label><input class="m-input" type="number" min="0" step="1" data-field="thinkingMaxTokens" value="' + (rc.thinkingMaxTokens == null ? '' : rc.thinkingMaxTokens) + '" placeholder="(default)"></div>';
      h += sel('Haiku backend', 'haikuBackend', BACKENDS, rc.haikuBackend || '', true);
      h += '<div class="editor-actions"><button class="btn-save" data-savebot="' + esc(b.name) + '">Save</button><span class="hint">applies on restart</span></div>';
      return h + '</div>';
    }

    function cardHtml(b) {
      var open = whyOpen.has(b.name);
      var thinking = b.thinkingMaxTokens == null ? null : String(b.thinkingMaxTokens);
      var h = '<div class="bot-card' + (b.mismatch ? ' mismatch' : '') + '" data-botcard="' + esc(b.name) + '">';
      h += '<div class="bc-head"><div class="bc-title"><span class="bc-name">' + esc(b.name) + '</span>' +
        '<span class="bc-conn mono">' + esc(b.connector.value) + '</span></div>' +
        '<button class="ghost-btn" data-editbot="' + esc(b.name) + '">Edit</button></div>';
      h += '<div class="bc-fields">' +
        fieldRow('Connector', b.connector.value, b.connector.origin) +
        fieldRow('Chat model', b.model.value, b.model.origin) +
        fieldRow('Thinking', thinking, null) +
        fieldRow('Haiku backend', b.haikuBackend.value, b.haikuBackend.origin) +
        '</div>';
      h += '<div class="bc-why" data-why="' + esc(b.name) + '" tabindex="0" role="button" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="caret' + (open ? ' open' : '') + '">▸</span> why this Haiku backend?</div>';
      h += '<div class="bc-chain" data-chain="' + esc(b.name) + '"' + (open ? '' : ' hidden') + '>' + chainHtml(b.chain) + '</div>';
      h += editorHtml(b);
      h += seenHtml(b);
      return h + '</div>';
    }

    function renderBots(data) {
      var grid = document.getElementById('botGrid');
      grid.innerHTML = (data.bots || []).map(cardHtml).join('') ||
        '<div class="empty-msg">No bots discovered</div>';
    }

    // ---- Roles ------------------------------------------------------------

    function roleEditor(r) {
      if (!r.overrideKey) return '';
      var opts = r.editKind === 'backend' ? BACKENDS : botNames;
      var cur = (r.overrideValue || '').toLowerCase();
      var h = '<div class="role-edit"><select class="m-select" data-role="' + esc(r.overrideKey) + '">';
      h += '<option value="">— default —</option>';
      opts.forEach(function (o) {
        h += '<option value="' + esc(o) + '"' + (o.toLowerCase() === cur ? ' selected' : '') + '>' + esc(o) + '</option>';
      });
      h += '</select><button class="ghost-btn" data-roleapply="' + esc(r.overrideKey) + '">Apply</button></div>';
      return h;
    }

    function renderRoles(data) {
      var body = document.getElementById('rolesBody');
      body.innerHTML = (data.roles || []).map(function (r) {
        var noteCls = r.note == null ? '' : (r.noteOk === false ? ' bad' : (r.noteOk === true ? ' ok' : ''));
        var val = r.bot ? '<span class="lc-val">' + esc(r.bot) + '</span>' : '<span class="lc-val none">— none —</span>';
        return '<div class="lc-row hover-wash">' +
          '<div class="lc-main"><div class="lc-title">' + esc(r.role) + '</div>' +
          (r.note ? '<div class="lc-note' + noteCls + '">' + esc(r.note) + '</div>' : '') + '</div>' +
          val + originChip(r.origin) + roleEditor(r) +
        '</div>';
      }).join('') || '<div class="empty-msg">No roles</div>';
    }

    // ---- Machine card -----------------------------------------------------
    // Read-only. The write-owner row is the one that matters operationally: two
    // instances against one wiki working tree is the failure this makes visible.
    function machineRow(label, valueHtml, noteHtml) {
      return '<div class="lc-row hover-wash">' +
        '<div class="lc-main"><div class="lc-title">' + esc(label) + '</div>' +
        (noteHtml ? '<div class="lc-note">' + noteHtml + '</div>' : '') + '</div>' +
        valueHtml +
      '</div>';
    }

    function renderMachine(data) {
      var body = document.getElementById('machineBody');
      if (!body) return;
      var m = data.machine;
      if (!m) { body.innerHTML = '<div class="empty-msg">No machine info</div>'; return; }
      var val = function (text, kind) {
        return '<span class="lc-val' + (kind === 'none' ? ' none' : '') + '">' + esc(text) + '</span>';
      };
      var h = '';
      h += machineRow('Hostname', val(m.hostname || '—'));
      h += machineRow('Scheduler',
        m.schedulerEnabled ? val('enabled') : val('disabled', 'none'),
        m.schedulerEnabled ? '' : 'SCHEDULER_ENABLED=false — gates the runner only, not the HTTP write surface');
      h += machineRow('Wiki page writes',
        m.wikiWriteOwner ? val('this instance owns them') : val('read-only', 'none'),
        m.wikiReadonly
          ? 'MUNINN_WIKI_READONLY=1 — gardener applies and fact-check writes 403 here; git commits are still allowed'
          : 'no MUNINN_WIKI_READONLY — this instance writes wiki pages');
      // Discovered ≠ running: a bot folder with no platform token is skipped at
      // startup ("Skipping bot X — no platform tokens"), which on the readonly
      // mini is typically every one of them. Lead with what actually polls.
      var bots = m.bots || [];
      var polling = bots.filter(function (b) { return b.polling; });
      var idle = bots.filter(function (b) { return !b.polling; });
      var botsVal = polling.length
        ? val(polling.map(function (b) { return b.name; }).join(', '))
        : val('none polling', 'none');
      var botsNote = idle.length
        ? esc(idle.map(function (b) { return b.name; }).join(', ')) +
          ' — discovered but no platform tokens, not polling'
        : '';
      h += machineRow('Bots', botsVal, botsNote);
      var wikis = m.wikis || [];
      // wikisKnown === false means the registry THREW. "none" would read as a
      // harmless instance; the count is genuinely unknown (detail in errors[]).
      h += machineRow('Registered wikis',
        m.wikisKnown === false
          ? val('unknown — registry failed to load', 'none')
          : wikis.length ? val(String(wikis.length)) : val('none', 'none'),
        m.wikisKnown === false
          ? 'see the errors banner above'
          : wikis.map(function (w) { return esc(w.name) + ' <span class="lc-via">(' + esc(w.source) + ')</span>'; }).join(' · '));
      body.innerHTML = h;
    }

    function renderWiki(data) {
      var body = document.getElementById('wikiSynthBody');
      body.innerHTML = (data.wikiSynthesis || []).map(function (w) {
        var reason = w.origin === 'pinned' ? 'explicit synthesisBot pin'
          : w.origin === 'owner' ? 'answers its own wiki'
          : w.origin === 'fallback' ? 'follows Research synthesizer' : '';
        var reasonHtml = reason ? '<div class="lc-reason">' + esc(reason) + '</div>' : '';
        if (w.ignoredPin) reasonHtml += '<div class="lc-reason bad">pin "' + esc(w.ignoredPin) + '" matches no bot — ignored</div>';
        return '<div class="lc-row hover-wash">' +
          '<span class="lc-wiki">' + esc(w.wiki) + '</span>' +
          '<span class="lc-arrow">→</span>' +
          '<div class="lc-main"><div class="lc-title">' + (w.bot ? esc(w.bot) : '<span class="empty">— none —</span>') + '</div>' +
          '<div class="lc-via">' + esc(w.connector) + ' · ' + esc(w.model) + '</div></div>' +
          '<div class="lc-right">' + originChip(w.origin) + reasonHtml + '</div>' +
        '</div>';
      }).join('') || '<div class="empty-msg">No wikis registered</div>';
    }

    // ---- Pipeline ---------------------------------------------------------

    function renderPipeline(data) {
      var body = document.getElementById('pipelineBody');
      if (!body) return;
      body.innerHTML = (data.pipeline || []).map(function (p) {
        return '<div class="pl-row hover-wash">' +
          '<div class="pl-job">' + esc(p.job) + runtimeChips(p) + '</div>' +
          '<div class="pl-backend">' + esc(p.backend) + '</div>' +
          '<div class="pl-model"><code>' + esc(p.model.value) + '</code>' + originChip(p.model.origin) +
            (p.note ? '<div class="note">' + esc(p.note) + '</div>' : '') + '</div>' +
          '<div class="pl-used">' + usedCell(p.used) + '</div>' +
        '</div>';
      }).join('') || '<div class="empty-msg">No jobs</div>';
    }

    // ---- Interactions -----------------------------------------------------

    function toggleWhy(name) {
      var open = !whyOpen.has(name);
      if (open) whyOpen.add(name); else whyOpen.delete(name);
      var toggle = document.querySelector('.bc-why[data-why="' + name + '"]');
      var panel = document.querySelector('.bc-chain[data-chain="' + name + '"]');
      if (toggle) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        var caret = toggle.querySelector('.caret');
        if (caret) caret.classList.toggle('open', open);
      }
      if (panel) panel.hidden = !open;
    }

    function toggleEditor(name) {
      var open = !editOpen.has(name);
      if (open) editOpen.add(name); else editOpen.delete(name);
      var panel = document.querySelector('.bc-editor[data-editor="' + name + '"]');
      if (panel) panel.hidden = !open;
    }

    // Delegated off the bot grid — the subtree is rebuilt on each load().
    var grid = document.getElementById('botGrid');
    grid.addEventListener('click', function (e) {
      var edit = e.target.closest('[data-editbot]');
      if (edit) { toggleEditor(edit.dataset.editbot); return; }
      var save = e.target.closest('[data-savebot]');
      if (save) { saveBot(save); return; }
      var why = e.target.closest('.bc-why');
      if (why) { toggleWhy(why.dataset.why); return; }
    });
    grid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var why = e.target.closest('.bc-why');
      if (!why) return;
      e.preventDefault();
      toggleWhy(why.dataset.why);
    });

    async function saveBot(btn) {
      var name = btn.dataset.savebot;
      var editor = btn.closest('.bc-editor');
      var bot = (lastData.bots || []).find(b => b.name === name);
      var rc = (bot && bot.rawConfig) || {};
      var get = (f) => editor.querySelector('[data-field="' + f + '"]');
      var connector = get('connector').value;
      var model = get('model').value.trim();
      var thinkingRaw = get('thinkingMaxTokens').value.trim();
      var haiku = get('haikuBackend').value;

      var changes = [];
      if (connector !== (rc.connector || 'claude-cli')) changes.push({ field: 'connector', value: connector });
      if (model !== (rc.model || '')) changes.push({ field: 'model', value: model === '' ? null : model });
      var curThinking = rc.thinkingMaxTokens == null ? '' : String(rc.thinkingMaxTokens);
      if (thinkingRaw !== curThinking) changes.push({ field: 'thinkingMaxTokens', value: thinkingRaw === '' ? null : Number(thinkingRaw) });
      if (haiku !== (rc.haikuBackend || '')) changes.push({ field: 'haikuBackend', value: haiku === '' ? null : haiku });

      if (changes.length === 0) { showToast('warn', 'No changes.'); return; }
      if (changes.some(c => c.field === 'connector')) {
        if (!confirm('Change ' + name + ' connector to "' + connector + '"? This alters the AI transport and MCP surface, and applies on restart.')) return;
      }

      btn.disabled = true;
      var anyWarning = '';
      for (var i = 0; i < changes.length; i++) {
        var ch = changes[i];
        var r = await postJson('/api/models/bot-config', { bot: name, field: ch.field, value: ch.value });
        if (!r.ok) { showToast('bad', name + ' ' + ch.field + ': ' + (r.data.error || 'failed')); btn.disabled = false; return; }
        if (r.data.warning) anyWarning = r.data.warning;
      }
      btn.disabled = false;
      editOpen.delete(name);
      showToast(anyWarning ? 'warn' : 'ok',
        'Saved ' + changes.length + ' field(s) to ' + name + '/config.json — applies on restart.' + (anyWarning ? ' ' + anyWarning : ''));
      load();
    }

    // ---- Repo sync card ---------------------------------------------------
    // Its own fetch loop: the sync status is a git read, not part of the models
    // overview assembly, and it must stay readable when that assembly degrades.
    // The GET never fetches from the remote (see readRepoStatus) — only the
    // buttons, which POST the same endpoint the launchd job curls.
    // One age formatter for the whole dashboard (the shared timeAgo helper);
    // only the null case is ours, since "never" is a real state here.
    function agoLabel(ms) { return ms ? timeAgo(ms) : 'never'; }

    function syncRow(r) {
      var counts = [];
      counts.push('<span class="' + (r.behind ? 'hot' : '') + '">behind ' + (r.behind === null ? '?' : r.behind) + '</span>');
      counts.push('<span class="' + (r.ahead ? 'hot' : '') + '">ahead ' + (r.ahead === null ? '?' : r.ahead) + '</span>');
      counts.push('<span class="' + (r.dirtyCount ? 'hot' : '') + '">dirty ' + r.dirtyCount + '</span>');
      var notes = [];
      notes.push(esc(r.branch || 'detached') + (r.upstreamFallback ? ' → ' + esc(r.upstream || '') + ' (no upstream set — fallback)' : ''));
      // The remote TIP's commit date (how fresh the other machine's newest work
      // is) — a different question from when we last fetched, hence two entries.
      notes.push('remote tip ' + agoLabel(r.remoteCommitMs));
      // How old the ahead/behind numbers are: the poll never fetches, so a
      // "behind 0" from three hours ago must not read as "up to date now".
      notes.push('fetched ' + agoLabel(r.lastFetchMs));
      notes.push('last sync ' + agoLabel(r.lastRunMs));
      if (r.consecutiveDeferrals > 1) notes.push(r.consecutiveDeferrals + ' deferrals in a row');
      if (r.error) notes.push('last error: ' + esc(String(r.error).slice(0, 160)));
      var warns = (r.warnings || []).map(function (w) {
        return '<div class="sync-warn">⚠ ' + esc(w) + '</div>';
      }).join('');
      return '<div class="lc-row hover-wash">' +
        '<span class="lc-wiki">' + esc(r.name) + '</span>' +
        '<div class="lc-main">' +
          '<div class="sync-counts">' + counts.join(' · ') + '</div>' +
          '<div class="lc-note">' + notes.join(' · ') + '</div>' +
          warns +
        '</div>' +
        '<div class="lc-right">' +
          '<div class="sync-state ' + esc(r.tone || 'ok') + '">' + esc(r.label || r.state) + '</div>' +
          '<div class="lc-via">' + esc(r.mode) + '</div>' +
        '</div>' +
        '<button class="btn-sync" data-syncrepo="' + esc(r.name) + '">Sync now</button>' +
      '</div>';
    }

    function renderSync(data) {
      var section = document.getElementById('syncSection');
      var body = document.getElementById('syncBody');
      if (!section || !body) return;
      // No SYNC_REPOS on this instance ⇒ the card is not a feature this machine
      // has; hide it rather than render an empty promise.
      if (!data || !data.configured) { section.hidden = true; return; }
      section.hidden = false;
      var h = (data.repos || []).map(syncRow).join('');
      var notes = (data.warnings || []).concat(data.errors || []);
      if (notes.length) {
        h += '<div class="lc-row"><div class="lc-main"><div class="lc-note bad">' +
          notes.map(esc).join('<br>') + '</div></div></div>';
      }
      body.innerHTML = h || '<div class="empty-msg">No repos configured</div>';
    }

    // ---- Pipeline ledger card (claude-usage) ------------------------------
    // Every row is built server-side (label/value/note/tone) — this only paints.
    var USAGE_TONE = { warning: 'warn', error: 'bad', success: 'ok' };

    function renderUsage(data) {
      var section = document.getElementById('usageSection');
      var body = document.getElementById('usageBody');
      if (!section || !body) return;
      // Neither configured nor reachable ⇒ this host is not a claude-usage host.
      // Hide rather than show every muninn install a permanent error about a
      // service it was never meant to have.
      if (!data || (!data.reachable && !data.configured)) { section.hidden = true; return; }
      section.hidden = false;
      var h = (data.rows || []).map(function (r) {
        var tone = USAGE_TONE[r.tone] || '';
        return '<div class="lc-row hover-wash">' +
          '<div class="lc-main"><div class="lc-title">' + esc(r.label) + '</div>' +
          (r.note ? '<div class="lc-note' + (tone ? ' ' + tone : '') + '">' + esc(r.note) + '</div>' : '') + '</div>' +
          '<span class="lc-val' + (tone ? ' ' + tone : '') + '">' + esc(r.value) + '</span>' +
        '</div>';
      }).join('');
      if (!data.reachable) {
        h += '<div class="lc-row"><div class="lc-main">' +
          '<div class="lc-title">claude-usage unreachable</div>' +
          '<div class="lc-note bad">' + esc((data.errors || []).join(' · ') || 'no detail') + '</div>' +
        '</div></div>';
      }
      body.innerHTML = h || '<div class="empty-msg">No ledger data</div>';
    }

    async function loadUsage() {
      try {
        var data = await fetch('/api/claude-usage/overview').then(r => r.json());
        renderUsage(data);
      } catch (e) { /* leave the last good render */ }
    }

    async function loadSync() {
      try {
        var data = await fetch('/api/sync/status').then(r => r.json());
        renderSync(data);
      } catch (e) { /* leave the last good render */ }
    }

    function showSyncReport(report) {
      var out = document.getElementById('syncOut');
      if (!out) return;
      var lines = (report.repos || []).map(function (r) {
        var parts = [r.name + ': ' + (r.label || r.state)];
        if (r.actions && r.actions.length) parts.push('  ' + r.actions.join('; '));
        if (r.committed && r.committed.length) {
          parts.push('  ' + (report.dryRun ? 'would commit' : 'committed') + ': ' + r.committed.join(', '));
        }
        if (r.deferredFiles && r.deferredFiles.length) {
          parts.push('  held: ' + r.deferredFiles.map(function (d) { return d.path + ' (' + d.reason + ')'; }).join(', '));
        }
        return parts.join('\\n');
      });
      out.hidden = false;
      out.textContent = (report.dryRun ? '[dry run] ' : '') + new Date().toLocaleTimeString() + '\\n' + lines.join('\\n');
    }

    async function runSyncPost(query, btn, busyLabel) {
      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = busyLabel || 'Syncing…'; }
      try {
        var res = await fetch('/api/sync/run' + query, { method: 'POST' });
        var data = await res.json();
        // 409 = every selected repo was already in flight (the route's
        // single-flight answer). It carries a human-readable error field, so the
        // existing toast branch handles it — but the report must not be
        // rendered as if this call had done the work.
        if (data.error) { showToast('bad', data.error); }
        else {
          showSyncReport(data);
          var bad = (data.repos || []).filter(function (r) { return r.tone === 'bad'; });
          var warn = (data.repos || []).filter(function (r) { return r.tone === 'warn'; });
          showToast(bad.length ? 'bad' : warn.length ? 'warn' : 'ok',
            (data.dryRun ? 'Dry run: ' : 'Sync: ') + (data.repos || []).map(function (r) { return r.name + ' ' + (r.label || r.state); }).join(' · '));
        }
      } catch (e) {
        showToast('bad', 'Sync failed: ' + String(e));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
        loadSync();
      }
    }

    document.getElementById('syncBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-syncrepo]');
      if (!btn) return;
      runSyncPost('?repo=' + encodeURIComponent(btn.dataset.syncrepo), btn);
    });
    document.getElementById('syncAllBtn').addEventListener('click', function (e) { runSyncPost('', e.target); });
    // A dry run writes nothing, so "Syncing…" was an outright lie about what the
    // button was doing.
    document.getElementById('syncDryBtn').addEventListener('click', function (e) { runSyncPost('?dry-run=1', e.target, 'Checking…'); });
    loadSync();
    setInterval(loadSync, 60000);
    // The ledger is rebuilt by claude-usage on its own cadence; a 5-min poll is
    // plenty and keeps the ~170 KB upstream payload off a per-minute loop.
    loadUsage();
    setInterval(loadUsage, 300000);

    // Role Apply (delegated off the roles list body — re-rendered on each load()).
    document.getElementById('rolesBody').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-roleapply]');
      if (!btn) return;
      const role = btn.dataset.roleapply;
      const sel = document.querySelector('select[data-role="' + role + '"]');
      const value = sel ? sel.value : '';
      btn.disabled = true;
      const { ok, data } = await postJson('/api/models/role', { role, value });
      btn.disabled = false;
      if (!ok) { showToast('bad', data.error || 'Failed to set override'); return; }
      showToast(data.warning ? 'warn' : 'ok', (data.message || 'Saved') + (data.warning ? ' — ' + data.warning : ''));
      load();
    });
  </script>
</body>
</html>`;
}
