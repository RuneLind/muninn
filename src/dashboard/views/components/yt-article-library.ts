/** YouTube page — Article library with category chips, articles grid, and doc panel integration */

import { docPanelStyles } from "./doc-panel.ts";

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

    /* --- Article view: 3-column layout (categories | text | similar) ---
       Scoped to this page only; overrides the shared single-column doc panel
       above. Wider panel so all three columns fit comfortably. */
    .doc-panel { width: 100vw; }
    .doc-panel-body {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 300px;
      gap: 24px;
      align-items: start;
    }
    /* min-width:0 lets code blocks shrink; cap + center the reading column so
       full-page width doesn't stretch lines uncomfortably wide */
    .yt-col-main { min-width: 0; max-width: 1000px; justify-self: center; }
    .yt-col-left, .yt-col-right {
      position: sticky;
      top: 0;
      align-self: start;
      max-height: calc(100vh - 96px);
      overflow-y: auto;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 14px;
    }
    .yt-side-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin: 0 0 10px;
    }
    .yt-cat-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .yt-cat-row:hover { background: var(--bg-surface); color: var(--text-primary); }
    .yt-cat-row.active { color: var(--accent-light); }
    .yt-cat-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .yt-cat-count { font-size: 11px; color: var(--text-dim); font-weight: 600; }
    .yt-cat-articles { padding: 2px 0 8px 10px; display: flex; flex-direction: column; gap: 2px; }
    /* the [hidden] attribute's UA "display:none" loses to the rule above, so
       restate it with higher specificity — this is what actually collapses
       a category list (and makes the row-click toggle work) */
    .yt-cat-articles[hidden] { display: none; }
    .yt-cat-article {
      font-size: 12px;
      color: var(--text-dim);
      text-decoration: none;
      padding: 3px 6px;
      border-radius: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .yt-cat-article:hover { color: var(--text-primary); background: var(--bg-surface); }
    .yt-cat-article.current { color: var(--accent-light); font-weight: 600; }

    /* Collapse to a single column on narrow viewports */
    @media (max-width: 1000px) {
      .doc-panel-body { grid-template-columns: 1fr; }
      .yt-col-left, .yt-col-right { position: static; max-height: none; }
    }

    .doc-similar { padding: 0; margin: 0; }
    .doc-similar h4 {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin: 0 0 10px;
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

    // Single shared fetch of the document archive, used by both this library and
    // the Recently Added list. Memoized so one page load doesn't pull the
    // (now date-enriched, read-every-file) listing twice; throws on an upstream
    // error so callers show a failure instead of a misleading empty state.
    // Pass force=true to refresh after an ingest completes.
    var _ytDocsPromise = null;
    function getYoutubeDocuments(force) {
      if (force || !_ytDocsPromise) {
        _ytDocsPromise = fetch('/api/youtube/documents').then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function(data) {
          if (data && data.error) throw new Error(data.error);
          return (data && data.documents) || [];
        }).catch(function(err) {
          _ytDocsPromise = null;  // don't cache a failure — allow retry
          throw err;
        });
      }
      return _ytDocsPromise;
    }

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
        var allDocs = await getYoutubeDocuments();

        var categories = catData.categories || [];
        allDocuments = allDocs.filter(function(d) {
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
      var cat = docCategory(docId);

      titleEl.textContent = title;
      linksEl.innerHTML = url
        ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">YouTube &rarr;</a>'
        : '';

      // 3-column article view: categories (left) | text (middle) | similar (right)
      bodyEl.innerHTML =
        '<div class="yt-col-left" id="ytCatPanel"></div>' +
        '<div class="yt-col-main" id="ytArticleMain">' +
          '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading...</div>' +
        '</div>' +
        '<div class="yt-col-right doc-similar" id="docSimilarPanel">' +
          '<h4>Similar Articles</h4>' +
          '<div style="color:var(--text-dim);font-size:12px;">Searching...</div>' +
        '</div>';
      overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';
      bodyEl.scrollTop = 0;

      // Left panel: browse categories without leaving the article
      renderArticleCategories(cat, docId);

      try {
        var encodedId = docId.split('/').map(encodeURIComponent).join('/');
        var res = await fetch('/api/youtube/document/' + encodedId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var doc = await res.json();

        var text = doc.text || '';
        // Strip breadcrumb prefix [collection > path] and tags line
        var cleaned = text.replace(/^\\[.*?\\]\\n*/, '').replace(/^tags:.*\\n*/m, '');
        var mainEl = document.getElementById('ytArticleMain');
        if (mainEl) mainEl.innerHTML = renderMarkdown(cleaned);

        // Right panel: other articles matching in relevance
        loadDocSimilar(title, docId);
      } catch (err) {
        var failEl = document.getElementById('ytArticleMain');
        if (failEl) failEl.innerHTML = '<div style="color:var(--status-error);padding:40px;text-align:center">Failed to load: ' + esc(err.message) + '</div>';
      }
    }

    // Left sidebar: every category sorted by recency (most-recent article first),
    // with the active category auto-expanded. Clicking a row selects it and is
    // single-expand — opens this category's article list and collapses every
    // other — so you can keep picking sibling articles under the selected
    // category. Reuses docsByCategory built by loadLibrary() — if the page
    // deep-linked straight into an article before the library loaded, fetch it
    // first.
    async function renderArticleCategories(activeCat, currentDocId) {
      var panel = document.getElementById('ytCatPanel');
      if (!panel) return;
      if (Object.keys(docsByCategory).length === 0) {
        panel.innerHTML = '<div class="yt-side-title">Categories</div>' +
          '<div style="color:var(--text-dim);font-size:12px;">Loading…</div>';
        try { await loadLibrary(); } catch {}
        panel = document.getElementById('ytCatPanel');
        if (!panel) return;  // user already navigated elsewhere
      }
      // Per-category newest date for sorting. The doc date is "YYYY-MM-DD" (or
      // an ISO timestamp with the same prefix), so lexical max == chronological
      // max. Undated cats reduce to '' and sink to the bottom.
      var catMaxDate = {};
      Object.keys(docsByCategory).forEach(function(c) {
        catMaxDate[c] = (docsByCategory[c] || []).reduce(function(m, d) {
          var k = (d && d.date) || '';
          return k > m ? k : m;
        }, '');
      });
      var cats = Object.keys(docsByCategory).sort(function(a, b) {
        return catMaxDate[b].localeCompare(catMaxDate[a]);
      });
      if (cats.length === 0) {
        panel.innerHTML = '<div class="yt-side-title">Categories</div>' +
          '<div style="color:var(--text-dim);font-size:12px;">No categories</div>';
        return;
      }
      panel.innerHTML = '<div class="yt-side-title">Categories</div>' + cats.map(function(cat) {
        // Copy before sorting — docsByCategory is shared with the chip view
        // (sorted by title in loadLibrary); mutating it would break that.
        var docs = (docsByCategory[cat] || []).slice().sort(function(a, b) {
          return ((b && b.date) || '').localeCompare((a && a.date) || '');
        });
        var isActive = cat === activeCat;
        return '<div class="yt-cat">' +
          '<div class="yt-cat-row' + (isActive ? ' active' : '') + '">' +
            '<span class="yt-cat-name">' + esc(cat) + '</span>' +
            '<span class="yt-cat-count">' + docs.length + '</span>' +
          '</div>' +
          // Active category opens by default so the user can pick a sibling
          // straight away; the others stay collapsed until clicked.
          '<div class="yt-cat-articles"' + (isActive ? '' : ' hidden') + '>' +
            docs.map(function(d) {
              var cur = d.id === currentDocId;
              return '<a href="#" class="yt-cat-article' + (cur ? ' current' : '') + '" ' +
                'data-doc-id="' + esc(d.id) + '" data-doc-url="' + esc(d.url || '') + '">' +
                esc(docTitle(d.id)) + '</a>';
            }).join('') +
          '</div>' +
        '</div>';
      }).join('');

      // Select + single-expand with toggle-on-same-click: clicking a different
      // row clears every other .active + collapses their article lists, then
      // selects + opens this one. Clicking the already-active row collapses
      // it and deselects — so you can dismiss the open list and pick another
      // category cleanly.
      panel.querySelectorAll('.yt-cat-row').forEach(function(row) {
        row.addEventListener('click', function() {
          var list = row.parentElement.querySelector('.yt-cat-articles');
          if (row.classList.contains('active')) {
            row.classList.remove('active');
            if (list) list.hidden = true;
            return;
          }
          panel.querySelectorAll('.yt-cat-row.active').forEach(function(r) {
            r.classList.remove('active');
          });
          panel.querySelectorAll('.yt-cat-articles').forEach(function(l) {
            l.hidden = true;
          });
          row.classList.add('active');
          if (list) list.hidden = false;
        });
      });
      // Open another article in place
      panel.querySelectorAll('.yt-cat-article').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          openYouTubeDoc(a.getAttribute('data-doc-id'), a.getAttribute('data-doc-url'));
        });
      });
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
