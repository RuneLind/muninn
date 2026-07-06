/** Summaries page — the Candidate inbox (Claude Learning Center, Phase D).
 *
 * Renders the anthropic watcher's gated discoveries as a ranked, pre-annotated
 * reading queue at the top of /summaries. Each row shows the gate score, where
 * inside the source it came from, the title, and the gate's "why" line, plus
 * status-driven actions. X rows additionally carry an author tier badge (★ top 1% / ☆
 * top 5% of tracked X authors, from server-computed percentile cuts in AUTHOR_TIERS) and
 * a "Top authors" filter chip that composes with the kind chips. Author signal is
 * transparency + filtering only — it never re-sorts the inbox.
 *
 * Reads GET /api/anthropic/candidates (the actionable + in-flight + shelf set:
 * statuses new / summarizing / summarized / error). The inbox proper shows only
 * the actionable + in-flight rows; `summarized` rows collapse into an expandable
 * "Done recently" group below it. Rows render by status:
 *  - `new`        → active [Summarize] + [Dismiss]
 *  - `error`      → "Failed" + [Retry] + [Dismiss]
 *  - `summarizing`→ "Summarizing…" chip (e.g. an auto-promoted ≥0.9 headliner mid-run)
 *  - `summarized` → compact "Done recently" line + "On the shelf ↗" linking the doc
 *
 * [Summarize] POSTs /api/anthropic/candidates/:id/summarize, then reuses the shared
 * job-card + SSE streamer (the YouTube/X summarize flow — `showJob` + `connectSSE`)
 * for the visible card; a lightweight per-row EventSource flips the row to summarized
 * on completion (moving it from the inbox into the done group). Handles the 409
 * (already in flight) and `{duplicate,doc_id}` (already on shelf) responses. Dismiss
 * POSTs …/:id/dismiss and drops the row. The section is always visible (it lives
 * behind the Candidates tab): an empty inbox shows a "Nothing new" state, and a
 * fetch failure shows a distinct "Couldn't load candidates" retry state. Rendering is
 * state-driven — a client-side array is re-rendered on every change. Uses the shared
 * esc() + openSummaryDoc() helpers (all summaries component scripts share one page scope). */

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
      display: flex;
      align-items: center;
      gap: 8px;
    }
    /* Origin badge (anthropic / x) — one inbox, two verticals. */
    .candidate-source-badge {
      flex-shrink: 0;
      padding: 1px 7px;
      border-radius: 4px;
      font-size: 10px;
      letter-spacing: 0.03em;
      border: 1px solid var(--border-secondary);
      color: var(--text-soft);
      background: var(--bg-surface);
    }
    .candidate-source-badge[data-source="x"] {
      color: var(--text-primary);
      border-color: var(--border-primary);
    }
    /* Author tier badge (X rows only) — ★ top 1%, ☆ top 5% of tracked X authors.
       Transparency only: it never re-ranks the inbox. Tooltip carries the stored score. */
    .candidate-author-badge {
      flex-shrink: 0;
      font-size: 12px;
      line-height: 1;
      cursor: help;
      color: var(--status-warning);
    }
    .candidate-author-badge[data-tier="top1"] { color: var(--status-success); }
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

    /* Empty / error states — the section is always mounted behind the tab, so it
       carries its own zero states rather than hiding. */
    .candidate-empty {
      padding: 22px 14px;
      text-align: center;
      font-size: 13px;
      color: var(--text-dim);
      border: 1px dashed var(--border-primary);
      border-radius: 8px;
    }
    .candidate-empty.error { color: var(--status-error); border-color: color-mix(in srgb, var(--status-error) 40%, transparent); }
    .candidate-retry-btn {
      margin-left: 8px;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border-secondary);
      background: var(--bg-surface);
      color: var(--text-secondary);
    }
    .candidate-retry-btn:hover { border-color: var(--accent); color: var(--text-primary); }

    /* "Done recently" collapse — summarized rows fold into one compact list. */
    .candidate-done { margin-top: 14px; }
    .candidate-done-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 4px;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-dim);
    }
    .candidate-done-toggle:hover { color: var(--text-secondary); }
    .candidate-done-caret {
      display: inline-block;
      transition: transform 0.15s;
      font-size: 11px;
    }
    .candidate-done-toggle[aria-expanded="true"] .candidate-done-caret { transform: rotate(90deg); }
    .candidate-done-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 6px;
    }
    .candidate-done-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border-radius: 6px;
    }
    .candidate-done-item:hover { background: var(--bg-surface); }
    .candidate-done-title {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      color: var(--text-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .candidate-done-shelf {
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--status-success);
      text-decoration: none;
      cursor: pointer;
    }
    .candidate-done-shelf:hover { text-decoration: underline; }
    .candidate-done-shelf.static { color: var(--text-dim); cursor: default; }
  `;
}

export function sumCandidatesHtml(): string {
  return `
    <div class="candidates-section" id="candidatesSection">
      <h2>Candidates <span class="count" id="candidatesCount"></span></h2>
      <p class="candidates-subtitle">Gated discoveries from the Anthropic tracker — pick what's worth a summary. Headliners summarize themselves.</p>
      <!-- Kind filter chips (All / X posts / News / Docs / Commits / Releases), rendered
           by renderKindFilter() over the inbox. Reuses the .source-chip / .source-filter
           styles declared in sum-recently-added. -->
      <div class="source-filter" id="candidateKindFilter"></div>
      <div class="candidate-list" id="candidateList"></div>
      <div class="candidate-done" id="candidateDone" hidden>
        <button class="candidate-done-toggle" id="candidateDoneToggle" type="button" aria-expanded="false">
          <span class="candidate-done-caret">&#9656;</span>
          <span id="candidateDoneLabel">Done recently</span>
        </button>
        <div class="candidate-done-list" id="candidateDoneList" hidden></div>
      </div>
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

    // Origin badge label — one inbox now carries anthropic releases + captured X posts.
    function candidateSourceLabel(source) {
      if (source === 'x') return 'X';
      if (source === 'anthropic') return 'Anthropic';
      return source || '';
    }

    // Author tier for an X candidate, from its capture-time score vs the CURRENT
    // server-computed percentile cuts (AUTHOR_TIERS). Returns 'top1' | 'top5' | null.
    // Null when there's no score, no thresholds, or the score is below the top-5% cut.
    function candidateAuthorTier(c) {
      if (!AUTHOR_TIERS || c.authorScore == null) return null;
      if (c.authorScore >= AUTHOR_TIERS.top1) return 'top1';
      if (c.authorScore >= AUTHOR_TIERS.top5) return 'top5';
      return null;
    }

    // ★/☆ badge markup for the meta row, or '' when the row isn't a top author.
    function candidateAuthorBadgeHtml(c) {
      var tier = candidateAuthorTier(c);
      if (!tier) return '';
      var pct = tier === 'top1' ? 'top 1%' : 'top 5%';
      var glyph = tier === 'top1' ? '\\u2605' : '\\u2606'; // ★ / ☆
      var title = 'Author rank ' + c.authorScore.toFixed(2) + ' — ' + pct + ' of tracked X authors';
      return '<span class="candidate-author-badge" data-tier="' + tier + '" title="' + esc(title) + '">' + glyph + '</span>';
    }

    // Status → sort rank within the inbox: actionable (new/error) first, then
    // in-flight. (summarized rows never reach the inbox — they render in the
    // "Done recently" group.) Stable sort keeps the server's score-desc order
    // within each rank.
    function candidateStatusRank(status) {
      if (status === 'summarizing') return 1;
      return 0; // new + error — needs a decision
    }

    // Right-hand action area, keyed off the candidate status. The buttons carry a
    // data-act marker (bound in bindCandidateRow); their handlers read id/title/url
    // off the row's dataset, so the actions can be re-rendered on a status flip.
    function candidateActionsHtml(c) {
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
          '<div class="candidate-meta">' +
            '<span class="candidate-source-badge" data-source="' + esc(c.source || '') + '">' +
              esc(candidateSourceLabel(c.source)) + '</span>' +
            candidateAuthorBadgeHtml(c) +
            (c.candidateSrc ? '<span>' + esc(c.candidateSrc) + '</span>' : '') +
          '</div>' +
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
    }

    // Client-side model — the inbox is state-driven: a full array from the API,
    // re-rendered on every change so a row can move between the inbox and the
    // "Done recently" group as its status flips.
    var candidatesState = [];
    var candidatesLoadError = false;
    var candidateDoneExpanded = false;
    // Active kind filter (null = all). Filters the inbox client-side; the done group
    // is unaffected. Sticky: it stays selected even when its kind empties out (the
    // inbox then shows the filtered-empty message) — the user widens via "All".
    var activeKind = null;
    // Independent boolean toggle (composes with the kind filter): show only rows whose
    // author is in the top 5% of tracked X authors (authorScore >= AUTHOR_TIERS.top5).
    var topAuthorsOnly = false;

    // Does this candidate clear the top-5% author cut? (The "Top authors" filter test.)
    function candidateIsTopAuthor(c) {
      return !!AUTHOR_TIERS && c.authorScore != null && c.authorScore >= AUTHOR_TIERS.top5;
    }

    // Kind → chip label. Order = chip order. 'blog' shows as "News" (the chip label
    // and the stored kind deliberately differ — we filter on 'blog', never 'news').
    var CANDIDATE_KINDS = [
      { kind: 'x-post', label: 'X posts' },
      { kind: 'blog', label: 'News' },
      { kind: 'doc', label: 'Docs' },
      { kind: 'commit', label: 'Commits' },
      { kind: 'release', label: 'Releases' },
    ];

    // Render the kind-filter chips over the (unfiltered) inbox with live counts.
    // Mirrors sum-recently-added's renderSourceFilter: "All" + one chip per present
    // kind. A sticky active filter keeps its chip rendered even at count 0 (so the
    // filtered-empty state below is reachable and the user explicitly clicks All to
    // widen). The row only hides when NO filter is active and there's nothing to
    // filter (≤1 kind present) — never while a filter is applied, which would strand
    // the user on an invisible filter with no All chip to recover.
    function renderKindFilter(inbox) {
      var el = document.getElementById('candidateKindFilter');
      if (!el) return;
      var counts = {};
      inbox.forEach(function(c) { if (c.kind) counts[c.kind] = (counts[c.kind] || 0) + 1; });
      var present = CANDIDATE_KINDS.filter(function(d) {
        return counts[d.kind] || d.kind === activeKind;
      });
      // "Top authors" count is over the full inbox (independent of the kind selection),
      // so the chip reads the same regardless of which kind is active.
      var topAuthorCount = inbox.filter(candidateIsTopAuthor).length;
      var showTopAuthors = topAuthorsOnly || topAuthorCount > 0;
      // Hide the whole row only when there's nothing to filter on either axis.
      if (activeKind === null && !topAuthorsOnly && present.length <= 1 && !showTopAuthors) {
        el.innerHTML = '';
        return;
      }
      var chips = ['<span class="source-chip' + (activeKind === null ? ' active' : '') +
        '" data-kind="">All <span class="chip-count">' + inbox.length + '</span></span>'];
      present.forEach(function(d) {
        chips.push('<span class="source-chip' + (activeKind === d.kind ? ' active' : '') +
          '" data-kind="' + esc(d.kind) + '">' + esc(d.label) +
          ' <span class="chip-count">' + (counts[d.kind] || 0) + '</span></span>');
      });
      // Author-axis toggle, rendered after the kind chips (an independent boolean, not a
      // member of the single-select kind set — carries data-top-author, not data-kind).
      if (showTopAuthors) {
        chips.push('<span class="source-chip' + (topAuthorsOnly ? ' active' : '') +
          '" data-top-author="1" title="Only authors in the top 5% of the tracked X network">' +
          '\\u2605 Top authors <span class="chip-count">' + topAuthorCount + '</span></span>');
      }
      el.innerHTML = chips.join('');
      el.querySelectorAll('.source-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          if (chip.getAttribute('data-top-author')) {
            topAuthorsOnly = !topAuthorsOnly;
          } else {
            var k = chip.getAttribute('data-kind');
            activeKind = k || null;
          }
          renderCandidates();
        });
      });
    }

    // Human label for a kind (filtered-empty message). Falls back to the raw kind.
    function candidateKindLabel(kind) {
      for (var i = 0; i < CANDIDATE_KINDS.length; i++) {
        if (CANDIDATE_KINDS[i].kind === kind) return CANDIDATE_KINDS[i].label;
      }
      return kind || '';
    }

    function findCandidate(id) {
      for (var i = 0; i < candidatesState.length; i++) {
        if (candidatesState[i].id === id) return candidatesState[i];
      }
      return null;
    }

    // Mutate one candidate's status in the model + re-render. A summarizing row
    // that flips to summarized moves from the inbox into the done group.
    function updateCandidateStatus(id, status, docId) {
      var c = findCandidate(id);
      if (!c) return;
      c.status = status;
      if (docId) c.docId = docId;
      if (status === 'summarized') c.updatedAt = Date.now();
      renderCandidates();
    }

    function removeCandidate(id) {
      candidatesState = candidatesState.filter(function(c) { return c.id !== id; });
      renderCandidates();
    }

    // Header count + Candidates tab badge both track the ACTIONABLE count (new +
    // error) — the rows that actually need a decision.
    function updateCandidateCounts() {
      var actionable = candidatesState.filter(function(c) {
        return c.status === 'new' || c.status === 'error';
      }).length;
      var countEl = document.getElementById('candidatesCount');
      if (countEl) countEl.textContent = actionable > 0 ? actionable : '';
      if (typeof updateTabCount === 'function') updateTabCount('candidates', actionable);
    }

    // Render the inbox (new/error/summarizing) + the collapsed done group from the
    // model. Always mounted behind the Candidates tab, so it carries its own zero
    // states instead of hiding.
    function renderCandidates() {
      var section = document.getElementById('candidatesSection');
      var list = document.getElementById('candidateList');
      if (!section || !list) return;

      if (candidatesLoadError) {
        list.innerHTML = '<div class="candidate-empty error">Couldn\\'t load candidates. ' +
          '<button class="candidate-retry-btn" id="candidateRetryBtn" type="button">Retry</button></div>';
        var rb = document.getElementById('candidateRetryBtn');
        if (rb) rb.addEventListener('click', loadCandidates);
        renderKindFilter([]);
        renderDoneGroup([]);
        updateCandidateCounts();
        return;
      }

      var inbox = candidatesState.filter(function(c) { return c.status !== 'summarized'; });
      var done = candidatesState.filter(function(c) { return c.status === 'summarized'; });

      // Float actionable (new/error) above in-flight; server already ordered by score.
      inbox.sort(function(a, b) { return candidateStatusRank(a.status) - candidateStatusRank(b.status); });

      // Chips over the full inbox (the active kind's chip stays, at count 0 if it
      // just emptied), then narrow the rendered rows to the active kind.
      renderKindFilter(inbox);
      var shownInbox = inbox.filter(function(c) {
        if (activeKind && c.kind !== activeKind) return false;
        if (topAuthorsOnly && !candidateIsTopAuthor(c)) return false;
        return true;
      });

      if (inbox.length === 0 && done.length === 0) {
        list.innerHTML = '<div class="candidate-empty">Nothing new — the tracker hasn\\'t surfaced anything to summarize.</div>';
      } else if (shownInbox.length === 0) {
        // A filter with no matches reads differently from a truly empty inbox.
        var filterLabel = topAuthorsOnly && activeKind
          ? 'top-author ' + candidateKindLabel(activeKind)
          : topAuthorsOnly
            ? 'top-author'
            : activeKind
              ? candidateKindLabel(activeKind)
              : '';
        list.innerHTML = filterLabel
          ? '<div class="candidate-empty">No ' + esc(filterLabel) + ' candidates right now.</div>'
          : ''; // only done rows remain; the done group carries them
      } else {
        list.innerHTML = shownInbox.map(renderCandidateRow).join('');
        list.querySelectorAll('.candidate-item').forEach(bindCandidateRow);
      }

      renderDoneGroup(done);
      updateCandidateCounts();
    }

    // The "Done recently (N)" collapse — compact one-line-per-item, newest first.
    function renderDoneGroup(done) {
      var wrap = document.getElementById('candidateDone');
      var listEl = document.getElementById('candidateDoneList');
      var label = document.getElementById('candidateDoneLabel');
      var toggle = document.getElementById('candidateDoneToggle');
      if (!wrap || !listEl || !label || !toggle) return;

      if (toggle && !toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        toggle.addEventListener('click', function() {
          // Pure visibility flip — no need to re-filter/re-sort/rebuild the list.
          candidateDoneExpanded = !candidateDoneExpanded;
          listEl.hidden = !candidateDoneExpanded;
          toggle.setAttribute('aria-expanded', candidateDoneExpanded ? 'true' : 'false');
        });
      }

      if (done.length === 0) { wrap.hidden = true; return; }
      wrap.hidden = false;

      done.sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

      label.textContent = 'Done recently (' + done.length + ')';
      listEl.hidden = !candidateDoneExpanded;
      toggle.setAttribute('aria-expanded', candidateDoneExpanded ? 'true' : 'false');

      listEl.innerHTML = done.map(function(c) {
        var shelf = c.docId
          ? '<a class="candidate-done-shelf" href="#" data-act="open-done" data-doc-id="' + esc(c.docId) + '" data-url="' + esc(c.url || '') + '">On the shelf &#8599;</a>'
          : '<span class="candidate-done-shelf static">On the shelf</span>';
        return '<div class="candidate-done-item">' +
          '<span class="candidate-done-title" title="' + esc(c.title || '') + '">' + esc(c.title || '') + '</span>' +
          shelf +
        '</div>';
      }).join('');

      listEl.querySelectorAll('[data-act="open-done"]').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          openSummaryDoc(a.getAttribute('data-doc-id'), a.getAttribute('data-url') || '', 'anthropic');
        });
      });
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
        if (res.status === 409) { updateCandidateStatus(id, 'summarizing'); return; }

        var data = await res.json().catch(function() { return {}; });

        // Already on the shelf — surface the existing doc and flip the row.
        if (data && data.duplicate) {
          updateCandidateStatus(id, 'summarized', data.doc_id);
          if (typeof showDuplicateBanner === 'function') showDuplicateBanner();
          return;
        }

        if (!res.ok || !data || !data.job_id) {
          if (sBtn) sBtn.disabled = false;
          console.error('summarize failed:', res.status, data);
          return;
        }

        // Stream the visible job card (reuse wholesale) and flip the row in-progress.
        updateCandidateStatus(id, 'summarizing');
        showJob(data.job_id, title, url, 'anthropic');
        connectSSE(data.job_id, 'anthropic');
        watchCandidateJob(data.job_id, id);
      } catch (err) {
        if (sBtn) sBtn.disabled = false;
        console.error('startCandidateSummarize failed:', err);
      }
    }

    // A per-row SSE listener that only watches for terminal events to flip the row's
    // model entry — decoupled from the job card's own stream so the shared streamer
    // stays untouched. Keyed by candidate id (not a DOM node) because a re-render
    // replaces the row element while the job runs.
    function watchCandidateJob(jobId, id) {
      var conn = sseClient('/api/anthropic/stream/' + jobId, {
        complete: async function() {
          conn.close();
          var docId = '';
          try {
            // limit=100 (the endpoint's cap): the jobs list is newest-first, and an
            // auto-promote burst can create several jobs in the window between this
            // job's kick and its completion — the default 20 could evict it and lose
            // its docId (→ a non-functional "On the shelf" link).
            var d = await getJson('/api/anthropic/jobs?limit=100');
            var job = (d.jobs || []).find(function(j) { return j.id === jobId; });
            if (job && job.docId) docId = job.docId;
          } catch {}
          updateCandidateStatus(id, 'summarized', docId);
        },
        // e.data present = an application-level job error; a bare error is just a
        // transient connection blip (EventSource auto-reconnects) — ignore it.
        error: function(e) {
          if (e.data) { conn.close(); updateCandidateStatus(id, 'error'); }
        },
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
          setTimeout(function() { removeCandidate(id); }, 200);
        } else {
          removeCandidate(id);
        }
      } catch (err) {
        btn.disabled = false;
        console.error('dismissCandidate failed:', err);
      }
    }

    async function loadCandidates() {
      var list = document.getElementById('candidateList');
      if (!list) return;
      try {
        var data = await getJson('/api/anthropic/candidates');
        candidatesState = (data && data.candidates) || [];
        candidatesLoadError = false;
        renderCandidates();
      } catch (err) {
        // A failed inbox shouldn't break the page — show a distinct error state.
        console.error('loadCandidates failed:', err);
        candidatesState = [];
        candidatesLoadError = true;
        renderCandidates();
      }
    }
  `;
}
