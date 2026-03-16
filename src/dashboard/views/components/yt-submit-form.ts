/** YouTube page — URL submission form */

export function ytSubmitFormStyles(): string {
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

export function ytSubmitFormHtml(): string {
  return `
    <div class="submit-form">
      <input type="text" id="urlInput" placeholder="Paste a YouTube URL to summarize..." />
      <button id="submitBtn" onclick="submitUrl()">Summarize</button>
    </div>`;
}

export function ytSubmitFormScript(): string {
  return `
    function extractVideoId(url) {
      try {
        var u = new URL(url);
        if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
        if (u.hostname === 'youtu.be') return u.pathname.slice(1);
      } catch {}
      return null;
    }

    async function submitUrl() {
      var input = document.getElementById('urlInput');
      var url = input.value.trim();
      if (!url) return;

      var videoId = extractVideoId(url);
      if (!videoId) {
        alert('Invalid YouTube URL');
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
        // Update URL without reload
        history.replaceState(null, '', '/youtube?job=' + data.job_id);
        showJob(data.job_id, url, url);
        connectSSE(data.job_id);
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
