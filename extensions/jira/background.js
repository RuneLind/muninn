/**
 * Background service worker.
 *
 * Declared in manifest as the extension's service_worker. The popup talks to the
 * content script directly (chrome.tabs.sendMessage → GET_JIRA_INFO), so this
 * worker has no active role; the inert listener just absorbs any stray runtime
 * message without leaving the port open.
 */

chrome.runtime.onMessage.addListener(() => {
  // No response needed — returning false closes the port immediately.
  return false;
});
