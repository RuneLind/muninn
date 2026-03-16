/** Search page — result list with score bars, chunk expansion, and empty states */

export function searchResultsStyles(): string {
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
  `;
}

export function searchResultsHtml(): string {
  return `
  <div class="content">
    <div id="resultCount" class="result-count"></div>
    <div id="results" class="results-list">
      <div class="empty">
        <div class="empty-icon">&#x1F4DA;</div>
        Search company knowledge using vector similarity
        <div class="empty-hint">Try: "onboarding process", "AWS best practices", "team structure"</div>
      </div>
    </div>
  </div>`;
}

export function searchResultsScript(): string {
  return `
    let searchResults = [];

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
  `;
}
