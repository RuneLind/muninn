/** MemSearch results — result cards, scoring, search execution, and rendering */

export function memsearchResultsStyles(): string {
  return `
    /* Results */
    .content { padding: 0 24px 24px; }

    .result-count {
      color: var(--text-dim);
      font-size: 13px;
      padding: 12px 0 8px;
    }

    .results-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .result-card {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .result-card:hover {
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      background: var(--bg-gradient-end);
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
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
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
      background: var(--border-primary);
      border-radius: 2px;
      overflow: hidden;
    }
    .result-score-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s;
    }
    .score-high { background: var(--status-success); }
    .score-medium { background: var(--status-warning); }
    .score-low { background: var(--status-error); }

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
    .badge-bot { background: color-mix(in srgb, var(--status-warning) 15%, transparent); color: var(--status-warning); }
    .badge-user { background: color-mix(in srgb, var(--status-info) 15%, transparent); color: var(--status-info); }
    .badge-scope-personal { background: color-mix(in srgb, var(--status-magenta) 15%, transparent); color: var(--status-magenta); }
    .badge-scope-shared { background: color-mix(in srgb, var(--status-cyan) 15%, transparent); color: var(--status-cyan); }
    .badge-tag { background: color-mix(in srgb, white 6%, transparent); color: var(--text-muted); }

    .result-summary {
      color: var(--text-tertiary);
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .result-summary mark {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--text-secondary);
      padding: 0 2px;
      border-radius: 2px;
    }

    .result-content {
      color: var(--text-muted);
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
      background: var(--bg-page);
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
      color: var(--text-faint);
      font-size: 11px;
      margin-left: auto;
    }

    .empty {
      color: var(--text-faint);
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
      color: var(--text-disabled);
      font-size: 12px;
      margin-top: 8px;
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: var(--text-dim);
    }
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-secondary);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
}

export function memsearchResultsHtml(): string {
  return `
  <div class="content">
    <div id="resultCount" class="result-count"></div>
    <div id="results" class="results-list">
      <div class="empty">
        <div class="empty-icon">&#x1F50D;</div>
        Search across all memories using semantic similarity and keyword matching
        <div class="empty-hint">Try: "user preferences", "calendar events", "project deadlines"</div>
      </div>
    </div>
  </div>`;
}

export function memsearchResultsScript(): string {
  return `
    let searchResults = [];

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

        const res = await fetch('/api/memsearch?' + params);
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
  `;
}
