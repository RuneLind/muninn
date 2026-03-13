/** MemSearch panel — embedded in dashboard as a tab */
import { escScript } from "./helpers.ts";

export function memsearchPanelStyles(): string {
  return `
    /* MemSearch Panel — Stats Bar */
    .ms-stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .ms-stat-card {
      background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-gradient-end) 100%);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
    }
    .ms-stat-value { color: var(--text-primary); font-weight: 700; font-size: 24px; }
    .ms-stat-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

    /* Search Area */
    .ms-search-area { margin-bottom: 12px; }
    .ms-search-input-row {
      display: flex;
      gap: 12px;
      align-items: stretch;
    }
    .ms-search-input {
      flex: 1;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .ms-search-input:focus { border-color: var(--accent); }
    .ms-search-input::placeholder { color: var(--text-faint); }
    .ms-search-btn {
      background: var(--accent);
      color: var(--text-primary);
      border: none;
      padding: 10px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .ms-search-btn:hover { background: var(--accent-hover); }
    .ms-search-btn:disabled { opacity: 0.5; cursor: default; }

    /* Filters */
    .ms-filters {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .ms-filter-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ms-filter-label {
      color: var(--text-dim);
      font-size: 12px;
    }
    .ms-filters select {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .ms-filters select:focus { outline: none; border-color: var(--accent); }

    .ms-mode-pills {
      display: flex;
      gap: 0;
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      overflow: hidden;
    }
    .ms-mode-pill {
      background: var(--bg-surface);
      color: var(--text-muted);
      border: none;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      border-right: 1px solid var(--border-secondary);
    }
    .ms-mode-pill:last-child { border-right: none; }
    .ms-mode-pill:hover { color: var(--accent-light); }
    .ms-mode-pill.active {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent);
    }

    .ms-search-timing {
      margin-left: auto;
      color: var(--text-faint);
      font-size: 12px;
    }

    /* Results */
    .ms-result-count {
      color: var(--text-dim);
      font-size: 13px;
      padding: 8px 0;
    }
    .ms-results-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ms-result-card {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .ms-result-card:hover {
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      background: var(--bg-gradient-end);
    }
    .ms-result-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .ms-result-score {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      min-width: 48px;
      justify-content: center;
    }
    .ms-result-score-bar {
      width: 60px;
      height: 4px;
      background: var(--border-primary);
      border-radius: 2px;
      overflow: hidden;
    }
    .ms-result-score-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s;
    }
    .ms-score-high { background: var(--status-success); }
    .ms-score-medium { background: var(--status-warning); }
    .ms-score-low { background: var(--status-error); }
    .ms-result-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-left: auto;
    }
    .ms-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .ms-badge-bot { background: color-mix(in srgb, var(--status-warning) 15%, transparent); color: var(--status-warning); }
    .ms-badge-user { background: color-mix(in srgb, var(--status-info) 15%, transparent); color: var(--status-info); }
    .ms-badge-scope-personal { background: color-mix(in srgb, var(--status-magenta) 15%, transparent); color: var(--status-magenta); }
    .ms-badge-scope-shared { background: color-mix(in srgb, var(--status-cyan) 15%, transparent); color: var(--status-cyan); }
    .ms-badge-tag { background: color-mix(in srgb, white 6%, transparent); color: var(--text-muted); }
    .ms-result-summary {
      color: var(--text-tertiary);
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .ms-result-summary mark {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--text-secondary);
      padding: 0 2px;
      border-radius: 2px;
    }
    .ms-result-content {
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.5;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s;
    }
    .ms-result-card.expanded .ms-result-content {
      max-height: 400px;
      margin-bottom: 8px;
    }
    .ms-result-content pre {
      background: var(--bg-page);
      padding: 10px;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }
    .ms-result-footer {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .ms-result-date {
      color: var(--text-faint);
      font-size: 11px;
      margin-left: auto;
    }
    .ms-empty {
      color: var(--text-faint);
      text-align: center;
      padding: 40px 20px;
      font-size: 14px;
    }
  `;
}

