/** Summaries page — active job card with status badge, summary area, SSE
 * streaming, and similar articles. Source-aware: streaming + similar calls are
 * routed to the active job's source (SOURCES[source].apiBase). */

import { markdownContentStyles } from "./doc-panel.ts";

export function sumJobCardStyles(): string {
  return `
    /* --- Job card: one-line progress strip + collapsible detail --- */
    .job-card {
      background: var(--bg-panel);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-primary));
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    .job-strip {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
    }
    .job-title {
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .job-title a { color: var(--text-primary); text-decoration: none; }
    .job-title a:hover { color: var(--accent-light); }
    .job-strip .status-badge { flex-shrink: 0; }
    .job-strip .category-badge { flex-shrink: 0; }

    /* Expand ▾ — reveals the streaming text / similar detail below the strip. */
    .job-expand {
      flex-shrink: 0;
      background: none;
      border: 1px solid var(--border-secondary);
      color: var(--text-dim);
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .job-expand:hover { color: var(--text-secondary); border-color: var(--accent); }

    /* Thin progress rail — an indeterminate sweep while the job is active. */
    .job-progress {
      height: 3px;
      background: var(--bg-surface);
      position: relative;
      overflow: hidden;
      display: none;
    }
    .job-card.running .job-progress { display: block; }
    .job-progress-fill {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 40%;
      background: var(--accent);
      border-radius: 0 2px 2px 0;
      animation: job-progress-sweep 1.4s ease-in-out infinite;
    }
    @keyframes job-progress-sweep {
      0%   { left: -40%; }
      100% { left: 100%; }
    }

    .job-detail {
      border-top: 1px solid var(--border-primary);
    }
    .job-detail[hidden] { display: none; }

    /* --- Status badge --- */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-pending { background: color-mix(in srgb, var(--text-dim) 20%, transparent); color: var(--text-dim); }
    .status-fetching_transcript, .status-downloading, .status-transcribing, .status-harvesting_captions { background: color-mix(in srgb, var(--status-info) 20%, transparent); color: var(--status-info); }
    .status-summarizing, .status-extracting_frames { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent-light); }
    .status-ingesting { background: color-mix(in srgb, var(--status-warning) 20%, transparent); color: var(--status-warning); }
    .status-complete { background: color-mix(in srgb, var(--status-success) 20%, transparent); color: var(--status-success); }
    .status-error { background: color-mix(in srgb, var(--status-error) 20%, transparent); color: var(--status-error); }
    /* Not a job status the server ever sends — the card's own badge for a
       capture route answering "this video is already in the archive". It is
       terminal and it is not an error, so it takes the info tone rather than
       either of the two above. */
    .status-duplicate { background: color-mix(in srgb, var(--status-info) 20%, transparent); color: var(--status-info); }

    .status-badge .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* --- Category badge --- */
    .category-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }

    /* --- Summary area --- */
    .summary-area {
      padding: 20px;
      min-height: 120px;
      color: var(--text-secondary);
      line-height: 1.7;
      font-size: 15px;
    }
    .summary-area.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-dim);
      font-style: italic;
    }
    ${markdownContentStyles(".summary-area")}
    .summary-cursor {
      display: inline-block;
      width: 2px;
      height: 1em;
      background: var(--accent);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* Was an inline style attribute on the element. It moved here so the notice tone
       below can override the border at all — an inline declaration wins over
       every stylesheet rule, so the red top border survived the tone swap. */
    #errorBanner {
      margin: 0;
      border-radius: 0;
      border-top: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
    }

    /* The card's banner carries NON-error outcomes too — "already captured",
       "already being captured" — so it gets a second TONE rather than a second
       element: it is the one line inside the card the reader is already looking
       at. */
    #errorBanner.notice {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--text-secondary);
    }
    #errorBanner.notice a { color: var(--accent-light); }

    /* --- Similar articles --- */
    .similar-panel {
      border-top: 1px solid var(--border-primary);
      padding: 16px 20px;
      display: none;
    }
    .similar-panel.visible { display: block; }
    .similar-panel h3 {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 10px;
    }
    .similar-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .similar-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--bg-surface);
      font-size: 13px;
    }
    .similar-item-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .similar-item-header a {
      color: var(--accent-light);
      text-decoration: none;
      font-weight: 500;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .similar-item-header a:hover { text-decoration: underline; }
    .similar-relevance {
      font-size: 11px;
      color: var(--text-dim);
      font-weight: 600;
      flex-shrink: 0;
    }
    .similar-snippet {
      font-size: 12px;
      color: var(--text-dim);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .similar-view-md {
      font-size: 12px;
      color: var(--accent-light);
      text-decoration: none;
      cursor: pointer;
      opacity: 0.7;
    }
    .similar-view-md:hover { opacity: 1; text-decoration: underline; }
  `;
}

