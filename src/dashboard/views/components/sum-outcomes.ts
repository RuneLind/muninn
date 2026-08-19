/** Summaries page — the Calibration tab (gate-outcome calibration, display-only).
 *
 * Renders the labeled capture-gate dataset that `summary_candidates` has become: every
 * row carries the gate `score`, its `kind`, and a terminal `status` (summarized = judged
 * worth a summary, dismissed = not). This tab turns that into three read-only views over
 * GET /api/anthropic/candidates/stats?days=N:
 *  - a windowed "last N days" block (7/14/30) at the TOP,
 *  - a per-(source, kind) acceptance table,
 *  - a 0.1-wide score-band histogram of outcomes,
 *  - suggested per-kind capture floors + a copyable `candidateMinScoreByKind` JSON snippet.
 *
 * The windowed block exists because the three all-time views cannot answer "is the change
 * that shipped this week working?" and cannot show rows nobody ever TRIAGED (they count
 * terminal statuses only). It puts Untriaged in its own amber column next to Rejected —
 * "never looked at" and "a human said no" are different facts — states its acceptance
 * target from the payload (`recent.target`, never hardcoded here), and for x carries the
 * organic judging metric for the #454 repackaging clamp — whose CAP and effective floor
 * also come from the payload (`recent.repackaging`), target 0. A null `recent` hides the
 * whole block rather than leaving a live select over an empty body.
 *
 * Acceptance rate = summarized / (summarized + manually-dismissed) — auto-expired,
 * bulk-swept (the one-shot X hype-dedup backlog sweep) and pre-migration ("unknown")
 * dismissals are shown as separate columns but kept OUT of the
 * denominator (they aren't accept/reject judgements). This tab NEVER writes watcher config;
 * the operator hand-copies the suggested floors into a bot's config.json. Uses the shared
 * esc() + getJson() helpers (all summaries component scripts share one page scope). */

export function sumOutcomesStyles(): string {
  return `
    .outcomes-section {
      margin-top: 8px;
      margin-bottom: 32px;
    }
    .outcomes-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 4px;
    }
    .outcomes-subtitle {
      font-size: 13px;
      color: var(--text-dim);
      margin: 0 0 18px;
    }
    .outcomes-block { margin-bottom: 26px; }
    .outcomes-block h3 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-dim);
      margin: 0 0 8px;
    }
    .outcomes-table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-card);
    }
    table.outcomes-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    table.outcomes-table th, table.outcomes-table td {
      padding: 7px 12px;
      text-align: right;
      white-space: nowrap;
      border-bottom: 1px solid var(--border-primary);
    }
    table.outcomes-table th:first-child, table.outcomes-table td:first-child {
      text-align: left;
    }
    table.outcomes-table thead th {
      color: var(--text-dim);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    table.outcomes-table tbody tr:last-child td { border-bottom: none; }
    table.outcomes-table td.dim { color: var(--text-dim); }
    .outcomes-acc {
      font-weight: 700;
      color: var(--text-soft);
    }
    .outcomes-acc[data-band="high"] { color: var(--status-success); }
    .outcomes-acc[data-band="low"] { color: var(--status-error); }

    /* --- Windowed "last N days" block --- */
    .outcomes-window-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .outcomes-window-head h3 { margin: 0; }
    .outcomes-window-label {
      font-size: 12px;
      color: var(--text-dim);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .outcomes-window-label select {
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      border: 1px solid var(--border-secondary);
      background: var(--bg-surface);
      color: var(--text-primary);
    }
    /* "Never looked at" must not read like "rejected" — it is amber and bold, while
       the manual-rejection column stays plain. That separation is the whole point. */
    .outcomes-untriaged { font-weight: 700; color: var(--status-warning); }
    .outcomes-untriaged[data-zero="1"] { font-weight: 400; color: var(--text-dim); }
    .outcomes-target-note {
      font-size: 12px;
      color: var(--text-dim);
      margin: 8px 0 0;
    }
    .outcomes-repack[data-band="ok"] { color: var(--status-success); font-weight: 600; }
    .outcomes-repack[data-band="bad"] { color: var(--status-error); font-weight: 700; }
    .outcomes-kind-tag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 4px;
      font-size: 11px;
      border: 1px solid var(--border-secondary);
      color: var(--text-soft);
      background: var(--bg-surface);
    }

    .outcomes-snippet {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }
    .outcomes-snippet:last-child { margin-bottom: 0; }
    .outcomes-snippet-hint {
      font-size: 12px;
      color: var(--text-dim);
    }
    .outcomes-snippet pre {
      margin: 0;
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-primary);
    }
    .outcomes-copy-btn {
      align-self: flex-start;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border-secondary);
      background: var(--bg-surface);
      color: var(--text-secondary);
    }
    .outcomes-copy-btn:hover { border-color: var(--accent); color: var(--text-primary); }

    .outcomes-empty {
      padding: 22px 14px;
      text-align: center;
      font-size: 13px;
      color: var(--text-dim);
      border: 1px dashed var(--border-primary);
      border-radius: 8px;
    }
    .outcomes-empty.error {
      color: var(--status-error);
      border-color: color-mix(in srgb, var(--status-error) 40%, transparent);
    }
  `;
}

