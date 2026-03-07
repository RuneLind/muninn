import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { markdownContentStyles, docPanelStyles, docPanelHtml, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { escScript } from "./components/helpers.ts";

export function renderYouTubePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - YouTube Summarizer</title>
  <style>
    ${SHARED_STYLES}

    .page-content {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    /* --- Submit form --- */
    .submit-form {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
    }
    .submit-form input {
      flex: 1;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
    }
    .submit-form input::placeholder { color: var(--text-dim); }
    .submit-form input:focus { outline: none; border-color: var(--accent); }
    .submit-form button {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    .submit-form button:hover { opacity: 0.9; }
    .submit-form button:disabled { opacity: 0.5; cursor: not-allowed; }

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
    .status-fetching_transcript { background: color-mix(in srgb, var(--status-info) 20%, transparent); color: var(--status-info); }
    .status-summarizing { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent-light); }
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

    /* --- Error display --- */
    .error-banner {
      display: none;
      padding: 12px 20px;
      background: color-mix(in srgb, var(--status-error) 10%, transparent);
      border-top: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
      color: var(--status-error);
      font-size: 13px;
    }
    .error-banner.visible { display: block; }

    /* --- Recent jobs list --- */
    .recent-section {
      margin-top: 32px;
    }
    .recent-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px;
    }
    .recent-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .recent-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      text-decoration: none;
    }
    .recent-item:hover { border-color: var(--accent); }
    .recent-item-title {
      flex: 1;
      font-size: 14px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .recent-item-time {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
    }

    /* --- Article Library --- */
    .library-section {
      margin-top: 40px;
      border-top: 1px solid var(--border-primary);
      padding-top: 24px;
    }
    .library-header {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 16px;
    }
    .library-header h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    .library-header .count {
      font-size: 13px;
      color: var(--text-dim);
    }
    .category-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .cat-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card);
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .cat-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .cat-chip.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }
    .cat-chip .chip-count {
      font-size: 11px;
      color: var(--text-dim);
      font-weight: 600;
    }
    .cat-chip.active .chip-count { color: var(--accent-light); }

    .articles-grid {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 16px;
    }
    .article-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      text-decoration: none;
      transition: border-color 0.15s;
    }
    .article-row:hover { border-color: var(--accent); }
    .article-row-title {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .article-row-link {
      font-size: 12px;
      color: var(--text-dim);
      text-decoration: none;
      flex-shrink: 0;
    }
    .article-row-link:hover { color: var(--accent-light); }

    ${docPanelStyles("ytSlideIn")}
    ${markdownContentStyles(".doc-panel-body")}

    .doc-similar {
      border-top: 1px solid var(--border-primary);
      padding: 16px 0 0;
      margin-top: 20px;
    }
    .doc-similar h4 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 8px;
    }
    .doc-similar-item {
      padding: 6px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border-primary) 50%, transparent);
    }
    .doc-similar-item:last-child { border-bottom: none; }
    .doc-similar-item a {
      font-size: 13px;
      color: var(--accent-light);
      text-decoration: none;
    }
    .doc-similar-item a:hover { text-decoration: underline; }
    .doc-similar-relevance {
      font-size: 11px;
      color: var(--text-dim);
      margin-left: 8px;
    }
  </style>
