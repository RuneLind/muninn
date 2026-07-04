/** Summaries page — active job card with status badge, summary area, SSE
 * streaming, and similar articles. Source-aware: streaming + similar calls are
 * routed to the active job's source (SOURCES[source].apiBase). */

import { markdownContentStyles } from "./doc-panel.ts";

export function sumJobCardStyles(): string {
  return `
    /* --- Job card --- */
    .job-card {
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .job-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-primary);
    }
    .job-title {
      flex: 1;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .job-title a { color: var(--text-primary); text-decoration: none; }
    .job-title a:hover { color: var(--accent-light); }

    /* --- Status badge --- */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-pending { background: color-mix(in srgb, var(--text-dim) 20%, transparent); color: var(--text-dim); }
    .status-fetching_transcript, .status-downloading, .status-transcribing { background: color-mix(in srgb, var(--status-info) 20%, transparent); color: var(--status-info); }
    .status-summarizing, .status-extracting_frames { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent-light); }
    .status-ingesting { background: color-mix(in srgb, var(--status-warning) 20%, transparent); color: var(--status-warning); }
    .status-complete { background: color-mix(in srgb, var(--status-success) 20%, transparent); color: var(--status-success); }
    .status-error { background: color-mix(in srgb, var(--status-error) 20%, transparent); color: var(--status-error); }

    .status-badge .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* --- Category badge --- */
    .category-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }

    /* --- Summary area --- */
    .summary-area {
      padding: 20px;
      min-height: 120px;
      color: var(--text-secondary);
      line-height: 1.7;
      font-size: 15px;
    }
    .summary-area.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-dim);
      font-style: italic;
    }
    ${markdownContentStyles(".summary-area")}
    .summary-cursor {
      display: inline-block;
      width: 2px;
      height: 1em;
      background: var(--accent);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* --- Similar articles --- */
    .similar-panel {
      border-top: 1px solid var(--border-primary);
      padding: 16px 20px;
      display: none;
    }
    .similar-panel.visible { display: block; }
    .similar-panel h3 {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 10px;
    }
    .similar-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .similar-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--bg-surface);
      font-size: 13px;
    }
    .similar-item-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .similar-item-header a {
      color: var(--accent-light);
      text-decoration: none;
      font-weight: 500;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .similar-item-header a:hover { text-decoration: underline; }
    .similar-relevance {
      font-size: 11px;
      color: var(--text-dim);
      font-weight: 600;
      flex-shrink: 0;
    }
    .similar-snippet {
      font-size: 12px;
      color: var(--text-dim);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .similar-view-md {
      font-size: 12px;
      color: var(--accent-light);
      text-decoration: none;
      cursor: pointer;
      opacity: 0.7;
    }
    .similar-view-md:hover { opacity: 1; text-decoration: underline; }
  `;
}

export function sumJobCardHtml(): string {
  return `
    <div class="job-card" id="jobCard" style="display:none">
      <div class="job-header">
        <span class="job-title" id="jobTitle"></span>
        <span class="category-badge" id="categoryBadge" style="display:none"></span>
        <span class="status-badge status-pending" id="statusBadge">
          <span class="spinner"></span>
          <span class="status-text">Pending</span>
        </span>
      </div>
      <div class="summary-area empty" id="summaryArea">
        Waiting for summary...
      </div>
      <div class="error-banner" id="errorBanner" style="margin:0;border-radius:0;border-top:1px solid color-mix(in srgb, var(--status-error) 30%, transparent);"></div>
      <div class="similar-panel" id="similarPanel">
        <h3>Similar</h3>
        <div class="similar-list" id="similarList"></div>
      </div>
    </div>`;
}

