const $ = (sel) => document.querySelector(sel);

let videoInfo = null;

document.addEventListener('DOMContentLoaded', async () => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state && state.videoId) {
      videoInfo = state;
      showVideoPage(state);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!/tiktok\.com\/.+\/video\/\d+/.test(tabs[0]?.url || '')) {
          showManualOnly();
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, (info) => {
          if (info && info.videoId) {
            videoInfo = info;
            showVideoPage(info);
          } else {
            showManualOnly();
          }
        });
      });
    }
  });

  $('#btn-summarize').addEventListener('click', handleSummarize);
  $('#btn-manual').addEventListener('click', handleManualSummarize);
  $('#manual-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleManualSummarize();
  });
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

function showVideoPage(state) {
  $('#video-title').textContent = state.title;
  $('#video-info').classList.remove('hidden');
  // A video was detected — the manual field becomes a "wrong video?" override.
  $('#manual-hint').textContent = 'Not this video? Paste the right TikTok URL:';
  $('#manual').classList.add('with-divider');
}

function showManualOnly() {
  // No video detected — e.g. the For You feed, which keeps the URL at /foryou
  // so the content script can't read a /video/<id> off the path.
  $('#manual-hint').textContent =
    "Couldn't detect a video here. Paste the TikTok URL to summarize it:";
}

// Accept a pasted link with or without a scheme; require a tiktok.com host.
// Short links (vm./vt.tiktok.com) and canonical /video/<id> URLs are both
// resolved server-side, so we only sanity-check the host here.
function normalizeTikTokUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
  return u.toString();
}

async function handleSummarize() {
  // Re-fetch fresh video info from the content script — the feed may have
  // advanced to a different video since the popup opened.
  const freshInfo = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return resolve(null);
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, resolve);
    });
  });
  if (freshInfo && freshInfo.videoId) {
    videoInfo = freshInfo;
  }
  await submit(videoInfo.url, videoInfo.title);
}

async function handleManualSummarize() {
  const url = normalizeTikTokUrl($('#manual-url').value);
  if (!url) {
    showError("That doesn't look like a TikTok URL.");
    return;
  }
  // No caption available for a pasted URL — the server derives a title from the
  // video itself, and passing the URL as the title is the existing fallback.
  await submit(url, url);
}

async function submit(url, title) {
  const status = $('#status');
  const buttons = [$('#btn-summarize'), $('#btn-manual')];

  buttons.forEach((b) => (b.disabled = true));
  status.className = '';
  status.innerHTML = '<span class="spinner"></span>Submitting to dashboard...';
  status.classList.remove('hidden');

  try {
    // Submit to Muninn — opens dashboard in new tab
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'SUMMARIZE', title, url }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });

    if (result?.duplicate) {
      status.className = '';
      status.textContent = 'Already summarized — opening existing summary.';
      setTimeout(() => window.close(), 1200);
      return;
    }

    // Close popup — dashboard tab is now open
    window.close();
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
    buttons.forEach((b) => (b.disabled = false));
  }
}

function showError(msg) {
  const status = $('#status');
  status.className = 'error';
  status.textContent = msg;
  status.classList.remove('hidden');
}