</head>
<body>
  ${renderNav("youtube")}

  <div class="page-content">
    <!-- Manual submit form -->
    <div class="submit-form">
      <input type="text" id="urlInput" placeholder="Paste a YouTube URL to summarize..." />
      <button id="submitBtn" onclick="submitUrl()">Summarize</button>
    </div>

    <!-- Active job card (hidden until a job is active) -->
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
      <div class="error-banner" id="errorBanner"></div>
      <div class="similar-panel" id="similarPanel">
        <h3>Similar Videos</h3>
        <div class="similar-list" id="similarList"></div>
      </div>
    </div>

    <!-- Recent jobs -->
    <div class="recent-section" id="recentSection">
      <h2>Recent Summaries</h2>
      <div class="recent-list" id="recentList">
        <div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">Loading...</div>
      </div>
    </div>

    <!-- Article Library -->
    <div class="library-section" id="librarySection">
      <div class="library-header">
        <h2>Article Library</h2>
        <span class="count" id="libraryCount"></span>
      </div>
      <div class="category-chips" id="categoryChips">
        <div style="color:var(--text-dim);font-size:13px;">Loading categories...</div>
      </div>
      <div class="articles-grid" id="articlesGrid"></div>
    </div>
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    ${escScript()}

    var accumulatedText = '';
    var currentJobId = null;
    var currentJobTitle = null;
    var eventSource = null;

    var STATUS_LABELS = {
      pending: 'Pending',
      fetching_transcript: 'Fetching transcript',
      summarizing: 'Summarizing',
      ingesting: 'Indexing',
      complete: 'Complete',
      error: 'Error'
    };

    var TERMINAL_STATES = ['complete', 'error'];

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
      // Wire up view-md links
      list.querySelectorAll('.similar-view-md').forEach(function(link) {
        link.addEventListener('click', function(e) {
          e.preventDefault();
          openYouTubeDoc(link.getAttribute('data-doc-id'), link.getAttribute('data-doc-url'));
        });
      });
    }

    async function loadJobSimilar(title) {
      if (!title) return;
      try {
        var res = await fetch('/api/youtube/similar?q=' + encodeURIComponent(title));
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

    function connectSSE(jobId) {
      if (eventSource) eventSource.close();
      currentJobId = jobId;

      eventSource = new EventSource('/api/youtube/stream/' + jobId);

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

      eventSource.addEventListener('complete', function() {
        finalizeSummary();
        updateStatusBadge('complete');
        eventSource.close();
        eventSource = null;
        loadRecentJobs();
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

    function showJob(jobId, title, url) {
      currentJobTitle = title;
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

    function extractVideoId(url) {
      try {
        var u = new URL(url);
        if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
        if (u.hostname === 'youtu.be') return u.pathname.slice(1);
      } catch {}
      return null;
    }

    async function submitUrl() {
      var input = document.getElementById('urlInput');
      var url = input.value.trim();
      if (!url) return;

      var videoId = extractVideoId(url);
      if (!videoId) {
        alert('Invalid YouTube URL');
        return;
      }

      var btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      try {
        var res = await fetch('/api/youtube/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '', url: url, video_id: videoId }),
        });
        var data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Failed to start');
          return;
        }
        // Update URL without reload
        history.replaceState(null, '', '/youtube?job=' + data.job_id);
        showJob(data.job_id, url, url);
        connectSSE(data.job_id);
        input.value = '';
      } catch (err) {
        alert('Request failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Summarize';
      }
    }

    function timeAgo(ts) {
      var diff = Date.now() - ts;
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    async function loadRecentJobs() {
      try {
        var res = await fetch('/api/youtube/jobs?limit=20');
        var data = await res.json();
        var list = document.getElementById('recentList');
        if (!data.jobs || data.jobs.length === 0) {
          list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">No summaries yet. Paste a YouTube URL above to get started.</div>';
          return;
        }
        list.innerHTML = data.jobs.map(function(job) {
          return '<a class="recent-item" href="/youtube?job=' + esc(job.id) + '">' +
            '<span class="status-badge status-' + job.status + '" style="font-size:10px;padding:2px 8px;">' +
              esc(STATUS_LABELS[job.status] || job.status) +
            '</span>' +
            '<span class="recent-item-title">' + esc(job.title || job.url || job.videoId) + '</span>' +
            (job.category ? '<span class="category-badge">' + esc(job.category) + '</span>' : '') +
            '<span class="recent-item-time">' + timeAgo(job.createdAt) + '</span>' +
          '</a>';
        }).join('');
      } catch (err) {
        console.error('loadRecentJobs failed:', err);
      }
    }

    // --- Doc panel close/escape ---
    function closeDocPanel() {
      document.getElementById('docOverlay').classList.remove('visible');
      document.body.style.overflow = '';
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && document.getElementById('docOverlay').classList.contains('visible')) {
        closeDocPanel();
      }
    });

    // --- Article Library ---
    var allDocuments = [];
    var docsByCategory = {};
    var activeCategory = null;

    function docTitle(docId) {
      // "ai/claude-code/Some Title.md" → "Some Title"
      var parts = docId.split('/');
      var filename = parts[parts.length - 1] || docId;
      return filename.replace(/\.md$/, '');
    }

    function docCategory(docId) {
      // "ai/claude-code/Some Title.md" → "ai/claude-code"
      var parts = docId.split('/');
      if (parts.length >= 2) return parts.slice(0, -1).join('/');
      return 'uncategorized';
    }

    async function loadLibrary() {
      try {
        var catRes = await fetch('/api/youtube/categories');
        var catData = await catRes.json();
        var docRes = await fetch('/api/youtube/documents');
        var docData = await docRes.json();

        var categories = catData.categories || [];
        allDocuments = (docData.documents || []).filter(function(d) {
          // Skip non-summary files (chrome-extension etc)
          return d.id.includes('/') && d.id.endsWith('.md');
        });

        // Group docs by category
        docsByCategory = {};
        allDocuments.forEach(function(doc) {
          var cat = docCategory(doc.id);
          if (!docsByCategory[cat]) docsByCategory[cat] = [];
          docsByCategory[cat].push(doc);
        });

        // Sort docs within each category by title
        Object.values(docsByCategory).forEach(function(docs) {
          docs.sort(function(a, b) { return docTitle(a.id).localeCompare(docTitle(b.id)); });
        });

        document.getElementById('libraryCount').textContent = allDocuments.length + ' articles';

        // Render category chips using API category data (has accurate counts)
        var chips = categories
          .sort(function(a, b) { return b.count - a.count; })
          .map(function(cat) {
            return '<span class="cat-chip" data-category="' + esc(cat.name) + '" onclick="toggleCategory(this)">' +
              esc(cat.name) +
              ' <span class="chip-count">' + cat.count + '</span>' +
            '</span>';
          }).join('');
        document.getElementById('categoryChips').innerHTML = chips || '<div style="color:var(--text-dim);font-size:13px;">No categories found</div>';
      } catch (err) {
        console.error('loadLibrary failed:', err);
        document.getElementById('categoryChips').innerHTML = '<div style="color:var(--text-dim);font-size:13px;">Failed to load library: ' + (err.message || err) + '</div>';
      }
    }

    function toggleCategory(chip) {
      var cat = chip.getAttribute('data-category');
      var grid = document.getElementById('articlesGrid');

      if (activeCategory === cat) {
        // Collapse
        activeCategory = null;
        chip.classList.remove('active');
        grid.innerHTML = '';
        return;
      }

      // Deactivate previous
      document.querySelectorAll('.cat-chip.active').forEach(function(c) { c.classList.remove('active'); });
      activeCategory = cat;
      chip.classList.add('active');

      // Find docs for this category
      var docs = docsByCategory[cat] || [];
      if (docs.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:12px 0;">No articles in this category</div>';
        return;
      }

      grid.innerHTML = docs.map(function(doc) {
        var title = docTitle(doc.id);
        var isYouTube = doc.url && doc.url.includes('youtube.com');
        return '<div class="article-row" data-doc-id="' + esc(doc.id) + '" data-doc-url="' + esc(doc.url || '') + '">' +
          '<span class="article-row-title">' + esc(title) + '</span>' +
          (isYouTube ? '<a class="article-row-link" href="' + esc(doc.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">YouTube &rarr;</a>' : '') +
        '</div>';
      }).join('');

      // Delegate clicks on article rows
      grid.querySelectorAll('.article-row').forEach(function(row) {
        row.addEventListener('click', function() {
          openYouTubeDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'));
        });
      });
    }

    async function openYouTubeDoc(docId, url) {
      var overlay = document.getElementById('docOverlay');
      var titleEl = document.getElementById('docPanelTitle');
      var linksEl = document.getElementById('docPanelLinks');
      var bodyEl = document.getElementById('docPanelBody');
      var title = docTitle(docId);

      titleEl.textContent = title;
      linksEl.innerHTML = url
        ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">YouTube &rarr;</a>'
        : '';
      bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading...</div>';
      overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';

      try {
        var encodedId = docId.split('/').map(encodeURIComponent).join('/');
        var res = await fetch('/api/youtube/document/' + encodedId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var doc = await res.json();

        var text = doc.text || '';
        // Strip breadcrumb prefix [collection > path]
        var cleaned = text.replace(/^\\[.*?\\]\\n*/, '');
        // Strip tags line
        cleaned = cleaned.replace(/^tags:.*\\n*/m, '');
        bodyEl.innerHTML = renderMarkdown(cleaned) +
          '<div class="doc-similar" id="docSimilarPanel"><h4>Similar Articles</h4><div style="color:var(--text-dim);font-size:12px;">Searching...</div></div>';

        // Fetch similar articles
        loadDocSimilar(title, docId);
      } catch (err) {
        bodyEl.innerHTML = '<div style="color:var(--status-error);padding:40px;text-align:center">Failed to load: ' + esc(err.message) + '</div>';
      }
    }

    async function loadDocSimilar(title, currentDocId) {
      var panel = document.getElementById('docSimilarPanel');
      if (!panel) return;
      try {
        var res = await fetch('/api/youtube/similar?q=' + encodeURIComponent(title));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        var results = (data.results || []).filter(function(r) { return r.id !== currentDocId; }).slice(0, 5);
        if (results.length === 0) {
          panel.innerHTML = '<h4>Similar Articles</h4><div style="color:var(--text-dim);font-size:12px;">No similar articles found</div>';
          return;
        }
        panel.innerHTML = '<h4>Similar Articles</h4>' + results.map(function(r) {
          var pct = Math.round((r.relevance || 0) * 100);
          var rTitle = (r.title || r.id || '').replace(/\.md$/, '');
          var rUrl = r.url || '#';
          return '<div class="doc-similar-item" data-doc-id="' + esc(r.id) + '" data-doc-url="' + esc(rUrl) + '">' +
            '<a href="#">' + esc(rTitle) + '</a>' +
            '<span class="doc-similar-relevance">' + pct + '%</span>' +
          '</div>';
        }).join('');
        // Wire up click handlers for similar items
        panel.querySelectorAll('.doc-similar-item').forEach(function(item) {
          item.querySelector('a').addEventListener('click', function(e) {
            e.preventDefault();
            var id = item.getAttribute('data-doc-id');
            var url = item.getAttribute('data-doc-url');
            closeDocPanel();
            setTimeout(function() { openYouTubeDoc(id, url); }, 200);
          });
        });
      } catch {
        panel.innerHTML = '<h4>Similar Articles</h4><div style="color:var(--text-dim);font-size:12px;">Failed to load similar</div>';
      }
    }

    // --- Init ---
    async function init() {
      loadRecentJobs();
      loadLibrary();

      // Check for ?job= param
      var params = new URLSearchParams(window.location.search);
      var jobId = params.get('job');
      if (!jobId) return;

      // Fetch current job state
      try {
        var res = await fetch('/api/youtube/jobs');
        var data = await res.json();
        var job = (data.jobs || []).find(function(j) { return j.id === jobId; });
        if (!job) return;

        showJob(jobId, job.title || job.url, job.url);

        // Replay existing state
        if (job.text) {
          accumulatedText = job.text;
          updateSummaryArea();
        }
        if (job.category) showCategory(job.category);
        if (job.similar) renderSimilar(job.similar);
        if (job.error) showError(job.error);
        updateStatusBadge(job.status);

        // Connect SSE for live updates (unless terminal)
        if (!TERMINAL_STATES.includes(job.status)) {
          connectSSE(jobId);
        } else {
          finalizeSummary();
          // Fetch scored similar results for completed jobs
          loadJobSimilar(job.title || job.url);
        }
      } catch {
        // ignore — job may have expired
      }
    }

    // Allow Enter key in input
    document.getElementById('urlInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitUrl();
    });

    init();
  </script>
</body>
</html>`;
}
