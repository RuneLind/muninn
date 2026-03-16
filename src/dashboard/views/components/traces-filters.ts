/** Traces filters — type dropdown, auto-refresh toggle, and pagination controls */
export function tracesFiltersStyles(): string {
  return `
    /* Filters */
    .filters {
      padding: 8px 24px;
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .filters select, .filters input {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .filters select:focus, .filters input:focus { outline: none; border-color: var(--accent); }
    .filters button {
      background: var(--accent);
      color: var(--text-primary);
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .filters button:hover { background: var(--accent-hover); }

    /* Pagination */
    .pagination {
      display: flex;
      justify-content: center;
      gap: 8px;
      padding: 16px;
    }
    .pagination button {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .pagination button:hover { border-color: var(--accent); }
    .pagination button:disabled { opacity: 0.3; cursor: default; }
    .pagination span { color: var(--text-dim); font-size: 13px; line-height: 32px; }
  `;
}

export function tracesFiltersHtml(): string {
  return `
  <div class="filters">
    <select id="filterName" onchange="currentPage=0;loadTraces();loadStats()">
      <option value="">All types</option>
    </select>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);margin-left:auto">
      <input type="checkbox" id="autoRefresh" checked> Auto-refresh (15s)
    </label>
  </div>`;
}

export function tracesPaginationHtml(): string {
  return `
    <div class="pagination">
      <button id="prevBtn" onclick="prevPage()" disabled>&laquo; Prev</button>
      <span id="pageInfo">Page 1</span>
      <button id="nextBtn" onclick="nextPage()">Next &raquo;</button>
    </div>`;
}

export function tracesFiltersScript(): string {
  return `
    let currentPage = 0;
    const PAGE_SIZE = 50;
    let refreshTimer = null;

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
  `;
}
