/** Summaries page — URL submission form.
 *
 * Only YouTube can be summarized straight from a pasted URL; X articles are
 * client-rendered so their text must come from the Chrome extension (the page
 * can't fetch it). The form detects an X/Twitter link and points the user at
 * the extension rather than failing opaquely. */

export function sumSubmitFormStyles(): string {
  return `
    .submit-form {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
    }
    .submit-form input {
      flex: 1;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
    }
    .submit-form input::placeholder { color: var(--text-dim); }
    .submit-form input:focus { outline: none; border-color: var(--accent); }
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
      <input type="text" id="urlInput" placeholder="Paste a YouTube URL to summarize..." />
      <button id="submitBtn" onclick="submitUrl()">Summarize</button>
    </div>`;
}

export function sumSubmitFormScript(): string {
  return `
    function extractVideoId(url) {
      try {
        var u = new URL(url);
        if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
        if (u.hostname === 'youtu.be') return u.pathname.slice(1);
      } catch {}
      return null;
    }

    function isXUrl(url) {
      try {
        var h = new URL(url).hostname;
        // Match x.com / twitter.com and their subdomains (www., mobile., m., …).
        return h === 'x.com' || h === 'twitter.com' ||
          h.endsWith('.x.com') || h.endsWith('.twitter.com');
      } catch { return false; }
    }

    async function submitUrl() {
      var input = document.getElementById('urlInput');
      var url = input.value.trim();
      if (!url) return;

      if (isXUrl(url)) {
        alert('X articles must be added with the Muninn Chrome extension — open the article on x.com and click the extension. The page can\\'t fetch X article text directly.');
        return;
      }

      var videoId = extractVideoId(url);
      if (!videoId) {
        alert('Paste a YouTube URL (youtube.com/watch?v=… or youtu.be/…).');
        return;
      }

      var btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      try {
        var res = await fetch('/api/youtube/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '', url: url, video_id: videoId }),
        });
        var data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Failed to start');
          return;
        }
        if (data.duplicate) {
          // Already summarized — jump to the existing doc.
          showDuplicateBanner();
          openSummaryDoc(data.document_id, data.existing_url || '', 'youtube');
          input.value = '';
          return;
        }
        // Update URL without reload. Preserve the active tab hash (switchSection
        // wrote it) so the rewrite doesn't yank the user off their current tab.
        history.replaceState(null, '', '/summaries?source=youtube&job=' + data.job_id + location.hash);
        showJob(data.job_id, url, url, 'youtube');
        connectSSE(data.job_id, 'youtube');
        input.value = '';
      } catch (err) {
        alert('Request failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Summarize';
      }
    }

    // Allow Enter key in input
    document.getElementById('urlInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitUrl();
    });
  `;
}
