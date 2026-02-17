import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";

export function renderSearchPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Search</title>
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

    /* Search Area */
    .search-area {
      padding: 8px 24px 16px;
    }
    .search-input-row {
      display: flex;
      gap: 12px;
      align-items: stretch;
    }
    .search-input {
      flex: 1;
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      color: #e0e0e0;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus { border-color: #6c63ff; }
    .search-input::placeholder { color: #555; }
    .search-btn {
      background: #6c63ff;
      color: #fff;
      border: none;
      padding: 10px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .search-btn:hover { background: #5a52e0; }
    .search-btn:disabled { opacity: 0.5; cursor: default; }

    /* Filters */
    .filters {
      padding: 8px 24px 0;
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .filter-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .filter-label {
      color: #666;
      font-size: 12px;
    }
    .filters select {
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      color: #e0e0e0;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .filters select:focus { outline: none; border-color: #6c63ff; }

    .mode-pills {
      display: flex;
      gap: 0;
      border: 1px solid #2a2a3e;
      border-radius: 6px;
      overflow: hidden;
    }
    .mode-pill {
      background: #1a1a2e;
      color: #888;
      border: none;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      border-right: 1px solid #2a2a3e;
    }
    .mode-pill:last-child { border-right: none; }
    .mode-pill:hover { color: #a5a0ff; }
    .mode-pill.active {
      background: rgba(108, 99, 255, 0.2);
      color: #6c63ff;
    }

    .search-timing {
      margin-left: auto;
      color: #555;
      font-size: 12px;
    }

    /* Results */
    .content { padding: 0 24px 24px; }

    .result-count {
      color: #666;
      font-size: 13px;
      padding: 12px 0 8px;
    }

    .results-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .result-card {
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .result-card:hover {
      border-color: rgba(108, 99, 255, 0.3);
      background: #14142a;
    }

    .result-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .result-score {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(108, 99, 255, 0.15);
      color: #a5a0ff;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      min-width: 48px;
      justify-content: center;
    }
    .result-score-bar {
      width: 60px;
      height: 4px;
      background: #1e1e2e;
      border-radius: 2px;
      overflow: hidden;
    }
    .result-score-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s;
    }
    .score-high { background: #4ade80; }
    .score-medium { background: #fbbf24; }
    .score-low { background: #f87171; }

    .result-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-left: auto;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-bot { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    .badge-user { background: rgba(96, 165, 250, 0.15); color: #60a5fa; }
    .badge-scope-personal { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
    .badge-scope-shared { background: rgba(34, 211, 238, 0.15); color: #22d3ee; }
    .badge-tag { background: rgba(255, 255, 255, 0.06); color: #888; }

    .result-summary {
      color: #ccc;
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .result-summary mark {
      background: rgba(108, 99, 255, 0.3);
      color: #e0e0e0;
      padding: 0 2px;
      border-radius: 2px;
    }

    .result-content {
      color: #888;
      font-size: 12px;
      line-height: 1.5;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s;
    }
    .result-card.expanded .result-content {
      max-height: 400px;
      margin-bottom: 8px;
    }
    .result-content pre {
      background: #0a0a0f;
      padding: 10px;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }

    .result-footer {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .result-date {
      color: #555;
      font-size: 11px;
      margin-left: auto;
    }

    .empty {
      color: #555;
      text-align: center;
      padding: 60px 24px;
      font-size: 14px;
    }
    .empty-icon {
      font-size: 48px;
      margin-bottom: 12px;
      opacity: 0.3;
    }
    .empty-hint {
      color: #444;
      font-size: 12px;
      margin-top: 8px;
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid #2a2a3e;
      border-top-color: #6c63ff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Detail Modal */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal-backdrop.visible { display: flex; }
    .modal {
      background: #12121a;
      border: 1px solid #2a2a3e;
      border-radius: 12px;
      width: 90vw;
      max-width: 700px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid #1e1e2e;
    }
    .modal-header h3 { font-size: 14px; color: #fff; }
    .modal-close {
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 20px;
      padding: 4px 8px;
    }
    .modal-close:hover { color: #fff; }
    .modal-body {
      flex: 1;
      overflow: auto;
      padding: 16px 20px;
    }
    .modal-field { margin-bottom: 16px; }
    .modal-field-label {
      color: #666;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .modal-field-value {
      color: #ccc;
      font-size: 13px;
      line-height: 1.6;
    }
    .modal-field-value pre {
      background: #0a0a0f;
      padding: 12px;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }
    .modal-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
  </style>
</head>
<body>
  ${renderNav("search")}

  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Total Memories</div></div>
    <div class="stat-card"><div class="stat-value" id="statEmbedded">-</div><div class="stat-label">With Embeddings</div></div>
    <div class="stat-card"><div class="stat-value" id="statUsers">-</div><div class="stat-label">Users</div></div>
    <div class="stat-card"><div class="stat-value" id="statTags">-</div><div class="stat-label">Unique Tags</div></div>
  </div>

  <div class="search-area">
    <div class="search-input-row">
      <input type="text" class="search-input" id="searchInput" placeholder="Search memories... (semantic + keyword)" autofocus>
      <button class="search-btn" id="searchBtn" onclick="doSearch()">Search</button>
    </div>
  </div>

  <div class="filters">
    <div class="filter-group">
      <span class="filter-label">Bot:</span>
      <select id="filterBot">
        <option value="">All bots</option>
      </select>
    </div>
    <div class="filter-group">
      <span class="filter-label">Scope:</span>
      <select id="filterScope">
        <option value="">All</option>
        <option value="personal">Personal</option>
        <option value="shared">Shared</option>
      </select>
    </div>
    <div class="filter-group">
      <span class="filter-label">Mode:</span>
      <div class="mode-pills">
        <button class="mode-pill active" data-mode="hybrid" onclick="setMode('hybrid')">Hybrid</button>
        <button class="mode-pill" data-mode="semantic" onclick="setMode('semantic')">Semantic</button>
        <button class="mode-pill" data-mode="text" onclick="setMode('text')">Text</button>
      </div>
    </div>
    <div class="filter-group">
      <span class="filter-label">Results:</span>
      <select id="filterLimit">
        <option value="10">10</option>
        <option value="25" selected>25</option>
        <option value="50">50</option>
      </select>
    </div>
    <span class="search-timing" id="searchTiming"></span>
  </div>

  <div class="content">
    <div id="resultCount" class="result-count"></div>
    <div id="results" class="results-list">
      <div class="empty">
        <div class="empty-icon">&#x1F50D;</div>
        Search across all memories using semantic similarity and keyword matching
        <div class="empty-hint">Try: "user preferences", "calendar events", "project deadlines"</div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="modalBackdrop" onclick="closeModal(event)">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h3 id="modalTitle">Memory Detail</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>

  <script>
    let searchMode = 'hybrid';
    let searchResults = [];

    ${escScript()}

    function fmtDate(epochMs) {
      const d = new Date(epochMs);
      const now = new Date();
      const diffMs = now - d;
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffDays === 0) return 'Today ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return diffDays + ' days ago';
      if (diffDays < 30) return Math.floor(diffDays / 7) + 'w ago';
      return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function setMode(mode) {
      searchMode = mode;
      document.querySelectorAll('.mode-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.mode === mode);
      });
    }

    function highlightQuery(text, query) {
      if (!query || !text) return esc(text);
      const escaped = esc(text);
      const words = query.split(/\\s+/).filter(w => w.length > 2);
      if (words.length === 0) return escaped;
      const pattern = words.map(w => w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('|');
      try {
        return escaped.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
      } catch { return escaped; }
    }

    function scoreClass(score) {
      if (score >= 0.025) return 'score-high';
      if (score >= 0.015) return 'score-medium';
      return 'score-low';
    }

    function scorePercent(score) {
      // RRF scores are typically 0-0.033, normalize to 0-100
      return Math.min(Math.round(score / 0.033 * 100), 100);
    }

    async function doSearch() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      const btn = document.getElementById('searchBtn');
      const resultsEl = document.getElementById('results');
      const countEl = document.getElementById('resultCount');
      const timingEl = document.getElementById('searchTiming');

      btn.disabled = true;
      btn.textContent = 'Searching...';
      resultsEl.innerHTML = '<div class="loading"><span class="spinner"></span>Generating embedding & searching...</div>';
      countEl.textContent = '';
      timingEl.textContent = '';

      const startTime = performance.now();

      try {
        const params = new URLSearchParams();
        params.set('q', query);
        params.set('mode', searchMode);
        params.set('limit', document.getElementById('filterLimit').value);
        const bot = document.getElementById('filterBot').value;
        if (bot) params.set('bot', bot);
        const scope = document.getElementById('filterScope').value;
        if (scope) params.set('scope', scope);

        const res = await fetch('/api/search?' + params);
        const data = await res.json();
        searchResults = data.results || [];

        const elapsed = Math.round(performance.now() - startTime);
        timingEl.textContent = elapsed + 'ms';

        if (searchResults.length === 0) {
          countEl.textContent = '';
          resultsEl.innerHTML = '<div class="empty">No results found for "' + esc(query) + '"<div class="empty-hint">Try different keywords or switch search mode</div></div>';
          return;
        }

        countEl.textContent = searchResults.length + ' result' + (searchResults.length !== 1 ? 's' : '');
        renderResults(searchResults, query);
      } catch (err) {
        resultsEl.innerHTML = '<div class="empty">Search failed: ' + esc(err.message) + '</div>';
        countEl.textContent = '';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Search';
      }
    }

    function renderResults(results, query) {
      const el = document.getElementById('results');
      el.innerHTML = results.map((r, i) => {
        const score = r.similarity || 0;
        const pct = scorePercent(score);
        const cls = scoreClass(score);
        const scopeBadge = r.scope === 'shared'
          ? '<span class="badge badge-scope-shared">shared</span>'
          : '<span class="badge badge-scope-personal">personal</span>';
        const tags = (r.tags || []).map(t => '<span class="badge badge-tag">' + esc(t) + '</span>').join('');

        return '<div class="result-card" data-index="' + i + '" onclick="toggleExpand(this)">' +
          '<div class="result-header">' +
            '<span class="result-score">' + score.toFixed(4) + '</span>' +
            '<div class="result-score-bar"><div class="result-score-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
            '<div class="result-meta">' +
              (r.botName ? '<span class="badge badge-bot">' + esc(r.botName) + '</span>' : '') +
              '<span class="badge badge-user">' + esc(r.username || r.userId) + '</span>' +
              scopeBadge +
            '</div>' +
          '</div>' +
          '<div class="result-summary">' + highlightQuery(r.summary, query) + '</div>' +
          '<div class="result-content"><pre>' + highlightQuery(r.content, query) + '</pre></div>' +
          '<div class="result-footer">' +
            tags +
            '<span class="result-date">' + fmtDate(r.createdAt) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function toggleExpand(card) {
      card.classList.toggle('expanded');
    }

    function closeModal(event) {
      if (event && event.target !== event.currentTarget) return;
      document.getElementById('modalBackdrop').classList.remove('visible');
    }

    // Enter key triggers search
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Escape closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Load stats and bot filter
    async function loadStats() {
      try {
        const res = await fetch('/api/search-stats');
        const stats = await res.json();
        document.getElementById('statTotal').textContent = stats.totalMemories;
        document.getElementById('statEmbedded').textContent = stats.withEmbeddings;
        document.getElementById('statUsers').textContent = stats.uniqueUsers;
        document.getElementById('statTags').textContent = stats.uniqueTags;
      } catch (e) { console.error('Failed to load search stats', e); }
    }

    async function loadBots() {
      try {
        const res = await fetch('/api/trace-filters');
        if (!res.ok) return;
        const { bots } = await res.json();
        const select = document.getElementById('filterBot');
        (bots || []).forEach(b => {
          const opt = document.createElement('option');
          opt.value = b;
          opt.textContent = b;
          select.appendChild(opt);
        });
      } catch (e) { console.error('Failed to load bots', e); }
    }

    // Init
    loadStats();
    loadBots();
  </script>
</body>
</html>`;
}
