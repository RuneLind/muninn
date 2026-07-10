import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { helpersClientScript } from "./components/helpers-client.ts";

/**
 * Models overview page — the effective model / connector / Haiku backend for
 * every AI job, next to what actually ran recently. Server renders the shell;
 * the client fetches `/api/models/overview?bot=<selected>` and renders the three
 * grouped tables (Bots · Role assignments · Pipeline jobs). The bot selector
 * only re-scopes the per-bot Pipeline rows — the Bots + Roles tables are global.
 */
export async function renderModelsPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Models</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}

    .page { padding: 16px 24px 40px; }
    .intro { color: var(--text-muted); font-size: 13px; margin-bottom: 16px; max-width: 820px; line-height: 1.5; }
    .intro code { background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; font-size: 12px; }

    .section { margin-bottom: 28px; }
    .section h2 { font-size: 15px; color: var(--text-primary); font-weight: 600; margin-bottom: 4px; }
    .section .sub { font-size: 12px; color: var(--text-dim); margin-bottom: 10px; }

    .m-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .m-table th {
      text-align: left; padding: 8px 12px; color: var(--text-dim); font-weight: 500;
      text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border-primary); white-space: nowrap;
    }
    .m-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
    .m-table tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .m-table code { font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

    .chip {
      display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; margin-left: 6px;
      vertical-align: middle;
    }
    .chip-config  { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-light); }
    .chip-env     { background: color-mix(in srgb, var(--status-info) 18%, transparent); color: var(--status-info); }
    .chip-derived { background: color-mix(in srgb, var(--status-cyan) 18%, transparent); color: var(--status-cyan); }
    .chip-legacy  { background: color-mix(in srgb, var(--status-warning) 18%, transparent); color: var(--status-warning); }
    .chip-default { background: var(--tint-neutral); color: var(--text-muted); }
    .chip-fixed   { background: color-mix(in srgb, var(--status-magenta) 18%, transparent); color: var(--status-magenta); }
    .chip-none    { background: var(--tint-neutral); color: var(--text-disabled); }

    .note { font-size: 11px; color: var(--text-dim); margin-top: 3px; }
    .note.ok { color: var(--status-success); }
    .note.bad { color: var(--status-error); }

    .used { display: flex; flex-direction: column; gap: 2px; }
    .used code { font-size: 11px; }
    .used .empty { color: var(--text-disabled); }
    .mismatch { color: var(--status-warning); font-size: 11px; margin-top: 2px; }

    .err-note { color: var(--status-warning); font-size: 12px; margin: 8px 0; }
    .empty-msg { color: var(--text-faint); padding: 24px; text-align: center; }
    .scroll { overflow-x: auto; }
  </style>
