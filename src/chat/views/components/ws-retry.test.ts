import { describe, test, expect } from "bun:test";
import {
  nextPreOpenRetryDelayMs,
  WS_PREOPEN_BACKOFF_MS,
  WS_STALLED_NOTICE_ID,
  WS_STALLED_NOTICE_TEXT,
} from "./ws-retry.ts";
import { EXPIRED_BANNER_ID } from "./authed-fetch.ts";
import { renderChatPage } from "../page.ts";

/**
 * The bound on a socket that never opened while its SESSION is alive.
 *
 * `chatSessionAlive()` treats only a **401** as a dead session, and
 * `src/auth/ws-upgrade.ts` answers **403** to an origin-refused handshake while
 * `/chat/me` answers 200. So "alive, and still refused" is a real state, it does
 * not self-heal, and the page retried it every 2 s for as long as the tab stayed
 * open — silently, since a refusal that is not an expiry gets no banner.
 *
 * Two halves, and both are needed: the LADDER (pure, here) and the WIRING (a
 * template string, invisible to `tsc`, pinned against the composed page).
 */

describe("the pre-open retry ladder", () => {
  test("it walks the schedule and then gives up", () => {
    expect(nextPreOpenRetryDelayMs(1)).toBe(WS_PREOPEN_BACKOFF_MS[0]!);
    expect(nextPreOpenRetryDelayMs(2)).toBe(WS_PREOPEN_BACKOFF_MS[1]!);
    expect(nextPreOpenRetryDelayMs(3)).toBe(WS_PREOPEN_BACKOFF_MS[2]!);
    // Spent. Null is the "stop, and say so" signal — the whole point, since the
    // condition behind it is a configuration fact no amount of retrying fixes.
    expect(nextPreOpenRetryDelayMs(WS_PREOPEN_BACKOFF_MS.length + 1)).toBeNull();
    expect(nextPreOpenRetryDelayMs(99)).toBeNull();
  });

  test("it BACKS OFF rather than hammering at a fixed 2 s", () => {
    const delays = WS_PREOPEN_BACKOFF_MS;
    expect(delays.length).toBeGreaterThan(0);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
    // Bounded in wall clock too: the reader must be TOLD in a sensible time,
    // not left with a spinner while a ladder doubles into minutes.
    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(30_000);
  });

  test("a nonsense failure count gives up rather than indexing into nothing", () => {
    for (const n of [0, -1, NaN, Infinity]) {
      expect(nextPreOpenRetryDelayMs(n)).toBeNull();
    }
  });

  test("the notice is its OWN element, not the session-expiry banner", () => {
    // Nothing has expired here — `/chat/me` said 200 — and telling a reader
    // their session ended when it did not is the class of lie `authed-fetch.ts`'s
    // `provider === null` rule exists to prevent.
    expect(WS_STALLED_NOTICE_ID).not.toBe(EXPIRED_BANNER_ID);
    expect(WS_STALLED_NOTICE_TEXT).not.toMatch(/expired/i);
    // It names what broke, what did not, and the one recovery the reader has.
    expect(WS_STALLED_NOTICE_TEXT).toMatch(/reload/i);
    expect(WS_STALLED_NOTICE_TEXT).toMatch(/session is still valid/i);
  });
});

describe("the ladder is WIRED into the page", () => {
  test("the composed page carries the schedule, the cap and the notice", async () => {
    const html = await renderChatPage();
    // ONE source of numbers: the page interpolates the array this module
    // declares, so a schedule change cannot land in only one of the two.
    expect(html).toContain(`var WS_PREOPEN_BACKOFF_MS = ${JSON.stringify(WS_PREOPEN_BACKOFF_MS)}`);
    expect(html).toContain(JSON.stringify(WS_STALLED_NOTICE_ID));
    expect(html).toContain(JSON.stringify(WS_STALLED_NOTICE_TEXT));
    // The cap is the array running out, expressed at the one call site.
    expect(html).toContain("showWsStalledNotice()");
  });

  test("an ordinary post-open reconnect is UNCHANGED — still 2 s, still unbounded", async () => {
    // The ladder must not touch the case it was not written for: a socket that
    // demonstrably worked and then dropped is an ordinary blip that self-heals,
    // and capping it would turn a laptop lid into a dead chat page.
    const html = await renderChatPage();
    expect(html).toContain("setTimeout(connectWs, 2000)");
  });

  test("a successful open resets the ladder and clears the notice", async () => {
    const html = await renderChatPage();
    expect(html).toContain("wsPreOpenFailures = 0");
    expect(html).toContain("hideWsStalledNotice()");
  });
});
