/**
 * Background service worker.
 * Submits YouTube videos to Muninn for summarization, opens dashboard.
 */

const tabState = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'VIDEO_PAGE':
      if (tabId) {
        tabState[tabId] = {
          videoId: message.videoId,
          url: message.url,
          title: message.title,
        };
      }
      break;

    case 'GET_STATE':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const state = tabs[0] ? tabState[tabs[0].id] : null;
        sendResponse(state || { error: 'Not on a YouTube video page' });
      });
      return true;

    case 'SUMMARIZE':
      handleSummarize(message).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabState[tabId];
});

async function getSettings() {
  return chrome.storage.sync.get({
    muninnUrl: 'http://localhost:3010',
  });
}

async function handleSummarize({ title, url, videoId }) {
  const settings = await getSettings();

  // Submit to Muninn — it handles transcript, summarization, indexing
  const response = await fetch(`${settings.muninnUrl}/api/youtube/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, url, video_id: videoId }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    let msg = `Muninn error: ${response.status}`;
    if (typeof err.detail === 'string') msg = err.detail;
    else if (typeof err.error === 'string') msg = err.error;
    else if (Array.isArray(err.detail)) msg = err.detail.map(d => d.msg).join(', ');
    throw new Error(msg);
  }

  const result = await response.json();

  // Open dashboard in new tab to see streaming progress
  const dashboardUrl = `${settings.muninnUrl}${result.dashboard_url || `/youtube?job=${result.job_id}`}`;
  chrome.tabs.create({ url: dashboardUrl });

  return result;
}
