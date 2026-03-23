/**
 * Background service worker.
 * Submits X article content to Muninn for summarization, opens dashboard.
 */

const tabState = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'ARTICLE_PAGE':
      if (tabId) {
        tabState[tabId] = {
          articleId: message.articleId,
          author: message.author,
          url: message.url,
          title: message.title,
        };
      }
      break;

    case 'GET_STATE':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const state = tabs[0] ? tabState[tabs[0].id] : null;
        sendResponse(state || { error: 'Not on an X article page' });
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

async function handleSummarize({ title, url, articleId, author, articleText }) {
  const settings = await getSettings();

  const response = await fetch(`${settings.muninnUrl}/api/x-articles/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      url,
      article_id: articleId,
      author,
      article_text: articleText,
    }),
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
  const dashboardUrl = `${settings.muninnUrl}${result.dashboard_url || `/x-articles?job=${result.job_id}`}`;
  chrome.tabs.create({ url: dashboardUrl });

  return result;
}
