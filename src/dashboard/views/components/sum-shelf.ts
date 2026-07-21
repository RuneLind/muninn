/** Summaries page — the Shelf: the persistent archive, recency-first.
 *
 * Merges the old "Recently Added" (date-bucketed, source-filterable list) and
 * "Article Library" (category browsing) tabs into ONE tab. The date buckets stay
 * the body (newest-first Today / Yesterday / This week / …); category browsing
 * demotes to a filter (the `#shelfCategoryFilter` dropdown) that composes with the
 * domain (All / AI / Life) and source chips. A recency lead ("N new (last 14d)")
 * heads the list so the freshest additions read first.
 *
 * Reads the merged archive from /api/summaries/documents via the shared
 * getSummaryDocuments() memo (sum-article-library), and reuses that file's shared
 * doc helpers (docTitle / docCategory / matchesDomain / sourceBadge / sourceLink /
 * openSummaryDoc) — all summaries component scripts share one page scope.
 *
 * Owns the interactive filter-chip vocabulary for the whole summaries page
 * (`.source-filter` / `.source-chip` / `.chip-count`) plus the row `.source-badge`.
 * The candidate inbox (sum-candidates) reuses these chip styles — they live here,
 * the one component that is always mounted, rather than in a now-retired file. */

export function sumShelfStyles(): string {
  return `
    .shelf-section { margin-top: 8px; }
    .shelf-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .shelf-section h2 .count {
      font-size: 13px;
      font-weight: 400;
      color: var(--text-dim);
    }

    /* Filter row: domain chips + source chips + category dropdown, all composing. */
    .shelf-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      margin-bottom: 14px;
    }
    .shelf-filters .source-filter { margin-bottom: 0; }
    .shelf-cat-select {
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card);
      color: var(--text-secondary);
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      max-width: 260px;
    }
    .shelf-cat-select:hover { border-color: var(--accent); color: var(--text-primary); }
    .shelf-cat-select:focus { outline: none; border-color: var(--accent); }

    /* Recency lead — "N new (last 14d)" over the currently-shown docs. */
    .shelf-lead {
      font-size: 13px;
      color: var(--text-dim);
      margin: 0 0 12px;
    }
    .shelf-lead strong { color: var(--text-soft); font-weight: 600; }

    /* --- Date buckets (recency-first list body) --- */
    .date-bucket {
      margin: 18px 0 8px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-dim);
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .date-bucket:first-child { margin-top: 0; }
    .date-bucket .bucket-count { font-weight: 500; color: var(--text-dim); opacity: 0.7; }
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
    .recent-item-link {
      font-size: 12px;
      color: var(--text-dim);
      text-decoration: none;
      flex-shrink: 0;
    }
    .recent-item-link:hover { color: var(--accent-light); }
    .recent-item-time {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
      flex-shrink: 0;
      min-width: 64px;
      text-align: right;
    }
    .shelf-empty {
      color: var(--text-dim);
      font-size: 13px;
      padding: 24px 0;
      text-align: center;
    }

    /* --- Source badge (shelf rows) --- */
    .source-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      flex-shrink: 0;
      border: 1px solid var(--border-secondary);
      color: var(--text-soft);
      background: var(--bg-surface);
    }
    .source-badge[data-source="youtube"] {
      color: var(--status-error);
      border-color: color-mix(in srgb, var(--status-error) 40%, transparent);
      background: color-mix(in srgb, var(--status-error) 12%, transparent);
    }
    .source-badge[data-source="x-article"] {
      color: var(--status-info);
      border-color: color-mix(in srgb, var(--status-info) 40%, transparent);
      background: color-mix(in srgb, var(--status-info) 12%, transparent);
    }

    /* --- Filter chips (canonical home; shared with the candidate inbox) --- */
    .source-filter {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .source-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card);
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .source-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .source-chip.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }
    .source-chip .chip-count { font-size: 11px; color: var(--text-dim); font-weight: 600; }
    .source-chip.active .chip-count { color: var(--accent-light); }
  `;
}