export function memsearchPanelHtml(): string {
  return `
    <div class="ms-stats-bar" id="msStatsBar">
      <div class="ms-stat-card"><div class="ms-stat-value" id="msStatTotal">-</div><div class="ms-stat-label">Total Memories</div></div>
      <div class="ms-stat-card"><div class="ms-stat-value" id="msStatEmbedded">-</div><div class="ms-stat-label">With Embeddings</div></div>
      <div class="ms-stat-card"><div class="ms-stat-value" id="msStatUsers">-</div><div class="ms-stat-label">Users</div></div>
      <div class="ms-stat-card"><div class="ms-stat-value" id="msStatTags">-</div><div class="ms-stat-label">Unique Tags</div></div>
    </div>

    <div class="ms-search-area">
      <div class="ms-search-input-row">
        <input type="text" class="ms-search-input" id="msSearchInput" placeholder="Search memories... (semantic + keyword)">
        <button class="ms-search-btn" id="msSearchBtn" onclick="msDoSearch()">Search</button>
      </div>
    </div>

    <div class="ms-filters">
      <div class="ms-filter-group">
        <span class="ms-filter-label">Bot:</span>
        <select id="msFilterBot">
          <option value="">All bots</option>
        </select>
      </div>
      <div class="ms-filter-group">
        <span class="ms-filter-label">Scope:</span>
        <select id="msFilterScope">
          <option value="">All</option>
          <option value="personal">Personal</option>
          <option value="shared">Shared</option>
        </select>
      </div>
      <div class="ms-filter-group">
        <span class="ms-filter-label">Mode:</span>
        <div class="ms-mode-pills">
          <button class="ms-mode-pill active" data-mode="hybrid" onclick="msSetMode('hybrid')">Hybrid</button>
          <button class="ms-mode-pill" data-mode="semantic" onclick="msSetMode('semantic')">Semantic</button>
          <button class="ms-mode-pill" data-mode="text" onclick="msSetMode('text')">Text</button>
        </div>
      </div>
      <div class="ms-filter-group">
        <span class="ms-filter-label">Results:</span>
        <select id="msFilterLimit">
          <option value="10">10</option>
          <option value="25" selected>25</option>
          <option value="50">50</option>
        </select>
      </div>
      <span class="ms-search-timing" id="msSearchTiming"></span>
    </div>

    <div id="msResultCount" class="ms-result-count"></div>
    <div id="msResults" class="ms-results-list">
      <div class="ms-empty">Search across all memories using semantic similarity and keyword matching</div>
    </div>
  `;
}