export function sumOutcomesHtml(): string {
  return `
    <div class="outcomes-section" id="outcomesSection">
      <h2>Calibration</h2>
      <p class="outcomes-subtitle">
        Capture-gate quality from the labeled candidate history. Acceptance = summarized ÷ (summarized + manually dismissed);
        auto-expired, bulk-swept and pre-tracking dismissals are shown separately and excluded from that rate. Display only — copy the
        suggested floors into a bot's <code>candidateMinScoreByKind</code> yourself.
      </p>
      <div class="outcomes-block" id="outcomesRecentBlock">
        <div class="outcomes-window-head">
          <h3 id="outcomesRecentTitle">Last 7 days</h3>
          <label class="outcomes-window-label">Window
            <select id="outcomesWindowSel">
              <option value="7" selected>7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
        </div>
        <div id="outcomesRecentBody"></div>
      </div>
      <div id="outcomesBody"></div>
    </div>`;
}

export function sumOutcomesScript(): string {
  return `
    // candidateMinScoreByKind keys, split by watcher so each snippet pastes into the
    // RIGHT config (suggestedFloors is source-agnostic — keyed by kind only — so a single
    // merged blob would carry a wrong paste target). Anthropic kinds → the Anthropic
    // Highlights watcher; the X kinds ('x-post' long-form, 'x-link' pointer tweets) → the
    // X Highlights watcher, which now also reads a per-kind candidateMinScoreByKind map.
    var OUTCOME_ANTHROPIC_KINDS = ['commit', 'release', 'doc', 'blog'];
    var OUTCOME_X_KINDS = ['x-post', 'x-link'];

    // The all-time tables band against the same 0.5 the floor heuristic targets. The
    // windowed block below takes its target from the PAYLOAD (recent.target) instead of
    // hardcoding a second copy — see outcomeAcc's optional target argument.
    function outcomeAcc(o, target) {
      var t = typeof target === 'number' ? target : 0.5;
      if (o.acceptanceRate == null) return '<span class="outcomes-acc" data-band="none">—</span>';
      var pct = Math.round(o.acceptanceRate * 100);
      var band = o.acceptanceRate >= t ? 'high' : 'low';
      return '<span class="outcomes-acc" data-band="' + band + '">' + pct + '%</span>';
    }

    function outcomeBandLabel(band) {
      return band.toFixed(1) + '\\u2013' + (band + 0.1).toFixed(1);
    }

    // A per-kind / per-band counts row → table cells (shared column layout).
    function outcomeCountCells(o) {
      return '<td>' + o.total + '</td>' +
        '<td>' + o.summarized + '</td>' +
        '<td>' + o.dismissedManual + '</td>' +
        '<td class="dim">' + o.dismissedExpired + '</td>' +
        '<td class="dim">' + (o.dismissedSwept || 0) + '</td>' +
        '<td class="dim">' + (o.dismissedOther || 0) + '</td>' +
        '<td class="dim">' + o.dismissedUnknown + '</td>' +
        '<td class="dim">' + o.error + '</td>' +
        '<td>' + outcomeAcc(o) + '</td>';
    }

    function outcomeCountHeader(firstLabel) {
      return '<thead><tr>' +
        '<th>' + firstLabel + '</th>' +
        '<th>Total</th><th>Summ.</th><th>Dismiss</th>' +
        '<th title="Auto-dismissed stale after 14 idle days — excluded from Accept">Expired</th>' +
        '<th title="Bulk-dismissed by the one-shot hype-dedup backlog sweep — excluded from Accept">Swept</th>' +
        '<th title="Dismissed with some other recorded reason — counted in Total, excluded from Accept">Other</th>' +
        '<th>Unknown</th><th>Error</th><th>Accept</th>' +
        '</tr></thead>';
    }

    function renderByKindBlock(byKind) {
      if (!byKind.length) return '';
      var rows = byKind.map(function(o) {
        var kindTag = o.kind
          ? '<span class="outcomes-kind-tag">' + esc(o.kind) + '</span>'
          : '<span class="outcomes-kind-tag">—</span>';
        return '<tr><td>' + esc(o.source) + ' ' + kindTag + '</td>' + outcomeCountCells(o) + '</tr>';
      }).join('');
      return '<div class="outcomes-block"><h3>By source &amp; kind</h3>' +
        '<div class="outcomes-table-wrap"><table class="outcomes-table">' +
        outcomeCountHeader('Source / kind') + '<tbody>' + rows + '</tbody></table></div></div>';
    }

    function renderByBandBlock(byBand) {
      if (!byBand.length) return '';
      // Highest band first — the score histogram reads top-down like the inbox.
      var ordered = byBand.slice().sort(function(a, b) { return b.band - a.band; });
      var rows = ordered.map(function(o) {
        return '<tr><td>' + esc(outcomeBandLabel(o.band)) + '</td>' + outcomeCountCells(o) + '</tr>';
      }).join('');
      return '<div class="outcomes-block"><h3>By score band</h3>' +
        '<div class="outcomes-table-wrap"><table class="outcomes-table">' +
        outcomeCountHeader('Score band') + '<tbody>' + rows + '</tbody></table></div></div>';
    }

    function renderSuggestedBlock(suggestedFloors) {
      if (!suggestedFloors.length) return '';
      var rows = suggestedFloors.map(function(s) {
        var val = s.suggestedFloor == null ? '—' : s.suggestedFloor.toFixed(1);
        return '<tr><td><span class="outcomes-kind-tag">' + esc(s.kind) + '</span></td>' +
          '<td>' + val + '</td></tr>';
      }).join('');
      var table = '<div class="outcomes-table-wrap"><table class="outcomes-table">' +
        '<thead><tr><th>Kind</th><th>Suggested floor</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';

      // Two source-scoped snippets, each pasting into its OWN watcher config. Each
      // snippet is built from that watcher's config-relevant kinds only, dropping any
      // with no suggestion (null) — a floor we can't recommend shouldn't silently ship
      // as a key. A snippet renders only when its kind set has at least one suggestion.
      var anthropicHtml = renderSnippetGroup(suggestedFloors, OUTCOME_ANTHROPIC_KINDS,
        'anthropic', 'Anthropic Highlights');
      var xHtml = renderSnippetGroup(suggestedFloors, OUTCOME_X_KINDS, 'x', 'X Highlights');
      var anySnippet = anthropicHtml.hasSnippet || xHtml.hasSnippet;
      var snippetHtml = anySnippet
        ? anthropicHtml.html + xHtml.html
        : '<div class="outcomes-snippet-hint">Not enough labeled outcomes yet to suggest floors for the config kinds.</div>';

      return '<div class="outcomes-block"><h3>Suggested capture floors</h3>' + table + snippetHtml + '</div>';
    }

    // Build one candidateMinScoreByKind snippet for a watcher's kind set. idSuffix
    // makes the pre/button ids unique (outcomesSnippet-anthropic / -x) so both
    // Copy buttons work independently. Returns { hasSnippet, html } — empty html when
    // no kind in the set has a suggestion (that snippet is simply omitted).
    function renderSnippetGroup(suggestedFloors, kinds, idSuffix, watcherLabel) {
      var snippet = {};
      suggestedFloors.forEach(function(s) {
        if (s.suggestedFloor != null && kinds.indexOf(s.kind) !== -1) {
          snippet[s.kind] = s.suggestedFloor;
        }
      });
      if (Object.keys(snippet).length === 0) return { hasSnippet: false, html: '' };
      var json = JSON.stringify({ candidateMinScoreByKind: snippet }, null, 2);
      var html = '<div class="outcomes-snippet">' +
        '<div class="outcomes-snippet-hint">Paste into the ' + esc(watcherLabel) + ' watcher config ' +
        '(heuristic: lowest 0.1 band whose at-or-above acceptance ≥ 50%). Review before applying.</div>' +
        '<pre id="outcomesSnippet-' + idSuffix + '">' + esc(json) + '</pre>' +
        '<button class="outcomes-copy-btn" id="outcomesCopyBtn-' + idSuffix + '" type="button">Copy JSON</button>' +
      '</div>';
      return { hasSnippet: true, html: html };
    }

    // --- Windowed "last N days" block ---------------------------------------
    // Its point is the two columns the all-time tables cannot show: Untriaged
    // ("never looked at" — status new/summarizing, NOT a rejection) and, for x,
    // the repackaging-clamp miss count — rows the #454 clamp did not reach. Target 0.
    // The cap and the count's effective floor come from the PAYLOAD (recent.repackaging),
    // never hardcoded here: both live in src/watchers/repackaging-shape.ts, and a browser
    // string repeating "0.8" or the ship date goes stale without anything failing.
    function showRecentBlock(show) {
      var block = document.getElementById('outcomesRecentBlock');
      if (block) block.style.display = show ? '' : 'none';
    }

    function renderRecent(recent) {
      var body = document.getElementById('outcomesRecentBody');
      if (!body) return;
      showRecentBlock(true);
      var title = document.getElementById('outcomesRecentTitle');
      if (title) title.textContent = 'Last ' + recent.windowDays + ' day' +
        (recent.windowDays === 1 ? '' : 's');
      if (!recent.bySource.length) {
        body.innerHTML = '<div class="outcomes-empty">Nothing captured in this window.</div>';
        return;
      }
      var targetPct = Math.round(recent.target * 100);
      var rep = recent.repackaging || {};
      // No cap in the payload ⇒ the WHOLE column is omitted, header and cells alike.
      // Falling back to a literal 0.8 is the exact failure the comment above warns
      // about: it labels every count ">0.8" on the one payload that never said so, and a
      // cap moved in repackaging-shape.ts would be mislabelled with nothing failing.
      var hasCap = typeof rep.cap === 'number';
      var cap = rep.cap;
      var repackLabel = hasCap ? 'Repack &gt;' + cap : '';
      var rows = recent.bySource.map(function(o) {
        // A source with no repackaging metric renders a dim EM DASH cell. The class goes
        // on the <td>, not on a <span>: this component styles td.dim and has no bare .dim
        // rule, so the span rendered at FULL strength and read as a real value.
        var repack = !hasCap
          ? ''
          : typeof o.repackagingShapedAbove08 === 'number'
          ? '<td><span class="outcomes-repack" data-band="' +
            (o.repackagingShapedAbove08 === 0 ? 'ok' : 'bad') + '">' +
            o.repackagingShapedAbove08 + '</span></td>'
          : '<td class="dim">—</td>';
        return '<tr>' +
          '<td>' + esc(o.source) + '</td>' +
          '<td>' + o.captured + '</td>' +
          '<td><span class="outcomes-untriaged" data-zero="' + (o.pending === 0 ? '1' : '0') + '">' +
            o.pending + '</span></td>' +
          '<td>' + o.triaged + '</td>' +
          '<td>' + o.summarized + '</td>' +
          '<td>' + o.dismissedManual + '</td>' +
          '<td class="dim">' + o.dismissedAuto + '</td>' +
          '<td class="dim">' + o.error + '</td>' +
          '<td>' + outcomeAcc(o, recent.target) + '</td>' +
          repack +
        '</tr>';
      }).join('');
      var head = '<thead><tr>' +
        '<th>Source</th>' +
        '<th title="Every candidate row created in this window">Captured</th>' +
        '<th title="Still new/summarizing — NEVER looked at. Not a rejection.">Untriaged</th>' +
        '<th title="Captured minus untriaged">Triaged</th>' +
        '<th>Accepted</th>' +
        '<th title="Human clicked Dismiss — the only rejections counted against Accept rate">Rejected</th>' +
        '<th title="Expired, bulk-swept or otherwise auto-dismissed — bookkeeping, not judgements; excluded from Accept rate">Auto-dismissed</th>' +
        '<th>Error</th>' +
        '<th title="Accepted ÷ (Accepted + Rejected); target ≥ ' + targetPct + '%">Accept rate</th>' +
        (hasCap
          ? '<th title="X x-post rows whose handle-stripped title is repackaging-shaped and whose score (rounded to 2 dp) is still above ' + cap + ' — rows the deterministic repackaging clamp (PR #454) did not reach. x-link pointers are exempt from the clamp and are not counted. Target: 0.">' +
            repackLabel + '</th>'
          : '') +
        '</tr></thead>';
      var repackNote = hasCap && rep.floored && rep.since
        ? ' ' + repackLabel + ' is counted since ' +
          esc(new Date(rep.since).toLocaleString()) +
          ' (clamp ship) — rows captured before it keep pre-clamp scores.'
        : '';
      body.innerHTML =
        '<div class="outcomes-table-wrap"><table class="outcomes-table">' +
        head + '<tbody>' + rows + '</tbody></table></div>' +
        '<p class="outcomes-target-note">Accept rate target ≥ ' + targetPct + '%. ' +
        'Untriaged rows are not rejections — they were never looked at, so they stay out of ' +
        'the rate entirely. Window starts ' + esc(new Date(recent.since).toLocaleString()) + '.' +
        (hasCap ? ' ' + repackLabel + ' target: 0.' + repackNote : '') + '</p>';
    }

    function renderOutcomes(stats) {
      var body = document.getElementById('outcomesBody');
      if (!body) return;
      var hasAny = stats.byKind.length || stats.byBand.length;
      if (!hasAny) {
        body.innerHTML = '<div class="outcomes-empty">No labeled candidate outcomes yet — ' +
          'summarize or dismiss a few from the Candidates tab and check back.</div>';
        return;
      }
      body.innerHTML =
        renderByKindBlock(stats.byKind) +
        renderByBandBlock(stats.byBand) +
        renderSuggestedBlock(stats.suggestedFloors);

      // Wire each snippet's Copy button to its OWN <pre> by matching id suffix, so both
      // the Anthropic and X snippets copy independently.
      wireCopyButton('outcomesCopyBtn-anthropic', 'outcomesSnippet-anthropic');
      wireCopyButton('outcomesCopyBtn-x', 'outcomesSnippet-x');
    }

    function wireCopyButton(btnId, preId) {
      var copyBtn = document.getElementById(btnId);
      if (!copyBtn) return;
      copyBtn.addEventListener('click', function() {
        var pre = document.getElementById(preId);
        var text = pre ? pre.textContent : '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function() {
            copyBtn.textContent = 'Copied';
            setTimeout(function() { copyBtn.textContent = 'Copy JSON'; }, 1500);
          }).catch(function() {});
        }
      });
    }

    // Window length for the "last N days" block. View state only — deliberately NOT in
    // the URL (the tab already owns the hash) and not persisted. It is SEEDED FROM THE
    // SELECT at wire time rather than from a literal 7: browsers restore a <select>'s
    // value across a reload while this var resets, so the fetch and the control the user
    // reads disagreed on every refresh of a non-default window.
    var outcomesWindowDays = 7;
    // Monotonic request token. A fast 7→30→14 leaves three fetches in flight and they
    // can settle in any order; without this the table could end up rendering the 30-day
    // answer under a select reading 14.
    var outcomesSeq = 0;

    async function loadOutcomes() {
      var body = document.getElementById('outcomesBody');
      if (!body) return;
      var seq = ++outcomesSeq;
      // Did the windowed block reach its own verdict? The inner try below owns that
      // decision for BOTH its outcomes (rendered, or hidden on a null/malformed block);
      // once it has, the outer catch must not overrule it. renderOutcomes runs AFTER
      // it, so an all-time render failure was hiding a windowed block that had just
      // rendered correctly — the fetch succeeded and the block's own data was fine.
      var recentHandled = false;
      try {
        var stats = await getJson('/api/anthropic/candidates/stats?days=' + outcomesWindowDays);
        if (seq !== outcomesSeq) return; // a newer window is in flight; this answer is stale
        // The server clamps ?days and reports the window it actually used, so the block
        // always labels itself from the payload, never from what we asked for. A null
        // recent block (its aggregation failed server-side) HIDES the block outright — a live
        // select over an empty body reads as "nothing captured", which is a claim.
        // Wrapped on its own so a malformed block cannot take the all-time tables down.
        try {
          if (stats.recent) renderRecent(stats.recent);
          else showRecentBlock(false);
        } catch (err) {
          console.error('renderRecent failed:', err);
          showRecentBlock(false);
        }
        recentHandled = true;
        renderOutcomes(stats);
      } catch (err) {
        console.error('loadOutcomes failed:', err);
        if (seq !== outcomesSeq) return;
        if (!recentHandled) showRecentBlock(false);
        body.innerHTML = '<div class="outcomes-empty error">Couldn\\'t load calibration stats. ' +
          '<button class="outcomes-copy-btn" id="outcomesRetryBtn" type="button">Retry</button></div>';
        var rb = document.getElementById('outcomesRetryBtn');
        if (rb) rb.addEventListener('click', loadOutcomes);
      }
    }

    (function wireOutcomesWindow() {
      var sel = document.getElementById('outcomesWindowSel');
      if (!sel) return;
      outcomesWindowDays = parseInt(sel.value, 10) || 7;
      sel.addEventListener('change', function() {
        var n = parseInt(sel.value, 10);
        outcomesWindowDays = isNaN(n) ? 7 : n;
        loadOutcomes();
      });
    })();
  `;
}
