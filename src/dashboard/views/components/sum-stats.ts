/** Summaries page — the Stats tab (ingest volume + gardener coverage).
 *
 * Two read-only views over GET /api/summaries/stats:
 *  - a pure HTML/CSS stacked-bar chart of new summaries per source per calendar
 *    month (last 8 months), with a per-source legend, and
 *  - a 30-day gardener-coverage strip (consumed / pending / never-clustered),
 *    with the never-clustered docs listed in an expandable <details>.
 *
 * No charting dependency — bars are flex boxes sized by percentage. Uses the
 * shared esc()/getJson() helpers + sourceBadge()/SOURCES from the page scope. A
 * huginn-unreachable collection shows an inline error chip; the rest still
 * render (the route returns partial data + an `errors` array). */

export function sumStatsStyles(): string {
  return `
    .stats-section {
      margin-top: 8px;
      margin-bottom: 32px;
    }
    .stats-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 4px;
    }
    .stats-subtitle {
      font-size: 13px;
      color: var(--text-dim);
      margin: 0 0 18px;
    }
    .stats-block { margin-bottom: 26px; }
    .stats-block h3 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-dim);
      margin: 0 0 12px;
    }

    /* Stacked-bar chart */
    .stats-chart {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      height: 220px;
      padding: 12px 12px 0;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-card);
      overflow-x: auto;
    }
    .stats-bar-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      flex: 1 0 42px;
      height: 100%;
      justify-content: flex-end;
    }
    .stats-bar-stack {
      width: 32px;
      display: flex;
      flex-direction: column-reverse;
      border-radius: 4px 4px 0 0;
      overflow: hidden;
      background: var(--bg-surface);
    }
    .stats-bar-seg { width: 100%; min-height: 0; }
    .stats-bar-empty {
      width: 32px;
      height: 3px;
      border-radius: 2px;
      background: var(--border-secondary);
    }
    .stats-bar-total {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--text-soft);
      min-height: 14px;
    }
    .stats-bar-label {
      font-size: 10px;
      color: var(--text-dim);
      white-space: nowrap;
    }

    .stats-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 12px;
    }
    .stats-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-soft);
    }
    .stats-legend-swatch {
      width: 11px;
      height: 11px;
      border-radius: 3px;
      flex: none;
    }
    .stats-legend-item .undated { color: var(--text-dim); }

    /* Coverage strip */
    .stats-coverage-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px 14px;
      padding: 14px 16px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-card);
      font-size: 14px;
      color: var(--text-secondary);
    }
    .stats-coverage-strip .num {
      font-weight: 700;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }
    .stats-coverage-strip .sep { color: var(--text-dim); }
    .stats-coverage-strip .num.consumed { color: var(--status-success); }
    .stats-coverage-strip .num.pending { color: var(--status-warning); }
    .stats-coverage-strip .num.never { color: var(--status-info); }

    details.stats-never {
      margin-top: 12px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-card);
    }
    details.stats-never > summary {
      cursor: pointer;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--text-soft);
      user-select: none;
    }
    details.stats-never[open] > summary { border-bottom: 1px solid var(--border-primary); }
    .stats-never-list { display: flex; flex-direction: column; }
    .stats-never-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 14px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
    }
    .stats-never-row:last-child { border-bottom: none; }
    .stats-never-title {
      flex: 1;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .stats-never-link {
      font-size: 12px;
      color: var(--accent-light);
      text-decoration: none;
      flex: none;
    }
    .stats-never-link:hover { text-decoration: underline; }

    .stats-error-chip {
      display: inline-block;
      margin-bottom: 14px;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      color: var(--status-error);
      background: var(--tint-error);
      border: 1px solid color-mix(in srgb, var(--status-error) 40%, transparent);
    }
    .stats-empty {
      padding: 22px 14px;
      text-align: center;
      font-size: 13px;
      color: var(--text-dim);
      border: 1px dashed var(--border-primary);
      border-radius: 8px;
    }
    .stats-empty.error {
      color: var(--status-error);
      border-color: color-mix(in srgb, var(--status-error) 40%, transparent);
    }
  `;
}

