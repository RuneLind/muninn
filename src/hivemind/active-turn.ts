/**
 * Per-bot stack of active chat turns, keyed by bot name. Push at the start
 * of `processMessage`, pop at the end. `peek` returns the most recent
 * threadId still in flight for that bot — used by the hivemind MCP tool
 * handlers to discover which thread originated an outbound peer call so
 * inbound replies can route back to it (see `correlation.ts` + `router.ts`).
 *
 * Trade-off: concurrent turns on the same bot race — the most recent push
 * wins. Acceptable for the typical single-user-per-bot case; upgrade to a
 * per-MCP-session binding (per-turn URL) if multi-user concurrent traffic
 * starts misrouting replies.
 */

const stacks = new Map<string, string[]>();

export function pushActiveTurn(botName: string, threadId: string): void {
  let stack = stacks.get(botName);
  if (!stack) {
    stack = [];
    stacks.set(botName, stack);
  }
  stack.push(threadId);
}

export function popActiveTurn(botName: string, threadId: string): void {
  const stack = stacks.get(botName);
  if (!stack) return;
  // Pop the most recent matching entry — protects against mismatched
  // push/pop ordering if multiple turns interleave.
  const idx = stack.lastIndexOf(threadId);
  if (idx >= 0) stack.splice(idx, 1);
  if (stack.length === 0) stacks.delete(botName);
}

export function peekActiveTurn(botName: string): string | null {
  const stack = stacks.get(botName);
  if (!stack || stack.length === 0) return null;
  return stack[stack.length - 1] ?? null;
}

/** Test-only — reset the stack between tests. */
export function _resetActiveTurnsForTests(): void {
  stacks.clear();
}