export function memsearchPanelScript(): string {
  return `
    var msSearchMode = 'hybrid';
    var msSearchResults = [];
    var msInitialized = false;

    ${escScript()}

    function msFmtDate(epochMs) {
      var d = new Date(epochMs);
      var now = new Date();
      var diffMs = now - d;
      var diffDays = Math.floor(diffMs / 86400000);
      if (diffDays === 0) return 'Today ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return diffDays + ' days ago';
      if (diffDays < 30) return Math.floor(diffDays / 7) + 'w ago';
      return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function msSetMode(mode) {
      msSearchMode = mode;
      document.querySelectorAll('.ms-mode-pill').forEach(function(p) {
        p.classList.toggle('active', p.dataset.mode === mode);
      });
    }

    function msHighlightQuery(text, query) {
      if (!query || !text) return esc(text);
      var escaped = esc(text);
      var words = query.split(/\\s+/).filter(function(w) { return w.length > 2; });
      if (words.length === 0) return escaped;
      var pattern = words.map(function(w) { return w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }).join('|');
      try {
        return escaped.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
      } catch(e) { return escaped; }
    }

    function msScoreClass(score) {
      if (score >= 0.025) return 'ms-score-high';
      if (score >= 0.015) return 'ms-score-medium';
      return 'ms-score-low';
    }

    function msScorePercent(score) {
      return Math.min(Math.round(score / 0.033 * 100), 100);
    }

    async function msDoSearch() {
      var query = document.getElementById('msSearchInput').value.trim();
      if (!query) return;

      var btn = document.getElementById('msSearchBtn');
      var resultsEl = document.getElementById('msResults');
      var countEl = document.getElementById('msResultCount');
      var timingEl = document.getElementById('msSearchTiming');

      btn.disabled = true;
      btn.textContent = 'Searching...';
      resultsEl.innerHTML = '<div class="ms-empty">Generating embedding & searching...</div>';
      countEl.textContent = '';
      timingEl.textContent = '';

      var startTime = performance.now();

      try {
        var params = new URLSearchParams();
        params.set('q', query);
        params.set('mode', msSearchMode);
        params.set('limit', document.getElementById('msFilterLimit').value);
        var bot = document.getElementById('msFilterBot').value;
        if (bot) params.set('bot', bot);
        var scope = document.getElementById('msFilterScope').value;
        if (scope) params.set('scope', scope);

        var res = await fetch('/api/memsearch?' + params);
        var data = await res.json();
        msSearchResults = data.results || [];

        var elapsed = Math.round(performance.now() - startTime);
        timingEl.textContent = elapsed + 'ms';

        if (msSearchResults.length === 0) {
          countEl.textContent = '';
          resultsEl.innerHTML = '<div class="ms-empty">No results found for "' + esc(query) + '"</div>';
          return;
        }

        countEl.textContent = msSearchResults.length + ' result' + (msSearchResults.length !== 1 ? 's' : '');
        msRenderResults(msSearchResults, query);
      } catch (err) {
        resultsEl.innerHTML = '<div class="ms-empty">Search failed: ' + esc(err.message) + '</div>';
        countEl.textContent = '';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Search';
      }
    }

    function msRenderResults(results, query) {
      var el = document.getElementById('msResults');
      el.innerHTML = results.map(function(r, i) {
        var score = r.similarity || 0;
        var pct = msScorePercent(score);
        var cls = msScoreClass(score);
        var scopeBadge = r.scope === 'shared'
          ? '<span class="ms-badge ms-badge-scope-shared">shared</span>'
          : '<span class="ms-badge ms-badge-scope-personal">personal</span>';
        var tags = (r.tags || []).map(function(t) { return '<span class="ms-badge ms-badge-tag">' + esc(t) + '</span>'; }).join('');

        return '<div class="ms-result-card" onclick="this.classList.toggle(\\'expanded\\')">'
          + '<div class="ms-result-header">'
            + '<span class="ms-result-score">' + score.toFixed(4) + '</span>'
            + '<div class="ms-result-score-bar"><div class="ms-result-score-fill ' + cls + '" style="width:' + pct + '%"></div></div>'
            + '<div class="ms-result-meta">'
              + (r.botName ? '<span class="ms-badge ms-badge-bot">' + esc(r.botName) + '</span>' : '')
              + '<span class="ms-badge ms-badge-user">' + esc(r.username || r.userId) + '</span>'
              + scopeBadge
            + '</div>'
          + '</div>'
          + '<div class="ms-result-summary">' + msHighlightQuery(r.summary, query) + '</div>'
          + '<div class="ms-result-content"><pre>' + msHighlightQuery(r.content, query) + '</pre></div>'
          + '<div class="ms-result-footer">'
            + tags
            + '<span class="ms-result-date">' + msFmtDate(r.createdAt) + '</span>'
          + '</div>'
        + '</div>';
      }).join('');
    }

    function msInit() {
      if (msInitialized) return;
      msInitialized = true;

      // Load stats
      fetch('/api/memsearch-stats').then(function(r) { return r.json(); }).then(function(stats) {
        document.getElementById('msStatTotal').textContent = stats.totalMemories;
        document.getElementById('msStatEmbedded').textContent = stats.withEmbeddings;
        document.getElementById('msStatUsers').textContent = stats.uniqueUsers;
        document.getElementById('msStatTags').textContent = stats.uniqueTags;
      }).catch(function() {});

      // Load bot filter
      fetch('/api/trace-filters').then(function(r) {
        if (!r.ok) return { bots: [] };
        return r.json();
      }).then(function(data) {
        var select = document.getElementById('msFilterBot');
        (data.bots || []).forEach(function(b) {
          var opt = document.createElement('option');
          opt.value = b;
          opt.textContent = b;
          select.appendChild(opt);
        });
      }).catch(function() {});

      // Enter key triggers search
      document.getElementById('msSearchInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') msDoSearch();
      });
    }

    // Lazy init: load stats/filters when tab is first activated
    onSectionActivate('memsearch', function() {
      msInit();
    });
  `;
}
