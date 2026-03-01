import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";
import { docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";

export function renderKnowledgePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Knowledge Search</title>
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
      background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-gradient-end) 100%);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
    }
    .stat-value { color: var(--text-primary); font-weight: 700; font-size: 24px; transition: font-size 0.2s; }
    .stat-value.text-value { font-size: 18px; }
    .stat-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

    /* Error Banner */
    .error-banner {
      display: none;
      margin: 0 24px 12px;
      padding: 12px 16px;
      background: color-mix(in srgb, var(--status-error) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
      border-radius: 8px;
      color: var(--status-error);
      font-size: 13px;
    }
    .error-banner.visible { display: block; }

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
      transition: all 0.2s;
    }
    .result-card:hover {
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      background: color-mix(in srgb, var(--bg-panel) 50%, var(--bg-gradient-end));
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
    .badge-collection { background: color-mix(in srgb, var(--status-cyan) 15%, transparent); color: var(--status-cyan); }

    .result-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }
    .result-links {
      display: flex;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .result-links a {
      color: var(--accent);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .result-links a:hover {
      color: var(--accent-light);
      text-decoration: underline;
    }
    .result-links .link-icon {
      font-size: 11px;
      opacity: 0.7;
    }

    .result-summary {
      color: var(--text-soft);
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .result-summary mark {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--text-secondary);
      padding: 0 2px;
      border-radius: 2px;
    }

    /* Expandable chunks */
    .result-chunks-toggle {
      color: var(--accent);
      font-size: 12px;
      cursor: pointer;
      border: none;
      background: none;
      padding: 4px 0;
    }
    .result-chunks-toggle:hover { color: var(--accent-light); }

    .result-chunks {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s;
    }
    .result-card.expanded .result-chunks {
      max-height: 2000px;
    }

    .chunk-card {
      background: var(--bg-page);
      border: 1px solid var(--bg-surface);
      border-radius: 6px;
      padding: 10px 12px;
      margin-top: 8px;
    }
    .chunk-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .chunk-score {
      color: var(--accent-light);
      font-size: 11px;
      font-weight: 600;
    }
    .chunk-score-bar {
      width: 40px;
      height: 3px;
      background: var(--border-primary);
      border-radius: 2px;
      overflow: hidden;
    }
    .chunk-score-fill {
      height: 100%;
      border-radius: 2px;
    }
    .chunk-heading {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: color-mix(in srgb, var(--accent) 50%, var(--accent-light));
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    .chunk-label {
      color: var(--text-faint);
      font-size: 11px;
      margin-left: auto;
    }
    .chunk-content {
      color: var(--text-soft);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .chunk-content mark {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--text-secondary);
      padding: 0 2px;
      border-radius: 2px;
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

    ${docPanelStyles()}
  </style>
</head>
<body>
  ${renderNav("knowledge")}

  <div class="error-banner" id="errorBanner">
    Knowledge API at <code>localhost:8321</code> is unreachable. Start it with:
    <code>cd ../documents-vector-search && uv run knowledge_api_server.py</code>
  </div>

  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statCollections">-</div><div class="stat-label" id="statCollectionsLabel">Collections</div></div>
    <div class="stat-card"><div class="stat-value" id="statDocuments">-</div><div class="stat-label">Documents</div></div>
    <div class="stat-card"><div class="stat-value" id="statChunks">-</div><div class="stat-label">Chunks</div></div>
    <div class="stat-card"><div class="stat-value" id="statEmbeddings">-</div><div class="stat-label">Embeddings</div></div>
  </div>

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
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}

  <div class="content">
    <div id="resultCount" class="result-count"></div>
    <div id="results" class="results-list">
      <div class="empty">
        <div class="empty-icon">&#x1F4DA;</div>
        Search company knowledge using vector similarity
        <div class="empty-hint">Try: "onboarding process", "AWS best practices", "team structure"</div>
      </div>
    </div>
  </div>

  <script>
    let searchResults = [];
    let allCollections = [];
    let apiAvailable = false;

    ${escScript()}

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

    function truncate(text, maxLen) {
      if (!text) return '';
      if (text.length <= maxLen) return text;
      return text.slice(0, maxLen).trimEnd() + '...';
    }

    function headingSuffix(headings) {
      if (!headings || headings.length === 0) return '';
      const shown = headings.slice(0, 3);
      return ' (' + shown.join(', ') + (headings.length > 3 ? ', ...' : '') + ')';
    }

    function stripBreadcrumb(text) {
      if (!text) return '';
      const lines = text.split('\\n');
      if (lines[0].startsWith('[') && lines[0].includes(']')) {
        return lines.slice(1).join('\\n').replace(/^\\n+/, '');
      }
      return text;
    }

    async function checkApiHealth() {
      try {
        const res = await fetch('/api/knowledge/health');
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

    function updateStats(selectedName) {
      const colLabel = document.getElementById('statCollectionsLabel');
      const colValue = document.getElementById('statCollections');
      if (!selectedName) {
        // All collections — show totals
        let totalDocs = 0, totalChunks = 0, totalEmbeddings = 0;
        allCollections.forEach(c => {
          totalDocs += c.document_count || 0;
          totalChunks += c.chunk_count || 0;
          totalEmbeddings += c.embedding_count || 0;
        });
        colLabel.textContent = 'Collections';
        colValue.textContent = allCollections.length;
        colValue.title = '';
        colValue.classList.remove('text-value');
        document.getElementById('statDocuments').textContent = totalDocs.toLocaleString();
        document.getElementById('statChunks').textContent = totalChunks.toLocaleString();
        document.getElementById('statEmbeddings').textContent = totalEmbeddings.toLocaleString();
      } else {
        const c = allCollections.find(x => x.name === selectedName);
        if (!c) return;
        // Show updated time in place of collection count
        if (c.updatedTime) {
          const d = new Date(c.updatedTime);
          const relative = formatRelativeTime(d);
          colLabel.textContent = 'Updated';
          colValue.textContent = relative;
          colValue.title = d.toLocaleString();
          colValue.classList.add('text-value');
        } else {
          colLabel.textContent = 'Collection';
          colValue.textContent = '1';
          colValue.title = '';
          colValue.classList.remove('text-value');
        }
        document.getElementById('statDocuments').textContent = (c.document_count || 0).toLocaleString();
        document.getElementById('statChunks').textContent = (c.chunk_count || 0).toLocaleString();
        document.getElementById('statEmbeddings').textContent = (c.embedding_count || 0).toLocaleString();
      }
    }

    function formatRelativeTime(date) {
      const now = new Date();
      const diffMs = now - date;
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return diffMin + 'm ago';
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return diffHrs + 'h ago';
      const diffDays = Math.floor(diffHrs / 24);
      if (diffDays < 30) return diffDays + 'd ago';
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    async function loadCollections() {
      try {
        const res = await fetch('/api/knowledge/collections');
        if (!res.ok) return;
        const data = await res.json();
        allCollections = data.collections || [];

        updateStats('');

        // Populate dropdown
        const select = document.getElementById('filterCollection');
        allCollections.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name + ' (' + (c.document_count || 0) + ' docs)';
          select.appendChild(opt);
        });

        // Update stats when collection changes
        select.addEventListener('change', () => updateStats(select.value));
      } catch (e) {
        console.error('Failed to load collections', e);
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

        const res = await fetch('/api/knowledge/search?' + params);
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

    function renderChunksToggle(chunks, chunksHtml) {
      const uniqueHeadings = [...new Set(chunks.map(c => c.heading).filter(Boolean))];
      const suffix = headingSuffix(uniqueHeadings.map(h => esc(h)));
      const toggleLabel = chunks.length + ' chunk' + (chunks.length !== 1 ? 's' : '') + ' matched' + suffix;
      return '<button class="result-chunks-toggle" onclick="toggleChunks(this)" data-headings="' + esc(JSON.stringify(uniqueHeadings)) + '">' +
        toggleLabel + ' — click to expand</button>' +
        '<div class="result-chunks">' + chunksHtml + '</div>';
    }

    function renderResults(results, query) {
      // Relevance: 0-1 scale, higher = better. Find min/max for relative bar width.
      const scores = results.map(r => r.relevance).filter(s => s != null);

      const minScore = Math.min(...scores);
      const maxScore = Math.max(...scores);
      const scoreRange = maxScore - minScore || 1;

      const el = document.getElementById('results');
      el.innerHTML = results.map((r, i) => {
        const chunks = r.matchedChunks || [];
        const bestScore = r.relevance != null ? r.relevance : null;

        // Relative bar: higher relevance = wider bar
        let barPct = 0;
        let barClass = 'score-low';
        if (bestScore !== null && scores.length > 1) {
          barPct = Math.round(((bestScore - minScore) / scoreRange) * 100);
          barClass = barPct >= 70 ? 'score-high' : barPct >= 40 ? 'score-medium' : 'score-low';
        } else if (bestScore !== null) {
          barPct = 100;
          barClass = 'score-high';
        }

        let bestChunkPreview = '';
        if (chunks.length > 0) {
          const stripped = stripBreadcrumb(chunks[0].content);
          const preview = truncate(stripped, 200);
          bestChunkPreview = chunks[0].heading
            ? '<strong>' + esc(chunks[0].heading) + ':</strong> ' + highlightQuery(preview, query)
            : highlightQuery(preview, query);
        }
        const safeUrl = r.url && /^https?:\\/\\//i.test(r.url) ? r.url : '';
        const docId = r.id || '';
        const linksHtml = '<div class="result-links">' +
          (safeUrl ? '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener"><span class="link-icon">&#x1F310;</span> Web</a>' : '') +
          (docId ? '<a href="#" class="index-link" data-collection="' + esc(r.collection) + '" data-docid="' + esc(docId) + '" data-url="' + esc(safeUrl) + '"><span class="link-icon">&#x1F4C4;</span> Index</a>' : '') +
        '</div>';

        const chunksHtml = chunks.map((c, ci) => {
          let chunkBarPct = 0;
          if (scores.length > 1) {
            chunkBarPct = Math.round(((c.relevance - minScore) / scoreRange) * 100);
          } else {
            chunkBarPct = 100;
          }
          const chunkBarClass = chunkBarPct >= 70 ? 'score-high' : chunkBarPct >= 40 ? 'score-medium' : 'score-low';
          const headingBadge = c.heading
            ? '<span class="chunk-heading" title="' + esc(c.heading) + '">' + esc(c.heading) + '</span>'
            : '';
          return '<div class="chunk-card">' +
            '<div class="chunk-header">' +
              '<span class="chunk-score">' + (c.relevance != null ? c.relevance.toFixed(3) : '—') + '</span>' +
              '<div class="chunk-score-bar"><div class="chunk-score-fill ' + chunkBarClass + '" style="width:' + chunkBarPct + '%"></div></div>' +
              headingBadge +
              '<span class="chunk-label">chunk ' + (ci + 1) + '</span>' +
            '</div>' +
            '<div class="chunk-content">' + highlightQuery(stripBreadcrumb(c.content), query) + '</div>' +
          '</div>';
        }).join('');

        return '<div class="result-card" data-index="' + i + '">' +
          '<div class="result-header">' +
            (bestScore !== null
              ? '<span class="result-score">' + bestScore.toFixed(3) + '</span>' +
                '<div class="result-score-bar"><div class="result-score-fill ' + barClass + '" style="width:' + barPct + '%"></div></div>'
              : '') +
            '<div class="result-meta">' +
              '<span class="badge badge-collection">' + esc(r.collection) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="result-title">' + esc(r.title || 'Untitled') + '</div>' +
          linksHtml +
          '<div class="result-summary">' + bestChunkPreview + '</div>' +
          (chunks.length > 0
            ? renderChunksToggle(chunks, chunksHtml)
            : '') +
        '</div>';
      }).join('');
    }

    function toggleChunks(btn) {
      const card = btn.closest('.result-card');
      const expanded = card.classList.toggle('expanded');
      const count = card.querySelectorAll('.chunk-card').length;
      let suffix = '';
      try {
        suffix = headingSuffix(JSON.parse(btn.dataset.headings || '[]'));
      } catch {}
      btn.textContent = expanded
        ? count + ' chunks' + suffix + ' — click to collapse'
        : count + ' chunk' + (count !== 1 ? 's' : '') + ' matched' + suffix + ' — click to expand';
    }

    ${docPanelScript()}

    // Delegated click handler for index links
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.index-link');
      if (link) {
        e.preventDefault();
        openDocPanel(link.dataset.collection, link.dataset.docid, link.dataset.url);
      }
    });

    // Enter key triggers search
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Init
    checkApiHealth().then(ok => {
      if (ok) loadCollections();
    });
  </script>
</body>
</html>`;
}
