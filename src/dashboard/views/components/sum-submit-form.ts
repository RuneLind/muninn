/** Summaries page — the two manual capture entries.
 *
 * 1. **A URL field** (`captureUrlFormHtml`), always visible: paste a Vimeo link
 *    and the page POSTs it to `/api/vimeo/summarize`, then shows the ordinary
 *    job card walking `harvesting_captions → summarizing → ingesting →
 *    complete`. Vimeo is the one vertical with no Chrome extension — its capture
 *    starts from a headless browser muninn drives itself, so a URL is the whole
 *    input.
 * 2. **A pasted-article textarea** (`sumSubmitFormHtml`), collapsed behind the
 *    page's "+ Paste article" toggle: a textarea plus optional Title and URL
 *    fields, POSTed to `/api/articles/summarize`. YouTube and X are captured via
 *    the Chrome extension, so a bare URL pasted there still points the user at
 *    the extension rather than trying (and failing) to fetch the page — EXCEPT a
 *    Vimeo link, which is forwarded to the same submit the URL field uses, so
 *    pasting into the wrong box works. */

export function sumSubmitFormStyles(): string {
  return `
    .submit-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 24px;
    }
    .submit-form textarea,
    .submit-form input {
      width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      box-sizing: border-box;
    }
    .submit-form textarea {
      min-height: 120px;
      resize: vertical;
      line-height: 1.5;
    }
    .submit-form textarea::placeholder,
    .submit-form input::placeholder { color: var(--text-dim); }
    .submit-form textarea:focus,
    .submit-form input:focus { outline: none; border-color: var(--accent); }
    .submit-form-meta {
      display: flex;
      gap: 10px;
    }
    .submit-form-meta input { flex: 1; }
    .submit-form-row {
      display: flex;
      justify-content: flex-end;
    }
    .submit-form button {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    .submit-form button:hover { opacity: 0.9; }
    .submit-form button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* The always-visible URL field. One line, shares the field + button look of
       the collapsed paste form above. */
    .capture-url-form {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .capture-url-form input {
      flex: 1;
      min-width: 0;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      box-sizing: border-box;
    }
    .capture-url-form input::placeholder { color: var(--text-dim); }
    .capture-url-form input:focus { outline: none; border-color: var(--accent); }
    .capture-url-form button {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .capture-url-form button:hover { opacity: 0.9; }
    .capture-url-form button:disabled { opacity: 0.5; cursor: not-allowed; }
  `;
}

/**
 * The one-line capture-by-URL form. Rendered ABOVE the collapsed paste form, and
 * never collapsed itself: it is the whole entry point for the Vimeo vertical.
 */
export function captureUrlFormHtml(): string {
  return `
    <div class="capture-url-form">
      <input type="url" id="captureUrl" aria-label="Vimeo URL" placeholder="Paste a Vimeo URL…" autocomplete="off" spellcheck="false" />
      <button id="captureUrlBtn" type="button" onclick="submitCaptureUrlFromInput()">Summarize</button>
    </div>`;
}

export function sumSubmitFormHtml(): string {
  return `
    <div class="submit-form">
      <textarea id="articleText" placeholder="Paste article text to summarize (e.g. a LinkedIn article)…"></textarea>
      <div class="submit-form-meta">
        <input type="text" id="articleTitle" placeholder="Title (optional)" />
        <input type="text" id="articleUrl" placeholder="Original URL (optional)" />
      </div>
      <div class="submit-form-row">
        <button id="submitBtn" onclick="submitArticle()">Summarize</button>
      </div>
    </div>`;
}

