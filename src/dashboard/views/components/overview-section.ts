/**
 * Overview (Home) section — the dashboard's landing view, rebuilt for the
 * dashboard-ux-w2 redesign:
 *   - a summary-tiles stat row (attention-border rule) replacing the emoji strip
 *   - a two-column body: LEFT = Now (live runs + up-next) · Attention · Usage;
 *     RIGHT = a single Activity column (the former bottom drawer, folded in here
 *     with inline All/Chat/System/Errors filter chips)
 *   - a slimmed 7-day usage chart (SVG bars + one total-token line, theme-aware
 *     via CSS classes — SVG presentation attrs never resolve var()), with the
 *     full 4-series Chart.js breakdown behind a toggle.
 *
 * The tile / chip builders come from the shared globals `tileHtml`, `kindChip`
 * (summary-tiles.ts / status-chips.ts). The live data is wired in connection.ts:
 * this file owns the render functions, connection.ts owns the SSE + fetches.
 */
export function overviewSectionStyles(): string {
  return `
    /* --- Home two-column layout --------------------------------------------- */
    .home-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1000px) { .home-grid { grid-template-columns: 1fr; } }
    .home-left { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .home-right { min-width: 0; }

    .home-card {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 10px; overflow: hidden;
    }
    .home-card-head {
      padding: 12px 16px; border-bottom: 1px solid var(--border-primary);
      display: flex; align-items: center; gap: 10px;
    }
    .home-card-title {
      font-size: 12px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
    }
    .home-card-sub { font-size: 11px; color: var(--text-faint); }
    .home-card-link {
      margin-left: auto; font-size: 11.5px; color: var(--accent-light);
      text-decoration: none; background: none; border: none; cursor: pointer;
      font-family: inherit; padding: 0;
    }
    .home-card-link:hover { text-decoration: underline; color: var(--accent); }
    .home-card-body { padding: 12px 16px; }
    .home-empty { padding: 14px 4px; font-size: 12px; color: var(--text-disabled); text-align: center; }

    /* --- Now card: live runs + up-next -------------------------------------- */
    .now-run {
      border: 1px solid color-mix(in srgb, var(--status-success) 25%, transparent);
      background: color-mix(in srgb, var(--status-success) 5%, transparent);
      border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;
    }
    .now-run-top { display: flex; align-items: center; gap: 9px; }
    .now-run .kind-chip { width: auto; }
    .now-dot {
      width: 9px; height: 9px; border-radius: 50%; background: var(--status-success);
      position: relative; flex-shrink: 0;
    }
    .now-dot::after {
      content: ''; position: absolute; inset: -4px; border-radius: 50%;
      background: var(--status-success); opacity: 0.35;
      animation: pulse-ring 1.6s ease-out infinite;
    }
    .now-run-name { font-size: 13px; color: var(--text-primary); flex: 1; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .now-run-elapsed { font-size: 11px; color: var(--text-faint);
      font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
    .now-bar { margin: 9px 0 2px 18px; height: 5px; border-radius: 3px; background: var(--bg-surface);
      position: relative; overflow: hidden; }
    .now-bar-fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 3px;
      background: var(--status-success); opacity: 0.75; transition: width 0.3s linear; }
    .now-sub { margin: 6px 0 0 18px; font-size: 11px; color: var(--text-muted); }
    .now-sub code { font-family: ui-monospace, Menlo, monospace; color: var(--text-secondary); }

    .un-row2 { display: flex; align-items: center; gap: 9px; padding: 7px 4px; border-radius: 8px; }
    .un-row2:hover { background: var(--bg-hover); }
    .un-node2 { width: 7px; height: 7px; border-radius: 50%; background: var(--border-secondary);
      flex-shrink: 0; margin: 0 1px; }
    .un-node2.soon { background: var(--status-success); }
    .un-row2 .kind-chip { flex-shrink: 0; }
    .un-name2 { font-size: 12.5px; color: var(--text-tertiary); flex: 1; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .un-when2 { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .un-when2.soon { color: var(--status-success); }

    /* --- Attention card ----------------------------------------------------- */
    .attn-count {
      display: inline-flex; align-items: center; font-size: 9px; font-weight: 700;
      letter-spacing: 0.5px; padding: 1px 7px; border-radius: 9px; line-height: 1.7;
      background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning);
    }
    .attn-row { display: flex; align-items: center; gap: 9px; padding: 6px 0; font-size: 12.5px; }
    .attn-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .attn-dot.warning { background: var(--status-warning); }
    .attn-dot.info    { background: var(--accent); }
    .attn-dot.error   { background: var(--status-error); }
    .attn-text { color: var(--text-tertiary); flex: 1; min-width: 0; }
    .attn-action { font-size: 11.5px; color: var(--accent-light); text-decoration: none; flex-shrink: 0; }
    .attn-action:hover { text-decoration: underline; color: var(--accent); }
    .attn-ok { padding: 10px 4px; font-size: 12.5px; color: var(--text-faint); }
    .attn-err { font-size: 11px; color: var(--status-warning); padding: 4px 0; }

    /* --- Usage chart (slim SVG, theme-aware via CSS classes) ----------------- */
    .uchart-legend { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); }
    .uchart-legend + .uchart-legend { margin-left: 6px; }
    .uchart-swatch-bar { width: 10px; height: 8px; border-radius: 2px; display: inline-block;
      background: var(--accent); opacity: 0.6; }
    .uchart-swatch-line { width: 10px; height: 3px; display: inline-block; background: var(--status-success); }
    .uchart-slim { padding: 14px 16px 8px; }
    .uchart-plot { position: relative; height: 150px; }
    .uchart-plot svg { width: 100%; height: 100%; display: block; }
    /* fill/stroke set here (CSS) — they resolve var(); as SVG presentation attrs
       they would NOT (the #316 lesson), hence classes not fill=/stroke=. */
    .uchart-bar  { fill: var(--accent); opacity: 0.55; }
    .uchart-line { fill: none; stroke: var(--status-success); stroke-width: 2; }
    .uchart-area { fill: var(--status-success); opacity: 0.09; }
    .uchart-grid { stroke: var(--border-primary); stroke-width: 1; }
    .uchart-xlabels { display: flex; justify-content: space-around; font-size: 10px;
      color: var(--text-faint); margin-top: 4px; }
    .uchart-full { padding: 8px; }

    /* --- Activity column (the folded-in drawer) ----------------------------- */
    .home-card-activity { display: flex; flex-direction: column; }
    .act-filters { margin-left: auto; display: flex; gap: 4px; }
    .act-chip {
      padding: 2px 9px; border-radius: 10px; font-size: 10.5px; font-weight: 600;
      color: var(--text-dim); background: transparent; border: 1px solid var(--border-secondary);
      cursor: pointer; font-family: inherit;
    }
    .act-chip:hover { color: var(--accent-light); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
    .act-chip.active {
      color: var(--accent-light); background: color-mix(in srgb, var(--accent) 15%, transparent);
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .live-badge { display: flex; align-items: center; gap: 6px; font-size: 11px;
      color: var(--status-success); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--status-success);
      animation: pulse-ring 2.4s ease-in-out infinite; }

    .feed-filter-bar {
      display: none; padding: 8px 12px; align-items: center; justify-content: space-between;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 15%, transparent);
      font-size: 12px; color: var(--accent-light); flex-shrink: 0;
    }
    .feed-filter-bar.visible { display: flex; }
    .feed-filter-clear {
      background: none; border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      color: var(--accent-light); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    }
    .feed-filter-clear:hover { background: color-mix(in srgb, var(--accent) 15%, transparent); }

    .feed-body { flex: 1; overflow-y: auto; padding: 6px 8px; max-height: 640px; }
    .feed-body::-webkit-scrollbar { width: 4px; }
    .feed-body::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

    /* Feed events (migrated from the retired activity-feed drawer) */
    .event { padding: 7px 10px; border-radius: 6px; font-size: 12.5px; line-height: 1.45;
      display: flex; gap: 10px; align-items: flex-start; }
    .event:hover { background: var(--bg-hover); }
    .event.act-hide { display: none; }
    .event.feed-dim { opacity: 0.15; }
    .event-time { color: var(--text-faint); font-size: 11px; font-family: ui-monospace, Menlo, monospace;
      white-space: nowrap; min-width: 40px; padding-top: 1px; }
    .event-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600;
      white-space: nowrap; min-width: 30px; text-align: center; height: fit-content; }
    .type-message_in .event-badge  { background: var(--tint-info);    color: var(--status-info); }
    .type-message_out .event-badge { background: var(--tint-success); color: var(--status-success); }
    .type-error .event-badge       { background: var(--tint-error);   color: var(--status-error); }
    .type-system .event-badge      { background: var(--tint-warning); color: var(--status-warning); }
    .event-main { flex: 1; min-width: 0; }
    .event-text { color: var(--text-soft); word-break: break-word; white-space: pre-wrap; }
    .event-timing { font-size: 10.5px; color: var(--text-faint); font-family: ui-monospace, Menlo, monospace;
      margin-top: 2px; }
    .event-timing .t-val { color: var(--accent-muted); }
    .event-bot { font-size: 10px; color: var(--text-faint); padding: 1px 6px; border-radius: 3px;
      background: color-mix(in srgb, var(--status-warning) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-warning) 15%, transparent); white-space: nowrap;
      height: fit-content; }
    .event-meta { color: var(--text-faint); font-size: 11px; white-space: nowrap; }
  `;
}

