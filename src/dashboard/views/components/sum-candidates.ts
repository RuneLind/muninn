/** Summaries page — the Candidate inbox (Claude Learning Center, Phase D-list).
 *
 * Renders the anthropic watcher's gated discoveries as a ranked, pre-annotated
 * reading queue at the top of /summaries. Each row shows the gate score, where
 * inside the source it came from, the title, and the gate's "why" line, plus
 * Dismiss + Summarize actions.
 *
 * Reads GET /api/anthropic/candidates (status `new`, source `anthropic`).
 * Dismiss POSTs /api/anthropic/candidates/:id/dismiss and drops the row.
 * Summarize is intentionally INERT until Phases A+C (no anthropic-summaries
 * collection / summarizer yet) — it renders disabled with a "later phase" hint.
 * The whole section stays hidden when the inbox is empty so the page is
 * unchanged for sources that don't capture candidates. Uses the shared esc()
 * helper (all summaries component scripts share one page scope). */

export function sumCandidatesStyles(): string {
  return `
    .candidates-section {
      margin-top: 8px;
      margin-bottom: 32px;
    }
    .candidates-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 4px;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .candidates-section h2 .count {
      font-size: 13px;
      font-weight: 400;
      color: var(--text-dim);
    }
    .candidates-subtitle {
      font-size: 13px;
      color: var(--text-dim);
      margin: 0 0 14px;
    }
    .candidate-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .candidate-item {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
    }
    .candidate-item.removing {
      opacity: 0;
      transform: translateX(8px);
      transition: opacity 0.2s, transform 0.2s;
    }

    /* Score pill — colored by band: headliner / mid / low. */
    .candidate-score {
      flex-shrink: 0;
      min-width: 46px;
      text-align: center;
      padding: 4px 0;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      border: 1px solid var(--border-secondary);
      color: var(--text-soft);
      background: var(--bg-surface);
    }
    .candidate-score[data-band="high"] {
      color: var(--status-success);
      border-color: color-mix(in srgb, var(--status-success) 40%, transparent);
      background: color-mix(in srgb, var(--status-success) 12%, transparent);
    }
    .candidate-score[data-band="mid"] {
      color: var(--status-warning);
      border-color: color-mix(in srgb, var(--status-warning) 40%, transparent);
      background: color-mix(in srgb, var(--status-warning) 12%, transparent);
    }

    .candidate-body {
      flex: 1;
      min-width: 0;
    }
    .candidate-meta {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-dim);
      margin-bottom: 2px;
    }
    .candidate-title {
      font-size: 14px;
      color: var(--text-primary);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .candidate-title a {
      color: inherit;
      text-decoration: none;
    }
    .candidate-title a:hover { color: var(--accent-light); }
    .candidate-why {
      font-size: 13px;
      color: var(--text-soft);
      line-height: 1.45;
    }

    .candidate-actions {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .candidate-btn {
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border-secondary);
      background: var(--bg-surface);
      color: var(--text-secondary);
      white-space: nowrap;
    }
    .candidate-btn:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--text-primary);
    }
    .candidate-btn-summarize:not(:disabled) {
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
      color: var(--accent-light);
    }
    .candidate-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
  `;
}

export function sumCandidatesHtml(): string {
  return `
    <div class="candidates-section" id="candidatesSection" hidden>
      <h2>Candidates <span class="count" id="candidatesCount"></span></h2>
      <p class="candidates-subtitle">Gated discoveries from the Anthropic tracker — pick what's worth a summary.</p>
      <div class="candidate-list" id="candidateList"></div>
    </div>`;
}

export function sumCandidatesScript(): string {
  return `
    // Score band drives the pill color: ~0.9+ are headliners (auto-promoted in a
    // later phase), 0.7+ the mid-band worth a look, below that the long tail.
    function candidateScoreBand(score) {
      if (score >= 0.9) return 'high';
      if (score >= 0.7) return 'mid';
      return 'low';
    }

    function renderCandidateRow(c) {
      // Band off the rounded value the user actually sees, so the pill text and
      // its color never disagree on a boundary score (e.g. 0.895 → "0.90").
      var shown = c.score.toFixed(2);
      var band = candidateScoreBand(parseFloat(shown));
      var titleInner = c.url
        ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.title) + '</a>'
        : esc(c.title);
      return '<div class="candidate-item" data-id="' + esc(c.id) + '">' +
        '<div class="candidate-score" data-band="' + band + '">' + shown + '</div>' +
        '<div class="candidate-body">' +
          (c.candidateSrc ? '<div class="candidate-meta">' + esc(c.candidateSrc) + '</div>' : '') +
          '<div class="candidate-title">' + titleInner + '</div>' +
          (c.why ? '<div class="candidate-why">' + esc(c.why) + '</div>' : '') +
        '</div>' +
        '<div class="candidate-actions">' +
          '<button class="candidate-btn candidate-btn-summarize" disabled ' +
            'title="Summarization arrives in a later phase of the Learning Center">Summarize</button>' +
          '<button class="candidate-btn candidate-btn-dismiss" data-id="' + esc(c.id) + '">Dismiss</button>' +
        '</div>' +
      '</div>';
    }

    function updateCandidateCount() {
      var section = document.getElementById('candidatesSection');
      var list = document.getElementById('candidateList');
      var countEl = document.getElementById('candidatesCount');
      if (!section || !list) return;
      var n = list.querySelectorAll('.candidate-item').length;
      if (n === 0) { section.hidden = true; return; }
      countEl.textContent = n;
    }

    async function dismissCandidate(id, btn) {
      btn.disabled = true;
      try {
        var res = await fetch('/api/anthropic/candidates/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var row = btn.closest('.candidate-item');
        if (row) {
          row.classList.add('removing');
          setTimeout(function() { row.remove(); updateCandidateCount(); }, 200);
        } else {
          updateCandidateCount();
        }
      } catch (err) {
        btn.disabled = false;
        console.error('dismissCandidate failed:', err);
      }
    }

    async function loadCandidates() {
      var section = document.getElementById('candidatesSection');
      var list = document.getElementById('candidateList');
      if (!section || !list) return;
      try {
        var res = await fetch('/api/anthropic/candidates');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        var candidates = (data && data.candidates) || [];
        if (candidates.length === 0) { section.hidden = true; return; }

        list.innerHTML = candidates.map(renderCandidateRow).join('');
        document.getElementById('candidatesCount').textContent = candidates.length;
        section.hidden = false;

        list.querySelectorAll('.candidate-btn-dismiss').forEach(function(btn) {
          btn.addEventListener('click', function() { dismissCandidate(btn.getAttribute('data-id'), btn); });
        });
      } catch (err) {
        // A failed/empty inbox shouldn't break the page — leave the section hidden.
        console.error('loadCandidates failed:', err);
        section.hidden = true;
      }
    }
  `;
}
