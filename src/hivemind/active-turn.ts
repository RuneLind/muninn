/**
 * Which chat turn is in flight, in two forms.
 *
 * **The exact one — {@link runInActiveTurn} / {@link currentActiveTurn}.** An
 * `AsyncLocalStorage` binding around the connector call, so anything running
 * INSIDE that turn's own async chain — the shared tool-result tail
 * (`ai/connectors/tool-span.ts`), the claude-cli `StreamParser` — can ask which
 * turn it belongs to and get an answer that is right by construction, with no
 * plumbing and no race. Concurrent turns on one bot each carry their own store.
 *
 * **The per-bot stack — {@link pushActiveTurn} / {@link peekActiveTurn}.** For
 * callers with no async link to the turn: muninn's own MCP servers, which are
 * separate `Bun.serve` listeners handling a request the model's subprocess made,
 * so there is nothing to inherit a store from. `peek` returns the most recent
 * threadId still in flight for that bot and is what the hivemind tool handlers
 * use to route an outbound peer call back to its origin thread
 * (`correlation.ts` + `router.ts`).
 *
 * **The stack's race is real and it is why `peek` is not the whole answer.**
 * Two people chatting one bot concurrently get the most recent push, whoever it
 * belongs to. That was accepted for a single-user instance; it stopped being
 * acceptable the moment a mis-attributed row is written DURABLY into someone
 * else's thread (`research/thread-citations.ts`, which now prefers the async
 * binding and treats an ambiguous stack as *unknown* rather than guessing —
 * see {@link activeTurnCount}).
 */

import { AsyncLocalStorage } from "node:async_hooks";

const stacks = new Map<string, string[]>();

/** The turn a piece of work belongs to, when it runs inside one. */
export interface ActiveTurnBinding {
  botName: string;
  threadId: string;
}

const turnStorage = new AsyncLocalStorage<ActiveTurnBinding>();

/**
 * Run `fn` bound to a turn, so everything in its async chain can recover the
 * originating thread via {@link currentActiveTurn}.
 *
 * Scoped deliberately tightly — around the connector call rather than the whole
 * of `processMessage` — because that is the only span whose descendants need
 * it, and a narrow scope is what keeps the binding honest. Pass a null/empty
 * `threadId` to run unbound (nothing to attribute to).
 */
export function runInActiveTurn<T>(
  botName: string,
  threadId: string | null | undefined,
  fn: () => T,
): T {
  if (!threadId) return fn();
  return turnStorage.run({ botName, threadId }, fn);
}

/** The turn the current async context belongs to, or null outside one. */
export function currentActiveTurn(): ActiveTurnBinding | null {
  return turnStorage.getStore() ?? null;
}

/** How many turns are in flight for a bot — 2+ means `peek` would be a guess. */
export function activeTurnCount(botName: string): number {
  return stacks.get(botName)?.length ?? 0;
}

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

/** Test-only — reset the stack between tests. Does not touch the async binding,
 *  which is scoped to its own `run` call and cannot leak between tests. */
export function _resetActiveTurnsForTests(): void {
  stacks.clear();
}