export function overviewSectionHtml(): string {
  return `
    <div data-section="overview" class="active">
      <div class="summary-tiles" id="overviewTiles"></div>

      <div class="home-grid">
        <div class="home-left">

          <div class="home-card">
            <div class="home-card-head">
              <span class="home-card-title">Now</span>
              <span class="home-card-sub" id="nowSub">idle</span>
              <a class="home-card-link" href="/agents">Open Agents &rarr;</a>
            </div>
            <div class="home-card-body" id="nowBody">
              <div class="home-empty">Loading...</div>
            </div>
          </div>

          <div class="home-card">
            <div class="home-card-head">
              <span class="home-card-title">Attention</span>
              <span class="attn-count" id="attnCount" hidden></span>
            </div>
            <div class="home-card-body" id="attnBody">
              <div class="home-empty">Loading...</div>
            </div>
          </div>

          <div class="home-card">
            <div class="home-card-head">
              <span class="home-card-title">Usage &middot; 7 days</span>
              <span class="uchart-legend"><span class="uchart-swatch-bar"></span>Messages</span>
              <span class="uchart-legend"><span class="uchart-swatch-line"></span>Tokens</span>
              <button class="home-card-link" id="uchartToggle" aria-expanded="false">Full breakdown</button>
            </div>
            <div class="home-card-body" style="padding:0">
              <div class="uchart-slim" id="uchartSlim">
                <div class="home-empty">Loading...</div>
              </div>
              <div class="uchart-full" id="uchartFull" hidden>
                <div class="chart-container"><canvas id="usageChart"></canvas></div>
              </div>
            </div>
          </div>
        </div>

        <div class="home-right">
          <div class="home-card home-card-activity">
            <div class="home-card-head">
              <span class="home-card-title">Activity</span>
              <div class="live-badge"><div class="live-dot"></div> Live</div>
              <div class="act-filters" id="actFilters">
                <button class="act-chip active" data-filter="all">All</button>
                <button class="act-chip" data-filter="chat">Chat</button>
                <button class="act-chip" data-filter="system">System</button>
                <button class="act-chip" data-filter="errors">Errors</button>
              </div>
            </div>
            <div class="feed-filter-bar" id="feedFilterBar">
              <span id="feedFilterLabel">Filtering...</span>
              <button class="feed-filter-clear" onclick="clearFeedFilter()">Clear filter</button>
            </div>
            <div class="feed-body" id="feed"></div>
          </div>
        </div>
      </div>
    </div>`;
}

