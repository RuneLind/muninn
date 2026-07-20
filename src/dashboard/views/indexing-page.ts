import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { helpersClientScript } from "./components/helpers-client.ts";

/**
 * Indexing overview page — huginn's indexing-run ledger, grouped into three
 * classes (scheduled-first). Server renders the shell; the client fetches
 * `/api/indexing/overview` and re-renders every 15s (this page's data IS the
 * overview, so it re-fetches the overview endpoint — huginn caches on an mtime
 * signature, so the poll is cheap). An unreachable huginn lands in the payload's
 * `errors[]`, and the client shows the error banner instead of a 5xx.
 */
export async function renderIndexingPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Indexing</title>
  <style>
    ${SHARED_STYLES}

    .page { padding: 16px 24px 40px; }
    .intro { color: var(--text-muted); font-size: 13px; margin-bottom: 16px; max-width: 860px; line-height: 1.5; }
    .intro code { background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; font-size: 12px; }

    .section { margin-bottom: 28px; }
    .section h2 { font-size: 15px; color: var(--text-primary); font-weight: 600; margin-bottom: 4px; }
    .section h2 .count { color: var(--text-dim); font-weight: 500; font-size: 13px; margin-left: 6px; }
    .section .sub { font-size: 12px; color: var(--text-dim); margin-bottom: 10px; }

    .i-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .i-table th {
      text-align: left; padding: 8px 12px; color: var(--text-dim); font-weight: 500;
      text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border-primary); white-space: nowrap;
    }
    .i-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
    .i-table tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .i-table code { font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .dim { color: var(--text-dim); }
    .empty { color: var(--text-disabled); }

    /* Loaded indicator */
    .load-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: middle; }
    .load-dot.on  { background: var(--status-success); }
    .load-dot.off { background: var(--text-disabled); }

    /* Status badges. degraded must NOT read like success; skipped is neutral (not a fault). */
    .badge {
      display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; vertical-align: middle;
    }
    .badge-succeeded  { background: color-mix(in srgb, var(--status-success) 20%, transparent); color: var(--status-success); }
    .badge-degraded   { background: color-mix(in srgb, var(--status-warning) 22%, transparent); color: var(--status-warning); }
    .badge-failed     { background: color-mix(in srgb, var(--status-error) 20%, transparent); color: var(--status-error); }
    .badge-skipped    { background: var(--tint-neutral); color: var(--text-muted); }
    .badge-running    { background: color-mix(in srgb, var(--status-info) 20%, transparent); color: var(--status-info); }
    .badge-incomplete { background: color-mix(in srgb, var(--status-magenta) 20%, transparent); color: var(--status-magenta); }
    .badge-unknown    { background: var(--tint-neutral); color: var(--text-dim); }

    .run-badge { display: inline-flex; align-items: center; gap: 6px; }
    .run-badge .pulse-dot { width: 7px; height: 7px; background: var(--status-info); --pulse-anim: pulse-ring; }

    .medians { display: flex; flex-direction: column; gap: 2px; }
    .medians .mv { font-size: 11px; }
    .medians .mv .variant { color: var(--text-dim); }

    /* Expansion affordance */
    .i-table tbody tr.summary { cursor: pointer; }
    .caret { display: inline-block; width: 12px; color: var(--text-dim); transition: transform 0.12s ease; font-size: 10px; }
    tr.summary.open .caret { transform: rotate(90deg); }
    tr.detail-row > td { padding: 0; border-bottom: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--accent) 3%, transparent); }
    .detail { padding: 14px 18px 18px 30px; display: flex; flex-direction: column; gap: 16px; }
    .detail h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); font-weight: 600; margin: 0 0 8px; }
    .detail .d-block { min-width: 0; }

    /* Phase timeline */
    .tl { display: flex; align-items: stretch; flex-wrap: wrap; gap: 0; }
    .tl-none { color: var(--text-disabled); font-style: italic; font-size: 12px; }
    .tl-note { color: var(--text-dim); font-size: 11px; margin-bottom: 6px; }
    .ph { display: flex; flex-direction: column; gap: 3px; padding: 6px 10px; border: 1px solid var(--border-primary);
      border-radius: 6px; background: var(--bg-surface); min-width: 74px; }
    .ph.fail { border-color: var(--status-error); background: color-mix(in srgb, var(--status-error) 8%, transparent); }
    .ph .ph-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .ph .ph-meta { font-size: 10px; color: var(--text-dim); display: flex; align-items: center; gap: 5px; }
    .ph .ph-fatal { color: var(--text-faint); font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
    .ph-arrow { display: flex; align-items: center; color: var(--text-disabled); padding: 0 6px; font-size: 13px; }

    /* Sparkline. SVG geometry is colored via CSS classes — var() does NOT resolve
       in SVG presentation attributes (fill=/stroke=), only in CSS rules. The sv0-sv3
       variant palette here MUST mirror VARIANT_COLORS in the client script (the legend
       swatches read that array for their style="background:…"). */
    .spark-wrap { display: flex; flex-direction: column; gap: 6px; }
    .spark svg { display: block; }
    .spark .sv0 { fill: var(--accent); stroke: var(--accent); }
    .spark .sv1 { fill: var(--status-magenta); stroke: var(--status-magenta); }
    .spark .sv2 { fill: var(--status-warning); stroke: var(--status-warning); }
    .spark .sv3 { fill: var(--status-info); stroke: var(--status-info); }
    .spark .line { fill: none; }                          /* polyline: variant stroke, no fill */
    .spark .dot { stroke: var(--bg-primary); }            /* normal dot: variant fill, bg-colored rim */
    .spark .dot-fail { stroke: var(--status-error); }     /* failed/degraded dot: red rim */
    .spark .err { fill: none; stroke: var(--status-error); } /* null-duration hollow diamond */
    .spark-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--text-muted); }
    .spark-legend .lg { display: inline-flex; align-items: center; gap: 5px; }
    .spark-legend .sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    .spark-legend .lg .md { color: var(--text-dim); }
    .detail-grid { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; }

    .err-note { color: var(--status-warning); font-size: 12px; margin: 8px 0; }
    .empty-msg { color: var(--text-faint); padding: 18px; text-align: center; }
    .scroll { overflow-x: auto; }
    .updated { color: var(--text-dim); font-size: 11px; margin-bottom: 12px; }
  </style>
