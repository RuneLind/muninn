/**
 * Background service worker.
 * Caches Jira issue page state per tab for the popup to query.
 */

const tabState = {};

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message.type === 'JIRA_ISSUE_PAGE' && tabId) {
    tabState[tabId] = message;
  }

  // No async response needed — must not leave port hanging
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabState[tabId];
});
