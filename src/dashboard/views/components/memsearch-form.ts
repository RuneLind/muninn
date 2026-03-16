/** MemSearch form — search input, filter dropdowns, and mode pills */

export function memsearchFormStyles(): string {
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

    .mode-pills {
      display: flex;
      gap: 0;
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      overflow: hidden;
    }
    .mode-pill {
      background: var(--bg-surface);
      color: var(--text-muted);
      border: none;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      border-right: 1px solid var(--border-secondary);
    }
    .mode-pill:last-child { border-right: none; }
    .mode-pill:hover { color: var(--accent-light); }
    .mode-pill.active {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent);
    }

    .search-timing {
      margin-left: auto;
      color: var(--text-faint);
      font-size: 12px;
    }
  `;
}

export function memsearchFormHtml(): string {
  return `
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
  </div>`;
}

export function memsearchFormScript(): string {
  return `
    let searchMode = 'hybrid';

    function setMode(mode) {
      searchMode = mode;
      document.querySelectorAll('.mode-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.mode === mode);
      });
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

    // Enter key triggers search
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });
  `;
}