export function sumJobCardScript(): string {
  return `
    var accumulatedText = '';
    var currentJobId = null;
    var currentJobTitle = null;
    var currentSource = 'youtube';
    var eventSource = null;

    var STATUS_LABELS = {
      pending: 'Pending',
      fetching_transcript: 'Fetching transcript',
      downloading: 'Downloading',
      transcribing: 'Transcribing',
      extracting_frames: 'Extracting frames',
      summarizing: 'Summarizing',
      ingesting: 'Indexing',
      complete: 'Complete',
      error: 'Error'
    };

    var TERMINAL_STATES = ['complete', 'error'];

    // Per-source API prefix (from the SOURCES registry injected by the page).
    function sourceApiBase(source) {
      var s = SOURCES[source || currentSource];
      return s ? s.apiBase : '/api/youtube';
    }

    function renderMarkdown(text) {
      if (typeof marked === 'undefined') return '<pre>' + esc(text) + '</pre>';
      if (typeof marked.use === 'function' && !marked.__sanitized) {
        marked.use({ renderer: { html: function(token) { return esc(token.raw || token.text || ''); } } });
        marked.__sanitized = true;
      }
      return marked.parse(text);
    }

    function updateStatusBadge(status) {
      var badge = document.getElementById('statusBadge');
      badge.className = 'status-badge status-' + status;
      var isActive = !TERMINAL_STATES.includes(status);
      badge.innerHTML = (isActive ? '<span class="spinner"></span>' : '') +
        '<span class="status-text">' + esc(STATUS_LABELS[status] || status) + '</span>';
    }

    function showCategory(category) {
      var badge = document.getElementById('categoryBadge');
      badge.textContent = category;
      badge.style.display = 'inline-block';
    }

    function cleanSnippet(text) {
      if (!text) return '';
      // Strip [collection > path > title] prefix and tags: line
      return text.replace(/^\\[.*?\\]\\s*/, '').replace(/^tags:.*\\n?/m, '').trim();
    }

    function renderSimilar(articles) {
      if (!articles || articles.length === 0) return;
      var panel = document.getElementById('similarPanel');
      var list = document.getElementById('similarList');
      var source = currentSource;
      list.innerHTML = articles.map(function(a) {
        // Search API returns matchedChunks, ingest returns snippet
        var rawSnippet = a.snippet || (a.matchedChunks && a.matchedChunks[0] ? a.matchedChunks[0].content : '');
        var snippet = cleanSnippet(rawSnippet);
        var pct = typeof a.relevance === 'number' ? Math.round(a.relevance * 100) : null;
        var hasDocId = !!a.id;
        var displayTitle = (a.title || '').replace(/\\.md$/, '');
        return '<div class="similar-item">' +
          '<div class="similar-item-header">' +
            '<a href="' + esc(a.url || '#') + '" target="_blank" rel="noopener">' + esc(displayTitle) + '</a>' +
            (pct !== null ? '<span class="similar-relevance">' + pct + '%</span>' : '') +
          '</div>' +
          (snippet ? '<div class="similar-snippet">' + esc(snippet) + '</div>' : '') +
          (hasDocId ? '<a class="similar-view-md" href="#" data-doc-id="' + esc(a.id) + '" data-doc-url="' + esc(a.url || '') + '">View article</a>' : '') +
        '</div>';
      }).join('');
      panel.classList.add('visible');
      // Wire up view-md links — similar results live in the job's own source collection.
      list.querySelectorAll('.similar-view-md').forEach(function(link) {
        link.addEventListener('click', function(e) {
          e.preventDefault();
          openSummaryDoc(link.getAttribute('data-doc-id'), link.getAttribute('data-doc-url'), source);
        });
      });
    }

    async function loadJobSimilar(title) {
      if (!title) return;
      try {
        var res = await fetch(sourceApiBase() + '/similar?q=' + encodeURIComponent(title));
        if (!res.ok) return;
        var data = await res.json();
        var normalizedTitle = title.toLowerCase().trim();
        var results = (data.results || []).filter(function(r) {
          var rTitle = (r.title || '').replace(/\\.md$/, '').toLowerCase().trim();
          return rTitle !== normalizedTitle;
        }).slice(0, 5);
        if (results.length > 0) {
          renderSimilar(results);
        }
      } catch {}
    }

    function showError(message) {
      var banner = document.getElementById('errorBanner');
      banner.textContent = message;
      banner.classList.add('visible');
    }

    function updateSummaryArea() {
      var area = document.getElementById('summaryArea');
      if (!accumulatedText) {
        area.className = 'summary-area empty';
        area.textContent = 'Waiting for summary...';
        return;
      }
      area.className = 'summary-area';
      area.innerHTML = renderMarkdown(accumulatedText) + '<span class="summary-cursor"></span>';
    }

    function finalizeSummary() {
      var area = document.getElementById('summaryArea');
      if (accumulatedText) {
        area.innerHTML = renderMarkdown(accumulatedText);
      }
    }

    function connectSSE(jobId, source) {
      if (eventSource) eventSource.close();
      currentJobId = jobId;
      if (source) currentSource = source;

      eventSource = new EventSource(sourceApiBase() + '/stream/' + jobId);

      eventSource.addEventListener('status', function(e) {
        var data = JSON.parse(e.data);
        updateStatusBadge(data.status);
      });

      eventSource.addEventListener('text_delta', function(e) {
        var data = JSON.parse(e.data);
        accumulatedText += data.text;
        updateSummaryArea();
      });

      eventSource.addEventListener('category', function(e) {
        var data = JSON.parse(e.data);
        showCategory(data.category);
      });

      eventSource.addEventListener('similar', function(e) {
        var data = JSON.parse(e.data);
        // Ingest returned similar articles — fetch scored results from search API
        renderSimilar(data.articles); // show immediately as fallback
        loadJobSimilar(currentJobTitle); // replace with scored results
      });

      eventSource.addEventListener('complete', function(e) {
        // Backward-compatible: only TikTok ships a parsed summary on the complete
        // event (its multi-turn frame-reading session leaks tool chatter into the
        // streamed deltas). youtube/x/anthropic send an empty payload, so this is
        // a no-op for them and finalizeSummary renders the accumulated text.
        if (e && e.data) {
          try {
            var payload = JSON.parse(e.data);
            if (payload && typeof payload.summary === 'string') {
              accumulatedText = payload.summary;
            }
          } catch (err) {}
        }
        finalizeSummary();
        updateStatusBadge('complete');
        eventSource.close();
        eventSource = null;
        loadRecentlyAdded(true);  // force-refresh so the just-ingested doc appears
      });

      eventSource.addEventListener('error', function(e) {
        if (e.data) {
          var data = JSON.parse(e.data);
          showError(data.message);
        }
        updateStatusBadge('error');
        eventSource.close();
        eventSource = null;
      });
    }

    function showJob(jobId, title, url, source) {
      currentJobTitle = title;
      if (source) currentSource = source;
      var card = document.getElementById('jobCard');
      card.style.display = '';
      var titleEl = document.getElementById('jobTitle');
      if (url) {
        titleEl.innerHTML = '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(title || 'Untitled') + '</a>';
      } else {
        titleEl.textContent = title || 'Untitled';
      }
      // Reset state
      accumulatedText = '';
      document.getElementById('summaryArea').className = 'summary-area empty';
      document.getElementById('summaryArea').textContent = 'Waiting for summary...';
      document.getElementById('categoryBadge').style.display = 'none';
      document.getElementById('similarPanel').classList.remove('visible');
      document.getElementById('errorBanner').classList.remove('visible');
      updateStatusBadge('pending');
    }
  `;
}
