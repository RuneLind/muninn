import { SHARED_STYLES, renderNav } from "./shared-styles.ts";

export function renderTracesPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Traces</title>
  <style>
    ${SHARED_STYLES}

    /* Stats Bar */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      padding: 16px 24px;
    }
    .stat-card {
      background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      padding: 16px;
    }
    .stat-value { color: #fff; font-weight: 700; font-size: 24px; }
    .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

    /* Filters */
    .filters {
      padding: 8px 24px;
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .filters select, .filters input {
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      color: #e0e0e0;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .filters select:focus, .filters input:focus { outline: none; border-color: #6c63ff; }
    .filters button {
      background: #6c63ff;
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .filters button:hover { background: #5a52e0; }

    /* Trace List */
    .content { padding: 0 24px 24px; }
    .trace-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .trace-table th {
      text-align: left;
      padding: 10px 12px;
      color: #666;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #1e1e2e;
    }
    .trace-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #1a1a24;
      white-space: nowrap;
    }
    .trace-table tr { cursor: pointer; transition: background 0.15s; }
    .trace-table tr:hover { background: rgba(108, 99, 255, 0.05); }
    .trace-table tr.expanded { background: rgba(108, 99, 255, 0.08); }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-ok { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    .badge-error { background: rgba(248, 113, 113, 0.15); color: #f87171; }
    .badge-name { background: rgba(108, 99, 255, 0.15); color: #a5a0ff; }
    .badge-bot { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }

    .tokens { color: #888; font-size: 12px; }

    /* Waterfall */
    .waterfall-container {
      display: none;
      padding: 16px 24px;
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 8px;
      margin: 8px 0 16px;
    }
    .waterfall-container.visible { display: block; }
    .waterfall-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .waterfall-header h3 { font-size: 14px; color: #fff; }
    .waterfall-close {
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 18px;
      padding: 4px;
    }
    .waterfall-close:hover { color: #fff; }

    .waterfall {
      position: relative;
      min-height: 40px;
    }
    .waterfall-row {
      display: grid;
      grid-template-columns: 200px 1fr;
      align-items: center;
      height: 28px;
      gap: 12px;
    }
    .waterfall-label {
      font-size: 12px;
      color: #aaa;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .waterfall-bar-container {
      position: relative;
      height: 16px;
      background: rgba(255,255,255,0.03);
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
    .waterfall-bar.kind-root { background: #6c63ff; }
    .waterfall-bar.kind-span { background: #22d3ee; }
    .waterfall-bar.kind-event { background: #fbbf24; width: 3px !important; }
    .waterfall-bar.status-error { background: #f87171; }
    .waterfall-duration {
      position: absolute;
      right: -60px;
      top: 0;
      font-size: 10px;
      color: #666;
      line-height: 16px;
      width: 55px;
    }

    /* Span Details */
    .span-details {
      margin-top: 16px;
      background: #0a0a0f;
      border: 1px solid #1e1e2e;
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
      display: none;
    }
    .span-details.visible { display: block; }
    .span-details h4 { color: #a5a0ff; margin-bottom: 8px; font-size: 13px; }
    .span-details pre {
      background: #12121a;
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      color: #ccc;
      font-size: 11px;
      line-height: 1.5;
    }

    /* Pagination */
    .pagination {
      display: flex;
      justify-content: center;
      gap: 8px;
      padding: 16px;
    }
    .pagination button {
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      color: #e0e0e0;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .pagination button:hover { border-color: #6c63ff; }
    .pagination button:disabled { opacity: 0.3; cursor: default; }
    .pagination span { color: #666; font-size: 13px; line-height: 32px; }

    .empty { color: #555; text-align: center; padding: 40px; font-size: 14px; }

    /* Prompt Modal */
    .prompt-modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .prompt-modal-backdrop.visible { display: flex; }
    .prompt-modal {
      background: #12121a;
      border: 1px solid #2a2a3e;
      border-radius: 12px;
      width: 90vw;
      max-width: 900px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }
    .prompt-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid #1e1e2e;
    }
    .prompt-modal-header h3 { font-size: 14px; color: #fff; }
    .prompt-modal-close {
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 20px;
      padding: 4px 8px;
    }
    .prompt-modal-close:hover { color: #fff; }
    .prompt-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #1e1e2e;
    }
    .prompt-tab {
      padding: 10px 20px;
      font-size: 13px;
      color: #888;
      background: none;
      border: none;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .prompt-tab:hover { color: #a5a0ff; }
    .prompt-tab.active { color: #6c63ff; border-bottom-color: #6c63ff; }
    .prompt-tab .char-count {
      font-size: 10px;
      color: #555;
      margin-left: 6px;
    }
    .prompt-modal-body {
      flex: 1;
      overflow: auto;
      padding: 16px 20px;
    }
    .prompt-modal-body pre {
      background: #0a0a0f;
      padding: 14px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.6;
      color: #ccc;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }
    .prompt-unavailable {
      color: #555;
      text-align: center;
      padding: 40px;
      font-size: 14px;
    }

    /* View Prompt button in waterfall header */
    .btn-view-prompt {
      background: rgba(108, 99, 255, 0.15);
      border: 1px solid rgba(108, 99, 255, 0.3);
      color: #a5a0ff;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      margin-right: 8px;
    }
    .btn-view-prompt:hover { background: rgba(108, 99, 255, 0.25); border-color: #6c63ff; }
  </style>
</head>
<body>
  ${renderNav("traces")}
    </div>
  </header>

  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Traces (24h)</div></div>
    <div class="stat-card"><div class="stat-value" id="statAvg">-</div><div class="stat-label">Avg Duration</div></div>
    <div class="stat-card"><div class="stat-value" id="statErrors">-</div><div class="stat-label">Errors (24h)</div></div>
    <div class="stat-card"><div class="stat-value" id="statByName">-</div><div class="stat-label">Trace Types</div></div>
  </div>

  <div class="filters">
    <select id="filterName">
      <option value="">All types</option>
      <option value="telegram_text">telegram_text</option>
      <option value="telegram_voice">telegram_voice</option>
      <option value="slack_message">slack_message</option>
      <option value="scheduler_tick">scheduler_tick</option>
    </select>
    <select id="filterBot">
      <option value="">All bots</option>
    </select>
    <button onclick="loadTraces()">Filter</button>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-left:auto">
      <input type="checkbox" id="autoRefresh" checked> Auto-refresh (15s)
    </label>
  </div>

  <div class="content">
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
        <h4 id="spanDetailsTitle"></h4>
        <pre id="spanDetailsJson"></pre>
      </div>
    </div>

    <table class="trace-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Name</th>
          <th>Bot</th>
          <th>User</th>
          <th>Duration</th>
          <th>Status</th>
          <th>Tokens</th>
        </tr>
      </thead>
      <tbody id="traceList"></tbody>
    </table>
    <div class="pagination">
      <button id="prevBtn" onclick="prevPage()" disabled>&laquo; Prev</button>
      <span id="pageInfo">Page 1</span>
      <button id="nextBtn" onclick="nextPage()">Next &raquo;</button>
    </div>
  </div>

  <div class="prompt-modal-backdrop" id="promptModalBackdrop" onclick="closePromptModal(event)">
    <div class="prompt-modal" onclick="event.stopPropagation()">
      <div class="prompt-modal-header">
        <h3>Prompt Snapshot</h3>
        <button class="prompt-modal-close" onclick="closePromptModal()">&times;</button>
      </div>
      <div class="prompt-tabs">
        <button class="prompt-tab active" id="tabSystem" onclick="switchPromptTab('system')">System Prompt <span class="char-count" id="systemCharCount"></span></button>
        <button class="prompt-tab" id="tabUser" onclick="switchPromptTab('user')">User Prompt <span class="char-count" id="userCharCount"></span></button>
      </div>
      <div class="prompt-modal-body">
        <div id="promptContent"></div>
      </div>
    </div>
  </div>

  <script>
    let currentPage = 0;
    const PAGE_SIZE = 50;
    let refreshTimer = null;
    let currentWaterfallTraceId = null;
    let promptCache = {};  // traceId -> { systemPrompt, userPrompt } | null
    let activePromptTab = 'system';

    function fmtTime(epochMs) {
      return new Date(epochMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function fmtDate(epochMs) {
      const d = new Date(epochMs);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) return fmtTime(epochMs);
      return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + fmtTime(epochMs);
    }
    function fmtDuration(ms) {
      if (ms == null) return '-';
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
    }
    function fmtTokens(attrs) {
      const input = attrs?.inputTokens || attrs?.input_tokens || 0;
      const output = attrs?.outputTokens || attrs?.output_tokens || 0;
      if (!input && !output) return '';
      const fmt = n => n >= 1000 ? (n/1000).toFixed(1) + 'k' : n;
      return fmt(input) + ' / ' + fmt(output);
    }

    async function loadStats() {
      try {
        const bot = document.getElementById('filterBot').value;
        const params = bot ? '?bot=' + bot : '';
        const res = await fetch('/api/trace-stats' + params);
        const stats = await res.json();
        document.getElementById('statTotal').textContent = stats.totalTraces;
        document.getElementById('statAvg').textContent = fmtDuration(stats.avgDurationMs);
        document.getElementById('statErrors').textContent = stats.errorCount;
        const types = Object.keys(stats.byName || {}).length;
        document.getElementById('statByName').textContent = types;
      } catch (e) { console.error('Failed to load stats', e); }
    }

    async function loadTraces() {
      try {
        const name = document.getElementById('filterName').value;
        const bot = document.getElementById('filterBot').value;
        const params = new URLSearchParams();
        params.set('limit', PAGE_SIZE);
        params.set('offset', currentPage * PAGE_SIZE);
        if (name) params.set('name', name);
        if (bot) params.set('bot', bot);

        const res = await fetch('/api/traces?' + params);
        const { traces } = await res.json();
        renderTraceList(traces);
        document.getElementById('pageInfo').textContent = 'Page ' + (currentPage + 1);
        document.getElementById('prevBtn').disabled = currentPage === 0;
        document.getElementById('nextBtn').disabled = traces.length < PAGE_SIZE;
      } catch (e) { console.error('Failed to load traces', e); }
    }

    function renderTraceList(traces) {
      const tbody = document.getElementById('traceList');
      if (traces.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">No traces found</td></tr>';
        return;
      }
      tbody.innerHTML = traces.map(t => {
        // Find token info from child spans' attributes
        const tokens = fmtTokens(t.attributes);
        return '<tr onclick="loadWaterfall(\\'' + t.traceId + '\\')" data-trace="' + t.traceId + '">' +
          '<td>' + fmtDate(t.startedAt) + '</td>' +
          '<td><span class="badge badge-name">' + esc(t.name) + '</span></td>' +
          '<td>' + (t.botName ? '<span class="badge badge-bot">' + esc(t.botName) + '</span>' : '-') + '</td>' +
          '<td>' + (t.username || t.userId || '-') + '</td>' +
          '<td>' + fmtDuration(t.durationMs) + '</td>' +
          '<td><span class="badge badge-' + t.status + '">' + t.status + '</span></td>' +
          '<td class="tokens">' + tokens + '</td>' +
          '</tr>';
      }).join('');
    }

    async function loadWaterfall(traceId) {
      try {
        currentWaterfallTraceId = traceId;
        const res = await fetch('/api/traces/' + traceId);
        const { spans } = await res.json();
        if (spans.length === 0) return;

        const container = document.getElementById('waterfallContainer');
        container.classList.add('visible');

        const root = spans.find(s => !s.parentId) || spans[0];
        document.getElementById('waterfallTitle').textContent =
          root.name + ' (' + fmtDuration(root.durationMs) + ')';

        // Highlight the selected row
        document.querySelectorAll('.trace-table tr').forEach(r => r.classList.remove('expanded'));
        const row = document.querySelector('tr[data-trace="' + traceId + '"]');
        if (row) row.classList.add('expanded');

        renderWaterfall(spans);
        document.getElementById('spanDetails').classList.remove('visible');
      } catch (e) { console.error('Failed to load waterfall', e); }
    }

    let waterfallSpans = []; // stored for click lookups

    function renderWaterfall(spans) {
      waterfallSpans = spans;
      const el = document.getElementById('waterfall');
      if (spans.length === 0) { el.innerHTML = '<div class="empty">No spans</div>'; return; }

      const minTime = Math.min(...spans.map(s => s.startedAt));
      const maxTime = Math.max(...spans.map(s => s.startedAt + (s.durationMs || 0)));
      const totalRange = Math.max(maxTime - minTime, 1);

      el.innerHTML = spans.map((s, i) => {
        const left = ((s.startedAt - minTime) / totalRange) * 100;
        const width = s.kind === 'event' ? 0.3 : Math.max(((s.durationMs || 0) / totalRange) * 100, 0.3);
        const statusClass = s.status === 'error' ? ' status-error' : '';
        const label = (s.parentId ? '  ' : '') + s.name;
        return '<div class="waterfall-row">' +
          '<div class="waterfall-label" title="' + esc(s.name) + '">' + esc(label) + '</div>' +
          '<div class="waterfall-bar-container">' +
            '<div class="waterfall-bar kind-' + s.kind + statusClass + '" ' +
              'style="left:' + left + '%;width:' + width + '%"' +
              ' data-span-index="' + i + '">' +
              '<span class="waterfall-duration">' + fmtDuration(s.durationMs) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Event delegation for waterfall bar clicks
    document.getElementById('waterfall').addEventListener('click', function(event) {
      const bar = event.target.closest('[data-span-index]');
      if (!bar) return;
      event.stopPropagation();
      const span = waterfallSpans[parseInt(bar.dataset.spanIndex, 10)];
      if (!span) return;
      const details = document.getElementById('spanDetails');
      details.classList.add('visible');
      document.getElementById('spanDetailsTitle').textContent =
        span.name + ' (' + span.kind + ', ' + span.status + ')';
      const attrs = span.attributes || {};
      document.getElementById('spanDetailsJson').textContent =
        JSON.stringify(attrs, null, 2);
    });

    function closeWaterfall() {
      document.getElementById('waterfallContainer').classList.remove('visible');
      document.querySelectorAll('.trace-table tr').forEach(r => r.classList.remove('expanded'));
    }

    function esc(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function openPromptModal() {
      if (!currentWaterfallTraceId) return;
      const backdrop = document.getElementById('promptModalBackdrop');
      const contentEl = document.getElementById('promptContent');
      contentEl.innerHTML = '<div class="prompt-unavailable">Loading...</div>';
      backdrop.classList.add('visible');
      activePromptTab = 'system';
      document.getElementById('tabSystem').classList.add('active');
      document.getElementById('tabUser').classList.remove('active');

      try {
        if (!promptCache[currentWaterfallTraceId]) {
          const res = await fetch('/api/prompts/' + currentWaterfallTraceId);
          if (res.status === 404) {
            promptCache[currentWaterfallTraceId] = null;
          } else {
            promptCache[currentWaterfallTraceId] = await res.json();
          }
        }
        const data = promptCache[currentWaterfallTraceId];
        if (!data) {
          contentEl.innerHTML = '<div class="prompt-unavailable">Prompt snapshot not available (expired or not captured)</div>';
          document.getElementById('systemCharCount').textContent = '';
          document.getElementById('userCharCount').textContent = '';
          return;
        }
        document.getElementById('systemCharCount').textContent = '(' + fmtCharCount(data.systemPrompt.length) + ')';
        document.getElementById('userCharCount').textContent = '(' + fmtCharCount(data.userPrompt.length) + ')';
        renderPromptTab(data);
      } catch (e) {
        contentEl.innerHTML = '<div class="prompt-unavailable">Failed to load prompt snapshot</div>';
        console.error('Failed to load prompt', e);
      }
    }

    function renderPromptTab(data) {
      const contentEl = document.getElementById('promptContent');
      const text = activePromptTab === 'system' ? data.systemPrompt : data.userPrompt;
      contentEl.innerHTML = '<pre>' + esc(text) + '</pre>';
    }

    function switchPromptTab(tab) {
      activePromptTab = tab;
      document.getElementById('tabSystem').classList.toggle('active', tab === 'system');
      document.getElementById('tabUser').classList.toggle('active', tab === 'user');
      const data = promptCache[currentWaterfallTraceId];
      if (data) renderPromptTab(data);
    }

    function closePromptModal(event) {
      if (event && event.target !== event.currentTarget) return;
      document.getElementById('promptModalBackdrop').classList.remove('visible');
    }

    function fmtCharCount(n) {
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k chars';
      return n + ' chars';
    }

    function prevPage() { if (currentPage > 0) { currentPage--; loadTraces(); } }
    function nextPage() { currentPage++; loadTraces(); }

    function startAutoRefresh() {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (document.getElementById('autoRefresh').checked) {
          loadTraces();
          loadStats();
        }
      }, 15000);
    }

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePromptModal();
    });

    // Init
    loadStats();
    loadTraces();
    startAutoRefresh();
  </script>
</body>
</html>`;
}
