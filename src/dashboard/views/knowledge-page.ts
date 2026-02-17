import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";

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
      background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      padding: 16px;
    }
    .stat-value { color: #fff; font-weight: 700; font-size: 24px; }
    .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

    /* Error Banner */
    .error-banner {
      display: none;
      margin: 0 24px 12px;
      padding: 12px 16px;
      background: rgba(248, 113, 113, 0.1);
      border: 1px solid rgba(248, 113, 113, 0.3);
      border-radius: 8px;
      color: #f87171;
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
    .badge-collection { background: rgba(34, 211, 238, 0.15); color: #22d3ee; }

    .result-title {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .result-title a {
      color: #e0e0e0;
      text-decoration: none;
    }
    .result-title a:hover {
      color: #a5a0ff;
      text-decoration: underline;
    }

    .result-summary {
      color: #999;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .result-summary mark {
      background: rgba(108, 99, 255, 0.3);
      color: #e0e0e0;
      padding: 0 2px;
      border-radius: 2px;
    }

    /* Expandable chunks */
    .result-chunks-toggle {
      color: #6c63ff;
      font-size: 12px;
      cursor: pointer;
      border: none;
      background: none;
      padding: 4px 0;
    }
    .result-chunks-toggle:hover { color: #a5a0ff; }

    .result-chunks {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s;
    }
    .result-card.expanded .result-chunks {
      max-height: 2000px;
    }

    .chunk-card {
      background: #0a0a0f;
      border: 1px solid #1a1a2e;
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
      color: #a5a0ff;
      font-size: 11px;
      font-weight: 600;
    }
    .chunk-score-bar {
      width: 40px;
      height: 3px;
      background: #1e1e2e;
      border-radius: 2px;
      overflow: hidden;
    }
    .chunk-score-fill {
      height: 100%;
      border-radius: 2px;
    }
    .chunk-heading {
      background: rgba(108, 99, 255, 0.1);
      color: #8b83ff;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    .chunk-label {
      color: #555;
      font-size: 11px;
      margin-left: auto;
    }
    .chunk-content {
      color: #aaa;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .chunk-content mark {
      background: rgba(108, 99, 255, 0.3);
      color: #e0e0e0;
      padding: 0 2px;
      border-radius: 2px;
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
  </style>
</head>
<body>
  ${renderNav("knowledge")}

  <div class="error-banner" id="errorBanner">
    Knowledge API at <code>localhost:8321</code> is unreachable. Start it with:
    <code>cd ../documents-vector-search && uv run knowledge_api_server.py</code>
  </div>

  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statCollections">-</div><div class="stat-label">Collections</div></div>
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

    async function loadCollections() {
      try {
        const res = await fetch('/api/knowledge/collections');
        if (!res.ok) return;
        const data = await res.json();
        const collections = data.collections || [];

        // Populate stats
        let totalDocs = 0, totalChunks = 0, totalEmbeddings = 0;
        collections.forEach(c => {
          totalDocs += c.document_count || 0;
          totalChunks += c.chunk_count || 0;
          totalEmbeddings += c.embedding_count || 0;
        });
        document.getElementById('statCollections').textContent = collections.length;
        document.getElementById('statDocuments').textContent = totalDocs;
        document.getElementById('statChunks').textContent = totalChunks;
        document.getElementById('statEmbeddings').textContent = totalEmbeddings;

        // Populate dropdown
        const select = document.getElementById('filterCollection');
        collections.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name + ' (' + (c.document_count || 0) + ' docs)';
          select.appendChild(opt);
        });
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
      // L2 distance: lower = better. Find min/max for relative bar width.
      const scores = results.map(r => {
        const chunks = r.matchedChunks || [];
        return chunks.length > 0 ? chunks[0].score : Infinity;
      }).filter(s => s !== Infinity);

      const minScore = Math.min(...scores);
      const maxScore = Math.max(...scores);
      const scoreRange = maxScore - minScore || 1;

      const el = document.getElementById('results');
      el.innerHTML = results.map((r, i) => {
        const chunks = r.matchedChunks || [];
        const bestScore = chunks.length > 0 ? chunks[0].score : null;

        // Relative bar: best (lowest L2) = 100%, worst = proportional
        // Invert so lower distance = higher bar
        let barPct = 0;
        let barClass = 'score-low';
        if (bestScore !== null && scores.length > 1) {
          barPct = Math.round((1 - (bestScore - minScore) / scoreRange) * 100);
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
        const titleHtml = safeUrl
          ? '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener">' + esc(r.title || 'Untitled') + '</a>'
          : esc(r.title || 'Untitled');

        const chunksHtml = chunks.map((c, ci) => {
          let chunkBarPct = 0;
          if (scores.length > 1) {
            chunkBarPct = Math.round((1 - (c.score - minScore) / scoreRange) * 100);
          } else {
            chunkBarPct = 100;
          }
          const chunkBarClass = chunkBarPct >= 70 ? 'score-high' : chunkBarPct >= 40 ? 'score-medium' : 'score-low';
          const headingBadge = c.heading
            ? '<span class="chunk-heading" title="' + esc(c.heading) + '">' + esc(c.heading) + '</span>'
            : '';
          return '<div class="chunk-card">' +
            '<div class="chunk-header">' +
              '<span class="chunk-score">' + c.score.toFixed(4) + '</span>' +
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
              ? '<span class="result-score">' + bestScore.toFixed(4) + '</span>' +
                '<div class="result-score-bar"><div class="result-score-fill ' + barClass + '" style="width:' + barPct + '%"></div></div>'
              : '') +
            '<div class="result-meta">' +
              '<span class="badge badge-collection">' + esc(r.collection) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="result-title">' + titleHtml + '</div>' +
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
