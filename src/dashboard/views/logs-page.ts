import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { escScript } from "./components/helpers.ts";

export function renderLogsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Logs</title>
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
      flex-wrap: wrap;
    }
    .filters select, .filters input[type="text"] {
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      color: #e0e0e0;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .filters select:focus, .filters input:focus { outline: none; border-color: #6c63ff; }

    .level-pills { display: flex; gap: 4px; }
    .level-pill {
      padding: 4px 10px;
      border-radius: 14px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s;
      user-select: none;
    }
    .level-pill.active { opacity: 1; }
    .level-pill:not(.active) { opacity: 0.35; }
    .level-pill[data-level="info"] { background: rgba(74, 222, 128, 0.15); color: #4ade80; border-color: rgba(74, 222, 128, 0.3); }
    .level-pill[data-level="warning"] { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border-color: rgba(251, 191, 36, 0.3); }
    .level-pill[data-level="error"] { background: rgba(248, 113, 113, 0.15); color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
    .level-pill[data-level="debug"] { background: rgba(34, 211, 238, 0.15); color: #22d3ee; border-color: rgba(34, 211, 238, 0.3); }
    .level-pill[data-level="fatal"] { background: rgba(192, 132, 252, 0.15); color: #c084fc; border-color: rgba(192, 132, 252, 0.3); }

    .filter-count { color: #555; font-size: 12px; white-space: nowrap; }

    .tail-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #666;
      cursor: pointer;
      user-select: none;
    }

    /* Log Table */
    .content { padding: 0 24px 24px; }
    .log-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .log-table th {
      text-align: left;
      padding: 10px 12px;
      color: #666;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #1e1e2e;
      position: sticky;
      top: 0;
      background: #0a0a0f;
      z-index: 1;
    }
    .log-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #1a1a24;
      vertical-align: top;
    }
    .log-table tr.log-row { cursor: pointer; transition: background 0.15s; }
    .log-table tr.log-row:hover { background: rgba(108, 99, 255, 0.05); }
    .log-table tr.log-row.expanded { background: rgba(108, 99, 255, 0.08); }

    .log-detail {
      display: none;
      background: #12121a;
    }
    .log-detail.visible { display: table-row; }
    .log-detail td {
      padding: 12px 16px;
      border-bottom: 1px solid #1e1e2e;
    }
    .log-detail pre {
      background: #0a0a0f;
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      color: #ccc;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
    }
    .log-detail .detail-message {
      color: #e0e0e0;
      font-size: 13px;
      margin-bottom: 8px;
      line-height: 1.5;
    }
    .log-detail .detail-label {
      color: #666;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 10px;
      margin-bottom: 4px;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-info { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
    .badge-warning { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    .badge-error { background: rgba(248, 113, 113, 0.15); color: #f87171; }
    .badge-debug { background: rgba(34, 211, 238, 0.15); color: #22d3ee; }
    .badge-fatal { background: rgba(192, 132, 252, 0.15); color: #c084fc; }
    .badge-bot { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    .badge-category { background: rgba(108, 99, 255, 0.15); color: #a5a0ff; }

    .msg-text {
      max-width: 600px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty { color: #555; text-align: center; padding: 40px; font-size: 14px; }
  </style>
</head>
<body>
  ${renderNav("logs", { headerLeftExtra: botSelectorHtml() })}

  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Total Entries</div></div>
    <div class="stat-card"><div class="stat-value" id="statErrors">-</div><div class="stat-label">Errors</div></div>
    <div class="stat-card"><div class="stat-value" id="statCategories">-</div><div class="stat-label">Categories</div></div>
    <div class="stat-card"><div class="stat-value" id="statBots">-</div><div class="stat-label">Bots</div></div>
  </div>

  <div class="filters">
    <select id="dateSelect" onchange="loadEntries()">
      <option value="">Loading...</option>
    </select>

    <div class="level-pills" id="levelPills">
      <span class="level-pill active" data-level="info">Info</span>
      <span class="level-pill active" data-level="warning">Warning</span>
      <span class="level-pill active" data-level="error">Error</span>
      <span class="level-pill active" data-level="debug">Debug</span>
      <span class="level-pill active" data-level="fatal">Fatal</span>
    </div>

    <select id="categorySelect" onchange="applyFilters()">
      <option value="">All categories</option>
    </select>

    <input type="text" id="searchInput" placeholder="Search messages..." style="width: 200px;">

    <label class="tail-label">
      <input type="checkbox" id="liveTail"> Live tail
    </label>

    <span class="filter-count" id="filterCount"></span>
  </div>

  <div class="content">
    <table class="log-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Level</th>
          <th>Category</th>
          <th>Bot</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody id="logBody"></tbody>
    </table>
  </div>

  <script>
    let allEntries = [];
    let filteredEntries = [];
    let expandedId = null; // numeric _id for stable row tracking
    let nextId = 0;
    let tailTimer = null;
    let activeLevels = new Set(['info', 'warning', 'error', 'debug', 'fatal']);
    let searchTimeout = null;

    // --- Bot selector ---
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
      applyFilters();
    }

    document.getElementById('botSelector').addEventListener('click', (e) => {
      const pill = e.target.closest('.bot-pill');
      if (pill) selectBot(pill.dataset.bot);
    });

    // --- Level pill toggles ---
    document.getElementById('levelPills').addEventListener('click', (e) => {
      const pill = e.target.closest('.level-pill');
      if (!pill) return;
      const level = pill.dataset.level;
      if (activeLevels.has(level)) {
        activeLevels.delete(level);
        pill.classList.remove('active');
      } else {
        activeLevels.add(level);
        pill.classList.add('active');
      }
      applyFilters();
    });

    // --- Search with debounce ---
    document.getElementById('searchInput').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(applyFilters, 200);
    });

    // --- Live tail ---
    document.getElementById('liveTail').addEventListener('change', (e) => {
      if (e.target.checked) startTail();
      else stopTail();
    });

    function startTail() {
      stopTail();
      const dateSelect = document.getElementById('dateSelect');
      const today = new Date().toISOString().slice(0, 10);
      if (dateSelect.value !== today) return;
      tailTimer = setInterval(pollTail, 5000);
    }

    function stopTail() {
      if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
    }

    async function pollTail() {
      const dateSelect = document.getElementById('dateSelect');
      const today = new Date().toISOString().slice(0, 10);
      if (dateSelect.value !== today) { stopTail(); return; }
      if (allEntries.length === 0) return;
      const lastTs = allEntries[allEntries.length - 1].ts;
      try {
        const res = await fetch('/api/logs/tail?date=' + dateSelect.value + '&after=' + encodeURIComponent(lastTs));
        const data = await res.json();
        if (data.entries && data.entries.length > 0) {
          allEntries.push(...data.entries.map(e => ({ ...e, _id: nextId++ })));
          updateCategoryDropdown();
          applyFilters();
        }
      } catch {}
    }

    // --- Load dates ---
    async function loadDates() {
      try {
        const res = await fetch('/api/logs/dates');
        const data = await res.json();
        const select = document.getElementById('dateSelect');
        if (!data.dates || data.dates.length === 0) {
          select.innerHTML = '<option value="">No logs found</option>';
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        select.innerHTML = data.dates.map((d, i) =>
          '<option value="' + esc(d) + '"' + (i === 0 ? ' selected' : '') + '>' + esc(d) + (d === today ? ' (today)' : '') + '</option>'
        ).join('');
        loadEntries();
      } catch (e) {
        console.error('Failed to load dates', e);
      }
    }

    // --- Load entries for selected date ---
    async function loadEntries() {
      const date = document.getElementById('dateSelect').value;
      if (!date) { allEntries = []; applyFilters(); return; }
      try {
        const res = await fetch('/api/logs?date=' + date);
        const data = await res.json();
        nextId = 0;
        allEntries = (data.entries || []).map(e => ({ ...e, _id: nextId++ }));
        expandedId = null;
        updateCategoryDropdown();
        applyFilters();

        // Enable/disable live tail based on date
        const today = new Date().toISOString().slice(0, 10);
        const tailCheckbox = document.getElementById('liveTail');
        if (date === today) {
          tailCheckbox.disabled = false;
          if (tailCheckbox.checked) startTail();
        } else {
          tailCheckbox.checked = false;
          tailCheckbox.disabled = true;
          stopTail();
        }
      } catch (e) {
        console.error('Failed to load entries', e);
        allEntries = [];
        applyFilters();
      }
    }

    // --- Apply filters & render ---
    function applyFilters() {
      const searchText = document.getElementById('searchInput').value.toLowerCase();
      const category = document.getElementById('categorySelect').value;

      filteredEntries = allEntries.filter(e => {
        if (!activeLevels.has(e.level)) return false;
        if (category && e.category !== category) return false;
        if (selectedBot && e.botName !== selectedBot) return false;
        if (searchText) {
          const inMsg = e.message.toLowerCase().includes(searchText);
          const inProps = !inMsg && JSON.stringify(e).toLowerCase().includes(searchText);
          if (!inMsg && !inProps) return false;
        }
        return true;
      });

      updateStats();
      renderTable();
      document.getElementById('filterCount').textContent =
        'Showing ' + filteredEntries.length + ' of ' + allEntries.length;
    }

    function updateStats() {
      document.getElementById('statTotal').textContent = allEntries.length;
      const errors = allEntries.filter(e => e.level === 'error' || e.level === 'fatal').length;
      document.getElementById('statErrors').textContent = errors;
      const categories = new Set(allEntries.map(e => e.category));
      document.getElementById('statCategories').textContent = categories.size;
      const bots = new Set(allEntries.filter(e => e.botName).map(e => e.botName));
      document.getElementById('statBots').textContent = bots.size;
    }

    function updateCategoryDropdown() {
      const select = document.getElementById('categorySelect');
      const current = select.value;
      const categories = [...new Set(allEntries.map(e => e.category))].sort();
      select.innerHTML = '<option value="">All categories</option>' +
        categories.map(c => '<option value="' + esc(c) + '"' + (c === current ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
    }

    function renderTable() {
      const tbody = document.getElementById('logBody');
      if (filteredEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">No log entries found</td></tr>';
        return;
      }

      // Show newest first
      const reversed = [...filteredEntries].reverse();
      const html = [];
      for (let i = 0; i < reversed.length; i++) {
        const e = reversed[i];
        const isExpanded = expandedId === e._id;
        const time = fmtTime(e.ts);
        const msg = e.message.length > 150 ? e.message.slice(0, 150) + '...' : e.message;
        const safeLevel = esc(e.level);

        html.push(
          '<tr class="log-row' + (isExpanded ? ' expanded' : '') + '" onclick="toggleRow(' + e._id + ')">' +
            '<td style="white-space:nowrap;color:#888">' + time + '</td>' +
            '<td><span class="badge badge-' + safeLevel + '">' + safeLevel + '</span></td>' +
            '<td><span class="badge badge-category">' + esc(e.category) + '</span></td>' +
            '<td>' + (e.botName ? '<span class="badge badge-bot">' + esc(e.botName) + '</span>' : '<span style="color:#444">-</span>') + '</td>' +
            '<td class="msg-text">' + esc(msg) + '</td>' +
          '</tr>'
        );

        html.push(
          '<tr class="log-detail' + (isExpanded ? ' visible' : '') + '">' +
            '<td colspan="5">' +
              '<div class="detail-message">' + esc(e.message) + '</div>' +
              renderProperties(e) +
            '</td>' +
          '</tr>'
        );
      }
      tbody.innerHTML = html.join('');
    }

    function renderProperties(entry) {
      const skip = new Set(['ts', 'level', 'category', 'message', '_id']);
      const props = {};
      let hasProps = false;
      for (const [k, v] of Object.entries(entry)) {
        if (!skip.has(k)) { props[k] = v; hasProps = true; }
      }
      if (!hasProps) return '';
      return '<div class="detail-label">Properties</div>' +
        '<pre>' + esc(JSON.stringify(props, null, 2)) + '</pre>';
    }

    function toggleRow(id) {
      expandedId = expandedId === id ? null : id;
      renderTable();
    }

    function fmtTime(isoStr) {
      const d = new Date(isoStr);
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
        '.' + String(d.getMilliseconds()).padStart(3, '0');
    }

    ${escScript()}

    // --- Init ---
    loadDates();
  </script>
</body>
</html>`;
}
