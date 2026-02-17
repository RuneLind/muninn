import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { escScript } from "./components/helpers.ts";

export function renderTracesPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Traces</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}

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
    .badge-tools { background: rgba(245, 158, 11, 0.15); color: #f59e0b; margin-left: 6px; }

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
    .waterfall-bar.kind-tool { background: #f59e0b; }
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

    /* Prompt Stats Pills */
    .prompt-stats {
      display: flex;
      gap: 8px;
      padding: 10px 20px;
      flex-wrap: wrap;
      border-bottom: 1px solid #1e1e2e;
    }
    .prompt-stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 11px;
      background: rgba(108, 99, 255, 0.1);
      color: #888;
    }
    .prompt-stat-pill .stat-val { font-weight: 600; color: #e0e0e0; }
    .prompt-stat-pill.clickable { cursor: pointer; transition: all 0.15s; }
    .prompt-stat-pill.clickable:hover { background: rgba(108, 99, 255, 0.25); color: #e0e0e0; }

    /* Section highlight flash */
    .section-highlight { animation: sectionFlash 1.5s ease-out; }
    @keyframes sectionFlash {
      0% { box-shadow: 0 0 0 2px rgba(108, 99, 255, 0.6); }
      100% { box-shadow: 0 0 0 2px transparent; }
    }

    /* Prompt Sections */
    .prompt-section {
      border: 1px solid #1e1e2e;
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .prompt-section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }
    .prompt-section-header:hover { background: rgba(255,255,255,0.03); }
    .prompt-section-chevron {
      transition: transform 0.2s;
      font-size: 10px;
      color: #666;
    }
    .prompt-section-chevron.collapsed { transform: rotate(-90deg); }
    .prompt-section-title { font-size: 12px; font-weight: 600; }
    .prompt-section-meta { font-size: 10px; color: #555; margin-left: auto; }
    .prompt-section-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 500;
      background: rgba(255,255,255,0.06);
      color: #999;
    }
    .prompt-section-body {
      padding: 8px 12px;
      border-top: 1px solid #1e1e2e;
      font-size: 12px;
      line-height: 1.6;
      color: #ccc;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .prompt-section-body.hidden { display: none; }

    /* Section color themes */
    .section-persona .prompt-section-title { color: #c084fc; }
    .section-persona { border-color: rgba(192,132,252,0.2); }
    .section-persona .prompt-section-header { background: rgba(192,132,252,0.05); }

    .section-identity .prompt-section-title { color: #4ade80; }
    .section-identity { border-color: rgba(74,222,128,0.2); }
    .section-identity .prompt-section-header { background: rgba(74,222,128,0.05); }

    .section-restrictions .prompt-section-title { color: #f87171; }
    .section-restrictions { border-color: rgba(248,113,113,0.2); }
    .section-restrictions .prompt-section-header { background: rgba(248,113,113,0.05); }

    .section-memories .prompt-section-title { color: #60a5fa; }
    .section-memories { border-color: rgba(96,165,250,0.2); }
    .section-memories .prompt-section-header { background: rgba(96,165,250,0.05); }

    .section-goals .prompt-section-title { color: #fbbf24; }
    .section-goals { border-color: rgba(251,191,36,0.2); }
    .section-goals .prompt-section-header { background: rgba(251,191,36,0.05); }

    .section-tasks .prompt-section-title { color: #2dd4bf; }
    .section-tasks { border-color: rgba(45,212,191,0.2); }
    .section-tasks .prompt-section-header { background: rgba(45,212,191,0.05); }

    .section-alerts .prompt-section-title { color: #f59e0b; }
    .section-alerts { border-color: rgba(245,158,11,0.2); }
    .section-alerts .prompt-section-header { background: rgba(245,158,11,0.05); }

    .section-knowledge .prompt-section-title { color: #8b5cf6; }
    .section-knowledge { border-color: rgba(139,92,246,0.2); }
    .section-knowledge .prompt-section-header { background: rgba(139,92,246,0.05); }

    .section-slack .prompt-section-title { color: #22d3ee; }
    .section-slack { border-color: rgba(34,211,238,0.2); }
    .section-slack .prompt-section-header { background: rgba(34,211,238,0.05); }

    .section-history .prompt-section-title { color: #94a3b8; }
    .section-history { border-color: rgba(148,163,184,0.2); }
    .section-history .prompt-section-header { background: rgba(148,163,184,0.05); }

    /* Conversation messages */
    .conv-message {
      margin-bottom: 6px;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .conv-message-user { border-left: 3px solid #60a5fa; background: rgba(96,165,250,0.05); }
    .conv-message-assistant { border-left: 3px solid #c084fc; background: rgba(192,132,252,0.05); }
    .conv-message-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .conv-message-user .conv-message-label { color: #60a5fa; }
    .conv-message-assistant .conv-message-label { color: #c084fc; }

    /* Current message highlight */
    .current-message-wrapper { margin-top: 8px; }
    .current-message-label { font-size: 11px; font-weight: 600; color: #4ade80; margin-bottom: 6px; }
    .current-message {
      border: 1px solid rgba(74,222,128,0.3);
      background: rgba(74,222,128,0.05);
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: #e0e0e0;
    }
  </style>
</head>
<body>
  ${renderNav("traces", { headerLeftExtra: botSelectorHtml() })}

  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Traces (24h)</div></div>
    <div class="stat-card"><div class="stat-value" id="statAvg">-</div><div class="stat-label">Avg Duration</div></div>
    <div class="stat-card"><div class="stat-value" id="statErrors">-</div><div class="stat-label">Errors (24h)</div></div>
    <div class="stat-card"><div class="stat-value" id="statByName">-</div><div class="stat-label">Trace Types</div></div>
  </div>

  <div class="filters">
    <select id="filterName" onchange="currentPage=0;loadTraces();loadStats()">
      <option value="">All types</option>
    </select>
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
          <th>Tools</th>
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
      <div class="prompt-stats" id="promptStats"></div>
      <div class="prompt-tabs">
        <button class="prompt-tab" id="tabSystem" onclick="switchPromptTab('system')">System Prompt <span class="char-count" id="systemCharCount"></span></button>
        <button class="prompt-tab active" id="tabUser" onclick="switchPromptTab('user')">User Prompt <span class="char-count" id="userCharCount"></span></button>
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

    // --- Bot selector (synced with dashboard via localStorage) ---
    let selectedBot = '';
    (function initBotSelector() {
      try { selectedBot = localStorage.getItem('javrvis-selected-bot') || ''; } catch {}
      loadBotList();
    })();

    async function loadBotList() {
      try {
        const res = await fetch('/api/bots').then(r => r.json());
        const container = document.getElementById('botSelector');
        const bots = res.bots || [];
        container.innerHTML =
          '<button class="bot-pill' + (!selectedBot ? ' active' : '') + '" data-bot="">All Bots</button>' +
          bots.map(b =>
            '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + esc(b) + '">' + esc(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>'
          ).join('');
      } catch {}
    }

    function selectBot(name) {
      selectedBot = name;
      try { localStorage.setItem('javrvis-selected-bot', name); } catch {}
      document.querySelectorAll('.bot-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.bot === name);
      });
      currentPage = 0;
      loadTraces();
      loadStats();
    }

    document.getElementById('botSelector').addEventListener('click', (e) => {
      const pill = e.target.closest('.bot-pill');
      if (pill) selectBot(pill.dataset.bot);
    });

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
        const bot = selectedBot;
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
        const bot = selectedBot;
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
        tbody.innerHTML = '<tr><td colspan="8" class="empty">No traces found</td></tr>';
        return;
      }
      tbody.innerHTML = traces.map(t => {
        // Find token info from child spans' attributes
        const tokens = fmtTokens(t.attributes);
        const toolCount = t.attributes?.toolCount || 0;
        const toolsBadge = toolCount > 0
          ? '<span class="badge badge-tools">' + toolCount + '</span>'
          : '<span style="color:#444">-</span>';
        return '<tr onclick="loadWaterfall(\\'' + t.traceId + '\\')" data-trace="' + t.traceId + '">' +
          '<td>' + fmtDate(t.startedAt) + '</td>' +
          '<td><span class="badge badge-name">' + esc(t.name) + '</span></td>' +
          '<td>' + (t.botName ? '<span class="badge badge-bot">' + esc(t.botName) + '</span>' : '-') + '</td>' +
          '<td>' + (t.username || t.userId || '-') + '</td>' +
          '<td>' + fmtDuration(t.durationMs) + '</td>' +
          '<td><span class="badge badge-' + t.status + '">' + t.status + '</span></td>' +
          '<td>' + toolsBadge + '</td>' +
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

      // Build parent lookup for nesting depth
      const spanById = {};
      spans.forEach(s => { spanById[s.id] = s; });

      function nestingDepth(s) {
        let depth = 0;
        let current = s;
        while (current.parentId && spanById[current.parentId]) {
          depth++;
          current = spanById[current.parentId];
        }
        return depth;
      }

      function isToolSpan(s) {
        return s.attributes && (s.attributes.toolName || s.attributes.toolId);
      }

      const minTime = Math.min(...spans.map(s => s.startedAt));
      const maxTime = Math.max(...spans.map(s => s.startedAt + (s.durationMs || 0)));
      const totalRange = Math.max(maxTime - minTime, 1);

      el.innerHTML = spans.map((s, i) => {
        const left = ((s.startedAt - minTime) / totalRange) * 100;
        const width = s.kind === 'event' ? 0.3 : Math.max(((s.durationMs || 0) / totalRange) * 100, 0.3);
        const statusClass = s.status === 'error' ? ' status-error' : '';
        const depth = nestingDepth(s);
        const indent = '\u00A0\u00A0'.repeat(depth);
        const label = indent + s.name;
        const barKind = isToolSpan(s) ? 'tool' : s.kind;
        return '<div class="waterfall-row">' +
          '<div class="waterfall-label" title="' + esc(s.name) + '">' + esc(label) + '</div>' +
          '<div class="waterfall-bar-container">' +
            '<div class="waterfall-bar kind-' + barKind + statusClass + '" ' +
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

    ${escScript()}

    async function openPromptModal() {
      if (!currentWaterfallTraceId) return;
      const backdrop = document.getElementById('promptModalBackdrop');
      const contentEl = document.getElementById('promptContent');
      contentEl.innerHTML = '<div class="prompt-unavailable">Loading...</div>';
      backdrop.classList.add('visible');
      activePromptTab = 'user';
      document.getElementById('tabSystem').classList.remove('active');
      document.getElementById('tabUser').classList.add('active');
      renderPromptStats();

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
      if (activePromptTab === 'system') {
        renderSystemPrompt(data.systemPrompt, contentEl);
      } else {
        renderUserPrompt(data.userPrompt, contentEl);
      }
    }

    function renderPromptStats() {
      const el = document.getElementById('promptStats');
      if (!el) return;
      const buildSpan = waterfallSpans.find(function(s) { return s.name === 'prompt_build'; });
      if (!buildSpan || !buildSpan.attributes) { el.innerHTML = ''; return; }
      var a = buildSpan.attributes;
      var stats = [
        { value: a.messagesCount, label: 'Messages', section: 'history', tab: 'user' },
        { value: a.memoriesCount, label: 'Memories', section: 'personal-memories', tab: 'system' },
        { value: a.goalsCount, label: 'Goals', section: 'goals', tab: 'system' },
        { value: a.scheduledTasksCount, label: 'Tasks', section: 'tasks', tab: 'system' },
        { value: a.alertsCount, label: 'Alerts', section: 'alerts', tab: 'system' },
        { value: a.knowledgeCount, label: 'Knowledge', section: 'knowledge', tab: 'system' },
      ].filter(function(s) { return s.value != null; });
      el.innerHTML = stats.map(function(s) {
        var clickable = s.value > 0;
        var cls = 'prompt-stat-pill' + (clickable ? ' clickable' : '');
        var attrs = clickable ? ' data-section="' + s.section + '" data-tab="' + s.tab + '"' : '';
        return '<div class="' + cls + '"' + attrs + '><span class="stat-val">' + s.value + '</span> ' + s.label + '</div>';
      }).join('');
      // Attach click handlers via event delegation
      el.querySelectorAll('.prompt-stat-pill.clickable').forEach(function(pill) {
        pill.addEventListener('click', function() {
          jumpToSection(pill.dataset.section, pill.dataset.tab);
        });
      });
    }

    function jumpToSection(sectionKey, tab) {
      if (activePromptTab !== tab) {
        switchPromptTab(tab);
      }
      // Small delay to let DOM render after tab switch
      setTimeout(function() {
        var section = document.querySelector('[data-section="' + sectionKey + '"]');
        if (!section) return;
        // Expand if collapsed
        var body = section.querySelector('.prompt-section-body');
        var chevron = section.querySelector('.prompt-section-chevron');
        if (body && body.classList.contains('hidden')) {
          body.classList.remove('hidden');
          if (chevron) chevron.classList.remove('collapsed');
        }
        // Scroll into view and flash highlight
        section.scrollIntoView({ behavior: 'smooth', block: 'center' });
        section.classList.add('section-highlight');
        setTimeout(function() { section.classList.remove('section-highlight'); }, 1500);
      }, 50);
    }

    function parseSystemSections(text) {
      var markers = [
        { key: 'identity', label: 'User Identity', marker: 'You are currently talking to:', color: 'identity' },
        { key: 'restrictions', label: 'Tool Restrictions', marker: '## Verktøyrestriksjoner', color: 'restrictions' },
        { key: 'personal-memories', label: 'Personal Memories', marker: 'Your memories about this user:', color: 'memories' },
        { key: 'shared-memories', label: 'Shared Memories', marker: 'Shared team knowledge:', color: 'memories' },
        { key: 'goals', label: 'Goals', marker: "User's active goals:", color: 'goals' },
        { key: 'tasks', label: 'Scheduled Tasks', marker: "User's scheduled tasks:", color: 'tasks' },
        { key: 'alerts', label: 'Alerts', marker: 'Recent watcher alerts sent to user (last 24h):', color: 'alerts' },
        { key: 'knowledge', label: 'Knowledge', marker: 'Relevant company knowledge (from Notion):', color: 'knowledge' },
        { key: 'slack-post', label: 'Slack Posting', marker: '## Slack Channel Posting', color: 'slack' },
        { key: 'channel-context', label: 'Channel Context', marker: '## Channel Context', color: 'slack' },
      ];
      var found = [];
      for (var i = 0; i < markers.length; i++) {
        var idx = text.indexOf(markers[i].marker);
        if (idx >= 0) {
          found.push({ key: markers[i].key, label: markers[i].label, marker: markers[i].marker, color: markers[i].color, pos: idx });
        }
      }
      found.sort(function(a, b) { return a.pos - b.pos; });
      var sections = [];
      var firstPos = found.length > 0 ? found[0].pos : text.length;
      var personaText = text.slice(0, firstPos).trim();
      if (personaText) {
        sections.push({ key: 'persona', label: 'Persona', color: 'persona', content: personaText, collapsed: true });
      }
      for (var i = 0; i < found.length; i++) {
        var start = found[i].pos;
        var end = i + 1 < found.length ? found[i + 1].pos : text.length;
        var content = text.slice(start, end).trim();
        sections.push({ key: found[i].key, label: found[i].label, color: found[i].color, content: content, collapsed: false });
      }
      return sections;
    }

    function parseUserSections(text) {
      var sections = [];
      var histStart = text.indexOf('<conversation_history>');
      var histEnd = text.indexOf('</conversation_history>');
      if (histStart >= 0 && histEnd >= 0) {
        var histContent = text.slice(histStart + '<conversation_history>'.length, histEnd).trim();
        var currentMsg = text.slice(histEnd + '</conversation_history>'.length).trim();
        var messages = parseConversationMessages(histContent);
        sections.push({ key: 'history', label: 'Conversation History', color: 'history', messages: messages, collapsed: messages.length > 10 });
        if (currentMsg) {
          sections.push({ key: 'current', label: 'Current Message', color: 'current', content: currentMsg, collapsed: false });
        }
      } else {
        sections.push({ key: 'current', label: 'Current Message', color: 'current', content: text.trim(), collapsed: false });
      }
      return sections;
    }

    function parseConversationMessages(text) {
      var re = /\\[(user\\/[^\\]]+|assistant)\\]\\s*/g;
      var messages = [];
      var match;
      var starts = [];
      while ((match = re.exec(text)) !== null) {
        starts.push({ label: match[1], pos: match.index, textStart: match.index + match[0].length });
      }
      for (var i = 0; i < starts.length; i++) {
        var end = i + 1 < starts.length ? starts[i + 1].pos : text.length;
        var content = text.slice(starts[i].textStart, end).trim();
        var role = starts[i].label.startsWith('user') ? 'user' : 'assistant';
        messages.push({ role: role, label: starts[i].label, content: content });
      }
      return messages;
    }

    function countItems(content) {
      var matches = content.match(/^- /gm);
      return matches ? matches.length : 0;
    }

    function renderSystemPrompt(text, container) {
      var sections = parseSystemSections(text);
      if (sections.length === 0) {
        container.innerHTML = '<pre>' + esc(text) + '</pre>';
        return;
      }
      container.innerHTML = sections.map(function(s) {
        var items = countItems(s.content);
        var badge = items > 0 ? '<span class="prompt-section-badge">' + items + ' items</span>' : '';
        var meta = fmtCharCount(s.content.length);
        var bodyClass = s.collapsed ? 'prompt-section-body hidden' : 'prompt-section-body';
        var chevClass = s.collapsed ? 'prompt-section-chevron collapsed' : 'prompt-section-chevron';
        return '<div class="prompt-section section-' + s.color + '" data-section="' + s.key + '">' +
          '<div class="prompt-section-header" onclick="toggleSection(this)">' +
            '<span class="' + chevClass + '">▼</span>' +
            '<span class="prompt-section-title">' + esc(s.label) + '</span>' +
            badge +
            '<span class="prompt-section-meta">' + meta + '</span>' +
          '</div>' +
          '<div class="' + bodyClass + '">' + esc(s.content) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderUserPrompt(text, container) {
      var sections = parseUserSections(text);
      if (sections.length === 0) {
        container.innerHTML = '<pre>' + esc(text) + '</pre>';
        return;
      }
      container.innerHTML = sections.map(function(s) {
        if (s.key === 'history') {
          var msgCount = s.messages.length;
          var badge = '<span class="prompt-section-badge">' + msgCount + ' messages</span>';
          var chevClass = s.collapsed ? 'prompt-section-chevron collapsed' : 'prompt-section-chevron';
          var bodyClass = s.collapsed ? 'prompt-section-body hidden' : 'prompt-section-body';
          return '<div class="prompt-section section-history" data-section="history">' +
            '<div class="prompt-section-header" onclick="toggleSection(this)">' +
              '<span class="' + chevClass + '">▼</span>' +
              '<span class="prompt-section-title">' + esc(s.label) + '</span>' +
              badge +
            '</div>' +
            '<div class="' + bodyClass + '" style="padding:6px 8px">' +
              s.messages.map(function(m) {
                var cls = m.role === 'user' ? 'conv-message conv-message-user' : 'conv-message conv-message-assistant';
                return '<div class="' + cls + '">' +
                  '<div class="conv-message-label">' + esc(m.label) + '</div>' +
                  esc(m.content) +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>';
        } else {
          return '<div class="current-message-wrapper">' +
            '<div class="current-message-label">Current Message</div>' +
            '<div class="current-message">' + esc(s.content) + '</div>' +
          '</div>';
        }
      }).join('');
    }

    function toggleSection(headerEl) {
      var body = headerEl.nextElementSibling;
      var chevron = headerEl.querySelector('.prompt-section-chevron');
      body.classList.toggle('hidden');
      chevron.classList.toggle('collapsed');
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
      let refreshCount = 0;
      refreshTimer = setInterval(() => {
        if (document.getElementById('autoRefresh').checked) {
          loadTraces();
          loadStats();
          refreshCount++;
          if (refreshCount % 4 === 0) loadFilters(); // refresh filters every ~60s
        }
      }, 15000);
    }

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePromptModal();
    });

    async function loadFilters() {
      try {
        const res = await fetch('/api/trace-filters');
        if (!res.ok) return;
        const { types } = await res.json();
        if (!types) return;
        const nameSelect = document.getElementById('filterName');
        const nameVal = nameSelect.value;
        nameSelect.innerHTML = '<option value="">All types</option>';
        types.forEach(t => {
          const opt = document.createElement('option');
          opt.value = t;
          opt.textContent = t;
          nameSelect.appendChild(opt);
        });
        nameSelect.value = nameVal;
      } catch (e) { console.error('Failed to load filters', e); }
    }

    // Init
    loadFilters();
    loadStats();
    loadTraces();
    startAutoRefresh();
  </script>
</body>
</html>`;
}