export function sumJobCardHtml(): string {
  return `
    <div class="job-card" id="jobCard" style="display:none">
      <div class="job-strip">
        <span class="status-badge status-pending" id="statusBadge">
          <span class="spinner"></span>
          <span class="status-text">Pending</span>
        </span>
        <span class="job-title" id="jobTitle"></span>
        <span class="category-badge" id="categoryBadge" style="display:none"></span>
        <button class="job-expand" id="jobExpandBtn" type="button" aria-expanded="true">Collapse &#9652;</button>
      </div>
      <div class="job-progress" id="jobProgress"><div class="job-progress-fill"></div></div>
      <div class="job-detail" id="jobDetail">
        <div class="summary-area empty" id="summaryArea">
          Waiting for summary...
        </div>
        <div class="error-banner" id="errorBanner"></div>
        <div class="similar-panel" id="similarPanel">
          <h3>Similar</h3>
          <div class="similar-list" id="similarList"></div>
        </div>
      </div>
    </div>`;
}

export function sumJobCardScript(): string {
  return `
    var accumulatedText = '';
    var currentJobId = null;
    var currentJobTitle = null;
    var currentSource = 'youtube';
    var eventSource = null;

    var STATUS_LABELS = {
      pending: 'Pending',
      fetching_transcript: 'Fetching transcript',
      harvesting_captions: 'Harvesting captions',
      downloading: 'Downloading',
      transcribing: 'Transcribing',
      extracting_frames: 'Extracting frames',
      summarizing: 'Summarizing',
      ingesting: 'Indexing',
      complete: 'Complete',
      error: 'Error',
      // Not a job status: the card's badge for a capture route that answered
      // "already captured" and started nothing.
      duplicate: 'Already captured'
    };

    var TERMINAL_STATES = ['complete', 'error', 'duplicate'];

    // --- Vimeo sentences: ONE map ------------------------------------------
    //
    // Read from two places — the URL form's rendering of a route answer that is
    // not a fresh job, and the job-error path below (\`no_captions\`). One map,
    // because a code spelled in two places drifts into a card reporting a
    // generic failure for a video Vimeo simply declined to describe.
    var VIMEO_SENTENCES = {
      bad_url: 'Not a Vimeo video URL',
      not_public: 'Vimeo says this video is not public',
      oembed_failed: 'Vimeo did not answer',
      no_captions: 'This video has no caption track',
      duplicate: 'Already captured',
      in_flight: 'Already being captured',
      bad_kind: 'That summary kind is not offered here',
      bad_lang: 'That output language is not offered here'
    };

    // The duration cap, in seconds, injected by the page from the SERVER
    // constant (\`VIMEO_MAX_DURATION_SEC\`, src/vimeo/limits.ts) — the same number
    // the route enforces and reports as \`maxSec\`. Read through this one accessor
    // so the two sentences that name the cap cannot drift from it, and so the
    // number is never re-spelled here as a literal.
    function vimeoCapSec(maxSec) {
      if (typeof maxSec === 'number' && isFinite(maxSec) && maxSec > 0) return maxSec;
      return VIMEO_MAX_DURATION_SEC;
    }

    // "3h" for the shipped 10800. Whole hours read as hours; anything else
    // spells the remainder, so raising the cap to 2.5 h does not silently
    // truncate the sentence to "2h".
    //
    // ONE duration format across this file: \`Nh\`, \`Nh Mm\`, \`Mm\` — no space
    // between the number and its unit, the same shape \`vimeoTooLongSentence\`
    // already used for the measurement it prints. The cap and the measurement
    // appear in ONE sentence ("Longer than the 3h cap (5h 33m)"), and two
    // spellings of the same quantity in one line read as two different units.
    // The cap omits a zero remainder and the measurement keeps it: a cap is a
    // named round number, a measurement is a measurement.
    //
    // Minutes are ROUNDED, not floored: the cap is the number the refusal is
    // about, and flooring 10830 s to "3h" would name a cap 30 s short of the one
    // the route enforces.
    function vimeoCapLabel(maxSec) {
      var min = Math.round(vimeoCapSec(maxSec) / 60);
      var h = Math.floor(min / 60);
      var m = min % 60;
      if (h && m) return h + 'h ' + m + 'm';
      if (h) return h + 'h';
      return m + 'm';
    }

    // \`too_long\` is the one sentence carrying a measurement, so it is derived
    // rather than stored. A duration the route did not report (it always does on
    // this branch) degrades to the cap alone rather than to "NaNh NaNm".
    //
    // The minutes are rounded ONCE, off the whole duration, and the hours read
    // off that — not hours-then-round-the-remainder, which reported 14390 s as
    // "3h 60m" (the remainder 3590 s rounds to 60 minutes, and 60 is not a
    // minute count). 14390 therefore reads "4h 0m": the rounding is to the
    // nearest minute of the WHOLE measurement, so 3h 59m 50s is four hours to
    // the nearest minute.
    function vimeoTooLongSentence(durationSec, maxSec) {
      var cap = 'Longer than the ' + vimeoCapLabel(maxSec) + ' cap';
      var secs = typeof durationSec === 'number' && isFinite(durationSec) && durationSec > 0
        ? Math.round(durationSec) : null;
      if (secs === null) return cap;
      var min = Math.round(secs / 60);
      var h = Math.floor(min / 60);
      var m = min % 60;
      return cap + ' (' + h + 'h ' + m + 'm)';
    }

    /** The sentence for a Vimeo route/job code, or null when there is none. */
    function vimeoSentence(code, data) {
      if (code === 'too_long') {
        return vimeoTooLongSentence(data && data.durationSec, data && data.maxSec);
      }
      if (code === 'duration_unknown') {
        return 'Vimeo did not report a duration, so the ' + vimeoCapLabel(data && data.maxSec) +
          ' cap cannot be checked';
      }
      // \`hasOwnProperty\`, not a bare lookup: \`VIMEO_SENTENCES['constructor']\` is
      // a truthy inherited member, so a bare read answered a code we have no
      // sentence for with the source of Object's constructor.
      if (!Object.prototype.hasOwnProperty.call(VIMEO_SENTENCES, code)) return null;
      return VIMEO_SENTENCES[code] || null;
    }

    // Per-source API prefix (from the SOURCES registry injected by the page).
    function sourceApiBase(source) {
      var s = SOURCES[source || currentSource];
      return s ? s.apiBase : '/api/youtube';
    }

    function renderMarkdown(text) {
      if (typeof marked === 'undefined') return '<pre>' + esc(text) + '</pre>';
      if (typeof marked.use === 'function' && !marked.__sanitized) {
        marked.use({ renderer: { html: function(token) { return esc(token.raw || token.text || ''); } } });
        marked.__sanitized = true;
      }
      return marked.parse(text);
    }

    function updateStatusBadge(status) {
      var badge = document.getElementById('statusBadge');
      badge.className = 'status-badge status-' + status;
      var isActive = !TERMINAL_STATES.includes(status);
      badge.innerHTML = (isActive ? '<span class="spinner"></span>' : '') +
        '<span class="status-text">' + esc(STATUS_LABELS[status] || status) + '</span>';
      // Drive the indeterminate progress rail — visible only while non-terminal.
      var card = document.getElementById('jobCard');
      if (card) card.classList.toggle('running', isActive);
    }

    // Reveal/collapse the streaming-text detail below the one-line strip.
    function setJobDetailExpanded(expanded) {
      var detail = document.getElementById('jobDetail');
      var btn = document.getElementById('jobExpandBtn');
      if (!detail || !btn) return;
      if (expanded) detail.removeAttribute('hidden');
      else detail.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      btn.innerHTML = (expanded ? 'Collapse \\u25B4' : 'Expand \\u25BE');
    }

    (function() {
      var btn = document.getElementById('jobExpandBtn');
      if (!btn) return;
      btn.addEventListener('click', function() {
        var detail = document.getElementById('jobDetail');
        setJobDetailExpanded(detail ? detail.hasAttribute('hidden') : true);
      });
    })();

    function showCategory(category) {
      var badge = document.getElementById('categoryBadge');
      badge.textContent = category;
      badge.style.display = 'inline-block';
    }

    function cleanSnippet(text) {
      if (!text) return '';
      // Strip [collection > path > title] prefix and tags: line
      return text.replace(/^\\[.*?\\]\\s*/, '').replace(/^tags:.*\\n?/m, '').trim();
    }

    function renderSimilar(articles) {
      if (!articles || articles.length === 0) return;
      var panel = document.getElementById('similarPanel');
      var list = document.getElementById('similarList');
      var source = currentSource;
      list.innerHTML = articles.map(function(a) {
        // Search API returns matchedChunks, ingest returns snippet
        var rawSnippet = a.snippet || (a.matchedChunks && a.matchedChunks[0] ? a.matchedChunks[0].content : '');
        var snippet = cleanSnippet(rawSnippet);
        var pct = typeof a.relevance === 'number' ? Math.round(a.relevance * 100) : null;
        var hasDocId = !!a.id;
        var displayTitle = (a.title || '').replace(/\\.md$/, '');
        return '<div class="similar-item">' +
          '<div class="similar-item-header">' +
            '<a href="' + esc(a.url || '#') + '" target="_blank" rel="noopener">' + esc(displayTitle) + '</a>' +
            (pct !== null ? '<span class="similar-relevance">' + pct + '%</span>' : '') +
          '</div>' +
          (snippet ? '<div class="similar-snippet">' + esc(snippet) + '</div>' : '') +
          (hasDocId ? '<a class="similar-view-md" href="#" data-doc-id="' + esc(a.id) + '" data-doc-url="' + esc(a.url || '') + '">View article</a>' : '') +
        '</div>';
      }).join('');
      panel.classList.add('visible');
      // Wire up view-md links — similar results live in the job's own source collection.
      list.querySelectorAll('.similar-view-md').forEach(function(link) {
        link.addEventListener('click', function(e) {
          e.preventDefault();
          openSummaryDoc(link.getAttribute('data-doc-id'), link.getAttribute('data-doc-url'), source);
        });
      });
    }

    async function loadJobSimilar(title) {
      if (!title) return;
      try {
        var res = await fetch(sourceApiBase() + '/similar?q=' + encodeURIComponent(title));
        if (!res.ok) return;
        var data = await res.json();
        var normalizedTitle = title.toLowerCase().trim();
        var results = (data.results || []).filter(function(r) {
          var rTitle = (r.title || '').replace(/\\.md$/, '').toLowerCase().trim();
          return rTitle !== normalizedTitle;
        }).slice(0, 5);
        if (results.length > 0) {
          renderSimilar(results);
        }
      } catch {}
    }

    function showError(message) {
      var banner = document.getElementById('errorBanner');
      banner.classList.remove('notice');
      // A vimeo job stores its refusals as CODES (\`no_captions\`), so the same
      // map the URL form reads turns them into a sentence here. Scoped to the
      // vimeo source: another vertical's error text must never be swallowed by
      // a code that happens to spell the same word.
      banner.textContent = (currentSource === 'vimeo' && vimeoSentence(message)) || message;
      banner.classList.add('visible');
      // An error is worth surfacing without a click — auto-expand the detail.
      setJobDetailExpanded(true);
    }

    /**
     * Is a capture STREAMING into this card right now?
     *
     * The pair, not either half: \`currentJobId\` survives a job that finished
     * (the card still shows it), and \`eventSource\` is nulled by every terminal
     * handler — so this is true exactly while events can still arrive.
     */
    function captureStreamIsLive() {
      return currentJobId !== null && eventSource !== null;
    }

    /**
     * WHICH job the banner currently on the card is about, or null when it is
     * about no job at all (a refusal, a duplicate — an answer about a url that
     * started nothing).
     *
     * It exists because \`complete\` may clear the banner ONLY when the banner
     * belongs to the job that just completed. Clearing unconditionally wiped an
     * answer about a DIFFERENT url: paste a second link mid-capture, get
     * "Already captured" (or a refusal) as the banner — which is the ONLY
     * feedback that paste gets, since a live stream is never repainted — and the
     * running job's completion, seconds later, erased it.
     */
    var bannerOwnerJob = null;

    /** Empty the card's banner and drop BOTH of its tones. */
    function clearCaptureBanner() {
      var banner = document.getElementById('errorBanner');
      if (!banner) return;
      banner.textContent = '';
      banner.classList.remove('visible');
      banner.classList.remove('notice');
      bannerOwnerJob = null;
    }

    /**
     * A capture-route answer that is not a fresh job — a refusal, a duplicate,
     * or an attach to a capture already running. It renders as a SENTENCE on the
     * card rather than an alert: the card is where the reader is already looking,
     * and a refusal is about the video, not about the form.
     *
     * ⚠️ When a capture is STREAMING, this is the BANNER AND NOTHING ELSE. The
     * answer is about the url just pasted; the card belongs to the job already
     * running, and repainting it threw that job away on screen while its stream
     * stayed open — measured: paste a second link mid-capture, get the refusal,
     * and twelve seconds later the FIRST job's summary streamed into a card
     * titled with the url that failed, under an Error badge, starting mid-word
     * (the repaint zeroes the accumulated text, so only the tail arrives).
     */
    function showCaptureOutcome(url, opts) {
      var live = captureStreamIsLive();
      if (!live) {
        showJob(opts.jobId || null, opts.title || url, url, opts.source || 'vimeo');
        updateStatusBadge(opts.status);
        if (opts.status !== 'pending') {
          // The card's placeholder promises a summary that is not coming.
          var area = document.getElementById('summaryArea');
          area.className = 'summary-area empty';
          area.textContent = opts.areaText || 'Nothing was captured.';
        }
      }
      var banner = document.getElementById('errorBanner');
      banner.classList.toggle('notice', opts.tone === 'notice');
      // Built as NODES, not innerHTML: the sentence is ours but the url in a
      // refusal is the reader's own paste.
      banner.textContent = opts.sentence;
      if (opts.link) {
        banner.appendChild(document.createTextNode(' — '));
        var a = document.createElement('a');
        a.href = opts.link;
        a.textContent = opts.linkLabel || 'open it';
        banner.appendChild(a);
      }
      banner.classList.add('visible');
      // Whose answer this is. \`opts.jobId\` is set only on an \`in_flight\` attach;
      // every other outcome is about a url that started nothing, so it owns no
      // job and no completion may clear it. Set AFTER the \`showJob\` branch
      // above — that path calls \`clearCaptureBanner\`, which nulls this.
      bannerOwnerJob = opts.jobId || null;
      setJobDetailExpanded(true);
    }

    function updateSummaryArea() {
      var area = document.getElementById('summaryArea');
      if (!accumulatedText) {
        area.className = 'summary-area empty';
        area.textContent = 'Waiting for summary...';
        return;
      }
      area.className = 'summary-area';
      area.innerHTML = renderMarkdown(accumulatedText) + '<span class="summary-cursor"></span>';
    }

    function finalizeSummary() {
      var area = document.getElementById('summaryArea');
      if (accumulatedText) {
        area.innerHTML = renderMarkdown(accumulatedText);
      }
    }

    function connectSSE(jobId, source) {
      if (eventSource) eventSource.close();
      currentJobId = jobId;
      if (source) currentSource = source;

      eventSource = sseClient(sourceApiBase() + '/stream/' + jobId, {
        status: function(e) {
          var data = JSON.parse(e.data);
          updateStatusBadge(data.status);
        },
        text_delta: function(e) {
          var data = JSON.parse(e.data);
          accumulatedText += data.text;
          updateSummaryArea();
        },
        category: function(e) {
          var data = JSON.parse(e.data);
          showCategory(data.category);
        },
        similar: function(e) {
          var data = JSON.parse(e.data);
          // Ingest returned similar articles — fetch scored results from search API
          renderSimilar(data.articles); // show immediately as fallback
          loadJobSimilar(currentJobTitle); // replace with scored results
        },
        complete: function(e) {
          // Backward-compatible: only TikTok ships a parsed summary on the complete
          // event (its multi-turn frame-reading session leaks tool chatter into the
          // streamed deltas). youtube/x/anthropic send an empty payload, so this is
          // a no-op for them and finalizeSummary renders the accumulated text.
          if (e && e.data) {
            try {
              var payload = JSON.parse(e.data);
              if (payload && typeof payload.summary === 'string') {
                accumulatedText = payload.summary;
              }
            } catch (err) {}
          }
          finalizeSummary();
          updateStatusBadge('complete');
          // Clear the banner only when it is about THIS job — the
          // "Already being captured" notice from a paste that ATTACHED to it,
          // which is answered now (a finished capture sitting under it reads as
          // still-queued).
          //
          // Never a banner about another url. While this job streamed, the
          // reader may have pasted a second link and been told "Already
          // captured", or refused; that banner is the ONLY feedback that paste
          // got (a live stream is never repainted), and clearing it here erased
          // the answer to a question the reader had just asked.
          //
          // Compared against \`jobId\` — this handler map's OWN job, from the
          // \`connectSSE\` closure — rather than \`currentJobId\`, which is mutable
          // and belongs to whichever stream is current.
          if (bannerOwnerJob === jobId) clearCaptureBanner();
          if (eventSource) eventSource.close();
          eventSource = null;
          if (typeof loadShelf === 'function') loadShelf(true);  // force-refresh so the just-ingested doc appears
        },
        // Server-sent named 'error' event (carries a message payload), distinct
        // from a native connection drop.
        error: function(e) {
          if (e.data) {
            var data = JSON.parse(e.data);
            showError(data.message);
          }
          updateStatusBadge('error');
          if (eventSource) eventSource.close();
          eventSource = null;
        },
      });
    }

    function showJob(jobId, title, url, source) {
      currentJobTitle = title;
      if (source) currentSource = source;
      var card = document.getElementById('jobCard');
      card.style.display = '';
      var titleEl = document.getElementById('jobTitle');
      // Only an http(s) address becomes an anchor. \`esc\` escapes the ATTRIBUTE,
      // which keeps the markup well-formed and does nothing about the scheme —
      // and one caller (\`showCaptureOutcome\` on a refusal) passes the reader's
      // own paste, so \`javascript:…\` was a live href on an operator page.
      var href = /^https?:\\/\\//i.test(String(url || '')) ? url : null;
      if (href) {
        titleEl.innerHTML = '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(title || 'Untitled') + '</a>';
      } else {
        titleEl.textContent = title || 'Untitled';
      }
      // Reset state
      accumulatedText = '';
      document.getElementById('summaryArea').className = 'summary-area empty';
      document.getElementById('summaryArea').textContent = 'Waiting for summary...';
      document.getElementById('categoryBadge').style.display = 'none';
      document.getElementById('similarPanel').classList.remove('visible');
      // BOTH tones: a card that opens with the previous capture's "Already being
      // captured" still on it is reporting the wrong thing about this one.
      clearCaptureBanner();
      setJobDetailExpanded(true);  // streaming text is the point — start expanded
      updateStatusBadge('pending');
    }
  `;
}
