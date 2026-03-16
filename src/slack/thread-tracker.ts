/** In-memory tracker for threads where the bot has responded — auto-respond without re-tagging.
 *  Key: "channel:threadTs", Value: last activity timestamp */

const THREAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createThreadTracker() {
  const activeThreads = new Map<string, number>();

  function trackThread(channel: string, threadTs: string) {
    activeThreads.set(`${channel}:${threadTs}`, Date.now());
    // Prune old threads
    if (activeThreads.size > 500) {
      const cutoff = Date.now() - THREAD_TTL_MS;
      for (const [key, ts] of activeThreads) {
        if (ts < cutoff) activeThreads.delete(key);
      }
    }
  }

  function isTrackedThread(channel: string, threadTs: string): boolean {
    const key = `${channel}:${threadTs}`;
    const ts = activeThreads.get(key);
    if (!ts) return false;
    if (Date.now() - ts > THREAD_TTL_MS) {
      activeThreads.delete(key);
      return false;
    }
    activeThreads.set(key, Date.now()); // refresh TTL
    return true;
  }

  return { trackThread, isTrackedThread };
}
