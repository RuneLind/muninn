import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { helpersClientScript } from "./components/helpers-client.ts";

/**
 * Models overview page — the effective model / connector / Haiku backend for
 * every AI job, next to what actually ran recently. Server renders the shell;
 * the client fetches `/api/models/overview?bot=<selected>` and renders the three
 * grouped tables (Bots · Role assignments · Pipeline jobs). The bot selector
 * only re-scopes the per-bot Pipeline rows — the Bots + Roles tables are global.
 *
 * PR 5 adds editing: per-bot config.json fields (applies on restart) via an
 * expandable editor row in the Bots table, and hot DB-backed role overrides
 * (SUMMARIZER_BOT / RESEARCH_BOT / HAIKU_BACKEND) via inline selects in the
 * Roles table.
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
    .chip-config   { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-light); }
    .chip-env      { background: color-mix(in srgb, var(--status-info) 18%, transparent); color: var(--status-info); }
    .chip-override { background: color-mix(in srgb, var(--status-success) 22%, transparent); color: var(--status-success); }
    .chip-derived  { background: color-mix(in srgb, var(--status-cyan) 18%, transparent); color: var(--status-cyan); }
    .chip-legacy   { background: color-mix(in srgb, var(--status-warning) 18%, transparent); color: var(--status-warning); }
    .chip-default  { background: var(--tint-neutral); color: var(--text-muted); }
    .chip-fixed    { background: color-mix(in srgb, var(--status-magenta) 18%, transparent); color: var(--status-magenta); }
    .chip-none     { background: var(--tint-neutral); color: var(--text-disabled); }

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

    /* --- Editing controls --- */
    .link-btn {
      background: none; border: 1px solid var(--border-primary); color: var(--text-secondary);
      font-size: 11px; padding: 2px 9px; border-radius: 6px; cursor: pointer;
    }
    .link-btn:hover { border-color: var(--accent); color: var(--accent-light); }
    .m-select, .m-input {
      background: var(--bg-surface); border: 1px solid var(--border-primary);
      color: var(--text-primary); font-size: 12px; padding: 3px 6px; border-radius: 5px;
      font-family: inherit;
    }
    .m-input { width: 150px; }
    .m-input.num { width: 88px; }
    .editor-row td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
    .editor {
      display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; padding: 6px 2px;
    }
    .editor .fld { display: flex; flex-direction: column; gap: 3px; }
    .editor .fld label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-dim); }
    .editor .actions { display: flex; gap: 8px; align-items: center; }
    .editor .hint { font-size: 11px; color: var(--text-dim); }
    .btn-save {
      background: var(--accent); border: none; color: #fff; font-size: 12px; font-weight: 600;
      padding: 5px 14px; border-radius: 6px; cursor: pointer;
    }
    .btn-save:hover { filter: brightness(1.08); }
    .btn-save:disabled { opacity: 0.5; cursor: default; }
    .role-edit { display: flex; gap: 6px; align-items: center; }
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
    <div class="intro">
      The <strong>effective</strong> model, connector, and Haiku backend for every AI job after all
      defaults resolve — next to the models <strong>actually seen</strong> in the last 7 days
      (<code>haiku_usage</code> + <code>traces</code>). A mismatch between the two is the
      <code>#191</code> silent-fallback class of bug. Per-bot fields edit <code>config.json</code>
      (<strong>applies on restart</strong>); role overrides are <strong>hot</strong> (take effect immediately).
    </div>

    <div id="errBox"></div>

    <div class="section">
      <h2>Bots</h2>
      <div class="sub">Chat connector + model, plus the Haiku router backend and why it resolved that way. Edit writes <code>bots/&lt;name&gt;/config.json</code> — applies on restart.</div>
      <div class="scroll"><table class="m-table">
        <thead><tr>
          <th>Bot</th><th>Connector</th><th>Chat model</th><th>Thinking</th>
          <th>Haiku backend</th><th>Chat used (7d)</th><th>Haiku used (7d)</th><th></th>
        </tr></thead>
        <tbody id="botsBody"><tr><td colspan="8" class="empty-msg">Loading…</td></tr></tbody>
      </table></div>
    </div>

    <div class="section">
      <h2>Role assignments</h2>
      <div class="sub">Global roles. Overrides are stored in the DB and beat env — they take effect immediately (no restart).</div>
      <div class="scroll"><table class="m-table">
        <thead><tr><th>Role</th><th>Bot / value</th><th>Origin</th><th>Note</th><th>Override</th></tr></thead>
        <tbody id="rolesBody"><tr><td colspan="5" class="empty-msg">Loading…</td></tr></tbody>
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

  <div class="toast" id="toast"></div>

  <script>
    ${helpers}

    let selectedBot = '';
    try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}

    let botNames = [];      // all discovered bot names (for role selectors)
    let lastData = null;    // last overview payload (for editor rendering)

    const CONNECTORS = ['claude-cli', 'copilot-sdk', 'openai-compat', 'claude-sdk'];
    const BACKENDS = ['cli', 'anthropic', 'copilot'];

    function chip(origin) {
      return '<span class="chip chip-' + esc(origin) + '">' + esc(origin) + '</span>';
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
        const data = await fetch(url).then(r => r.json());
        lastData = data;
        render(data);
      } catch (e) {
        document.getElementById('errBox').innerHTML =
          '<div class="err-note">Failed to load overview: ' + esc(String(e)) + '</div>';
      }
    }

    function render(data) {
      document.getElementById('errBox').innerHTML = (data.errors && data.errors.length)
        ? '<div class="err-note">Degraded sources: ' + esc(data.errors.join('; ')) + '</div>'
        : '';

      document.getElementById('pipelineBot').textContent = data.selectedBot || '';

      // Bots.
      const botsBody = document.getElementById('botsBody');
      botsBody.innerHTML = (data.bots || []).map(b => {
        const configured = b.model.value;
        const mismatch = (b.usedChatModels || []).filter(m => m !== configured &&
          !m.includes(configured) && !configured.includes(m));
        const mismatchHtml = mismatch.length ? '<div class="mismatch">⚠ used ≠ configured</div>' : '';
        return '<tr data-botrow="' + esc(b.name) + '">' +
          '<td><strong>' + esc(b.name) + '</strong></td>' +
          '<td><code>' + esc(b.connector.value) + '</code>' + chip(b.connector.origin) + '</td>' +
          '<td><code>' + esc(b.model.value) + '</code>' + chip(b.model.origin) + '</td>' +
          '<td>' + (b.thinkingMaxTokens == null ? '<span class="empty">—</span>' : '<code>' + b.thinkingMaxTokens + '</code>') + '</td>' +
          '<td><code>' + esc(b.haikuBackend.value) + '</code>' + chip(b.haikuBackend.origin) +
            '<div class="note">' + esc(b.haikuBackendReason) + '</div></td>' +
          '<td>' + usedCell(b.usedChatModels) + mismatchHtml + '</td>' +
          '<td>' + usedCell(b.usedHaikuModels) + '</td>' +
          '<td><button class="link-btn" data-editbot="' + esc(b.name) + '">✎ Edit</button></td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="8" class="empty-msg">No bots discovered</td></tr>';

      // Roles.
      const rolesBody = document.getElementById('rolesBody');
      rolesBody.innerHTML = (data.roles || []).map((r, i) => {
        const noteCls = r.note == null ? '' : (r.noteOk === false ? ' bad' : (r.noteOk === true ? ' ok' : ''));
        return '<tr>' +
          '<td>' + esc(r.role) + '</td>' +
          '<td>' + (r.bot ? '<strong>' + esc(r.bot) + '</strong>' : '<span class="empty">— none —</span>') + '</td>' +
          '<td>' + chip(r.origin) + '</td>' +
          '<td>' + (r.note ? '<span class="note' + noteCls + '">' + esc(r.note) + '</span>' : '') + '</td>' +
          '<td>' + roleEditor(r) + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="5" class="empty-msg">No roles</td></tr>';

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

    // --- Role override editor (inline select + Apply/Clear) ---
    function roleEditor(r) {
      if (!r.overrideKey) return '<span class="note">—</span>';
      const opts = r.editKind === 'backend' ? BACKENDS : botNames;
      const cur = r.overrideValue || '';
      let html = '<div class="role-edit">';
      html += '<select class="m-select" data-role="' + esc(r.overrideKey) + '">';
      html += '<option value="">— default —</option>';
      for (const o of opts) {
        const sel = (o.toLowerCase() === cur.toLowerCase()) ? ' selected' : '';
        html += '<option value="' + esc(o) + '"' + sel + '>' + esc(o) + '</option>';
      }
      html += '</select>';
      html += '<button class="link-btn" data-roleapply="' + esc(r.overrideKey) + '">Apply</button>';
      html += '</div>';
      return html;
    }

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

    // --- Per-bot config editor (expandable row) ---
    document.getElementById('botsBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-editbot]');
      if (!btn) return;
      const name = btn.dataset.editbot;
      const row = document.querySelector('tr[data-botrow="' + name + '"]');
      const existing = row.nextElementSibling;
      if (existing && existing.classList.contains('editor-row')) { existing.remove(); return; }
      document.querySelectorAll('.editor-row').forEach(el => el.remove());
      const bot = (lastData.bots || []).find(b => b.name === name);
      if (!bot) return;
      const tr = document.createElement('tr');
      tr.className = 'editor-row';
      const td = document.createElement('td');
      td.colSpan = 8;
      td.innerHTML = botEditor(bot);
      tr.appendChild(td);
      row.after(tr);
    });

    function selectField(label, name, options, current, allowClear) {
      let html = '<div class="fld"><label>' + esc(label) + '</label><select class="m-select" data-field="' + esc(name) + '">';
      if (allowClear) html += '<option value="">— unset (default) —</option>';
      for (const o of options) {
        const sel = (o === current) ? ' selected' : '';
        html += '<option value="' + esc(o) + '"' + sel + '>' + esc(o) + '</option>';
      }
      html += '</select></div>';
      return html;
    }

    function botEditor(bot) {
      const rc = bot.rawConfig || {};
      let html = '<div class="editor" data-bot="' + esc(bot.name) + '">';
      html += selectField('Connector', 'connector', CONNECTORS, rc.connector || 'claude-cli', false);
      html += '<div class="fld"><label>Model</label><input class="m-input" data-field="model" value="' +
        esc(rc.model || '') + '" placeholder="(default)"></div>';
      html += '<div class="fld"><label>Thinking max tokens</label><input class="m-input num" type="number" min="0" step="1" data-field="thinkingMaxTokens" value="' +
        (rc.thinkingMaxTokens == null ? '' : rc.thinkingMaxTokens) + '" placeholder="(default)"></div>';
      html += selectField('Haiku backend', 'haikuBackend', BACKENDS, rc.haikuBackend || '', true);
      html += '<div class="actions">' +
        '<button class="btn-save" data-savebot="' + esc(bot.name) + '">Save</button>' +
        '<span class="hint">applies on restart</span></div>';
      html += '</div>';
      return html;
    }

    document.getElementById('botsBody').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-savebot]');
      if (!btn) return;
      const name = btn.dataset.savebot;
      const editor = btn.closest('.editor');
      const bot = (lastData.bots || []).find(b => b.name === name);
      const rc = (bot && bot.rawConfig) || {};

      // Collect current values.
      const get = (f) => editor.querySelector('[data-field="' + f + '"]');
      const connector = get('connector').value;
      const model = get('model').value.trim();
      const thinkingRaw = get('thinkingMaxTokens').value.trim();
      const haiku = get('haikuBackend').value;

      // Build the change set: only fields that differ from the raw config.
      const changes = [];
      if (connector !== (rc.connector || 'claude-cli')) changes.push({ field: 'connector', value: connector });
      if (model !== (rc.model || '')) changes.push({ field: 'model', value: model === '' ? null : model });
      const curThinking = rc.thinkingMaxTokens == null ? '' : String(rc.thinkingMaxTokens);
      if (thinkingRaw !== curThinking) changes.push({ field: 'thinkingMaxTokens', value: thinkingRaw === '' ? null : Number(thinkingRaw) });
      if (haiku !== (rc.haikuBackend || '')) changes.push({ field: 'haikuBackend', value: haiku === '' ? null : haiku });

      if (changes.length === 0) { showToast('warn', 'No changes.'); return; }

      // Confirm connector changes (they alter the transport + MCP surface).
      if (changes.some(c => c.field === 'connector')) {
        if (!confirm('Change ' + name + ' connector to "' + connector + '"? This alters the AI transport and MCP surface, and applies on restart.')) return;
      }

      btn.disabled = true;
      let anyWarning = '';
      for (const ch of changes) {
        const { ok, data } = await postJson('/api/models/bot-config', { bot: name, field: ch.field, value: ch.value });
        if (!ok) { showToast('bad', name + ' ' + ch.field + ': ' + (data.error || 'failed')); btn.disabled = false; return; }
        if (data.warning) anyWarning = data.warning;
      }
      btn.disabled = false;
      showToast(anyWarning ? 'warn' : 'ok',
        'Saved ' + changes.length + ' field(s) to ' + name + '/config.json — applies on restart.' + (anyWarning ? ' ' + anyWarning : ''));
      load();
    });
  </script>
</body>
</html>`;
}
