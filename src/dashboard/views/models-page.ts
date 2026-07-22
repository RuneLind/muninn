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
    .lc-val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-secondary); flex-shrink: 0; }
    .lc-val.none { color: var(--text-disabled); }
    .role-edit { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .role-edit .m-select { width: auto; }
    .lc-wiki { font-size: 13px; font-weight: 600; color: var(--text-primary); width: 150px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lc-arrow { color: var(--text-faint); font-size: 11px; flex-shrink: 0; }
    .lc-via { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--text-dim); margin-top: 1px; }
    .lc-right { text-align: right; flex-shrink: 0; }
    .lc-reason { font-size: 10px; color: var(--text-faint); margin-top: 2px; }
    .lc-reason.bad { color: var(--status-error); }

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
