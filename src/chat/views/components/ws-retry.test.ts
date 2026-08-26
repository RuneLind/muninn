import { describe, test, expect } from "bun:test";
import {
  classifyChatSessionProbe,
  makePreOpenRetry,
  nextPreOpenRetryDelayMs,
  wsRetryScript,
  WS_PREOPEN_BACKOFF_MS,
  WS_STALLED_NOTICE_ID,
  WS_STALLED_NOTICE_TEXT,
  WS_UNKNOWN_RETRY_MS,
  type ChatSessionProbe,
  type PreOpenRetry,
  type PreOpenRetryDeps,
} from "./ws-retry.ts";
import { EXPIRED_BANNER_ID } from "./authed-fetch.ts";
import { renderChatPage } from "../page.ts";

/**
 * The rules for a socket that never opened, driven as a LOOP.
 *
 * The first round of this test asserted `html.toContain("setTimeout(connectWs,
 * 2000)")` and that the backoff array was interpolated — string presence, which
 * is exactly what a rule with the wrong PREDICATE passes. The predicate was
 * wrong: `status !== 401` counted a restart, a dead network and a `503` from an
 * introspection outage as "the session is alive, so this is a refusal", and the
 * page then spent its 3-rung ladder in ~12 s and stopped forever with an amber
 * "the connection was refused" bar over a server that was coming back.
 *
 * So the tests below drive the FAILURE AXIS: a probe that keeps failing must
 * keep producing attempts past the ladder's length, and only a 2xx probe may
 * spend a rung or ever reach the notice. They run the code the PAGE runs —
 * `wsRetryScript()`'s emitted functions — not a TypeScript twin of it.
 */

// ── The emitted script, evaluated ─────────────────────────────────────────

interface Emitted {
  makePreOpenRetry: (deps: PreOpenRetryDeps) => PreOpenRetry;
  classifyChatSessionProbe: (res: { status?: number } | null | undefined) => ChatSessionProbe;
  nextPreOpenRetryDelayMs: (failures: number) => number | null;
}

/** The page has no module graph — these are function declarations in one inline
 *  script — so the test evaluates the emitted text the same way the browser does. */
function evalEmitted(): Emitted {
  const fn = new Function(
    `${wsRetryScript()}
     return {
       makePreOpenRetry: makePreOpenRetry,
       classifyChatSessionProbe: classifyChatSessionProbe,
       nextPreOpenRetryDelayMs: nextPreOpenRetryDelayMs
     };`,
  );
  return fn() as Emitted;
}

/** Let a `.then` chain settle between simulated timer fires. */
const settle = () => new Promise((r) => setTimeout(r, 0));

interface Run {
  /** How many sockets were opened, INCLUDING the first one the page opens at load. */
  attempts: number;
  /** The delay each scheduled retry was given, in order. */
  delays: number[];
  stalls: number;
  expiries: number;
  /** Timers still queued when the run stopped — 0 means the page gave up. */
  queued: number;
}

/**
 * Drive the real ladder against a socket that NEVER opens.
 *
 * `retry` closes immediately without an `open`, which is what a refused
 * handshake (and a network that is still down) looks like from the browser, so
 * this is the loop the measured defect lived in rather than an arithmetic check.
 */
async function drive(probe: () => Promise<ChatSessionProbe>, steps: number): Promise<Run> {
  const { makePreOpenRetry: make } = evalEmitted();
  const timers: { fn: () => void; ms: number }[] = [];
  const run: Run = { attempts: 0, delays: [], stalls: 0, expiries: 0, queued: 0 };
  let ladder!: PreOpenRetry;
  ladder = make({
    probe,
    retry: () => {
      run.attempts++;
      ladder.onClose(); // the new socket closes without ever opening, too
    },
    expired: () => { run.expiries++; },
    stall: () => { run.stalls++; },
    clearStall: () => {},
    schedule: (fn, ms) => { timers.push({ fn, ms }); },
  });

  run.attempts++; // the socket the page opens at load
  ladder.onClose();

  for (let i = 0; i < steps; i++) {
    await settle();
    const next = timers.shift();
    if (!next) break;
    run.delays.push(next.ms);
    next.fn();
  }
  await settle();
  run.queued = timers.length;
  return run;
}