export function sumShelfHtml(): string {
  return `
    <div class="shelf-section" id="shelfSection">
      <h2>Shelf <span class="count" id="shelfCount"></span></h2>
      <div class="shelf-filters">
        <!-- Domain chips (All / AI / Life), rendered by sum-article-library's
             renderDomainFilter(). -->
        <div class="source-filter" id="domainFilter"></div>
        <!-- Source chips (All / YouTube / X / …), rendered below. -->
        <div class="source-filter" id="sourceFilter"></div>
        <!-- Category browsing demoted to a filter. -->
        <select class="shelf-cat-select" id="shelfCategoryFilter" aria-label="Filter by category"></select>
      </div>
      <div class="shelf-lead" id="shelfLead"></div>
      <div id="shelfList">
        <div class="shelf-empty">Loading…</div>
      </div>
    </div>`;
}

export function sumShelfScript(): string {
  return `
    // Active source filter (null = all sources). Shared page-global (the candidate
    // kind filter is independent — this one narrows the shelf list only).
    var activeSource = null;
    // Active category filter (null = all categories). Composes with domain + source.
    var activeShelfCategory = null;

    // Parse a doc date ("2026-01-09" or full ISO) to a local-midnight Date.
    // Day-only strings are parsed component-wise to avoid UTC timezone drift.
    function parseDocDate(s) {
      if (!s) return null;
      var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    // Map a date to a bucket label. Buckets are a monotonic function of recency,
    // so iterating date-descending and emitting a header on label change yields
    // correctly ordered, non-duplicated sections.
    function dateBucketLabel(d, now) {
      if (!d) return 'Undated';
      var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var diffDays = Math.round((startOfToday - d) / 86400000);
      if (diffDays <= 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return 'This week';
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'This month';
      return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    }

    function formatDocDate(d, now) {
      if (!d) return '';
      var opts = d.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' };
      return d.toLocaleDateString('en-US', opts);
    }

    // Only real summary docs (category-pathed .md files) go on the shelf.
    function isShelfDoc(d) {
      return d.id && d.id.includes('/') && d.id.endsWith('.md');
    }

    // Render the source-filter chips from whichever sources appear in the
    // domain-narrowed archive. "All" plus one chip per present source.
    function renderSourceFilter(docs) {
      var el = document.getElementById('sourceFilter');
      if (!el) return;
      var counts = {};
      docs.forEach(function(d) { counts[d.source] = (counts[d.source] || 0) + 1; });
      var present = Object.keys(counts);
      if (present.length <= 1) { el.innerHTML = ''; return; }  // nothing to filter
      var chips = ['<span class="source-chip' + (activeSource === null ? ' active' : '') +
        '" data-source="">All <span class="chip-count">' + docs.length + '</span></span>'];
      present.forEach(function(id) {
        var s = SOURCES[id];
        var label = s ? s.label : id;
        chips.push('<span class="source-chip' + (activeSource === id ? ' active' : '') +
          '" data-source="' + esc(id) + '">' + esc(label) +
          ' <span class="chip-count">' + counts[id] + '</span></span>');
      });
      el.innerHTML = chips.join('');
      el.querySelectorAll('.source-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          var s = chip.getAttribute('data-source');
          activeSource = s || null;
          loadShelf();  // re-render from cache (no force)
        });
      });
    }

    // Category filter dropdown, built from the domain+source-narrowed docs so the
    // options reflect what's actually reachable. A sticky active category keeps its
    // option even at count 0 (the list then shows the filtered-empty state and the
    // user widens via "All categories").
    function renderShelfCategoryFilter(docs) {
      var sel = document.getElementById('shelfCategoryFilter');
      if (!sel) return;
      var counts = {};
      docs.forEach(function(d) {
        var cat = docCategory(d.id);
        counts[cat] = (counts[cat] || 0) + 1;
      });
      var cats = Object.keys(counts);
      if (activeShelfCategory && counts[activeShelfCategory] === undefined) {
        cats.push(activeShelfCategory);  // keep the sticky selection reachable
        counts[activeShelfCategory] = 0;
      }
      cats.sort(function(a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
      var opts = ['<option value="">All categories (' + docs.length + ')</option>'];
      cats.forEach(function(cat) {
        var selAttr = cat === activeShelfCategory ? ' selected' : '';
        opts.push('<option value="' + esc(cat) + '"' + selAttr + '>' + esc(cat) + ' (' + counts[cat] + ')</option>');
      });
      sel.innerHTML = opts.join('');
      if (!sel.dataset.bound) {
        sel.dataset.bound = '1';
        sel.addEventListener('change', function() {
          activeShelfCategory = sel.value || null;
          loadShelf();
        });
      }
    }

    // Number of shown docs whose date falls inside the last 14 days — the recency
    // lead. Undated docs never count as "new".
    function shelfFreshCount(docs, now) {
      var cutoff = now.getTime() - 14 * 86400000;
      return docs.filter(function(d) { return d._date && d._date.getTime() >= cutoff; }).length;
    }

    // force=true refetches the archive (used after an ingest completes); the shared
    // getSummaryDocuments (sum-article-library) otherwise memoizes the listing so the
    // page fetches it once across consumers.
    async function loadShelf(force) {
      var list = document.getElementById('shelfList');
      if (!list) return;
      try {
        var all = (await getSummaryDocuments(force)).filter(isShelfDoc);

        // Narrow by domain first (matchesDomain from sum-article-library), so every
        // filter row reflects the active domain; then source, then category.
        var domainDocs = all.filter(matchesDomain);
        renderSourceFilter(domainDocs);
        var sourceDocs = activeSource
          ? domainDocs.filter(function(d) { return d.source === activeSource; })
          : domainDocs.slice();
        renderShelfCategoryFilter(sourceDocs);
        var docs = activeShelfCategory
          ? sourceDocs.filter(function(d) { return docCategory(d.id) === activeShelfCategory; })
          : sourceDocs.slice();

        var now = new Date();
        docs.forEach(function(d) {
          d._date = parseDocDate(d.date);
          // Full-precision ingest timestamp (huginn modifiedTime) breaks ties within
          // a day — the frontmatter date is day-precision only.
          var ts = d.modifiedTime ? Date.parse(d.modifiedTime) : NaN;
          d._ts = isNaN(ts) ? -Infinity : ts;
        });

        if (docs.length === 0) {
          list.innerHTML = '<div class="shelf-empty">No summaries match these filters. Paste article text or use the Chrome extension to add more.</div>';
          document.getElementById('shelfCount').textContent = '';
          document.getElementById('shelfLead').innerHTML = '';
          if (typeof updateTabCount === 'function') updateTabCount('shelf', 0);
          return;
        }

        // Newest first; undated docs sink to the bottom.
        docs.sort(function(a, b) {
          var ta = a._date ? a._date.getTime() : -Infinity;
          var tb = b._date ? b._date.getTime() : -Infinity;
          if (tb !== ta) return tb - ta;
          return b._ts - a._ts;
        });

        document.getElementById('shelfCount').textContent = docs.length + ' articles';
        if (typeof updateTabCount === 'function') updateTabCount('shelf', docs.length);

        // Recency lead — the "N new (last 14d)" line that heads the shelf.
        var fresh = shelfFreshCount(docs, now);
        document.getElementById('shelfLead').innerHTML =
          '<strong>' + fresh + ' new</strong> (last 14d) · ' + docs.length + ' on the shelf';

        // Group into date buckets, preserving sort order.
        var buckets = [];
        var current = null;
        docs.forEach(function(doc) {
          var label = dateBucketLabel(doc._date, now);
          if (!current || current.label !== label) {
            current = { label: label, docs: [] };
            buckets.push(current);
          }
          current.docs.push(doc);
        });

        list.innerHTML = buckets.map(function(bucket) {
          var rows = bucket.docs.map(function(doc) {
            var title = docTitle(doc.id);
            var cat = docCategory(doc.id);
            return '<div class="recent-item" data-doc-id="' + esc(doc.id) + '" data-doc-url="' + esc(doc.url || '') + '" data-source="' + esc(doc.source) + '">' +
              sourceBadge(doc.source) +
              '<span class="recent-item-title">' + esc(title) + '</span>' +
              '<span class="category-badge">' + esc(cat) + '</span>' +
              sourceLink(doc) +
              '<span class="recent-item-time">' + esc(formatDocDate(doc._date, now)) + '</span>' +
            '</div>';
          }).join('');
          return '<div class="date-bucket">' + esc(bucket.label) +
            ' <span class="bucket-count">' + bucket.docs.length + '</span></div>' +
            '<div class="recent-list">' + rows + '</div>';
        }).join('');

        // Delegate row clicks to the shared doc panel opener.
        list.querySelectorAll('.recent-item').forEach(function(row) {
          row.addEventListener('click', function() {
            openSummaryDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'), row.getAttribute('data-source'));
          });
        });
      } catch (err) {
        console.error('loadShelf failed:', err);
        list.innerHTML = '<div class="shelf-empty">Failed to load: ' + esc(err.message || String(err)) + '</div>';
      }
    }
  `;
}
