/** Search page — search input, filters, and search execution logic */

export function searchFormStyles(): string {
  return `
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
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus { border-color: var(--accent); }
    .search-input::placeholder { color: var(--text-faint); }
    .search-btn {
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
    .search-btn:hover { background: var(--accent-hover); }
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
      color: var(--text-dim);
      font-size: 12px;
    }
    .filters select {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .filters select:focus { outline: none; border-color: var(--accent); }

    .search-timing {
      margin-left: auto;
      color: var(--text-faint);
      font-size: 12px;
    }
  `;
}

export function searchFormHtml(): string {
  return `
  <div class="search-area">
    <div class="search-input-row">
      <input type="text" class="search-input" id="searchInput" placeholder="Search knowledge base... (vector similarity)" autofocus>
      <button class="search-btn" id="searchBtn" onclick="doSearch()">Search</button>
    </div>
  </div>

  <div class="filters">
    <div class="filter-group">
      <span class="filter-label">Collection:</span>
      <select id="filterCollection">
        <option value="">All collections</option>
      </select>
    </div>
    <div class="filter-group">
      <span class="filter-label">Results:</span>
      <select id="filterLimit">
        <option value="10" selected>10</option>
        <option value="25">25</option>
        <option value="50">50</option>
      </select>
    </div>
    <span class="search-timing" id="searchTiming"></span>
  </div>`;
}

export function searchFormScript(): string {
  return `
    let apiAvailable = false;

    async function checkApiHealth() {
      try {
        const res = await fetch('/api/search/health');
        if (!res.ok) throw new Error('not ok');
        apiAvailable = true;
        document.getElementById('errorBanner').classList.remove('visible');
        document.getElementById('searchBtn').disabled = false;
        return true;
      } catch {
        apiAvailable = false;
        document.getElementById('errorBanner').classList.add('visible');
        document.getElementById('searchBtn').disabled = true;
        return false;
      }
    }

    async function doSearch() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query || !apiAvailable) return;

      const btn = document.getElementById('searchBtn');
      const resultsEl = document.getElementById('results');
      const countEl = document.getElementById('resultCount');
      const timingEl = document.getElementById('searchTiming');

      btn.disabled = true;
      btn.textContent = 'Searching...';
      resultsEl.innerHTML = '<div class="loading"><span class="spinner"></span>Searching knowledge base...</div>';
      countEl.textContent = '';
      timingEl.textContent = '';

      const startTime = performance.now();

      try {
        const params = new URLSearchParams();
        params.set('q', query);
        params.set('limit', document.getElementById('filterLimit').value);
        const collection = document.getElementById('filterCollection').value;
        if (collection) params.append('collection', collection);

        const res = await fetch('/api/search/search?' + params);
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Search failed');
        }

        searchResults = data.results || [];

        const elapsed = Math.round(performance.now() - startTime);
        timingEl.textContent = elapsed + 'ms';

        if (searchResults.length === 0) {
          countEl.textContent = '';
          resultsEl.innerHTML = '<div class="empty">No results found for "' + esc(query) + '"<div class="empty-hint">Try different keywords or a different collection</div></div>';
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

    // Enter key triggers search
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });
  `;
}
