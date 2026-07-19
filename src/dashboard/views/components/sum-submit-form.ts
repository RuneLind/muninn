/** Summaries page — pasted-article submission form.
 *
 * The primary capture path is pasted text (first use case: LinkedIn articles):
 * a textarea plus optional Title and URL fields, POSTed to
 * `/api/articles/summarize`. YouTube and X are captured via the Chrome
 * extension, so if the user pastes a bare URL the form points them there rather
 * than trying (and failing) to fetch the page. */

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
  `;
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
  `;
}
