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

/**
 * Whether a pending message is still queued (and unexpired) for this thread.
 *
 * A read-only peek — deliberately NOT a consume. {@link setPendingMessage} is
 * last-write-wins, so a second seed posted onto a thread whose first seed nobody
 * opened yet silently destroys that first question. Writers that target an
 * EXISTING thread (the wiki reader's "Send there →") check this first and refuse
 * rather than clobber.
 */
export function hasPendingMessage(threadId: string): boolean {
  return pendingMessages.has(threadId);
}

/**
 * Set a pending message ONLY if the thread has none queued — the atomic form of
 * `hasPendingMessage()` + `setPendingMessage()`.
 *
 * Returns `false` (and writes nothing) when a seed is already queued. The split
 * pair is a real TOCTOU for any writer that targets an EXISTING thread: the
 * checking route awaits several round-trips (connector lookup, connector stamp,
 * conversation shell) between its peek and its write, and `setPendingMessage` is
 * last-write-wins — so a second escalation landing inside that window destroys a
 * question nobody has opened yet, which is the exact outcome the peek exists to
 * prevent. Being one synchronous function on a single-threaded event loop is what
 * makes it atomic.
 */
export function setPendingMessageIfAbsent(
  threadId: string,
  text: string,
  meta?: PendingMeta,
): boolean {
  if (pendingMessages.has(threadId)) return false;
  setPendingMessage(threadId, text, meta);
  return true;
}

export function consumePendingMessage(threadId: string): PendingResult | null {
  const entry = pendingMessages.get(threadId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingMessages.delete(threadId);
  return { text: entry.text, jiraContent: entry.jiraContent, title: entry.title };
}