export function overviewSectionScript(): string {
  return `
    // ---- shared home state (set by connection.ts loaders) ----
    var lastStats = null;         // DashboardStats
    var nowRuns = [];             // last agent_runs snapshot (all bots)
    var nowUpNext = [];           // last overview upNext (all bots)

    // ---- Summary tiles -----------------------------------------------------
    function homeTokens7d(stats) {
      return (stats.tokensByDay || []).reduce(function (a, t) {
        return a + (t.mainTokens || 0) + (t.haikuTokens || 0) + (t.watcherTokens || 0);
      }, 0);
    }
    function renderOverviewTiles() {
      var el = document.getElementById('overviewTiles');
      if (!el || !lastStats) return;
      var runs = nowRuns.filter(function (r) { return matchesBotOv(r.botName) && !r.completed; });
      var runSub = 'idle';
      if (runs.length) {
        var r0 = runs[0];
        runSub = (KIND_LABEL_OV[r0.kind || 'chat'] || 'Run') + (r0.botName ? ' \\u00b7 ' + r0.botName : '');
      }
      var tiles = [
        { label: 'Messages today', value: lastStats.messagesToday, sub: fmtTokens(lastStats.totalMessages) + ' total' },
        { label: 'Running now', value: runs.length, sub: runSub, tone: runs.length ? 'success' : undefined },
        { label: 'Goals', value: lastStats.activeGoalsCount, sub: 'active' },
        { label: 'Tasks', value: lastStats.scheduledTasksCount, sub: 'scheduled' },
        { label: 'Memories', value: fmtTokens(lastStats.memoriesCount), sub: 'stored' },
        { label: 'Tokens \\u00b7 7d', value: fmtTokens(homeTokens7d(lastStats)), sub: 'all jobs' }
      ];
      el.innerHTML = tiles.map(tileHtml).join('');
    }

    // ---- Now card ----------------------------------------------------------
    var KIND_LABEL_OV = {
      chat: 'Chat', scheduled_task: 'Task', watcher: 'Watcher', gardener_drain: 'Gardener',
      capture: 'Capture', research: 'Research', digest: 'Wiki digest', extractor: 'Extractor', profile: 'Profile'
    };
    var KIND_SHORT_OV = {
      chat: 'Chat', scheduled_task: 'Task', watcher: 'Watcher', gardener_drain: 'Gardener',
      capture: 'Capture', research: 'Research', digest: 'Digest', extractor: 'Extractor', profile: 'Profile'
    };
    function kindChipOv(kind) { return kindChip(KIND_SHORT_OV[kind] || kind || 'chat'); }
    function matchesBotOv(bot) { return !selectedBot || bot === selectedBot; }

    function fmtUntilOv(ts) {
      var diff = ts - Date.now();
      if (diff <= 0) return 'due now';
      var mins = Math.round(diff / 60000);
      if (mins < 1) return 'in <1m';
      if (mins < 60) return 'in ' + mins + 'm';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return 'in ' + hrs + 'h ' + (mins % 60) + 'm';
      var days = Math.floor(hrs / 24);
      if (days < 7) return 'in ' + days + 'd';
      return new Date(ts).toLocaleDateString();
    }

    function nowRunHtml(r) {
      var kind = r.kind || 'chat';
      var name = r.name || KIND_LABEL_OV[kind] || 'Run';
      var phase = r.phase || '';
      var subParts = [];
      if (r.botName) subParts.push(esc(r.botName));
      if (r.connectorLabel) subParts.push(esc(r.connectorLabel));
      if (r.model) subParts.push('<code>' + esc(r.model) + '</code>');
      var sub = subParts.join(' \\u00b7 ') + (phase ? ' \\u00b7 ' + esc(phase) : '');
      var bar = '';
      if (r.progress && r.progress.total > 0) {
        var pct = Math.min(100, Math.round((r.progress.done / r.progress.total) * 100));
        bar = '<div class="now-bar"><div class="now-bar-fill" style="width:' + pct + '%"></div></div>';
      }
      return '<div class="now-run">' +
        '<div class="now-run-top">' +
          '<span class="now-dot"></span>' +
          kindChipOv(kind) +
          '<span class="now-run-name" title="' + escapeAttr(name) + '">' + esc(name) + '</span>' +
          '<span class="now-run-elapsed" data-now-elapsed data-start="' + r.startedAt + '">' + fmtMs(Date.now() - r.startedAt) + '</span>' +
        '</div>' +
        bar +
        (sub ? '<div class="now-sub">' + sub + '</div>' : '') +
      '</div>';
    }

    function nowUpNextHtml(u) {
      var when = u.label || fmtUntilOv(u.nextRunAt);
      var soon = !!u.label || (u.nextRunAt - Date.now()) <= 1800000;
      var nameHtml = u.sourcePage
        ? '<a class="attn-action" href="' + escapeAttr(u.sourcePage) + '">' + esc(u.name) + '</a>'
        : esc(u.name);
      return '<div class="un-row2">' +
        '<span class="un-node2' + (soon ? ' soon' : '') + '"></span>' +
        kindChipOv(u.kind) +
        '<span class="un-name2">' + nameHtml + '</span>' +
        '<span class="un-when2' + (soon ? ' soon' : '') + '">' + esc(when) + '</span>' +
      '</div>';
    }

    function renderNow() {
      var body = document.getElementById('nowBody');
      var subEl = document.getElementById('nowSub');
      if (!body) return;
      var runs = nowRuns.filter(function (r) { return matchesBotOv(r.botName) && !r.completed; });
      var up = nowUpNext.filter(function (u) { return matchesBotOv(u.bot); });
      if (subEl) subEl.textContent = runs.length + ' running \\u00b7 ' + up.length + ' up next';
      if (!runs.length && !up.length) {
        body.innerHTML = '<div class="home-empty">Nothing running &middot; nothing scheduled</div>';
        renderOverviewTiles();
        return;
      }
      var html = runs.map(nowRunHtml).join('');
      html += up.slice(0, 5).map(nowUpNextHtml).join('');
      body.innerHTML = html;
      renderOverviewTiles();
    }

    // Cheap 1s elapsed tick for running rows (no full re-render → no pulse restart).
    setInterval(function () {
      var now = Date.now();
      document.querySelectorAll('[data-now-elapsed]').forEach(function (el) {
        var s = Number(el.getAttribute('data-start'));
        if (s) el.textContent = fmtMs(now - s);
      });
    }, 1000);

    // ---- Attention card ----------------------------------------------------
    function attnRowHtml(it) {
      return '<div class="attn-row">' +
        '<span class="attn-dot ' + esc(it.tone) + '"></span>' +
        '<span class="attn-text">' + esc(it.text) + '</span>' +
        '<a class="attn-action" href="' + escapeAttr(it.actionHref) + '">' + esc(it.actionLabel) + '</a>' +
      '</div>';
    }
    function renderAttention(data) {
      var body = document.getElementById('attnBody');
      var countEl = document.getElementById('attnCount');
      if (!body) return;
      var items = (data && data.items) || [];
      if (countEl) {
        if (items.length) { countEl.textContent = items.length; countEl.hidden = false; }
        else countEl.hidden = true;
      }
      var errNote = (data && data.errors && data.errors.length)
        ? '<div class="attn-err">Some checks degraded: ' + esc(data.errors.join('; ')) + '</div>' : '';
      if (!items.length) {
        body.innerHTML = errNote + '<div class="attn-ok">&#10003; Nothing needs your attention.</div>';
        return;
      }
      body.innerHTML = errNote + items.map(attnRowHtml).join('');
    }

    // ---- Usage chart (slim SVG + full toggle) ------------------------------
    function renderSlimChart(stats) {
      var el = document.getElementById('uchartSlim');
      if (!el) return;
      var days = stats.messagesByDay || [];
      var toks = stats.tokensByDay || [];
      if (!days.length) { el.innerHTML = '<div class="home-empty">No usage data yet</div>'; return; }
      var W = 700, H = 150, padT = 8, padB = 4;
      var n = days.length, slot = W / n, plotH = H - padT - padB;
      var maxMsg = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.count || 0; })));
      var totals = toks.map(function (t) { return (t.mainTokens || 0) + (t.haikuTokens || 0) + (t.watcherTokens || 0); });
      var maxTok = Math.max(1, Math.max.apply(null, totals.length ? totals : [0]));
      var barW = slot * 0.5;
      var grid = '';
      for (var g = 1; g <= 3; g++) {
        var gy = (padT + (plotH * g) / 4).toFixed(1);
        grid += '<line class="uchart-grid" x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '"></line>';
      }
      var bars = days.map(function (d, i) {
        var h = ((d.count || 0) / maxMsg) * plotH;
        var x = (i * slot + (slot - barW) / 2).toFixed(1);
        var y = (padT + plotH - h).toFixed(1);
        return '<rect class="uchart-bar" x="' + x + '" y="' + y + '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '"></rect>';
      }).join('');
      var pts = totals.map(function (t, i) {
        var x = (i * slot + slot / 2).toFixed(1);
        var y = (padT + plotH - (t / maxTok) * plotH).toFixed(1);
        return x + ',' + y;
      });
      var line = '', area = '';
      if (pts.length) {
        line = '<polyline class="uchart-line" vector-effect="non-scaling-stroke" points="' + pts.join(' ') + '"></polyline>';
        var baseY = (padT + plotH).toFixed(1);
        var firstX = pts[0].split(',')[0];
        var lastX = pts[pts.length - 1].split(',')[0];
        area = '<polygon class="uchart-area" points="' + firstX + ',' + baseY + ' ' + pts.join(' ') + ' ' + lastX + ',' + baseY + '"></polygon>';
      }
      var labels = days.map(function (d) {
        var wd = new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        return '<span>' + esc(wd) + '</span>';
      }).join('');
      el.innerHTML =
        '<div class="uchart-plot"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
          grid + bars + area + line +
        '</svg></div>' +
        '<div class="uchart-xlabels">' + labels + '</div>';
    }

    var uchartFullShown = false;
    function toggleUsageChart() {
      var slim = document.getElementById('uchartSlim');
      var full = document.getElementById('uchartFull');
      var btn = document.getElementById('uchartToggle');
      if (!slim || !full || !btn) return;
      uchartFullShown = !uchartFullShown;
      slim.hidden = uchartFullShown;
      full.hidden = !uchartFullShown;
      btn.setAttribute('aria-expanded', uchartFullShown ? 'true' : 'false');
      btn.textContent = uchartFullShown ? 'Slim view' : 'Full breakdown';
      if (uchartFullShown && lastStats && typeof initChart === 'function') {
        initChart(lastStats.messagesByDay || [], lastStats.tokensByDay || []);
      }
    }
    (function wireUsageToggle() {
      var btn = document.getElementById('uchartToggle');
      if (btn) btn.addEventListener('click', toggleUsageChart);
    })();

    // ---- Activity column (folded-in drawer) --------------------------------
    var currentActivityType = 'all'; // all | chat | system | errors

    function actTypeMatches(type) {
      switch (currentActivityType) {
        case 'chat':    return type === 'message_in' || type === 'message_out';
        case 'system':  return type === 'system';
        case 'errors':  return type === 'error';
        default:        return true;
      }
    }
    function applyActivityFilter() {
      var feedEl = document.getElementById('feed');
      if (!feedEl) return;
      for (var i = 0; i < feedEl.children.length; i++) {
        var child = feedEl.children[i];
        var t = child.getAttribute('data-ev-type') || '';
        child.classList.toggle('act-hide', !actTypeMatches(t));
      }
    }
    (function wireActivityFilters() {
      var bar = document.getElementById('actFilters');
      if (!bar) return;
      bar.addEventListener('click', function (e) {
        var btn = e.target.closest('.act-chip');
        if (!btn) return;
        currentActivityType = btn.dataset.filter || 'all';
        bar.querySelectorAll('.act-chip').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        applyActivityFilter();
      });
    })();

    function clearFeed() {
      var feedEl = document.getElementById('feed');
      if (feedEl) feedEl.innerHTML = '';
    }

    // Retarget the retired drawer's expand hook: bring the Activity column into
    // view by switching to the Overview tab (the feed now lives there).
    function expandActivityDrawer() {
      if (typeof switchSection === 'function') switchSection('overview');
      var feedEl = document.getElementById('feed');
      if (feedEl && feedEl.scrollIntoView) feedEl.scrollIntoView({ block: 'nearest' });
    }

    function badgeLabelOv(type) {
      switch (type) {
        case 'message_in': return 'IN';
        case 'message_out': return 'OUT';
        case 'error': return 'ERR';
        case 'system': return 'SYS';
        default: return type;
      }
    }
    function renderTimingOv(m) {
      var parts = [];
      if (m.startupMs > 500) parts.push('<span class="t-label">mcp:</span> <span class="t-val">' + fmtMs(m.startupMs) + '</span>');
      if (m.apiMs) parts.push('<span class="t-label">api:</span> <span class="t-val">' + fmtMs(m.apiMs) + '</span>');
      if (m.inputTokens || m.outputTokens) parts.push('<span class="t-val">' + fmtTokens(m.inputTokens || 0) + ' in / ' + fmtTokens(m.outputTokens || 0) + ' out</span>');
      if (m.model) parts.push('<span>' + escapeHtml(m.model) + '</span>');
      return parts.join(' &nbsp;&middot;&nbsp; ');
    }

    // addEvent — prepends one activity row to #feed. Applies BOTH the type-chip
    // filter (act-hide) and the watcher-name dim filter (feed-dim, owned by
    // watchers-panel via currentFeedFilter).
    function addEvent(ev) {
      var feedEl = document.getElementById('feed');
      if (!feedEl) return;
      var div = document.createElement('div');
      div.className = 'event type-' + ev.type;
      div.dataset.evType = ev.type;
      div.dataset.feedEvent = 'true';

      var meta = '';
      if (ev.durationMs) meta += fmtMs(ev.durationMs);
      if (ev.metadata && (ev.metadata.inputTokens || ev.metadata.outputTokens)) {
        var total = (ev.metadata.inputTokens || 0) + (ev.metadata.outputTokens || 0);
        meta += (meta ? ' &middot; ' : '') + fmtTokens(total) + ' tok';
      }
      if (ev.username) meta += (meta ? ' &middot; ' : '') + '@' + escapeHtml(ev.username);

      var botBadge = (ev.botName && !selectedBot) ? '<span class="event-bot">' + escapeHtml(ev.botName) + '</span>' : '';
      var timing = (ev.metadata && ev.type === 'message_out')
        ? '<div class="event-timing">' + renderTimingOv(ev.metadata) + '</div>' : '';

      div.innerHTML =
        '<span class="event-time">' + formatTime(ev.timestamp) + '</span>' +
        '<span class="event-badge">' + badgeLabelOv(ev.type) + '</span>' +
        botBadge +
        '<div class="event-main">' +
          '<span class="event-text">' + escapeHtml(ev.text) + '</span>' +
          timing +
        '</div>' +
        (meta ? '<span class="event-meta">' + meta + '</span>' : '');

      // Type-chip filter.
      if (!actTypeMatches(ev.type)) div.classList.add('act-hide');
      // Watcher-name dim filter (currentFeedFilter is defined in watchers-panel).
      if (typeof currentFeedFilter !== 'undefined' && currentFeedFilter) {
        var matches = ev.text && ev.text.includes('Watcher "' + currentFeedFilter + '"');
        if (!matches) div.classList.add('feed-dim');
      }

      feedEl.prepend(div);
    }
  `;
}
