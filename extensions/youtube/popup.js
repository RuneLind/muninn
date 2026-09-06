const $ = (sel) => document.querySelector(sel);

// The Slides tick, remembered per browser under the same sync storage the
// Muninn URL lives in. Default OFF: slides cost a download, an ffmpeg pass and
// a multi-turn model session, so they are opt-in per the plan.
const FRAMES_KEY = 'frames';

let videoInfo = null;

document.addEventListener('DOMContentLoaded', async () => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (state && state.videoId) {
      videoInfo = state;
      showVideoPage(state);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.url?.includes('youtube.com/watch')) {
          $('#not-video').classList.remove('hidden');
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, (info) => {
          if (info && info.videoId) {
            videoInfo = info;
            showVideoPage(info);
          } else {
            $('#not-video').classList.remove('hidden');
          }
        });
      });
    }
  });

  // Restore the remembered tick, then persist every change. Both halves are
  // guarded: a storage failure must leave the button working, not the popup
  // dead — the tick then simply defaults to off for that session.
  const frames = $('#chk-frames');
  try {
    const stored = await chrome.storage.sync.get({ [FRAMES_KEY]: false });
    frames.checked = stored[FRAMES_KEY] === true;
  } catch (err) {
    console.warn('Could not read the Slides preference', err);
  }
  frames.addEventListener('change', () => {
    chrome.storage.sync
      .set({ [FRAMES_KEY]: frames.checked })
      .catch((err) => console.warn('Could not save the Slides preference', err));
  });

  $('#btn-summarize').addEventListener('click', handleSummarize);
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

function showVideoPage(state) {
  $('#video-title').textContent = state.title;
  $('#video-info').classList.remove('hidden');
}

async function handleSummarize() {
  const btn = $('#btn-summarize');
  const status = $('#status');

  btn.disabled = true;
  status.className = '';
  status.innerHTML = '<span class="spinner"></span>Submitting to dashboard...';
  status.classList.remove('hidden');

  try {
    // Re-fetch fresh video info from the content script
    const freshInfo = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve(null);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_INFO' }, resolve);
      });
    });
    if (freshInfo && freshInfo.videoId) {
      videoInfo = freshInfo;
    }

    // Submit to Muninn — opens dashboard in new tab
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'SUMMARIZE',
        title: videoInfo.title,
        url: videoInfo.url,
        videoId: videoInfo.videoId,
        // Always a real boolean: the route 400s `bad_frames` on anything else.
        frames: $('#chk-frames').checked === true,
      }, (response) => {
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
    btn.disabled = false;
  }
}