const okProbe = async (): Promise<ChatSessionProbe> => classifyChatSessionProbe({ status: 200 });
const deadProbe = async (): Promise<ChatSessionProbe> => classifyChatSessionProbe({ status: 401 });

/** The page's own expression, verbatim: `authedFetch('/chat/me')` REJECTS (the
 *  network is down, muninn is restarting) and the catch maps it to `unknown`. */
const transportFailingProbe = (): Promise<ChatSessionProbe> =>
  Promise.reject(new Error("Failed to fetch")).then(classifyChatSessionProbe, () => "unknown" as ChatSessionProbe);

describe("the probe has three answers, and only ONE of them is a refusal", () => {
  test("2xx is alive-and-refused, 401 is dead, everything else is unknown", () => {
    expect(classifyChatSessionProbe({ status: 200 })).toBe("refused");
    expect(classifyChatSessionProbe({ status: 204 })).toBe("refused");
    expect(classifyChatSessionProbe({ status: 401 })).toBe("dead");
    // ⚠️ The measured regression: `status !== 401` called every one of these
    // "alive", so a restart and an introspection outage each burned the ladder.
    for (const status of [500, 502, 503, 504, 403, 404, 0]) {
      expect(classifyChatSessionProbe({ status }), String(status)).toBe("unknown");
    }
    // No response object at all (a rejected fetch handed on, a HEADless stub).
    expect(classifyChatSessionProbe(null)).toBe("unknown");
    expect(classifyChatSessionProbe(undefined)).toBe("unknown");
    expect(classifyChatSessionProbe({})).toBe("unknown");
  });
});

describe("a socket that never opens while the server is UNREACHABLE", () => {
  test("it keeps retrying past the ladder's length — no cap, no notice", async () => {
    // The measured failure: 4 attempts, then a permanent stop under an amber
    // "the chat connection was refused" bar, while muninn was restarting.
    const run = await drive(transportFailingProbe, 20);
    expect(run.attempts).toBe(21);
    expect(run.attempts).toBeGreaterThan(1 + WS_PREOPEN_BACKOFF_MS.length);
    expect(run.stalls).toBe(0);
    expect(run.expiries).toBe(0);
    // Flat 2 s, the same as an ordinary post-open drop — it is the same kind of
    // condition, and it self-heals.
    expect(new Set(run.delays)).toEqual(new Set([WS_UNKNOWN_RETRY_MS]));
    // Still going: a retry is queued when the run stops counting.
    expect(run.queued).toBe(1);
  });

  test("…and a 503 from an introspection outage is the same condition", async () => {
    // An authenticating instance answers 503 while token introspection is
    // unavailable (src/auth/middleware.ts). That is Texas being down, not this
    // reader's session — and it comes back.
    const probe = async (): Promise<ChatSessionProbe> => classifyChatSessionProbe({ status: 503 });
    const run = await drive(probe, 20);
    expect(run.attempts).toBe(21);
    expect(run.stalls).toBe(0);
    expect(run.expiries).toBe(0);
  });
});

