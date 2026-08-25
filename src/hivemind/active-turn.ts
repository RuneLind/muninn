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
 * belongs to. {@link resolveActiveTurn} is the honest read: the binding first,
 * the stack only while it is unambiguous, and *nothing* otherwise.
 *
 * **`resolveActiveTurn` is NOT applied everywhere, deliberately.** Its only
 * caller is `research/thread-citations.ts`, because there the wrong answer is a
 * row written DURABLY into someone else's thread. The hivemind tool handlers
 * (`mcp-server.ts`) still `peek` bare, and that is a different trade rather than
 * an oversight: a mis-routed peer reply is an ephemeral message in the wrong
 * conversation, while REFUSING to route it drops the reply into the default
 * `peer:<ns>/<name>` bucket and loses the thread it belonged to. Neither is
 * good; both are recoverable, and neither is a durable write. Re-decide that
 * alongside the auth work — it is not closed here.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const stacks = new Map<string, string[]>();

/** The turn a piece of work belongs to, when it runs inside one. */
export interface ActiveTurnBinding {
  botName: string;
  /**
   * The originating thread, or null for a turn that has none.
   *
   * A THREADLESS turn binds too, and that is the point: left unbound it would
   * fall through to the stack, where — with exactly one other turn in flight —
   * the ambiguity guard reads "1, unambiguous" and files its hits into that
   * other person's thread. Binding null says "this turn has no thread", which
   * resolves to no row rather than someone else's.
   */
  threadId: string | null;
}

const turnStorage = new AsyncLocalStorage<ActiveTurnBinding>();

/**
 * Run `fn` bound to a turn, so everything in its async chain can recover the
 * originating thread via {@link currentActiveTurn}.
 *
 * Scoped deliberately tightly — around the connector call rather than the whole
 * of `processMessage` — because that is the only span whose descendants need it,
 * and a narrow scope is what keeps the binding honest. Binds unconditionally,
 * including for a threadless turn: see {@link ActiveTurnBinding.threadId}.
 */
export function runInActiveTurn<T>(
  botName: string,
  threadId: string | null | undefined,
  fn: () => T,
): T {
  return turnStorage.run({ botName, threadId: threadId ?? null }, fn);
}

/** The turn the current async context belongs to, or null outside one. */
export function currentActiveTurn(): ActiveTurnBinding | null {
  return turnStorage.getStore() ?? null;
}

/**
 * The thread a piece of work belongs to, in order of certainty — the read for
 * any caller that must not attribute work to the wrong conversation.
 *
 *  1. **The async binding**, when it is for this bot — exact, and the common
 *     path (the tool-result seam runs inside the turn's own async chain). Its
 *     `threadId` may legitimately be null; that is an answer, not a miss.
 *  2. **The per-bot stack, only while unambiguous** — for the out-of-band caller
 *     with no context to inherit: muninn's own MCP servers are separate
 *     `Bun.serve` listeners answering the model's subprocess. With one turn in
 *     flight there is nothing to be wrong about.
 *  3. **Nothing.** Two turns up and no binding is a guess, and the caller that
 *     needs this would rather have no answer than a wrong one.
 *
 * `ambiguous` distinguishes (3) from an honest "no turn at all" so the caller
 * can say which happened.
 */
export function resolveActiveTurn(botName: string): { threadId: string | null; ambiguous: boolean } {
  const bound = currentActiveTurn();
  // The bot guard is not paranoia: a bound context from a DIFFERENT bot's turn
  // would be exactly as wrong as the stack race this replaces.
  if (bound && bound.botName === botName) return { threadId: bound.threadId, ambiguous: false };

  // DISTINCT threads, not stack depth: two concurrent turns in the SAME thread
  // (an ordinary message while a 60-600 s Jira draft turn runs in the same
  // conversation) are not ambiguous at all, and counting entries dropped a row
  // whose correct answer was never in doubt.
  const threads = new Set(stacks.get(botName) ?? []);
  if (threads.size > 1) return { threadId: null, ambiguous: true };
  return { threadId: peekActiveTurn(botName), ambiguous: false };
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
