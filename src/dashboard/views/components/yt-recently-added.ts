/** YouTube page — persistent "Recently Added" list, grouped by date buckets.
 *
 * Replaces the old ephemeral in-memory "Recent Summaries" list. Reads the full
 * archive from /api/youtube/documents (which now carries each doc's added date)
 * and groups newest-first under Today / Yesterday / This week / This month /
 * then per-month headers. Reuses openYouTubeDoc/docTitle/docCategory from
 * yt-article-library (all component scripts share one page scope).
 */

export function ytRecentlyAddedStyles(): string {
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
  `;
}

export function ytRecentlyAddedHtml(): string {
  return `
    <div class="recent-section" id="recentlyAddedSection">
      <h2>Recently Added <span class="count" id="recentlyAddedCount"></span></h2>
      <div id="recentlyAddedList">
        <div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">Loading...</div>
      </div>
    </div>`;
}

export function ytRecentlyAddedScript(): string {
  return `
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

    async function loadRecentlyAdded() {
      var list = document.getElementById('recentlyAddedList');
      try {
        var res = await fetch('/api/youtube/documents');
        var data = await res.json();
        var docs = (data.documents || []).filter(function(d) {
          return d.id && d.id.includes('/') && d.id.endsWith('.md');
        });

        if (docs.length === 0) {
          list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">No summaries yet. Paste a YouTube URL above to get started.</div>';
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
            var isYouTube = doc.url && doc.url.indexOf('youtube.com') !== -1;
            return '<div class="recent-item" data-doc-id="' + esc(doc.id) + '" data-doc-url="' + esc(doc.url || '') + '">' +
              '<span class="recent-item-title">' + esc(title) + '</span>' +
              '<span class="category-badge">' + esc(cat) + '</span>' +
              (isYouTube ? '<a class="recent-item-link" href="' + esc(doc.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">YouTube &rarr;</a>' : '') +
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
            openYouTubeDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'));
          });
        });
      } catch (err) {
        console.error('loadRecentlyAdded failed:', err);
        list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">Failed to load: ' + esc(err.message || String(err)) + '</div>';
      }
    }
  `;
}
