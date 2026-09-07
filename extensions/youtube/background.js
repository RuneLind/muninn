/**
 * Background service worker.
 * Submits YouTube videos to Muninn for summarization, opens dashboard.
 *
 * `capture-rules.js` is emitted from `src/youtube/extension-options-rules.ts`
 * by `bun run build:extension` — the request body is built there, where it is
 * tested, rather than assembled twice.
 */
import { buildSummarizeBody } from './capture-rules.js';

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

    case 'GET_OPTIONS':
      handleGetOptions().then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
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

/**
 * What this Muninn offers — the summary kinds and whether slides are available.
 *
 * The fetch lives here rather than in the popup for the reason the SUMMARIZE
 * fetch does: `muninnUrl` is settings the worker owns, and it is routinely a
 * host the manifest does not grant, which only an extension-page fetch would
 * be blocked on. A plain GET with no custom headers, so it is a CORS *simple*
 * request and needs no preflight. Never throws for the popup: any failure comes
 * back as `{error}`, which the popup renders as "Standard only".
 */
async function handleGetOptions() {
  const settings = await getSettings();
  const response = await fetch(`${settings.muninnUrl}/api/youtube/options`);
  if (!response.ok) {
    throw new Error(`Muninn options: ${response.status}`);
  }
  return { options: await response.json() };
}

async function handleSummarize({ title, url, videoId, kind, frames }) {
  const settings = await getSettings();

  // Submit to Muninn — it handles transcript, summarization, indexing
  const response = await fetch(`${settings.muninnUrl}/api/youtube/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `frames` and `kind` are coerced here rather than trusted from the popup
    // message: the route refuses a non-boolean with 400 `bad_frames` and an
    // unoffered id with 400 `bad_kind`. An older popup sends neither — which is
    // today's transcript-only Standard capture, exactly as before.
    body: JSON.stringify(
      buildSummarizeBody({ title, url, videoId, kind, frames }),
    ),
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
