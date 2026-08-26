/**
 * The retry rules for a chat socket that NEVER OPENED.
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
 *    `/chat/me` to tell a refusal from an outage.
 *
 * This module is the decision for that second case, and ONLY that case.
 *
 * ## The probe has THREE answers, not two
 *
 * The first cut asked a yes/no question — "is the session alive?" — and answered
 * **yes** to everything that was not a 401, transport failures included. That
 * collapsed two opposite conditions into one, and the ladder below then fired on
 * the wrong one. Measured on the composed page: muninn restarting, a laptop
 * waking with the network still down, and a `503` from an introspection outage
 * each spent the whole ladder in ~12 s and then stopped **permanently**, with an
 * amber "the chat connection was refused" bar over a server that was coming back
 * up. (The wake case is the sharpest: every 2 s retry builds a NEW `connectWs`
 * closure whose `everOpened` is `false`, so the *post*-open reconnect degrades
 * into pre-open attempts and is bounded by a ladder written for something else.)
 *
 * So {@link classifyChatSessionProbe} answers three things:
 *
 * | probe result | meaning | what happens |
 * |---|---|---|
 * | `dead` (**401**) | the session is gone | `__muninnAuthRefusal('ws')` — reload or banner, terminal |
 * | `refused` (**2xx**) | the session is FINE and the upgrade is still refused | one rung of the ladder below |
 * | `unknown` (5xx, a transport failure, anything else) | an outage that says nothing about the session | retry in {@link WS_UNKNOWN_RETRY_MS}, forever, no rung, no notice |
 *
 * `unknown` is unbounded on purpose. Every condition in it — a restart, a dead
 * network, a Texas outage answered `503` — self-heals, and the page's whole job
 * meanwhile is to be there when it does.
 *
 * ## The `refused` ladder: bounded, and then VISIBLE
 *
 * `src/auth/ws-upgrade.ts` answers **403** to an origin-refused handshake while
 * `/chat/me` answers **200**. That pair is a session the server says is alive
 * behind a handshake it will never accept — a configuration fact (an origin
 * missing from `MUNINN_ALLOWED_ORIGINS`, a proxy that drops the `Origin`
 * header), not a transient. Retrying it forever cannot succeed and retrying it
 * silently is the worst of both: no live updates and nothing on screen saying
 * so. The ladder therefore backs off, gives up after a handful of attempts, and
 * the page states it. Deliberately NOT the session-expiry banner: nothing here
 * has expired, and telling a reader their session ended when it did not is the
 * class of lie `authed-fetch.ts`'s `provider === null` rule exists to prevent.
 *
 * The schedule is short on purpose (~12 s to the notice). It is spent entirely
 * on a condition that does not self-heal, and the recovery — reload the page —
 * is one the reader can only take once they are told.
 *
 * ## One source for the rules, in BOTH places they run
 *
 * The page's `connectWs` is a template string, invisible to `tsc`, and the first
 * cut left it indexing `WS_PREOPEN_BACKOFF_MS` by hand beside a
 * `nextPreOpenRetryDelayMs` that only the unit test ever called. {@link
 * wsRetryScript} emits these functions THEMSELVES (`Function.prototype.toString`
 * on the transpiled source — the `askDeclineReason` idiom in
 * `src/dashboard/views/research-page.ts`), so the page runs the code this module
 * declares rather than a hand-port of it, and `ws-retry.test.ts` drives the
 * emitted script rather than grepping the page for a literal.
 */

/**
 * Delay before the Nth pre-open retry of a REFUSED handshake, in ms. The array
 * LENGTH is the cap: `WS_PREOPEN_BACKOFF_MS.length` retries follow the initial
 * attempt, and then the page gives up and says so.
 */
export const WS_PREOPEN_BACKOFF_MS: readonly number[] = [2000, 4000, 6000];

/** The flat, UNBOUNDED retry for an `unknown` probe — the same 2 s an ordinary
 *  post-open drop uses, because it is the same kind of condition. */
export const WS_UNKNOWN_RETRY_MS = 2000;

/** What `/chat/me` said about the session behind a handshake that never opened. */
export type ChatSessionProbe = "dead" | "refused" | "unknown";