describe("a socket that never opens while the session is ALIVE", () => {
  test("it backs off, caps, and shows the notice exactly once", async () => {
    // /chat/me answers 200 while ws-upgrade.ts answers 403: the origin-refused
    // handshake. A configuration fact — it cannot self-heal, so it is bounded
    // AND said out loud.
    const run = await drive(okProbe, 20);
    expect(run.attempts).toBe(1 + WS_PREOPEN_BACKOFF_MS.length);
    expect(run.delays).toEqual([...WS_PREOPEN_BACKOFF_MS]);
    expect(run.stalls).toBe(1);
    expect(run.expiries).toBe(0);
    // Nothing left queued: it really stopped, rather than stopping the counter.
    expect(run.queued).toBe(0);
  });

  test("an UNKNOWN answer in between does not spend a rung", async () => {
    // The counter is for a permanent refusal. A blip in the middle of one must
    // not shorten the ladder, or a flaky network turns 3 refusals into 1.
    const answers: ChatSessionProbe[] = ["unknown", "refused", "unknown", "refused", "refused"];
    let i = 0;
    const probe = async (): Promise<ChatSessionProbe> => answers[i++] ?? "refused";
    const run = await drive(probe, 20);
    // 3 refusals are still what it takes to reach the notice.
    expect(run.stalls).toBe(1);
    expect(run.delays).toEqual([WS_UNKNOWN_RETRY_MS, 2000, WS_UNKNOWN_RETRY_MS, 4000, 6000]);
  });

  test("a reset — a socket that OPENED — starts the ladder over", async () => {
    const { makePreOpenRetry: make } = evalEmitted();
    let stalls = 0;
    let cleared = 0;
    const timers: (() => void)[] = [];
    const ladder = make({
      probe: okProbe,
      retry: () => {},
      expired: () => {},
      stall: () => { stalls++; },
      clearStall: () => { cleared++; },
      schedule: (fn) => { timers.push(fn); },
    });
    for (let i = 0; i < WS_PREOPEN_BACKOFF_MS.length; i++) { ladder.onClose(); await settle(); }
    expect(stalls).toBe(0);
    ladder.reset();
    expect(cleared).toBe(1); // the amber bar comes down with it
    // A full ladder again, not one rung to the notice.
    for (let i = 0; i < WS_PREOPEN_BACKOFF_MS.length; i++) { ladder.onClose(); await settle(); }
    expect(stalls).toBe(0);
    ladder.onClose();
    await settle();
    expect(stalls).toBe(1);
  });
});

describe("a dead session is terminal, and is not the amber notice", () => {
  test("a 401 probe expires the channel and stops — no rung, no bar", async () => {
    const run = await drive(deadProbe, 20);
    expect(run.expiries).toBe(1);
    expect(run.attempts).toBe(1);
    expect(run.stalls).toBe(0);
    expect(run.queued).toBe(0);
  });
});

