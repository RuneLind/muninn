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
    /* The kind + language picker beside the URL field — the same field look. */
    .capture-url-form select {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
    }
    .capture-url-form select:focus { outline: none; border-color: var(--accent); }
    .capture-url-form .capture-frames {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .capture-url-form .capture-frames:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
    @media (max-width: 720px) {
      .capture-url-form { flex-wrap: wrap; }
      .capture-url-form input { flex-basis: 100%; }
    }
  `;
}

/** One `{id, label}` option of the picker, as the page injects it. */
export interface CapturePickerOption {
  id: string;
  label: string;
}

/**
 * The localStorage key the picker's controls persist under, per browser.
 * Versioned (the plan-board draft-key idiom): a changed shape gets a new key
 * rather than a migration.
 */
export const CAPTURE_PREFS_KEY = "muninn.summaries.capture.v1";

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function selectHtml(id: string, label: string, options: readonly CapturePickerOption[]): string {
  const opts = options
    .map((o) => `<option value="${escapeAttr(o.id)}">${escapeAttr(o.label)}</option>`)
    .join("");
  return `<select id="${id}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${opts}</select>`;
}

/**
 * The one-line capture-by-URL form. Rendered ABOVE the collapsed paste form, and
 * never collapsed itself: it is the whole entry point for the Vimeo vertical.
 */
export function captureUrlFormHtml(picker: {
  kinds: readonly CapturePickerOption[];
  langs: readonly CapturePickerOption[];
  /**
   * Whether the SUMMARIZER bot's connector can read frames (`supportsExtraDirs`).
   * When false the Slides checkbox renders DISABLED with the reason in its
   * title, rather than absent — the reader learns why there are no slides
   * instead of never seeing the control. Default true (a render with no bot in
   * hand — tests).
   */
  framesSupported?: boolean;
}): string {
  const framesSupported = picker.framesSupported ?? true;
  const framesTitle = framesSupported
    ? "Pull one slide frame every ~40 s of the talk and let the summary quote slides inline (off by default; remembered)"
    : "The summarizer bot's connector cannot read frame files (no extra-dirs support) — set SUMMARIZER_BOT to a claude-cli or claude-sdk bot";
  return `
    <div class="capture-url-form">
      <input type="url" id="captureUrl" aria-label="Vimeo URL" placeholder="Paste a Vimeo URL…" autocomplete="off" spellcheck="false" />
      ${selectHtml("captureKind", "Summary kind", picker.kinds)}
      ${selectHtml("captureLang", "Output language", picker.langs)}
      <label class="capture-frames" title="${escapeAttr(framesTitle)}"><input type="checkbox" id="captureFrames"${framesSupported ? "" : " disabled"} /> Slides</label>
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
     * The picker's two controls, remembered per browser under
     * \`CAPTURE_PREFS_KEY\` — a reader who summarizes Norwegian talks as talk
     * notes should not re-pick that on every paste. Every read and write is in
     * a try/catch (private windows and blocked storage throw on the accessor
     * itself), a stored value that is not one of the select's options is
     * ignored (a kind the server stopped offering must not leave the select on
     * a blank), and with nothing stored the selects keep their first option —
     * the server's defaults.
     */
    var CAPTURE_PREFS_KEY = ${JSON.stringify(CAPTURE_PREFS_KEY)};

    function readCapturePrefs() {
      try {
        var raw = localStorage.getItem(CAPTURE_PREFS_KEY);
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) { return {}; }
    }

    function writeCapturePrefs(prefs) {
      try { localStorage.setItem(CAPTURE_PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
    }

    /** Set a select to \`value\` only if it is one of its options. */
    function selectIfOffered(el, value) {
      if (!el || typeof value !== 'string') return;
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === value) { el.value = value; return; }
      }
    }

    /**
     * The picker's current choice, as the capture POST body carries it.
     * \`frames\` is always a boolean: a DISABLED checkbox (the summarizer's
     * connector cannot read frames) reads false whatever storage remembers,
     * so a browser that ticked Slides on one instance never sends a 503 on
     * another.
     */
    function capturePickerValues() {
      var kindEl = document.getElementById('captureKind');
      var langEl = document.getElementById('captureLang');
      var framesEl = document.getElementById('captureFrames');
      var out = {};
      if (kindEl && kindEl.value) out.kind = kindEl.value;
      if (langEl && langEl.value) out.lang = langEl.value;
      out.frames = !!(framesEl && !framesEl.disabled && framesEl.checked);
      return out;
    }

    (function initCapturePicker() {
      var kindEl = document.getElementById('captureKind');
      var langEl = document.getElementById('captureLang');
      var framesEl = document.getElementById('captureFrames');
      var prefs = readCapturePrefs();
      selectIfOffered(kindEl, prefs.kind);
      selectIfOffered(langEl, prefs.lang);
      // Off by default (the plan's decision); restored only as a real boolean.
      if (framesEl && !framesEl.disabled && prefs.frames === true) framesEl.checked = true;
      // A DISABLED box has nothing to say about the reader's standing choice:
      // the picker's kind/lang changes persist too, and rewriting \`frames\`
      // from a disabled box erased a tick made on another instance (measured
      // by review: laptop ticks Slides, the copilot-summarizer instance changes
      // only the kind, the tick is gone on both). Storage keeps what it had.
      function persist() {
        var values = capturePickerValues();
        if (framesEl && framesEl.disabled) {
          var stored = readCapturePrefs();
          if (typeof stored.frames === 'boolean') values.frames = stored.frames;
        }
        writeCapturePrefs(values);
      }
      if (kindEl && kindEl.addEventListener) kindEl.addEventListener('change', persist);
      if (langEl && langEl.addEventListener) langEl.addEventListener('change', persist);
      if (framesEl && framesEl.addEventListener) framesEl.addEventListener('change', persist);
    })();

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
        // The picker rides on EVERY capture POST, the article-box forward
        // included: the kind and language are the reader's standing choice,
        // not a property of the box the link was pasted into.
        var picked = capturePickerValues();
        var res = await fetch('/api/vimeo/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url, kind: picked.kind, lang: picked.lang, frames: picked.frames }),
        });
        var data = {};
        try { data = await res.json(); } catch (e) { data = {}; }

        if (!res.ok) {
          // A 400 about the URL carries no machine code (the route spells the
          // url in prose), so the STATUS names it — unless the body carries a
          // \`code\` (a refused kind or language); every other refusal
          // carries one in \`error\`.
          var code = res.status === 400 ? (typeof data.code === 'string' ? data.code : 'bad_url') : data.error;
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
