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

    function rowHtml(row) {
      return '<tr>' +
        '<td><strong>' + esc(row.collection) + '</strong></td>' +
        '<td>' + loadDot(row.loaded) + '</td>' +
        '<td>' + lastRunCell(row) + '</td>' +
        '<td>' + durationCell(row) + '</td>' +
        '<td>' + mediansCell(row) + '</td>' +
        '<td>' + scheduleCell(row) + '</td>' +
        '<td>' + jobCell(row) + '</td>' +
      '</tr>';
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

    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}