describe("the ladder's arithmetic", () => {
  test("it walks the schedule and then gives up", () => {
    expect(nextPreOpenRetryDelayMs(1)).toBe(WS_PREOPEN_BACKOFF_MS[0]!);
    expect(nextPreOpenRetryDelayMs(2)).toBe(WS_PREOPEN_BACKOFF_MS[1]!);
    expect(nextPreOpenRetryDelayMs(3)).toBe(WS_PREOPEN_BACKOFF_MS[2]!);
    expect(nextPreOpenRetryDelayMs(WS_PREOPEN_BACKOFF_MS.length + 1)).toBeNull();
    expect(nextPreOpenRetryDelayMs(99)).toBeNull();
    for (const n of [0, -1, NaN, Infinity]) expect(nextPreOpenRetryDelayMs(n)).toBeNull();
  });

  test("it BACKS OFF rather than hammering at a fixed 2 s", () => {
    const delays = WS_PREOPEN_BACKOFF_MS;
    expect(delays.length).toBeGreaterThan(0);
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    // Bounded in wall clock too: the reader must be TOLD in a sensible time.
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  test("the EMITTED functions answer exactly what the TypeScript ones do", () => {
    // They are the same source (`Function.prototype.toString`), and this is what
    // keeps that true through a transpiler change: a divergence here is a page
    // whose rules differ from the tested ones.
    const emitted = evalEmitted();
    for (const n of [0, 1, 2, 3, 4, 99, -1, NaN, Infinity]) {
      expect(emitted.nextPreOpenRetryDelayMs(n), String(n)).toBe(nextPreOpenRetryDelayMs(n));
    }
    for (const res of [null, undefined, {}, { status: 200 }, { status: 401 }, { status: 503 }]) {
      expect(emitted.classifyChatSessionProbe(res), JSON.stringify(res))
        .toBe(classifyChatSessionProbe(res));
    }
  });

  test("the notice is its OWN element, not the session-expiry banner", () => {
    // Nothing has expired here — /chat/me said 200 — and telling a reader their
    // session ended when it did not is the class of lie `authed-fetch.ts`'s
    // `provider === null` rule exists to prevent.
    expect(WS_STALLED_NOTICE_ID).not.toBe(EXPIRED_BANNER_ID);
    expect(WS_STALLED_NOTICE_TEXT).not.toMatch(/expired/i);
    expect(WS_STALLED_NOTICE_TEXT).toMatch(/reload/i);
    expect(WS_STALLED_NOTICE_TEXT).toMatch(/session is still valid/i);
  });

  test("the TypeScript source of the ladder behaves as the emitted one does", async () => {
    // `makePreOpenRetry` is what `wsRetryScript()` stringifies, so the two must
    // not be able to drift: the emitted half is driven above, this is the same
    // schedule through the import.
    const delays: number[] = [];
    let stalls = 0;
    let ladder!: PreOpenRetry;
    ladder = makePreOpenRetry({
      probe: okProbe,
      retry: () => { ladder.onClose(); },
      expired: () => {},
      stall: () => { stalls++; },
      clearStall: () => {},
      schedule: (fn, ms) => { delays.push(ms); fn(); },
    });
    ladder.onClose();
    // `schedule` fires synchronously here, so one close walks the whole ladder
    // once the probe promises settle.
    for (let i = 0; i < 10; i++) await settle();
    expect(delays).toEqual([...WS_PREOPEN_BACKOFF_MS]);
    expect(stalls).toBe(1);
  });
});

describe("the rules are WIRED into the page", () => {
  test("the page CALLS the ladder rather than re-implementing it", async () => {
    const html = await renderChatPage();
    // The emitted functions themselves.
    expect(html).toContain(`var WS_PREOPEN_BACKOFF_MS = ${JSON.stringify(WS_PREOPEN_BACKOFF_MS)}`);
    expect(html).toContain("function nextPreOpenRetryDelayMs(failures)");
    expect(html).toContain("function classifyChatSessionProbe(res)");
    expect(html).toContain("function makePreOpenRetry(deps)");
    // …and the wiring: one construction, one close, one reset.
    expect(html).toContain("makePreOpenRetry({");
    expect(html).toContain("wsPreOpenRetry.onClose()");
    expect(html).toContain("wsPreOpenRetry.reset()");
    // The probe is the three-state one, including the transport-failure catch.
    expect(html).toContain("authedFetch('/chat/me').then(classifyChatSessionProbe");
    expect(html).toContain("function() { return 'unknown'; }");
  });

  test("the backoff array is read in exactly ONE place — the emitted function", async () => {
    // The duplication this closes: the page indexed `WS_PREOPEN_BACKOFF_MS`
    // itself, so `nextPreOpenRetryDelayMs` was tested and unused while the
    // shipped rule was a hand-port beside it.
    const html = await renderChatPage();
    expect(html.split("WS_PREOPEN_BACKOFF_MS[").length - 1).toBe(1);
  });

  test("an ordinary post-open reconnect is UNCHANGED — still 2 s, still unbounded", async () => {
    // The ladder must not touch the case it was not written for: a socket that
    // demonstrably worked and then dropped is an ordinary blip that self-heals,
    // and capping it would turn a laptop lid into a dead chat page.
    const html = await renderChatPage();
    expect(html).toContain("setTimeout(connectWs, 2000)");
  });

  test("the amber bar is STACKED under the expiry banner, not hidden behind it", async () => {
    // Both are position:fixed at top:0 and the banner has the higher z-index, so
    // at top:0 the amber bar was simply invisible whenever both were up.
    const html = await renderChatPage();
    expect(html).toContain("window.__muninnRestackNotices = function()");
    expect(html).toContain("stalledNoticeTopPx()");
    expect(html).toContain(JSON.stringify(EXPIRED_BANNER_ID));
  });
});
