/**
 * The retry ladder for a chat socket that NEVER OPENED.
 *
 * ## Why this is a separate decision from an ordinary reconnect
 *
 * `connectWs` has two close cases and they are not the same event:
 *
 *  - **The socket opened, then dropped.** An ordinary network blip. It retries
 *    every 2 s forever, which is correct: the connection demonstrably worked
 *    once, and the condition self-heals.
 *  - **The socket never fired `open`.** The browser reports a REFUSED handshake
 *    as an ordinary 1006 close (see `page.ts`'s `connectWs`), so the page probes
 *    `/chat/me` to tell a refusal from a drop. Only a **401** there is treated
 *    as a dead session — and `src/auth/ws-upgrade.ts` answers **403** to an
 *    origin-refused handshake while `/chat/me` answers 200. That pair is a
 *    session the server says is ALIVE behind a handshake it will never accept,
 *    and the page then retried it every 2 s for as long as the tab stayed open.
 *
 * This module is the bound on that second case, and ONLY that case.
 *
 * ## Bounded, and then VISIBLE
 *
 * A refused upgrade is a configuration fact (an origin missing from
 * `MUNINN_ALLOWED_ORIGINS`, a proxy that drops the `Origin` header), not a
 * transient — so retrying it forever cannot succeed and retrying it silently is
 * the worst of both: no live updates and nothing on screen saying so. The ladder
 * therefore backs off, gives up after a handful of attempts, and the page states
 * it. Deliberately NOT the session-expiry banner: nothing here has expired, and
 * telling a reader their session ended when it did not is the class of lie
 * `authed-fetch.ts`'s `provider === null` rule exists to prevent.
 *
 * The schedule is short on purpose (~12 s to the notice). It is spent entirely
 * on a condition that does not self-heal, and the recovery — reload the page —
 * is one the reader can only take once they are told.
 */

/**
 * Delay before the Nth pre-open retry, in ms. The array LENGTH is the cap:
 * `WS_PREOPEN_BACKOFF_MS.length` retries follow the initial attempt, and then
 * the page gives up and says so.
 */
export const WS_PREOPEN_BACKOFF_MS: readonly number[] = [2000, 4000, 6000];

/**
 * How long to wait before the retry that follows `failures` consecutive
 * pre-open failures, or **null** when the ladder is spent.
 *
 * `failures` is 1-based: 1 is "the first attempt never opened".
 *
 * The page's injected script interpolates {@link WS_PREOPEN_BACKOFF_MS} and
 * indexes it with exactly this rule; this function is where the rule is stated
 * and tested, since a template string is invisible to `tsc`.
 */
export function nextPreOpenRetryDelayMs(failures: number): number | null {
  if (!Number.isFinite(failures) || failures < 1) return null;
  const delay = WS_PREOPEN_BACKOFF_MS[failures - 1];
  return delay === undefined ? null : delay;
}

/** The id of the one-per-page "live updates are unavailable" bar. Separate from
 *  `EXPIRED_BANNER_ID` because it reports a different fact. */
export const WS_STALLED_NOTICE_ID = "chatConnStalledNotice";

/** The copy. Names what stopped working, what did NOT (the session), and the one
 *  recovery a reader has. */
export const WS_STALLED_NOTICE_TEXT =
  "Live updates are unavailable — the chat connection was refused. " +
  "Your session is still valid; reload the page to try again.";