export function sumSubmitFormScript(): string {
  return `
    // A "bare URL" paste — the whole textarea is a single http(s) link and
    // nothing else. YouTube/X can't be fetched server-side, so route the user to
    // the Chrome extension instead of failing opaquely.
    function isBareUrl(text) {
      var t = text.trim();
      if (/\\s/.test(t)) return false;
      try {
        var u = new URL(t);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch { return false; }
    }

    async function submitArticle() {
      var textEl = document.getElementById('articleText');
      var titleEl = document.getElementById('articleTitle');
      var urlEl = document.getElementById('articleUrl');
      var text = textEl.value.trim();
      if (!text) return;

      if (isBareUrl(text)) {
        // A Vimeo link pasted into the WRONG box still works — it goes to the
        // same submit the URL field uses. Every other bare link keeps today's
        // alert, byte for byte: those verticals are captured with the extension
        // and there is nothing here to forward them to.
        if (detectCaptureProvider(text) === 'vimeo') {
          // The button the reader actually pressed is this form's own, not the
          // URL field's — the forward used to disable and relabel a button on
          // the other side of the page while #submitBtn sat there looking idle.
          await submitCaptureUrl(text, {
            buttonId: 'submitBtn',
            clear: function() { textEl.value = ''; },
          });
          return;
        }
        alert('This looks like a bare link. YouTube and X posts are captured with the Muninn Chrome extension — open the page and click the extension. This form wants the pasted article text itself.');
        return;
      }

      var title = titleEl.value.trim();
      var url = urlEl.value.trim();

      var btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      try {
        var res = await fetch('/api/articles/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, title: title, url: url }),
        });
        var data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Failed to start');
          return;
        }
        if (data.duplicate) {
          // Already summarized — jump to the existing doc.
          showDuplicateBanner();
          openSummaryDoc(data.document_id, data.existing_url || '', 'article');
          textEl.value = '';
          return;
        }
        // Update URL without reload. Preserve the active tab hash (switchSection
        // wrote it) so the rewrite doesn't yank the user off their current tab.
        var subject = title || url || 'Pasted article';
        history.replaceState(null, '', '/summaries?source=article&job=' + data.job_id + location.hash);
        showJob(data.job_id, subject, url, 'article');
        connectSSE(data.job_id, 'article');
        textEl.value = '';
        titleEl.value = '';
        urlEl.value = '';
      } catch (err) {
        alert('Request failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Summarize';
      }
    }

    // Ctrl/Cmd+Enter in the textarea submits (a plain Enter is a newline).
    document.getElementById('articleText').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !document.getElementById('submitBtn').disabled) submitArticle();
    });

    // --- Capture by URL ----------------------------------------------------

    /**
     * Which capture vertical a pasted link BELONGS to — a HINT, and only that.
     * The host test is deliberately loose (any vimeo.com / player.vimeo.com
     * address, whatever the path), because its one job is deciding whether a
     * bare link in the ARTICLE box is forwardable rather than alert-worthy. The
     * server's \`resolveVimeoRef\` is the authority on what is actually a video,
     * and answers 400 for everything it cannot resolve — which is why the URL
     * field itself does NOT consult this and posts whatever was typed.
     */
    function detectCaptureProvider(url) {
      var u;
      try { u = new URL(String(url).trim()); } catch { return null; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      var host = u.hostname.toLowerCase();
      if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') return 'vimeo';
      return null;
    }

    /**
     * The submit buttons' resting labels, snapshotted ONCE at script init.
     *
     * Read at call time instead, a submit that starts while another is in flight
     * captures "Starting..." and restores THAT in its \`finally\` — permanently,
     * because nothing else ever writes the label back.
     */
    var CAPTURE_BUTTON_LABELS = {};
    (function() {
      ['captureUrlBtn', 'submitBtn'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) CAPTURE_BUTTON_LABELS[id] = el.textContent;
      });
    })();

    /**
     * POST one url to the Vimeo capture route and render whatever comes back on
     * the job card — a streaming job, an attach to one already running, a
     * duplicate, or a refusal as a SENTENCE (see \`vimeoSentence\` in the job
     * card, the one place those strings live).
     *
     * \`opts.clear\` is called only on an answer that STARTED or ADOPTED
     * something: a refusal leaves the reader's text where they can fix it.
     * \`opts.buttonId\` is the button the reader actually pressed (default: the
     * URL field's own).
     *
     * ⚠️ Nothing here touches a LIVE stream. An answer that is not a fresh job
     * is a banner when one is running (\`showCaptureOutcome\` decides that), and
     * the reconnect below is skipped for the same reason — reconnecting to the
     * job already streaming closed the working EventSource and opened a second
     * one that received the state replay and then nothing at all.
     */
    async function submitCaptureUrl(url, opts) {
      var options = opts || {};
      var btnId = options.buttonId || 'captureUrlBtn';
      var btn = document.getElementById(btnId);
      var btnLabel = CAPTURE_BUTTON_LABELS[btnId] || 'Summarize';
      if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
      // A refusal from the PREVIOUS paste is not an answer about this one, and it
      // outlived the whole next request.
      clearCaptureBanner();
      try {
        var res = await fetch('/api/vimeo/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url }),
        });
        var data = {};
        try { data = await res.json(); } catch (e) { data = {}; }

        if (!res.ok) {
          // A 400 carries no machine code (the route spells the url in prose),
          // so the STATUS is what names it; every other refusal carries one.
          var code = res.status === 400 ? 'bad_url' : data.error;
          showCaptureOutcome(url, {
            status: 'error',
            sentence: vimeoSentence(code, data) || data.error || ('Capture refused (HTTP ' + res.status + ')'),
          });
          return;
        }

        if (data.duplicate) {
          showCaptureOutcome(url, {
            status: 'duplicate',
            tone: 'notice',
            sentence: vimeoSentence('duplicate'),
            link: data.dashboard_url,
            linkLabel: 'open the summary',
            areaText: 'This video is already in the archive.',
          });
          if (options.clear) options.clear();
          return;
        }

        // Every remaining answer claims to carry a job. Validated BEFORE the URL
        // is rewritten: a 200 with neither \`duplicate\` nor \`job_id\` put
        // \`?job=undefined\` in the address bar and opened a stream on
        // \`/api/vimeo/stream/undefined\`.
        if (typeof data.job_id !== 'string' || data.job_id === '') {
          showCaptureOutcome(url, {
            status: 'error',
            sentence: 'The capture route answered something this page cannot read',
          });
          return;
        }

        var live = captureStreamIsLive();
        if (data.in_flight) {
          showCaptureOutcome(url, {
            status: 'pending',
            tone: 'notice',
            jobId: data.job_id,
            title: data.title,
            sentence: vimeoSentence('in_flight'),
          });
          if (!live) {
            // Preserve the active tab hash (switchSection wrote it) so the
            // rewrite doesn't yank the user off it.
            history.replaceState(null, '', '/summaries?source=vimeo&job=' + data.job_id + location.hash);
            connectSSE(data.job_id, 'vimeo');
          }
        } else {
          history.replaceState(null, '', '/summaries?source=vimeo&job=' + data.job_id + location.hash);
          // The route's own title, so the card is labelled with the video's name
          // from the first frame rather than with the pasted address until a
          // reload replaces it.
          showJob(data.job_id, data.title || url, url, 'vimeo');
          connectSSE(data.job_id, 'vimeo');
        }
        if (options.clear) options.clear();
      } catch (err) {
        showCaptureOutcome(url, { status: 'error', sentence: 'Request failed: ' + err.message });
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
      }
    }

    async function submitCaptureUrlFromInput() {
      var el = document.getElementById('captureUrl');
      var url = el.value.trim();
      if (!url) return;
      await submitCaptureUrl(url, { clear: function() { el.value = ''; } });
    }

    // Enter submits — this is a one-line field, not a textarea.
    document.getElementById('captureUrl').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !document.getElementById('captureUrlBtn').disabled) submitCaptureUrlFromInput();
    });
  `;
}
