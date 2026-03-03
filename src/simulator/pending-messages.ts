/**
 * Temporary in-memory store for pending research messages.
 *
 * When the Chrome extension posts a Jira task to /api/research/chat,
 * the message text is stored here instead of being processed immediately.
 * The chat page picks it up via GET /chat/pending/:threadId and sends
 * it through the normal chat pipeline (with WebSocket already connected).
 */

export interface PendingMeta {
  jiraContent?: string;
  title?: string;
}

export interface PendingResult {
  text: string;
  jiraContent?: string;
  title?: string;
}

interface PendingEntry {
  text: string;
  jiraContent?: string;
  title?: string;
  timer: Timer;
}

const pendingMessages = new Map<string, PendingEntry>();

const EXPIRE_MS = 5 * 60 * 1000; // 5 minutes

export function setPendingMessage(threadId: string, text: string, meta?: PendingMeta): void {
  // Clear any existing entry
  const existing = pendingMessages.get(threadId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => pendingMessages.delete(threadId), EXPIRE_MS);
  pendingMessages.set(threadId, { text, jiraContent: meta?.jiraContent, title: meta?.title, timer });
}

export function consumePendingMessage(threadId: string): PendingResult | null {
  const entry = pendingMessages.get(threadId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingMessages.delete(threadId);
  return { text: entry.text, jiraContent: entry.jiraContent, title: entry.title };
}
