/** Summaries page — persistent "Recently Added" list, grouped by date buckets.
 *
 * Reads the merged archive from /api/summaries/documents (every source's
 * collection, each doc tagged with its `source` and carrying an added date) and
 * groups newest-first under Today / Yesterday / This week / This month / then
 * per-month headers. Each row shows a source badge so you can tell a YouTube
 * summary from an X article at a glance. Reuses openSummaryDoc / docTitle /
 * docCategory / sourceBadge / getSummaryDocuments from sum-article-library (all
 * component scripts share one page scope). */

export function sumRecentlyAddedStyles(): string {
  return `
    .recent-section {
      margin-top: 32px;
    }
    .recent-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .recent-section h2 .count {
      font-size: 13px;
      font-weight: 400;
      color: var(--text-dim);
    }
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
    .date-bucket .bucket-count {
      font-weight: 500;
      color: var(--text-dim);
      opacity: 0.7;
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

    /* --- Source badge (shared by Recently Added + Article Library rows) --- */
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

    /* --- Source filter chips --- */
    .source-filter {
      display: flex;
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

export function sumRecentlyAddedHtml(): string {
  return `
    <div class="recent-section" id="recentlyAddedSection">
      <h2>Recently Added <span class="count" id="recentlyAddedCount"></span></h2>
      <!-- Domain filter (All / AI / Life), rendered by sum-article-library's
           renderDomainFilter(). Sits alongside the source chips; both compose. -->
      <div class="source-filter" id="domainFilter"></div>
      <div class="source-filter" id="sourceFilter"></div>
      <div id="recentlyAddedList">
        <div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">Loading...</div>
      </div>
    </div>`;
}

export function sumRecentlyAddedScript(): string {
  return `
    // Active source filter (null = all sources). Shared with the rendered list.
    var activeSource = null;

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

    // Render the source-filter chips from whichever sources actually appear in
    // the archive. "All" plus one chip per present source.
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
          loadRecentlyAdded();  // re-render from cache (no force)
        });
      });
    }

    // force=true refetches the archive (used after an ingest completes); the
    // shared getSummaryDocuments (sum-article-library) otherwise memoizes the
    // listing so the page fetches it once across both consumers.
    async function loadRecentlyAdded(force) {
      var list = document.getElementById('recentlyAddedList');
      try {
        var all = (await getSummaryDocuments(force)).filter(function(d) {
          return d.id && d.id.includes('/') && d.id.endsWith('.md');
        });

        // Narrow to the active domain first (matchesDomain from sum-article-
        // library), so the source chips + list compose with the domain filter.
        var domainDocs = all.filter(matchesDomain);
        renderSourceFilter(domainDocs);
        var docs = activeSource ? domainDocs.filter(function(d) { return d.source === activeSource; }) : domainDocs.slice();

        if (docs.length === 0) {
          list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">No summaries yet. Paste article text above or use the Chrome extension to get started.</div>';
          document.getElementById('recentlyAddedCount').textContent = '';
          if (typeof updateTabCount === 'function') updateTabCount('recently', 0);
          return;
        }

        var now = new Date();
        docs.forEach(function(d) { d._date = parseDocDate(d.date); });
        // Newest first; undated docs sink to the bottom.
        docs.sort(function(a, b) {
          var ta = a._date ? a._date.getTime() : -Infinity;
          var tb = b._date ? b._date.getTime() : -Infinity;
          return tb - ta;
        });

        document.getElementById('recentlyAddedCount').textContent = docs.length + ' articles';
        if (typeof updateTabCount === 'function') updateTabCount('recently', docs.length);

        // Group into buckets, preserving sort order.
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
        console.error('loadRecentlyAdded failed:', err);
        list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">Failed to load: ' + esc(err.message || String(err)) + '</div>';
      }
    }
  `;
}
