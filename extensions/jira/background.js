/**
 * Background service worker.
 * Listens for messages from content script to keep the message port open.
 */

chrome.runtime.onMessage.addListener(() => {
  // Content script sends JIRA_ISSUE_PAGE on navigation.
  // No response needed — just prevent "message port closed" warnings.
  return false;
});
