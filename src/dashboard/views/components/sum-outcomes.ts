/** Summaries page — the Calibration tab (gate-outcome calibration, display-only).
 *
 * Renders the labeled capture-gate dataset that `summary_candidates` has become: every
 * row carries the gate `score`, its `kind`, and a terminal `status` (summarized = judged
 * worth a summary, dismissed = not). This tab turns that into three read-only views over
 * GET /api/anthropic/candidates/stats:
 *  - a per-(source, kind) acceptance table,
 *  - a 0.1-wide score-band histogram of outcomes,
 *  - suggested per-kind capture floors + a copyable `candidateMinScoreByKind` JSON snippet.
 *
 * Acceptance rate = summarized / (summarized + manually-dismissed) — auto-expired and
 * pre-migration ("unknown") dismissals are shown as separate columns but kept OUT of the
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
    }
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
        auto-expired and pre-tracking dismissals are shown separately and excluded from that rate. Display only — copy the
        suggested floors into a bot's <code>candidateMinScoreByKind</code> yourself.
      </p>
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

    function outcomeAcc(o) {
      if (o.acceptanceRate == null) return '<span class="outcomes-acc" data-band="none">—</span>';
      var pct = Math.round(o.acceptanceRate * 100);
      var band = o.acceptanceRate >= 0.5 ? 'high' : 'low';
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
        '<td class="dim">' + o.dismissedUnknown + '</td>' +
        '<td class="dim">' + o.error + '</td>' +
        '<td>' + outcomeAcc(o) + '</td>';
    }

    function outcomeCountHeader(firstLabel) {
      return '<thead><tr>' +
        '<th>' + firstLabel + '</th>' +
        '<th>Total</th><th>Summ.</th><th>Dismiss</th>' +
        '<th>Expired</th><th>Unknown</th><th>Error</th><th>Accept</th>' +
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

    async function loadOutcomes() {
      var body = document.getElementById('outcomesBody');
      if (!body) return;
      try {
        var stats = await getJson('/api/anthropic/candidates/stats');
        renderOutcomes(stats);
      } catch (err) {
        console.error('loadOutcomes failed:', err);
        body.innerHTML = '<div class="outcomes-empty error">Couldn\\'t load calibration stats. ' +
          '<button class="outcomes-copy-btn" id="outcomesRetryBtn" type="button">Retry</button></div>';
        var rb = document.getElementById('outcomesRetryBtn');
        if (rb) rb.addEventListener('click', loadOutcomes);
      }
    }
  `;
}