</head>
<body>
  ${renderNav("indexing")}

  <div class="page">
    <div class="intro">
      Huginn's indexing-run ledger — when each collection was last (re)indexed, how long it took, and
      whether a scheduled job is drifting. Collections are grouped: <strong>scheduled &amp; tracked</strong>
      first (the ones that can drift), then tracked-but-unscheduled manual scripts, then served-but-never-tracked
      collections. Data is huginn's <code>/api/indexing/jobs</code>, polled every 15s.
    </div>

    <div id="errBox"></div>
    <div class="updated" id="updated"></div>
    <div id="classes">
      <div class="empty-msg">Loading…</div>
    </div>
  </div>

  <script>
    ${helpers}

    // Collections whose depth row is expanded — survives the 15s re-render.
    var expanded = new Set();

    function loadDot(loaded) {
      return '<span class="load-dot ' + (loaded ? 'on' : 'off') + '" title="' +
        (loaded ? 'loaded (searchable)' : 'not loaded') + '"></span>';
    }

    function lastRunCell(row) {
      if (!row.lastStatus) return '<span class="empty">— never —</span>';
      var badge = '<span class="badge badge-' + esc(row.lastStatus.cls) + '">' + esc(row.lastStatus.label) + '</span>';
      var rel = row.lastRelative ? '<span class="dim"> ' + esc(row.lastRelative) + '</span>' : '';
      return badge + rel;
    }

    function durationCell(row) {
      if (row.running) {
        var el = row.runningElapsed ? '<span class="dim">' + esc(row.runningElapsed) + '</span>' : '';
        return '<span class="run-badge"><span class="pulse-dot"></span><span class="badge badge-running">running</span>' +
          (el ? ' ' + el : '') + '</span>';
      }
      if (row.lastDuration == null) return '<span class="empty">—</span>';
      return '<code>' + esc(row.lastDuration) + '</code>';
    }

    function mediansCell(row) {
      if (!row.medians || row.medians.length === 0) return '<span class="empty">—</span>';
      return '<div class="medians">' + row.medians.map(function (m) {
        return '<span class="mv"><code>' + esc(m.duration) + '</code> <span class="variant">' + esc(m.variant) + '</span></span>';
      }).join('') + '</div>';
    }

    function scheduleCell(row) {
      return row.nextScheduled ? '<code>' + esc(row.nextScheduled) + '</code>' : '<span class="empty">—</span>';
    }

    function jobCell(row) {
      return row.job ? '<code class="dim">' + esc(row.job) + '</code>' : '<span class="empty">—</span>';
    }

    // ---- Per-collection depth (expansion row) -----------------------------

    // Palette used to distinguish run variants (incremental vs rebuild vs …).
    // The legend swatches use these values as inline style="background:…"; the SVG
    // geometry uses the mirrored .sv0-.sv3 CSS classes (var() can't resolve in SVG
    // presentation attributes). Both wrap via % length, so keep them the same length.
    var VARIANT_COLORS = ['var(--accent)', 'var(--status-magenta)', 'var(--status-warning)', 'var(--status-info)'];
    function variantColor(i) { return VARIANT_COLORS[i % VARIANT_COLORS.length]; }
    function variantClass(i) { return 'sv' + (i % VARIANT_COLORS.length); }

    function phaseHtml(p) {
      var cls = 'ph' + (p.nonFatalFailure || (p.status && p.status.status === 'failed') ? ' fail' : '');
      var badge = '<span class="badge badge-' + esc(p.status.cls) + '">' + esc(p.status.label) + '</span>';
      var dur = p.duration ? '<code>' + esc(p.duration) + '</code>' : '<span class="empty">—</span>';
      var fatal = p.fatal ? '<span class="ph-fatal" title="fatal to the run">fatal</span>' : '';
      return '<div class="' + cls + '">' +
        '<span class="ph-name">' + esc(p.name) + '</span>' +
        '<span class="ph-meta">' + badge + dur + fatal + '</span>' +
      '</div>';
    }

    function timelineHtml(tl) {
      if (!tl || tl.kind === 'none') return '<div class="tl-none">no phases recorded</div>';
      var note = tl.kind === 'ordered'
        ? '<div class="tl-note">chronological — earliest first</div>'
        : '<div class="tl-note">arrival order — phase start times unavailable</div>';
      var connector = tl.kind === 'ordered' ? '<div class="ph-arrow">→</div>' : '';
      var chips = tl.phases.map(phaseHtml).join(connector);
      return note + '<div class="tl">' + chips + '</div>';
    }

    function sparkSvg(spark) {
      if (!spark || !spark.points.length) return '<span class="empty">no history</span>';
      var pts = spark.points;
      var H = 46, padT = 7, padB = 11, step = 16, padL = 6, padR = 6;
      var W = padL + padR + Math.max(1, pts.length - 1) * step;
      var max = spark.maxDurationSeconds || 1;
      function xOf(i) { return padL + i * step; }
      function yOf(v) { return H - padB - (v / max) * (H - padT - padB); }
      var baseY = H - padB;

      // Per-variant trend polylines (only real, non-null durations).
      var lines = spark.variants.map(function (v, vi) {
        var seg = [];
        pts.forEach(function (p, i) {
          if (p.variant === v && p.durationSeconds != null) seg.push(xOf(i) + ',' + yOf(p.durationSeconds));
        });
        if (seg.length < 2) return '';
        return '<polyline points="' + seg.join(' ') + '" class="line ' + variantClass(vi) +
          '" stroke-width="1.5" stroke-opacity="0.55" />';
      }).join('');

      var dots = pts.map(function (p, i) {
        var x = xOf(i);
        var title = (p.duration || 'no duration') + ' · ' + p.variant + ' · ' + p.status.label;
        if (p.durationSeconds == null) {
          // Null duration (failed/incomplete) — a hollow red marker at baseline. NEVER a 0 dot.
          return '<path d="M' + (x - 3) + ',' + baseY + ' L' + x + ',' + (baseY - 4) + ' L' + (x + 3) + ',' + baseY +
            ' L' + x + ',' + (baseY + 4) + ' Z" class="err" stroke-width="1.3">' +
            '<title>' + esc(title) + '</title></path>';
        }
        var y = yOf(p.durationSeconds);
        var failed = p.status.status === 'failed' || p.status.status === 'degraded';
        var dotCls = variantClass(p.variantIndex) + (failed ? ' dot-fail' : ' dot');
        return '<circle cx="' + x + '" cy="' + y + '" r="2.6" class="' + dotCls +
          '" stroke-width="1"><title>' + esc(title) + '</title></circle>';
      }).join('');

      return '<div class="spark"><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
        '" role="img" aria-label="duration history">' + lines + dots + '</svg></div>';
    }

    function medianLookup(row, variant) {
      var m = (row.medians || []).find(function (x) { return x.variant === variant; });
      return m ? m.duration : null;
    }

    function sparkLegend(row, spark) {
      return '<div class="spark-legend">' + spark.variants.map(function (v, vi) {
        var med = medianLookup(row, v);
        var medTxt = med ? ' <span class="md">median ' + esc(med) + '</span>' : '';
        return '<span class="lg"><span class="sw" style="background:' + variantColor(vi) + '"></span>' +
          esc(v) + medTxt + '</span>';
      }).join('') + '</div>';
    }

    function detailHtml(row) {
      var d = row.detail || { lastTimeline: { kind: 'none', phases: [] }, sparkline: { points: [], variants: [], maxDurationSeconds: null }, current: null };
      var blocks = '';

      if (row.running && d.current) {
        var el = row.runningElapsed ? ' <span class="dim">(' + esc(row.runningElapsed) + ' elapsed)</span>' : '';
        blocks += '<div class="d-block"><h4>In flight' + el + '</h4>' + timelineHtml(d.current) + '</div>';
      }

      blocks += '<div class="d-block"><h4>Last run phases</h4>' + timelineHtml(d.lastTimeline) + '</div>';

      blocks += '<div class="detail-grid">' +
        '<div class="d-block spark-wrap"><h4>Duration history</h4>' + sparkSvg(d.sparkline) +
          sparkLegend(row, d.sparkline) + '</div>' +
      '</div>';

      return '<div class="detail">' + blocks + '</div>';
    }

    function rowHtml(row) {
      var isOpen = expanded.has(row.collection);
      var summary = '<tr class="summary' + (isOpen ? ' open' : '') + '" data-col="' + esc(row.collection) +
        '" tabindex="0" role="button" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
        '<td><span class="caret">▸</span> <strong>' + esc(row.collection) + '</strong></td>' +
        '<td>' + loadDot(row.loaded) + '</td>' +
        '<td>' + lastRunCell(row) + '</td>' +
        '<td>' + durationCell(row) + '</td>' +
        '<td>' + mediansCell(row) + '</td>' +
        '<td>' + scheduleCell(row) + '</td>' +
        '<td>' + jobCell(row) + '</td>' +
      '</tr>';
      var detail = '<tr class="detail-row" data-col="' + esc(row.collection) + '"' +
        (isOpen ? '' : ' style="display:none"') + '><td colspan="7">' + detailHtml(row) + '</td></tr>';
      return summary + detail;
    }

    function classHtml(cls) {
      var body = cls.rows.length
        ? cls.rows.map(rowHtml).join('')
        : '<tr><td colspan="7" class="empty-msg">None</td></tr>';
      return '<div class="section">' +
        '<h2>' + esc(cls.title) + '<span class="count">(' + cls.rows.length + ')</span></h2>' +
        '<div class="sub">' + esc(cls.subtitle) + '</div>' +
        '<div class="scroll"><table class="i-table">' +
          '<thead><tr>' +
            '<th>Collection</th><th>Loaded</th><th>Last run</th><th>Duration</th>' +
            '<th>Median</th><th>Next scheduled</th><th>Job label</th>' +
          '</tr></thead>' +
          '<tbody>' + body + '</tbody>' +
        '</table></div>' +
      '</div>';
    }

    function render(data) {
      document.getElementById('errBox').innerHTML = (data.errors && data.errors.length)
        ? '<div class="err-note">Degraded sources: ' + esc(data.errors.join('; ')) + '</div>'
        : '';
      var total = data.total != null ? data.total : 0;
      document.getElementById('updated').textContent =
        total + ' collection' + (total === 1 ? '' : 's') + ' · updated ' + new Date(data.generatedAt || Date.now()).toLocaleTimeString();

      // Prune expansion state for collections no longer in the payload, so a
      // collection that disappears and later reappears doesn't ghost-re-expand.
      var present = new Set();
      (data.classes || []).forEach(function (cls) {
        (cls.rows || []).forEach(function (row) { present.add(row.collection); });
      });
      expanded.forEach(function (col) { if (!present.has(col)) expanded.delete(col); });

      document.getElementById('classes').innerHTML = (data.classes || []).map(classHtml).join('');
    }

    async function load() {
      try {
        var data = await fetch('/api/indexing/overview').then(function (r) { return r.json(); });
        render(data);
      } catch (e) {
        document.getElementById('errBox').innerHTML =
          '<div class="err-note">Failed to load overview: ' + esc(String(e)) + '</div>';
      }
    }

    // Toggle a collection's depth row. Delegated (click + keyboard) because the
    // table is re-rendered on every poll — direct listeners would die each cycle.
    function toggleSummary(tr) {
      var col = tr.getAttribute('data-col');
      if (!col) return;
      var detail = tr.nextElementSibling;
      if (expanded.has(col)) {
        expanded.delete(col);
        tr.classList.remove('open');
        tr.setAttribute('aria-expanded', 'false');
        if (detail && detail.classList.contains('detail-row')) detail.style.display = 'none';
      } else {
        expanded.add(col);
        tr.classList.add('open');
        tr.setAttribute('aria-expanded', 'true');
        if (detail && detail.classList.contains('detail-row')) detail.style.display = '';
      }
    }

    var classesEl = document.getElementById('classes');
    classesEl.addEventListener('click', function (ev) {
      var tr = ev.target.closest ? ev.target.closest('tr.summary') : null;
      if (tr) toggleSummary(tr);
    });
    classesEl.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      var tr = ev.target.closest ? ev.target.closest('tr.summary') : null;
      if (!tr) return;
      ev.preventDefault(); // stop Space from scrolling the page
      toggleSummary(tr);
    });

    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}