/**
 * Classify a `/chat/me` response.
 *
 * ⚠️ Only a **2xx** is evidence the session is alive. The predicate this
 * replaced was `status !== 401`, which called a `503` — the answer an
 * authenticating instance gives while token introspection is UNAVAILABLE — proof
 * of a healthy session, and then counted it as a refusal rung.
 */
export function classifyChatSessionProbe(res: { status?: number } | null | undefined): ChatSessionProbe {
  if (!res || typeof res.status !== "number") return "unknown";
  if (res.status === 401) return "dead";
  if (res.status >= 200 && res.status < 300) return "refused";
  return "unknown";
}

/**
 * How long to wait before the retry that follows `failures` consecutive
 * REFUSED pre-open failures, or **null** when the ladder is spent.
 *
 * `failures` is 1-based: 1 is "the first attempt never opened".
 */
export function nextPreOpenRetryDelayMs(failures: number): number | null {
  if (!Number.isFinite(failures) || failures < 1) return null;
  const delay = WS_PREOPEN_BACKOFF_MS[failures - 1];
  return delay === undefined ? null : delay;
}

/** Everything the ladder does to the outside world. The page supplies the real
 *  ones; a test supplies counters, which is what makes the LOOP testable rather
 *  than just the arithmetic. */
export interface PreOpenRetryDeps {
  /** Ask `/chat/me`. Never rejects — a transport failure is `unknown`. */
  probe: () => Promise<ChatSessionProbe>;
  /** Open another socket. */
  retry: () => void;
  /** The session is gone: `__muninnAuthRefusal('ws')`. Terminal. */
  expired: () => void;
  /** The ladder is spent: show the amber "live updates are unavailable" bar. */
  stall: () => void;
  /** A socket opened: take that bar back down. */
  clearStall: () => void;
  schedule: (fn: () => void, ms: number) => void;
}

export interface PreOpenRetry {
  /** A socket OPENED — the ladder starts over and the notice comes off. */
  reset: () => void;
  /** A socket closed WITHOUT ever opening. */
  onClose: () => void;
}

/**
 * The pre-open close handler: probe, then act on which of the three answers came
 * back. Only `refused` spends a rung, and only a spent ladder shows the notice.
 */
export function makePreOpenRetry(deps: PreOpenRetryDeps): PreOpenRetry {
  let failures = 0;
  return {
    reset: function () {
      failures = 0;
      deps.clearStall();
    },
    onClose: function () {
      deps.probe().then(function (state) {
        if (state === "dead") {
          deps.expired();
          return;
        }
        if (state !== "refused") {
          // An outage — a restart, a dead network, a 503 from introspection.
          // It says nothing about this session, it self-heals, and a ladder
          // written for a permanent config fact must not bound it.
          deps.schedule(deps.retry, WS_UNKNOWN_RETRY_MS);
          return;
        }
        failures++;
        const delay = nextPreOpenRetryDelayMs(failures);
        if (delay === null) {
          deps.stall();
          return;
        }
        deps.schedule(deps.retry, delay);
      });
    },
  };
}

/**
 * The three rules above, as browser JS for the chat page's inline script.
 *
 * They are emitted from the FUNCTIONS, not re-typed: a hand-port is what left
 * the page indexing the backoff array by hand while the tested helper sat
 * unused. `WS_PREOPEN_BACKOFF_MS` is declared as a `var` because
 * `nextPreOpenRetryDelayMs` closes over that name (a numeric const like
 * `WS_UNKNOWN_RETRY_MS` is inlined by the transpiler and needs no declaration).
 */
export function wsRetryScript(): string {
  return `
  var WS_PREOPEN_BACKOFF_MS = ${JSON.stringify(WS_PREOPEN_BACKOFF_MS)};
  ${nextPreOpenRetryDelayMs.toString()}
  ${classifyChatSessionProbe.toString()}
  ${makePreOpenRetry.toString()}
`;
}

/** The id of the one-per-page "live updates are unavailable" bar. Separate from
 *  `EXPIRED_BANNER_ID` because it reports a different fact. */
export const WS_STALLED_NOTICE_ID = "chatConnStalledNotice";

/** The copy. Names what stopped working, what did NOT (the session), and the one
 *  recovery a reader has. */
export const WS_STALLED_NOTICE_TEXT =
  "Live updates are unavailable — the chat connection was refused. " +
  "Your session is still valid; reload the page to try again.";
