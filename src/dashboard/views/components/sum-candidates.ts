/** Summaries page — the Candidate inbox (Claude Learning Center, Phase D).
 *
 * Renders the anthropic watcher's gated discoveries as a ranked, pre-annotated
 * reading queue at the top of /summaries. Each row shows the gate score, where
 * inside the source it came from, the title, and the gate's "why" line, plus
 * status-driven actions.
 *
 * Reads GET /api/anthropic/candidates (the actionable + in-flight + shelf set:
 * statuses new / summarizing / summarized / error). Rows render by status:
 *  - `new`        → active [Summarize] + [Dismiss]
 *  - `error`      → "Failed" + [Retry] + [Dismiss]
 *  - `summarizing`→ "Summarizing…" chip (e.g. an auto-promoted ≥0.9 headliner mid-run)
 *  - `summarized` → read-only "On the shelf ↗" linking the summary doc
 *
 * [Summarize] POSTs /api/anthropic/candidates/:id/summarize, then reuses the shared
 * job-card + SSE streamer (the YouTube/X summarize flow — `showJob` + `connectSSE`)
 * for the visible card; a lightweight per-row EventSource flips the row to "On the
 * shelf" on completion. Handles the 409 (already in flight) and `{duplicate,doc_id}`
 * (already on shelf) responses. Dismiss POSTs …/:id/dismiss and drops the row.
 * The whole section stays hidden when the inbox is empty. Uses the shared esc() +
 * openSummaryDoc() helpers (all summaries component scripts share one page scope). */

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
    .candidate-ask {
      display: inline-block;
      margin-top: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent-light);
      text-decoration: none;
    }
    .candidate-ask:hover { text-decoration: underline; }

    .candidate-actions {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: stretch;
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

    /* On-the-shelf affordance (summarized — read-only; opens the summary doc panel). */
    .candidate-onshelf {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid color-mix(in srgb, var(--status-success) 40%, transparent);
      color: var(--status-success);
      background: color-mix(in srgb, var(--status-success) 12%, transparent);
    }
    .candidate-onshelf:hover { background: color-mix(in srgb, var(--status-success) 20%, transparent); }
    .candidate-onshelf.static { cursor: default; }

    /* In-progress chip (summarizing — e.g. an auto-promoted headliner mid-run). */
    .candidate-status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
      color: var(--accent-light);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .candidate-spinner {
      width: 10px;
      height: 10px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    /* Failed note (error rows — Retry is offered alongside). */
    .candidate-failed {
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      color: var(--status-error);
    }
  `;
}

export function sumCandidatesHtml(): string {
  return `
    <div class="candidates-section" id="candidatesSection" hidden>
      <h2>Candidates <span class="count" id="candidatesCount"></span></h2>
      <p class="candidates-subtitle">Gated discoveries from the Anthropic tracker — pick what's worth a summary. Headliners summarize themselves.</p>
      <div class="candidate-list" id="candidateList"></div>
    </div>`;
}

export function sumCandidatesScript(): string {
  return `
    // Score band drives the pill color: ~0.9+ are headliners (auto-promoted), 0.7+
    // the mid-band worth a look, below that the long tail.
    function candidateScoreBand(score) {
      if (score >= 0.9) return 'high';
      if (score >= 0.7) return 'mid';
      return 'low';
    }

    // Status → sort rank: actionable (new/error) first, then in-flight, then shelf.
    // Stable sort keeps the server's score-desc order within each rank.
    function candidateStatusRank(status) {
      if (status === 'summarizing') return 1;
      if (status === 'summarized') return 2;
      return 0; // new + error — needs a decision
    }

    // Right-hand action area, keyed off the candidate status. The buttons carry a
    // data-act marker (bound in bindCandidateRow); their handlers read id/title/url
    // off the row's dataset, so the actions can be re-rendered on a status flip.
    function candidateActionsHtml(c) {
      if (c.status === 'summarized') {
        return c.docId
          ? '<a class="candidate-onshelf" href="#" data-act="open">On the shelf ↗</a>'
          : '<span class="candidate-onshelf static">On the shelf</span>';
      }
      if (c.status === 'summarizing') {
        return '<span class="candidate-status-chip"><span class="candidate-spinner"></span>Summarizing…</span>';
      }
      // new or error — both get an active Summarize/Retry + Dismiss.
      var label = c.status === 'error' ? 'Retry' : 'Summarize';
      return (c.status === 'error' ? '<div class="candidate-failed">Failed</div>' : '') +
        '<button class="candidate-btn candidate-btn-summarize" data-act="summarize">' + label + '</button>' +
        '<button class="candidate-btn candidate-btn-dismiss" data-act="dismiss">Dismiss</button>';
    }

    function renderCandidateRow(c) {
      // Band off the rounded value the user actually sees, so the pill text and its
      // color never disagree on a boundary score (e.g. 0.895 → "0.90").
      var shown = c.score.toFixed(2);
      var band = candidateScoreBand(parseFloat(shown));
      var titleInner = c.url
        ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.title) + '</a>'
        : esc(c.title);
      // Cross-link into the Research layer: a discovery becomes a question. Lands
      // on /research?q=<title>, which auto-asks the cited-Q&A box over the corpus.
      var askHref = '/research?q=' + encodeURIComponent(c.title || '');
      return '<div class="candidate-item" data-id="' + esc(c.id) + '"' +
          ' data-url="' + esc(c.url || '') + '" data-title="' + esc(c.title || '') + '"' +
          ' data-status="' + esc(c.status) + '" data-doc-id="' + esc(c.docId || '') + '">' +
        '<div class="candidate-score" data-band="' + band + '">' + shown + '</div>' +
        '<div class="candidate-body">' +
          (c.candidateSrc ? '<div class="candidate-meta">' + esc(c.candidateSrc) + '</div>' : '') +
          '<div class="candidate-title">' + titleInner + '</div>' +
          (c.why ? '<div class="candidate-why">' + esc(c.why) + '</div>' : '') +
          '<a class="candidate-ask" href="' + askHref + '">Ask in Research &rarr;</a>' +
        '</div>' +
        '<div class="candidate-actions">' + candidateActionsHtml(c) + '</div>' +
      '</div>';
    }

    function bindCandidateRow(row) {
      var sBtn = row.querySelector('[data-act="summarize"]');
      if (sBtn) sBtn.addEventListener('click', function() { startCandidateSummarize(row); });
      var dBtn = row.querySelector('[data-act="dismiss"]');
      if (dBtn) dBtn.addEventListener('click', function() { dismissCandidate(row.dataset.id, dBtn); });
      var open = row.querySelector('[data-act="open"]');
      if (open) open.addEventListener('click', function(e) {
        e.preventDefault();
        if (row.dataset.docId) openSummaryDoc(row.dataset.docId, row.dataset.url || '', 'anthropic');
      });
    }

    // Re-render a single row's action area after a status transition + rebind it.
    function setCandidateRowStatus(row, status, docId) {
      row.dataset.status = status;
      if (docId) row.dataset.docId = docId;
      var actions = row.querySelector('.candidate-actions');
      if (actions) {
        actions.innerHTML = candidateActionsHtml({ status: status, docId: docId || row.dataset.docId });
        bindCandidateRow(row);
      }
      updateCandidateCount();
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

    // POST /summarize → reuse the shared job-card + SSE streamer (the YouTube/X flow)
    // for the visible card; a lightweight per-row EventSource flips the row to "On the
    // shelf" on completion. Handles the 409 (already in flight) + duplicate responses.
    async function startCandidateSummarize(row) {
      var id = row.dataset.id;
      var title = row.dataset.title || '';
      var url = row.dataset.url || '';
      var sBtn = row.querySelector('[data-act="summarize"]');
      if (sBtn) sBtn.disabled = true;
      try {
        var res = await fetch('/api/anthropic/candidates/' + encodeURIComponent(id) + '/summarize', { method: 'POST' });

        // Already summarizing (double-click, or the auto-promote path beat us to it).
        if (res.status === 409) { setCandidateRowStatus(row, 'summarizing'); return; }

        var data = await res.json().catch(function() { return {}; });

        // Already on the shelf — surface the existing doc and flip the row.
        if (data && data.duplicate) {
          setCandidateRowStatus(row, 'summarized', data.doc_id);
          if (typeof showDuplicateBanner === 'function') showDuplicateBanner();
          return;
        }

        if (!res.ok || !data || !data.job_id) {
          if (sBtn) sBtn.disabled = false;
          console.error('summarize failed:', res.status, data);
          return;
        }

        // Stream the visible job card (reuse wholesale) and flip the row in-progress.
        setCandidateRowStatus(row, 'summarizing');
        showJob(data.job_id, title, url, 'anthropic');
        connectSSE(data.job_id, 'anthropic');
        watchCandidateJob(data.job_id, row);
      } catch (err) {
        if (sBtn) sBtn.disabled = false;
        console.error('startCandidateSummarize failed:', err);
      }
    }

    // A per-row SSE listener that only watches for terminal events to flip the row —
    // decoupled from the job card's own stream so the shared streamer stays untouched.
    function watchCandidateJob(jobId, row) {
      var es = new EventSource('/api/anthropic/stream/' + jobId);
      es.addEventListener('complete', async function() {
        es.close();
        var docId = '';
        try {
          // limit=100 (the endpoint's cap): the jobs list is newest-first, and an
          // auto-promote burst can create several jobs in the window between this
          // job's kick and its completion — the default 20 could evict it and lose
          // its docId (→ a non-functional "On the shelf" link).
          var r = await fetch('/api/anthropic/jobs?limit=100');
          var d = await r.json();
          var job = (d.jobs || []).find(function(j) { return j.id === jobId; });
          if (job && job.docId) docId = job.docId;
        } catch {}
        setCandidateRowStatus(row, 'summarized', docId);
      });
      es.addEventListener('error', function(e) {
        // e.data present = an application-level job error; a bare error is just a
        // transient connection blip (EventSource auto-reconnects) — ignore it.
        if (e.data) { es.close(); setCandidateRowStatus(row, 'error'); }
      });
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

        // Float actionable (new/error) rows above in-flight + on-the-shelf ones;
        // the server already ordered by score within each status.
        candidates.sort(function(a, b) {
          return candidateStatusRank(a.status) - candidateStatusRank(b.status);
        });

        list.innerHTML = candidates.map(renderCandidateRow).join('');
        document.getElementById('candidatesCount').textContent = candidates.length;
        section.hidden = false;

        list.querySelectorAll('.candidate-item').forEach(bindCandidateRow);
      } catch (err) {
        // A failed/empty inbox shouldn't break the page — leave the section hidden.
        console.error('loadCandidates failed:', err);
        section.hidden = true;
      }
    }
  `;
}
