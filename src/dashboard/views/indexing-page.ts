import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import {
  pageHeaderHtml,
  pageHeaderScript,
  pageHeaderStyles,
} from "./components/page-header.ts";
import { summaryTilesHtml, summaryTilesScript } from "./components/summary-tiles.ts";
import { statusChipsScript } from "./components/status-chips.ts";

/**
 * Indexing overview page — huginn's indexing-run ledger (dashboard redesign PR 2).
 * The three run classes merge into ONE card with collapsible group headers
 * ("Served, never tracked" collapsed by default); each row expands into a phase
 * timeline + duration bar-chart. The server renders the shell (page header, help
 * panel, empty tile row + card); the client fetches `/api/indexing/overview` and
 * re-renders every 15s. Group-collapse + row-expansion state survive that poll.
 *
 * Consumes the PR 1 shared primitives: `pageHeader*` (title + persisted help
 * panel), `summaryTiles*`/`tileHtml` (the stat row — tiles ship ready-made in the
 * payload), and `statusChipsScript`'s `runStatusChip`/`attentionChip`. An
 * unreachable huginn lands in the payload's `errors[]`; the client shows the
 * error banner rather than a 5xx.
 */
export async function renderIndexingPage(): Promise<string> {
  const helpers = await helpersClientScript();

  const helpHtml = `Huginn's indexing-run ledger — when each collection was last (re)indexed, how long it took, and
      whether a scheduled job is drifting. Collections are grouped: <strong>scheduled &amp; tracked</strong>
      first (the ones that can drift), then tracked-but-unscheduled manual scripts, then served-but-never-tracked
      collections. Data is huginn's <code>/api/indexing/jobs</code>, polled every 15s.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Indexing</title>
  <style>
    ${SHARED_STYLES}
    ${pageHeaderStyles()}

    .page { padding: 22px 28px 56px; max-width: 1560px; margin: 0 auto; }
    .pghdr-help code { background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .empty { color: var(--text-disabled); }

    /* --- One card container with collapsible group headers ------------------ */
    .idx-card { background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 12px; overflow-x: auto; }
    .idx-inner { min-width: 1080px; }

    .grp { border-top: 1px solid var(--border-primary); }
    .grp:first-child { border-top: none; }
    .grp-header {
      display: flex; align-items: center; gap: 8px; padding: 11px 16px;
      background: var(--bg-deep); border-bottom: 1px solid var(--border-primary);
      cursor: pointer; user-select: none;
    }
    .grp-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .grp-title { font-size: 11px; font-weight: 600; letter-spacing: 0.7px; text-transform: uppercase; color: var(--text-soft); }
    .grp-count { font-size: 11px; color: var(--text-faint); }
    .grp-sub { font-size: 11px; color: var(--text-dim); margin-left: 6px; }
    .grp-body[hidden] { display: none; }

    /* --- Grid rows (caret · collection · last-run · duration · median · next · job) --- */
    .idx-cols {
      display: grid; gap: 12px; align-items: center;
      grid-template-columns: 20px 250px 190px 80px 160px 180px 1fr;
    }
    .idx-head {
      padding: 7px 16px; border-bottom: 1px solid var(--border-subtle);
      font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-faint);
    }
    .idx-row { padding: 9px 16px; border-bottom: 1px solid var(--border-subtle); cursor: pointer; }
    .idx-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .idx-row-empty { padding: 14px 16px; color: var(--text-faint); font-size: 12px; }

    .col-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .col-name .name { font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .load-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .load-dot.on  { background: var(--status-success); }
    .load-dot.off { background: var(--text-disabled); }

    .col-last { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
    .col-dur { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-tertiary); }
    .col-median { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
    .col-next .cd { font-size: 12px; color: var(--text-tertiary); }
    .col-next .sched { font-size: 11px; color: var(--text-dim); }
    .col-job { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rel-dim { color: var(--text-soft); }

    /* Running badge (duration column) — reuses the shared pulse dot, tinted info. */
    .run-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--status-info); }
    .run-badge .pulse-dot { width: 7px; height: 7px; background: var(--status-info); }

    /* --- Expanded detail panel ---------------------------------------------- */
    .idx-detail[hidden] { display: none; }
    .detail {
      background: var(--bg-inset); border-bottom: 1px solid var(--border-subtle);
      padding: 16px 20px 18px 48px; display: flex; gap: 44px; flex-wrap: wrap;
    }
    .detail .d-block { min-width: 0; }
    .detail h4 { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-dim); font-weight: 600; margin: 0 0 9px; }
    .detail h4 .sub { color: var(--text-faint); font-weight: 500; text-transform: none; letter-spacing: 0; }

    /* Phase chips (page-local ph-*; shared header was renamed pghdr-* to avoid these). */
    .tl { display: flex; align-items: center; flex-wrap: wrap; }
    .tl-none { color: var(--text-disabled); font-style: italic; font-size: 12px; }
    .tl-note { color: var(--text-dim); font-size: 11px; margin-bottom: 6px; }
    .ph { display: flex; flex-direction: column; gap: 3px; padding: 7px 11px; border: 1px solid var(--border-primary); border-radius: 7px; background: var(--bg-surface); min-width: 72px; }
    .ph.fail { border-color: var(--status-error); background: color-mix(in srgb, var(--status-error) 8%, transparent); }
    .ph-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .ph-meta { display: flex; align-items: center; gap: 5px; font-size: 10px; }
    .ph-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--status-success); }
    .ph-dot.bad { background: var(--status-error); }
    .ph-dur { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted); }
    .ph-fatal { color: var(--text-faint); font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
    .ph-arrow { color: var(--text-disabled); padding: 0 7px; font-size: 13px; }

    /* Duration bar chart. Bars are HTML divs — the #317 SVG var() caveat does not
       apply; VARIANT_COLORS (single palette source) drives both bar + legend fill
       via inline background. A null-duration failed run renders a short hollow-red
       marker, NEVER a 0-height bar. */
    .bars-wrap { display: flex; flex-direction: column; }
    .bars { display: flex; align-items: flex-end; gap: 4px; height: 44px; }
    .bar { width: 9px; border-radius: 2px 2px 0 0; opacity: 0.9; flex-shrink: 0; }
    .bar-fail { background: transparent; border: 1px solid var(--status-error); box-sizing: border-box; }
    .bar-failmark { outline: 1px solid var(--status-error); outline-offset: -1px; }
    .bars-empty { color: var(--text-disabled); font-size: 12px; height: 44px; display: flex; align-items: flex-end; }
    .bars-legend { display: flex; gap: 14px; margin-top: 8px; font-size: 11px; color: var(--text-muted); flex-wrap: wrap; }
    .bars-legend .lg { display: inline-flex; align-items: center; gap: 5px; }
    .bars-legend .sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
    .bars-legend .md { color: var(--text-dim); }

    .err-note { color: var(--status-warning); font-size: 12px; margin: 8px 0; }
    .empty-msg { color: var(--text-faint); padding: 18px; text-align: center; }
  </style>
</head>
<body>
  ${renderNav("indexing")}

  <div class="page">
    ${pageHeaderHtml({
      title: "Indexing",
      metaHtml: `<span id="idxMeta">loading…</span>`,
      helpHtml,
    })}

    ${summaryTilesHtml("idxTiles")}

    <div id="errBox"></div>
    <div class="idx-card" id="idxCard">
      <div class="empty-msg">Loading…</div>
    </div>
  </div>

  <script>
    ${helpers}
    ${summaryTilesScript()}
    ${statusChipsScript()}
    ${pageHeaderScript("indexing")}

    // Row-expansion + group-collapse state — both survive the 15s re-render.
    var expanded = new Set();
    var groupOpen = { scheduled: true, tracked: true, never: false };

    // Single palette source for the duration bars + their legend swatches
    // (VARIANT_COLORS — kept from the sparkline machinery). Bars are HTML, so
    // inline background:var(...) resolves fine (the SVG caveat from #317 is moot).
    var VARIANT_COLORS = ['var(--accent)', 'var(--status-magenta)', 'var(--status-warning)', 'var(--status-info)'];
    function variantColor(i) { return VARIANT_COLORS[i % VARIANT_COLORS.length]; }
    function shortVariant(v) { return v === 'incremental' ? 'incr' : v; }

    function loadDot(loaded) {
      return '<span class="load-dot ' + (loaded ? 'on' : 'off') + '" title="' +
        (loaded ? 'loaded (searchable)' : 'not loaded') + '"></span>';
    }

    // ---- Row cells --------------------------------------------------------

    function collectionCell(row) {
      var chip = (row.attention === 'stale') ? attentionChip('STALE') : '';
      return '<div class="col-name">' + loadDot(row.loaded) +
        '<span class="name">' + esc(row.collection) + '</span>' + chip + '</div>';
    }

    // Relative-time tint: a failed run reads red, stale warning, aging muted-warning.
    // The STATUS dot itself stays true to the run status (a succeeded-but-stale run
    // keeps a green dot — the run did succeed; only the age text warns).
    function relClass(row) {
      if (row.failed) return 'run-error';
      if (row.attention === 'stale') return 'run-warning';
      if (row.attention === 'aging') return 'text-aging';
      return 'rel-dim';
    }

    function lastRunCell(row) {
      if (!row.lastStatus) return '<span class="col-last"><span class="empty">— never tracked —</span></span>';
      var chip = runStatusChip(row.lastStatus.status, row.lastStatus.label);
      var rel = row.lastRelative
        ? '<span class="' + relClass(row) + '">· ' + esc(row.lastRelative) + '</span>' : '';
      return '<span class="col-last">' + chip + rel + '</span>';
    }

    function durationCell(row) {
      if (row.running) {
        var el = row.runningElapsed ? '<span class="rel-dim">' + esc(row.runningElapsed) + '</span>' : '';
        return '<span class="run-badge"><span class="pulse-dot"></span>running' + (el ? ' ' + el : '') + '</span>';
      }
      if (row.lastDuration == null) return '<span class="empty">—</span>';
      return '<span class="col-dur">' + esc(row.lastDuration) + '</span>';
    }

    function medianCell(row) {
      if (!row.medians || row.medians.length === 0) return '<span class="empty">—</span>';
      return '<span class="col-median">' + row.medians.map(function (m) {
        return esc(m.duration) + ' ' + esc(shortVariant(m.variant));
      }).join(' · ') + '</span>';
    }

    function nextCell(row) {
      if (!row.nextScheduled && !row.nextRelative) return '<span class="empty">—</span>';
      var cd = row.nextRelative ? '<span class="cd">' + esc(row.nextRelative) + '</span>' : '';
      var sc = row.nextScheduled ? ' <span class="sched">' + esc(row.nextScheduled) + '</span>' : '';
      return '<span class="col-next">' + cd + sc + '</span>';
    }

    function jobCell(row) {
      return row.job ? '<span class="col-job">' + esc(row.job) + '</span>' : '<span class="empty">—</span>';
    }

    // ---- Expanded detail (phase timeline + duration bars) ------------------

    function phaseHtml(p) {
      var bad = p.nonFatalFailure || (p.status && (p.status.status === 'failed' || p.status.status === 'degraded'));
      var chip = p.status ? runStatusChip(p.status.status, p.status.label) : '<span class="ph-dot"></span>';
      var dur = p.duration ? '<span class="ph-dur">' + esc(p.duration) + '</span>' : '<span class="empty">—</span>';
      var fatal = p.fatal ? '<span class="ph-fatal" title="fatal to the run">fatal</span>' : '';
      return '<div class="ph' + (bad ? ' fail' : '') + '">' +
        '<span class="ph-name">' + esc(p.name) + '</span>' +
        '<span class="ph-meta">' + chip + dur + fatal + '</span>' +
      '</div>';
    }

    function timelineHtml(tl) {
      if (!tl || tl.kind === 'none') return '<div class="tl-none">no phases recorded</div>';
      var note = tl.kind === 'ordered'
        ? '<div class="tl-note">chronological — earliest first</div>'
        : '<div class="tl-note">arrival order — phase start times unavailable</div>';
      var connector = tl.kind === 'ordered' ? '<span class="ph-arrow">→</span>' : '';
      return note + '<div class="tl">' + tl.phases.map(phaseHtml).join(connector) + '</div>';
    }

    function barsHtml(spark) {
      if (!spark || !spark.points.length) return '<div class="bars-empty"><span class="empty">no history</span></div>';
      var max = spark.maxDurationSeconds || 1;
      var MAXH = 40, MINH = 3;
      var bars = spark.points.map(function (p) {
        var title = (p.duration || 'no duration') + ' · ' + p.variant + ' · ' + p.status.label;
        if (p.durationSeconds == null) {
          // Failed / incomplete null-duration — short hollow red marker, NEVER 0.
          return '<div class="bar bar-fail" style="height:10px" title="' + esc(title) + '"></div>';
        }
        var h = Math.max(MINH, Math.round((p.durationSeconds / max) * MAXH));
        var failed = p.status.status === 'failed' || p.status.status === 'degraded';
        var cls = 'bar' + (failed ? ' bar-failmark' : '');
        return '<div class="' + cls + '" style="height:' + h + 'px;background:' + variantColor(p.variantIndex) +
          '" title="' + esc(title) + '"></div>';
      }).join('');
      return '<div class="bars">' + bars + '</div>';
    }

    function medianLookup(row, variant) {
      var m = (row.medians || []).find(function (x) { return x.variant === variant; });
      return m ? m.duration : null;
    }

    function barsLegend(row, spark) {
      if (!spark || !spark.variants.length) return '';
      return '<div class="bars-legend">' + spark.variants.map(function (v, vi) {
        var med = medianLookup(row, v);
        var medTxt = med ? ' <span class="md">median ' + esc(med) + '</span>' : '';
        return '<span class="lg"><span class="sw" style="background:' + variantColor(vi) + '"></span>' +
          esc(shortVariant(v)) + medTxt + '</span>';
      }).join('') + '</div>';
    }

    function detailHtml(row) {
      var d = row.detail || { lastTimeline: { kind: 'none', phases: [] }, sparkline: { points: [], variants: [], maxDurationSeconds: null }, current: null };
      var blocks = '';
      if (row.running && d.current) {
        var el = row.runningElapsed ? ' <span class="sub">(' + esc(row.runningElapsed) + ' elapsed)</span>' : '';
        blocks += '<div class="d-block"><h4>In flight' + el + '</h4>' + timelineHtml(d.current) + '</div>';
      }
      blocks += '<div class="d-block"><h4>Last run phases</h4>' + timelineHtml(d.lastTimeline) + '</div>';
      var n = (d.sparkline && d.sparkline.points) ? d.sparkline.points.length : 0;
      blocks += '<div class="d-block bars-wrap"><h4>Duration history <span class="sub">— last ' + n +
        ' run' + (n === 1 ? '' : 's') + '</span></h4>' + barsHtml(d.sparkline) + barsLegend(row, d.sparkline) + '</div>';
      return '<div class="detail">' + blocks + '</div>';
    }

    // ---- Rows + groups -----------------------------------------------------

    function rowHtml(row) {
      var isOpen = expanded.has(row.collection);
      var r = '<div class="idx-row idx-cols hover-wash" data-col="' + esc(row.collection) +
        '" tabindex="0" role="button" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
        '<div><span class="caret' + (isOpen ? ' open' : '') + '">▸</span></div>' +
        collectionCell(row) +
        '<div>' + lastRunCell(row) + '</div>' +
        '<div>' + durationCell(row) + '</div>' +
        '<div>' + medianCell(row) + '</div>' +
        '<div>' + nextCell(row) + '</div>' +
        '<div>' + jobCell(row) + '</div>' +
      '</div>';
      var detail = '<div class="idx-detail" data-detail="' + esc(row.collection) + '"' +
        (isOpen ? '' : ' hidden') + '>' + detailHtml(row) + '</div>';
      return r + detail;
    }

    function groupHtml(cls) {
      var open = !!groupOpen[cls.key];
      var header = '<div class="grp-header" data-grp="' + esc(cls.key) + '" tabindex="0" role="button" aria-expanded="' +
        (open ? 'true' : 'false') + '">' +
        '<span class="caret' + (open ? ' open' : '') + '">▸</span>' +
        '<span class="grp-title">' + esc(cls.title) + '</span>' +
        '<span class="grp-count">' + cls.rows.length + '</span>' +
        '<span class="grp-sub">' + esc(cls.subtitle) + '</span>' +
      '</div>';
      var head = '<div class="idx-head idx-cols"><div></div><div>Collection</div><div>Last run</div>' +
        '<div>Duration</div><div>Median</div><div>Next run</div><div>Job label</div></div>';
      var body = cls.rows.length ? cls.rows.map(rowHtml).join('') : '<div class="idx-row-empty">None</div>';
      return '<div class="grp">' + header +
        '<div class="grp-body"' + (open ? '' : ' hidden') + '>' + head + body + '</div>' +
      '</div>';
    }

    // ---- Render ------------------------------------------------------------

    function render(data) {
      document.getElementById('errBox').innerHTML = (data.errors && data.errors.length)
        ? '<div class="err-note">Degraded sources: ' + esc(data.errors.join('; ')) + '</div>'
        : '';

      var total = data.total != null ? data.total : 0;
      var meta = document.getElementById('idxMeta');
      if (meta) {
        meta.textContent = total + ' collection' + (total === 1 ? '' : 's') +
          ' · updated ' + new Date(data.generatedAt || Date.now()).toLocaleTimeString() +
          ' · polls every 15s';
      }

      document.getElementById('idxTiles').innerHTML = (data.tiles || []).map(function (t) {
        return tileHtml(t);
      }).join('');

      // Prune expansion state for collections no longer present, so a collection
      // that disappears and later reappears doesn't ghost-re-expand.
      var present = new Set();
      (data.classes || []).forEach(function (cls) {
        (cls.rows || []).forEach(function (row) { present.add(row.collection); });
      });
      expanded.forEach(function (col) { if (!present.has(col)) expanded.delete(col); });

      document.getElementById('idxCard').innerHTML =
        '<div class="idx-inner">' + (data.classes || []).map(groupHtml).join('') + '</div>';
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

    // Toggles mutate state AND the DOM directly (responsive, no full re-render
    // flicker); the next poll re-renders consistently from the same state.
    // Delegated off the card because the subtree is rebuilt every poll.
    function toggleGroup(header) {
      var key = header.getAttribute('data-grp');
      if (!key) return;
      var open = !groupOpen[key];
      groupOpen[key] = open;
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
      var caret = header.querySelector('.caret');
      if (caret) caret.classList.toggle('open', open);
      var body = header.parentNode ? header.parentNode.querySelector('.grp-body') : null;
      if (body) body.hidden = !open;
    }

    function toggleRow(rowEl) {
      var col = rowEl.getAttribute('data-col');
      if (!col) return;
      var open = !expanded.has(col);
      if (open) expanded.add(col); else expanded.delete(col);
      rowEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      var caret = rowEl.querySelector('.caret');
      if (caret) caret.classList.toggle('open', open);
      var detail = rowEl.nextElementSibling;
      if (detail && detail.classList.contains('idx-detail')) detail.hidden = !open;
    }

    var cardEl = document.getElementById('idxCard');
    cardEl.addEventListener('click', function (ev) {
      var h = ev.target.closest ? ev.target.closest('.grp-header') : null;
      if (h) { toggleGroup(h); return; }
      var r = ev.target.closest ? ev.target.closest('.idx-row') : null;
      if (r) toggleRow(r);
    });
    cardEl.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      var h = ev.target.closest ? ev.target.closest('.grp-header') : null;
      var r = ev.target.closest ? ev.target.closest('.idx-row') : null;
      if (!h && !r) return;
      ev.preventDefault(); // stop Space from scrolling the page
      if (h) toggleGroup(h); else toggleRow(r);
    });

    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}