</head>
<body>
  ${renderNav("models", { headerLeftExtra: botSelectorHtml() })}

  <div class="page">
    <div class="intro">
      The <strong>effective</strong> model, connector, and Haiku backend for every AI job after all
      defaults resolve — next to the models <strong>actually seen</strong> in the last 7 days
      (<code>haiku_usage</code> + <code>traces</code>). A mismatch between the two is the
      <code>#191</code> silent-fallback class of bug. Read-only.
    </div>

    <div id="errBox"></div>

    <div class="section">
      <h2>Bots</h2>
      <div class="sub">Chat connector + model, plus the Haiku router backend and why it resolved that way.</div>
      <div class="scroll"><table class="m-table">
        <thead><tr>
          <th>Bot</th><th>Connector</th><th>Chat model</th><th>Thinking</th>
          <th>Haiku backend</th><th>Chat used (7d)</th><th>Haiku used (7d)</th>
        </tr></thead>
        <tbody id="botsBody"><tr><td colspan="7" class="empty-msg">Loading…</td></tr></tbody>
      </table></div>
    </div>

    <div class="section">
      <h2>Role assignments</h2>
      <div class="sub">Global roles resolved across all bots (env override → default).</div>
      <div class="scroll"><table class="m-table">
        <thead><tr><th>Role</th><th>Bot</th><th>Origin</th><th>Note</th></tr></thead>
        <tbody id="rolesBody"><tr><td colspan="4" class="empty-msg">Loading…</td></tr></tbody>
      </table></div>
    </div>

    <div class="section">
      <h2>Pipeline jobs <span class="chip chip-default" id="pipelineBot"></span></h2>
      <div class="sub">Fixed background jobs. Per-bot rows follow the selected bot; watcher rows list every configured watcher.</div>
      <div class="scroll"><table class="m-table">
        <thead><tr><th>Job</th><th>Backend</th><th>Model</th><th>Used (7d)</th></tr></thead>
        <tbody id="pipelineBody"><tr><td colspan="4" class="empty-msg">Loading…</td></tr></tbody>
      </table></div>
    </div>
  </div>

  <script>
    ${helpers}

    let selectedBot = '';
    try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}

    function chip(origin) {
      return '<span class="chip chip-' + esc(origin) + '">' + esc(origin) + '</span>';
    }

    function usedCell(models) {
      if (!models || models.length === 0) return '<span class="empty">—</span>';
      return '<div class="used">' + models.map(m => '<code>' + esc(m) + '</code>').join('') + '</div>';
    }

    // --- Bot selector (re-scopes the per-bot pipeline rows) ---
    (function initBotSelector() { loadBotList(); })();

    async function loadBotList() {
      try {
        const res = await fetch('/api/bots').then(r => r.json());
        const container = document.getElementById('botSelector');
        const bots = res.bots || [];
        // No "All Bots" option here — the pipeline table is single-bot scoped.
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
        const data = await fetch(url).then(r => r.json());
        render(data);
      } catch (e) {
        document.getElementById('errBox').innerHTML =
          '<div class="err-note">Failed to load overview: ' + esc(String(e)) + '</div>';
      }
    }

    function render(data) {
      // Errors banner (degraded sources).
      document.getElementById('errBox').innerHTML = (data.errors && data.errors.length)
        ? '<div class="err-note">Degraded sources: ' + esc(data.errors.join('; ')) + '</div>'
        : '';

      document.getElementById('pipelineBot').textContent = data.selectedBot || '';

      // Bots.
      const botsBody = document.getElementById('botsBody');
      botsBody.innerHTML = (data.bots || []).map(b => {
        // Highlight a used chat model that isn't the configured one.
        const configured = b.model.value;
        const mismatch = (b.usedChatModels || []).filter(m => m !== configured &&
          !m.includes(configured) && !configured.includes(m));
        const mismatchHtml = mismatch.length
          ? '<div class="mismatch">⚠ used ≠ configured</div>' : '';
        return '<tr>' +
          '<td><strong>' + esc(b.name) + '</strong></td>' +
          '<td><code>' + esc(b.connector.value) + '</code>' + chip(b.connector.origin) + '</td>' +
          '<td><code>' + esc(b.model.value) + '</code>' + chip(b.model.origin) + '</td>' +
          '<td>' + (b.thinkingMaxTokens == null ? '<span class="empty">—</span>' : '<code>' + b.thinkingMaxTokens + '</code>') + '</td>' +
          '<td><code>' + esc(b.haikuBackend.value) + '</code>' + chip(b.haikuBackend.origin) +
            '<div class="note">' + esc(b.haikuBackendReason) + '</div></td>' +
          '<td>' + usedCell(b.usedChatModels) + mismatchHtml + '</td>' +
          '<td>' + usedCell(b.usedHaikuModels) + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="7" class="empty-msg">No bots discovered</td></tr>';

      // Roles.
      const rolesBody = document.getElementById('rolesBody');
      rolesBody.innerHTML = (data.roles || []).map(r => {
        const noteCls = r.note == null ? '' : (r.noteOk === false ? ' bad' : (r.noteOk === true ? ' ok' : ''));
        return '<tr>' +
          '<td>' + esc(r.role) + '</td>' +
          '<td>' + (r.bot ? '<strong>' + esc(r.bot) + '</strong>' : '<span class="empty">— none —</span>') + '</td>' +
          '<td>' + chip(r.origin) + '</td>' +
          '<td>' + (r.note ? '<span class="note' + noteCls + '">' + esc(r.note) + '</span>' : '') + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="4" class="empty-msg">No roles</td></tr>';

      // Pipeline.
      const pipelineBody = document.getElementById('pipelineBody');
      pipelineBody.innerHTML = (data.pipeline || []).map(p =>
        '<tr>' +
          '<td>' + esc(p.job) + '</td>' +
          '<td><code>' + esc(p.backend) + '</code></td>' +
          '<td><code>' + esc(p.model.value) + '</code>' + chip(p.model.origin) +
            (p.note ? '<div class="note">' + esc(p.note) + '</div>' : '') + '</td>' +
          '<td>' + usedCell(p.used) + '</td>' +
        '</tr>'
      ).join('') || '<tr><td colspan="4" class="empty-msg">No jobs</td></tr>';
    }
  </script>
</body>
</html>`;
}
