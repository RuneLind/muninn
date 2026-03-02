/**
 * Temporary in-memory store for pending research messages.
 *
 * When the Chrome extension posts a Jira task to /api/research/chat,
 * the message text is stored here instead of being processed immediately.
 * The chat page picks it up via GET /chat/pending/:threadId and sends
 * it through the normal chat pipeline (with WebSocket already connected).
 */

const pendingMessages = new Map<string, { text: string; timer: Timer }>();

const EXPIRE_MS = 5 * 60 * 1000; // 5 minutes

export function setPendingMessage(threadId: string, text: string): void {
  // Clear any existing entry
  const existing = pendingMessages.get(threadId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => pendingMessages.delete(threadId), EXPIRE_MS);
  pendingMessages.set(threadId, { text, timer });
}

export function consumePendingMessage(threadId: string): string | null {
  const entry = pendingMessages.get(threadId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingMessages.delete(threadId);
  return entry.text;
}