export function sumStatsHtml(): string {
  return `
    <div class="stats-section" id="statsSection">
      <h2>Stats</h2>
      <p class="stats-subtitle">
        New summaries per source per calendar month (last 8 months), and how much of the last 30 days the wiki
        gardener has consumed. Read-only — sourced live from the knowledge base and the proposals table.
      </p>
      <div id="statsBody"></div>
    </div>`;
}

export function sumStatsScript(): string {
  return `
    // Chart series colors keyed by source id — theme-aware shared CSS vars (the
    // light theme darkens these in shared-styles.ts, so hardcoded hex would
    // render the dark palette on a light background). Falls back to a neutral
    // swatch for an unknown source (e.g. a new collection not yet mapped).
    var STATS_COLORS = {
      youtube: 'var(--status-error)',
      'x-article': 'var(--status-info)',
      anthropic: 'var(--status-magenta)',
      tiktok: 'var(--status-cyan)',
    };
    function statsColor(sourceId) { return STATS_COLORS[sourceId] || 'var(--accent-muted)'; }
    function statsSourceLabel(sourceId) {
      var s = (typeof SOURCES !== 'undefined') ? SOURCES[sourceId] : null;
      return s ? s.label : sourceId;
    }

    var statsLoaded = false;

    function renderStatsChart(stats) {
      var months = stats.months || [];
      var maxTotal = 0;
      months.forEach(function(m) { if (m.total > maxTotal) maxTotal = m.total; });

      // Series = union of source ids present across months + bySource, ordered by
      // the registry so the legend/segment order is stable.
      var order = (typeof SOURCES !== 'undefined') ? Object.keys(SOURCES) : [];
      var seen = {};
      order.forEach(function(id) { seen[id] = true; });
      Object.keys(stats.bySource || {}).forEach(function(id) {
        if (!seen[id]) { order.push(id); seen[id] = true; }
      });

      var cols = months.map(function(m) {
        var segHtml;
        if (!m.total) {
          segHtml = '<div class="stats-bar-empty" title="No new summaries"></div>';
        } else {
          segHtml = '<div class="stats-bar-stack" style="height:' +
            (maxTotal ? (m.total / maxTotal * 100) : 0) + '%">' +
            order.map(function(id) {
              var n = (m.counts && m.counts[id]) || 0;
              if (!n) return '';
              var pct = (n / m.total * 100);
              return '<div class="stats-bar-seg" style="height:' + pct + '%;background:' +
                statsColor(id) + '" title="' + esc(statsSourceLabel(id)) + ': ' + n + '"></div>';
            }).join('') +
            '</div>';
        }
        var label = m.month.slice(2); // YY-MM
        return '<div class="stats-bar-col">' +
          '<div class="stats-bar-total">' + (m.total || '') + '</div>' +
          segHtml +
          '<div class="stats-bar-label">' + esc(label) + '</div>' +
          '</div>';
      }).join('');

      var legend = order.map(function(id) {
        var roll = (stats.bySource && stats.bySource[id]) || { inWindow: 0, undated: 0 };
        var undated = roll.undated
          ? ' <span class="undated">(+' + roll.undated + ' undated)</span>'
          : '';
        return '<span class="stats-legend-item">' +
          '<span class="stats-legend-swatch" style="background:' + statsColor(id) + '"></span>' +
          esc(statsSourceLabel(id)) + undated +
          '</span>';
      }).join('');

      return '<div class="stats-block"><h3>New summaries per month</h3>' +
        '<div class="stats-chart">' + cols + '</div>' +
        '<div class="stats-legend">' + legend + '</div></div>';
    }

    function renderStatsCoverage(stats) {
      var cov = stats.coverage || { windowDays: 30, total: 0, consumed: 0, pending: 0, neverClustered: [] };
      var never = cov.neverClustered || [];
      var strip = '<div class="stats-coverage-strip">' +
        '<span><span class="num">' + cov.total + '</span> new docs last ' + cov.windowDays + 'd</span>' +
        '<span class="sep">&middot;</span>' +
        '<span><span class="num consumed">' + cov.consumed + '</span> consumed by wiki proposals</span>' +
        '<span class="sep">&middot;</span>' +
        '<span><span class="num pending">' + cov.pending + '</span> pending review</span>' +
        '<span class="sep">&middot;</span>' +
        '<span><span class="num never">' + never.length + '</span> never clustered</span>' +
        (cov.undated
          ? '<span class="sep">&middot;</span><span><span class="num">' + cov.undated + '</span> undated (not windowed)</span>'
          : '') +
        // All-time ingest backlog (across every collection, not just the 30d window),
        // fetched separately from /api/wiki/ingest-backlog and filled in below.
        '<span class="sep">&middot;</span>' +
        '<span>all-time backlog: <span class="num never" id="statsBacklogNum">&hellip;</span></span>' +
        '</div>';

      var details = '';
      if (never.length) {
        var rows = never.map(function(d) {
          // Only linkify http(s) urls — esc() doesn't neutralize a javascript: scheme.
          var link = (d.url && /^https?:\\/\\//i.test(d.url))
            ? '<a class="stats-never-link" href="' + esc(d.url) + '" target="_blank" rel="noopener">open &#8599;</a>'
            : '';
          return '<div class="stats-never-row">' +
            (typeof sourceBadge === 'function' ? sourceBadge(d.source) : esc(d.source)) +
            '<span class="stats-never-title" title="' + esc(d.title || d.id) + '">' + esc(d.title || d.id) + '</span>' +
            link +
            '</div>';
        }).join('');
        details = '<details class="stats-never"><summary>Never-clustered docs (' + never.length + ')</summary>' +
          '<div class="stats-never-list">' + rows + '</div></details>';
      }

      return '<div class="stats-block"><h3>Gardener coverage (last ' + cov.windowDays + ' days)</h3>' +
        strip + details + '</div>';
    }

    // Fill the coverage strip's all-time backlog number from /api/wiki/ingest-backlog.
    // Uses the same bot default (jarvis) as the stats route. Best-effort — a failed
    // load just shows a dash, never breaks the strip.
    async function loadBacklogNum() {
      var el = document.getElementById('statsBacklogNum');
      if (!el) return;
      try {
        var bk = await getJson('/api/wiki/ingest-backlog?bot=jarvis');
        el.textContent = (bk && typeof bk.queued === 'number' && !bk.error) ? String(bk.queued) : '—';
      } catch (err) {
        el.textContent = '—';
      }
    }

    function renderStats(stats) {
      var body = document.getElementById('statsBody');
      if (!body) return;
      var errChip = '';
      if (stats.errors && stats.errors.length) {
        var srcs = stats.errors.map(function(e) { return e.source; }).join(', ');
        errChip = '<div class="stats-error-chip">Some sources could not be loaded: ' + esc(srcs) + '</div>';
      }
      var hasMonths = (stats.months || []).some(function(m) { return m.total > 0; });
      var body2 = renderStatsChart(stats) + renderStatsCoverage(stats);
      if (!hasMonths && stats.coverage && stats.coverage.total === 0 && (!stats.errors || !stats.errors.length)) {
        body.innerHTML = '<div class="stats-empty">No summaries ingested yet — summarize a few and check back.</div>';
        return;
      }
      body.innerHTML = errChip + body2;
      loadBacklogNum();
    }

    async function loadStats(force) {
      if (statsLoaded && !force) return;
      var body = document.getElementById('statsBody');
      if (!body) return;
      statsLoaded = true;
      try {
        var stats = await getJson('/api/summaries/stats' + (force ? '?refresh=1' : ''));
        renderStats(stats);
      } catch (err) {
        console.error('loadStats failed:', err);
        statsLoaded = false;
        body.innerHTML = '<div class="stats-empty error">Couldn\\'t load stats. ' +
          '<button class="outcomes-copy-btn" id="statsRetryBtn" type="button">Retry</button></div>';
        var rb = document.getElementById('statsRetryBtn');
        if (rb) rb.addEventListener('click', function() { loadStats(true); });
      }
    }
  `;
}
