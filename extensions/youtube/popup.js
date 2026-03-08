const $ = (sel) => document.querySelector(sel);

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
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'SUMMARIZE',
        title: videoInfo.title,
        url: videoInfo.url,
        videoId: videoInfo.videoId,
      }, (response) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });

    // Close popup — dashboard tab is now open
    window.close();
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
    btn.disabled = false;
  }
}
