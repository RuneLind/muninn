/** YouTube page — Article library with category chips, articles grid, and doc panel integration */

import { docPanelStyles, markdownContentStyles } from "./doc-panel.ts";

export function ytArticleLibraryStyles(): string {
  return `
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
  `;
}

export function ytArticleLibraryHtml(): string {
  return `
    <div class="library-section" id="librarySection">
      <div class="library-header">
        <h2>Article Library</h2>
        <span class="count" id="libraryCount"></span>
      </div>
      <div class="category-chips" id="categoryChips">
        <div style="color:var(--text-dim);font-size:13px;">Loading categories...</div>
      </div>
      <div class="articles-grid" id="articlesGrid"></div>
    </div>`;
}

export function ytArticleLibraryScript(): string {
  return `
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
      // "ai/claude-code/Some Title.md" -> "Some Title"
      var parts = docId.split('/');
      var filename = parts[parts.length - 1] || docId;
      return filename.replace(/\\.md$/, '');
    }

    function docCategory(docId) {
      // "ai/claude-code/Some Title.md" -> "ai/claude-code"
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
          var rTitle = (r.title || r.id || '').replace(/\\.md$/, '');
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
  `;
}
