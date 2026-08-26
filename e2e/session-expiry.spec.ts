import { test, expect, type Page } from "@playwright/test";
import { WS_PREOPEN_BACKOFF_MS, WS_STALLED_NOTICE_ID } from "../src/chat/views/components/ws-retry.ts";

/**
 * Acceptance 19 + 20, in a real browser: the chat page's expiry rules, driven
 * through the wiring rather than through the decision function.
 *
 * The unit half (`src/chat/views/components/authed-fetch.test.ts`) evaluates the
 * emitted script against a stubbed browser and covers every predicate and the
 * breaker. What it cannot see is the WIRING — that `ws.onclose` actually calls
 * the decision, that `authedFetch` is what the page's own call sites use, and
 * that a `reload` verdict really navigates. All three are one deleted line away
 * from silence, and all three are invisible to `tsc`.
 *
 * Everything is stubbed with `page.route` / `page.routeWebSocket`, so this runs
 * against the shared 3011 server on any machine — no second muninn, no port
 * entry, no `MUNINN_AUTH` on the server at all. What is under test is the
 * CLIENT, and `/chat/me`'s `provider` plus a 401 body are its only inputs.
 * (`chat-session-identity.spec.ts` is the precedent for the whole shape.)
 */

const BOT = { name: "e2e-bot", showWaterfall: false, hasTelegram: false, hasSlack: false };

const meFor = (provider: string) => ({
  mode: "session",
  userId: "session-user",
  displayName: "Session User",
  navIdent: null,
  provider,
  role: "user",
});

/** The two 401 bodies `unauthenticatedBody()` produces, verbatim. */
const ENTRA_401 = { error: "unauthenticated", mode: "entra", loginUrl: "/oauth2/login" };
const LOCAL_401 = { error: "unauthenticated", mode: "local", loginUrl: "/?muninn_token=YOUR_MUNINN_LOCAL_TOKEN" };

interface Opts {
  provider: string;
  /** When set, `GET /chat/threads/**` answers 401 with this body — a real call
   *  site on a real page, reached through authedFetch. */
  refuse?: Record<string, unknown>;
  /** Take over the chat socket so the test can close it on demand. */
  interceptWs?: boolean;
  /** When set, every `/chat/me` AFTER the first answers 401 with this body —
   *  the shape a session that expires while the tab is open really has. */
  expireAfterFirstMe?: Record<string, unknown>;
  /** When set, every `/chat/me` AFTER the first FAILS the way an unreachable
   *  server does: `route.abort()`, i.e. the fetch rejects. muninn restarting, a
   *  laptop waking with the network still down. */
  abortAfterFirstMe?: boolean;
  /** When set, every `/chat/me` AFTER the first answers this status — 503 is
   *  what an authenticating instance answers while introspection is down. */
  meStatusAfterFirst?: number;
  /** Replace `WebSocket` with one that never OPENS and closes 1006 — a
   *  handshake the server refused. Playwright's `routeWebSocket` cannot produce
   *  it: its mock accepts the connection, so the page always sees `open` first. */
  refuseUpgrade?: boolean;
  /** `GET /chat/events` answers this status permanently. 403 is the measured
   *  case: role `user` on `/api/events`, or a zone denial after a role change. */
  eventsStatus?: number;
}

/** Requests the page made, per stubbed route. Reset by `open()`, and NOT reset
 *  by a reload — which is the point for the SSE case. */
const hits = { events: 0, me: 0, sockets: 0 };

/** The status `/chat/events` answers RIGHT NOW. Seeded from `opts.eventsStatus`
 *  by `open()` and mutable mid-test, which is what lets the recovery case take
 *  the stream from a permanent refusal back to a working one. */
let eventsStatusNow: number | undefined;

/** The intercepted socket, closable from the test AFTER the page has settled. */
let wsRoute: { close: (o: { code: number }) => void } | null = null;

async function open(page: Page, opts: Opts): Promise<void> {
  hits.events = 0;
  hits.me = 0;
  hits.sockets = 0;
  eventsStatusNow = opts.eventsStatus;

  if (opts.refuseUpgrade) {
    await page.addInitScript(() => {
      const w = window as unknown as { WebSocket: unknown; __wsAttempts?: number };
      w.__wsAttempts = 0;
      class RefusedSocket {
        onopen: (() => void) | null = null;
        onclose: ((e: { code: number }) => void) | null = null;
        onmessage: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          w.__wsAttempts = (w.__wsAttempts ?? 0) + 1;
          // No `open`, ever — exactly what a 401'd handshake looks like from a
          // browser: an immediate close carrying the useless 1006.
          setTimeout(() => this.onclose?.({ code: 1006 }), 10);
        }
        send(): void {}
        close(): void {}
      }
      w.WebSocket = RefusedSocket;
    });
  }

  await page.route("**/chat/me", (route) => {
    hits.me += 1;
    if (opts.expireAfterFirstMe && hits.me > 1) {
      return route.fulfill({ status: 401, json: opts.expireAfterFirstMe });
    }
    if (opts.abortAfterFirstMe && hits.me > 1) return route.abort();
    if (opts.meStatusAfterFirst && hits.me > 1) {
      return route.fulfill({ status: opts.meStatusAfterFirst, body: "introspection unavailable" });
    }
    return route.fulfill({ json: meFor(opts.provider) });
  });
  await page.route("**/chat/bots", (route) => route.fulfill({ json: { bots: [BOT], connectors: [] } }));
  await page.route("**/chat/conversations*", (route) => route.fulfill({ json: { conversations: [] } }));
  await page.route("**/chat/events*", (route) => {
    hits.events += 1;
    if (eventsStatusNow) return route.fulfill({ status: eventsStatusNow, body: "denied" });
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "\n\n" });
  });
  await page.route("**/chat/threads/**", (route) =>
    opts.refuse
      ? route.fulfill({ status: 401, json: opts.refuse })
      : route.fulfill({ json: { threads: [] } }));

  wsRoute = null;
  if (opts.interceptWs) {
    // The server closes an EXPIRED socket with 4401 (WS_CLOSE_EXPIRED); the
    // shared 3011 server has auth off, so its own socket never expires and
    // nothing else here can produce that code. The handler HOLDS the socket
    // instead of closing it, because the close has to land after the page has
    // settled — see `closeWs` below.
    await page.routeWebSocket("**/chat/ws", (ws) => { wsRoute = ws; });
  }

  const me = page.waitForResponse((r) => r.url().includes("/chat/me"));
  await page.goto("/chat");
  await page.waitForFunction(() => typeof (window as { authedFetch?: unknown }).authedFetch === "function");
  // The provider is published by loadSessionUser, and BOTH non-HTTP predicates
  // read it. A close that lands before this resolves would be judged against a
  // null provider — which is how the first cut of this spec failed.
  await me;
}

/**
 * Close the page's socket with `code`, after init has finished painting.
 *
 * Timing is load-bearing: a close during init is judged before `/chat/me` has
 * published the provider, which is how the first cut of this spec failed. (It
 * used to matter for a second reason — the banner was a child of
 * `#chatMessages` and `clearChat()`'s `innerHTML =` wiped it — which the
 * page-level banner has removed; "it survives the innerHTML wipe" below is the
 * assertion that keeps it removed.)
 */
async function closeWs(page: Page, code: number): Promise<void> {
  await page.waitForFunction(() => !!document.querySelector("#chatMessages .empty-state"));
  await page.waitForTimeout(250);
  if (!wsRoute) throw new Error("closeWs called without interceptWs");
  wsRoute.close({ code });
}

/** A marker the page loses if (and only if) it reloads. */
async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__e2eMark = 1; });
}
async function reloaded(page: Page): Promise<boolean> {
  // A reload is a navigation, so poll for the marker to disappear rather than
  // evaluating once into a frame that may be mid-navigation.
  for (let i = 0; i < 40; i++) {
    const gone = await page
      .evaluate(() => (window as unknown as Record<string, unknown>).__e2eMark === undefined)
      .catch(() => true);
    if (gone) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

const banner = (page: Page) => page.locator("#authExpiredBanner");

test.describe("acceptance 19 — the WebSocket half", () => {
  test("a 4401 close RELOADS when the cached provider is entra", async ({ page }) => {
    await open(page, { provider: "entra", interceptWs: true });
    await markPage(page);
    await closeWs(page, 4401);
    expect(await reloaded(page)).toBe(true);
  });

  test("a 4401 close shows the BANNER and does not reload in local mode", async ({ page }) => {
    // There is no login page in local mode, so a reload would replace the chat
    // with raw 401 JSON — strictly worse than a stalled page that says why.
    await open(page, { provider: "local", interceptWs: true });
    await markPage(page);
    await closeWs(page, 4401);
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toHaveText(/session expired/i);
    await page.waitForTimeout(400);
    expect(await reloaded(page)).toBe(false);
  });

  test("an ORDINARY close is neither — it reconnects, as before", async ({ page }) => {
    await open(page, { provider: "entra", interceptWs: true });
    await markPage(page);
    await closeWs(page, 1006);
    await page.waitForTimeout(400);
    expect(await reloaded(page)).toBe(false);
    await expect(banner(page)).toHaveCount(0);
  });
});

test.describe("acceptance 19 — a REFUSED HANDSHAKE, which carries no code at all", () => {
  // The blind spot this closes: a 401'd upgrade is reported to the page as an
  // ordinary 1006 close, so the 4401 rule never saw it and the 2 s retry ran
  // forever in silence — measured, five refused handshakes, zero reloads, no
  // banner. The page now probes /chat/me before it believes such a close.

  test("entra: a socket that never opened reloads once the session is really gone", async ({ page }) => {
    await open(page, { provider: "entra", refuseUpgrade: true, expireAfterFirstMe: ENTRA_401 });
    await markPage(page);
    expect(await reloaded(page)).toBe(true);
  });

  test("local: it banners, and STOPS retrying", async ({ page }) => {
    await open(page, { provider: "local", refuseUpgrade: true, expireAfterFirstMe: LOCAL_401 });
    await markPage(page);
    await expect(banner(page)).toBeVisible();
    // One construction, not one every two seconds. Two full retry windows.
    await page.waitForTimeout(4200);
    expect(await page.evaluate(() => (window as unknown as { __wsAttempts: number }).__wsAttempts)).toBe(1);
    expect(await reloaded(page)).toBe(false);
  });

  // The ordinary drop — a socket that DID open, then closed 1006 — is unchanged
  // and is covered by "an ORDINARY close is neither" above.
});

test.describe("acceptance 19 — a PERMANENTLY refused EventSource is terminal", () => {
  test("a 403 on /chat/events spends ONE reload, then banners and stops", async ({ page }) => {
    // Measured before the fix: the banner verdict fell through to the 3 s
    // reconnect, which re-entered the rule every cycle and re-armed the breaker
    // every 60 s — a reload a minute, forever, plus "your session expired"
    // about a session that had not expired.
    // Counted rather than marked: the stream is refused during init, so the
    // reload can land BEFORE a `page.evaluate` marker could be planted — which
    // is a flake, not a signal (it failed exactly once, under a loaded parallel
    // run). A main-frame navigation count is immune to that ordering.
    let navigations = 0;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });

    await open(page, { provider: "entra", eventsStatus: 403 });
    // The goto, plus exactly one reload.
    await expect.poll(() => navigations, { timeout: 10_000 }).toBe(2);

    await page.waitForFunction(() => typeof (window as { authedFetch?: unknown }).authedFetch === "function");
    await expect(banner(page)).toBeVisible();
    const afterReload = hits.events;
    // Two full 3 s poll cycles and then some: neither a reconnect nor a reload.
    await page.waitForTimeout(7000);
    expect(hits.events).toBe(afterReload);
    expect(navigations).toBe(2);
  });
});

test.describe("acceptance 19 — and a latched channel RECOVERS", () => {
  test("a stream that comes back clears the latch and takes the banner down", async ({ page }) => {
    // ⚠️ The regression the latch introduced. Its only release was
    // `__muninnClearAuthReloadStamp`, whose sole caller is init — so on a
    // `local` instance (no reload; the verdict is a banner) ONE transient
    // /chat/events failure killed the stream for the life of the tab and left a
    // "session expired" bar over a session that was fine. Before the latch
    // existed the page recovered in 3 s.
    await open(page, { provider: "local", eventsStatus: 403 });
    await expect(banner(page)).toBeVisible();
    await markPage(page);

    // The stream stays dead while the refusal stands — that half must not
    // regress either, and it is what the latch is FOR.
    const whileRefused = hits.events;
    await page.waitForTimeout(3500);
    expect(hits.events).toBe(whileRefused);

    // The server comes back.
    eventsStatusNow = undefined;
    // …and the page re-opens the stream the way it really does: a viewer change.
    // `reconnectChatSse` is a no-op when the viewer has not moved, so the id is
    // changed first — this drives the actual wiring, not the decision function.
    await page.evaluate(() => {
      const w = window as unknown as { __muninnViewerId: string | null; reconnectChatSse: () => void };
      w.__muninnViewerId = "recovered-viewer";
      w.reconnectChatSse();
    });

    // The stream is opened (the latch released), it OPENS, and the banner goes.
    await expect.poll(() => hits.events, { timeout: 10_000 }).toBeGreaterThan(whileRefused);
    await expect(banner(page)).toHaveCount(0);
    // Recovery is not a reload — nothing here reloaded, in either direction.
    expect(await reloaded(page)).toBe(false);
  });

  test("…and the recovered stream retries again on a LATER transient failure", async ({ page }) => {
    // A released latch has to actually restore the 3 s ladder. Left spent, the
    // fresh stream's first ordinary error takes the terminal branch and the
    // channel is dead again with nothing on screen.
    await open(page, { provider: "local", eventsStatus: 403 });
    await expect(banner(page)).toBeVisible();

    eventsStatusNow = undefined;
    await page.evaluate(() => {
      const w = window as unknown as { __muninnViewerId: string | null; reconnectChatSse: () => void };
      w.__muninnViewerId = "recovered-viewer";
      w.reconnectChatSse();
    });
    await expect(banner(page)).toHaveCount(0);
    const afterRecovery = hits.events;

    // The stub answers 200 and closes immediately, so the stream ends and the
    // 3 s reconnect ladder is what produces the next hit.
    await expect.poll(() => hits.events, { timeout: 12_000 }).toBeGreaterThan(afterRecovery);
  });
});

test.describe("acceptance 19 — a refused UPGRADE whose session is ALIVE is bounded", () => {
  // `src/auth/ws-upgrade.ts` answers 403 to an origin-refused handshake while
  // /chat/me answers 200 — the one probe result (`refused`) that spends a rung.
  // "alive, and still refused" retried every 2 s for as long as the tab stayed
  // open, silently — a refusal that is not an expiry gets no banner.
  test("it backs off, gives up, and SAYS so — without claiming an expiry", async ({ page }) => {
    // The ladder is ~12 s of wall clock by construction, plus a /chat/me probe
    // per rung; the default 30 s budget is too tight to be honest about.
    test.setTimeout(60_000);

    // NB no `expireAfterFirstMe`: /chat/me keeps answering 200, which is exactly
    // the state that made this unbounded.
    await open(page, { provider: "local", refuseUpgrade: true });
    await markPage(page);

    const attempts = () => page.evaluate(() => (window as unknown as { __wsAttempts: number }).__wsAttempts);
    const expected = 1 + WS_PREOPEN_BACKOFF_MS.length;

    // It stops at the cap and stays there — two more full rungs of quiet.
    await expect.poll(attempts, { timeout: 45_000 }).toBe(expected);
    await page.waitForTimeout(8000);
    expect(await attempts()).toBe(expected);

    // …and the giving-up is VISIBLE, in its own bar.
    await expect(page.locator(`#${WS_STALLED_NOTICE_ID}`)).toBeVisible();
    await expect(page.locator(`#${WS_STALLED_NOTICE_ID}`)).toHaveText(/reload the page/i);
    // Not the expiry banner: /chat/me said 200, so nothing has expired, and
    // telling the reader otherwise is a lie the page must not tell.
    await expect(banner(page)).toHaveCount(0);
    expect(await reloaded(page)).toBe(false);

    // …and when the expiry banner DOES arrive on top of it, the amber bar is
    // stacked under it rather than hidden behind it: both are position:fixed at
    // top:0 and the banner wins the z-index, so at top:0 the amber one is
    // invisible while a reader is being told two different things.
    const amberTop = async () =>
      (await page.locator(`#${WS_STALLED_NOTICE_ID}`).boundingBox())?.y ?? -1;
    expect(await amberTop()).toBe(0);
    await page.evaluate(() =>
      (window as unknown as { __muninnAuthRefusal: (c: string) => string }).__muninnAuthRefusal("ws"));
    await expect(banner(page)).toBeVisible();
    await expect(page.locator(`#${WS_STALLED_NOTICE_ID}`)).toBeVisible();
    const bannerBox = await banner(page).boundingBox();
    expect(await amberTop()).toBeGreaterThanOrEqual((bannerBox?.height ?? 0) - 1);
  });
});

test.describe("acceptance 19 — an OUTAGE is not a refusal, and is not bounded", () => {
  // ⚠️ The measured regression: the probe answered "alive" to everything that
  // was not a 401 — a transport failure included — so a socket that never
  // opened while the server was simply DOWN was treated as the origin-refused
  // handshake. Four attempts in ~12 s and then a permanent stop, under an amber
  // "the chat connection was refused" bar, while muninn was coming back up.

  test("a /chat/me that cannot be reached keeps retrying past the ladder's length", async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, { provider: "local", refuseUpgrade: true, abortAfterFirstMe: true });
    await markPage(page);

    const attempts = () => page.evaluate(() => (window as unknown as { __wsAttempts: number }).__wsAttempts);
    // The ladder would have stopped at 4. Unbounded 2 s retries pass that within
    // seconds and keep going.
    await expect.poll(attempts, { timeout: 60_000 }).toBeGreaterThan(1 + WS_PREOPEN_BACKOFF_MS.length + 3);

    // And it says NOTHING while it does: nothing has expired, and nothing has
    // been refused. Both bars would be a lie about an outage.
    await expect(page.locator(`#${WS_STALLED_NOTICE_ID}`)).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
    expect(await reloaded(page)).toBe(false);
  });

  test("…and a 503 from an introspection outage is the same condition", async ({ page }) => {
    // An authenticating instance answers 503 while token introspection is
    // unavailable. That is Texas being down, not this reader's session.
    test.setTimeout(90_000);
    await open(page, { provider: "entra", refuseUpgrade: true, meStatusAfterFirst: 503 });
    await markPage(page);

    const attempts = () => page.evaluate(() => (window as unknown as { __wsAttempts: number }).__wsAttempts);
    await expect.poll(attempts, { timeout: 60_000 }).toBeGreaterThan(1 + WS_PREOPEN_BACKOFF_MS.length + 3);
    await expect(page.locator(`#${WS_STALLED_NOTICE_ID}`)).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
    // A 503 must not reload either — that is the storm the breaker exists for.
    expect(await reloaded(page)).toBe(false);
  });
});

test.describe("the banner is page-level", () => {
  test("it survives the innerHTML wipe every thread switch performs", async ({ page }) => {
    // `clearChat()` and `loadThreadMessages()` both assign #chatMessages'
    // innerHTML. A banner rendered inside that container disappeared on the
    // next bot or thread switch, while the session was still expired.
    await open(page, { provider: "local", interceptWs: true });
    await closeWs(page, 4401);
    await expect(banner(page)).toBeVisible();
    await expect(page.locator("#chatMessages #authExpiredBanner")).toHaveCount(0);

    await page.evaluate(() => { document.getElementById("chatMessages")!.innerHTML = ""; });
    await expect(banner(page)).toBeVisible();
  });
});

test.describe("acceptance 19 + 20 — the HTTP half, through a real call site", () => {
  test("a 401 whose loginUrl is the sidecar's reloads the page", async ({ page }) => {
    // Not a synthetic call: `loadThreads()` fetches /chat/threads/... through
    // authedFetch like every other call site on the page. This is the assertion
    // that a missed call site cannot pass.
    await open(page, { provider: "entra", refuse: ENTRA_401 });
    await markPage(page);
    expect(await reloaded(page)).toBe(true);
  });

  test("a 401 carrying the LOCAL loginUrl neither reloads nor banners", async ({ page }) => {
    await open(page, { provider: "local", refuse: LOCAL_401 });
    await markPage(page);
    await page.waitForTimeout(500);
    expect(await reloaded(page)).toBe(false);
    await expect(banner(page)).toHaveCount(0);
  });
});

test.describe("acceptance 19 — the breaker", () => {
  test("a second refusal inside the window shows the banner instead of reloading", async ({ page }) => {
    // Without this a persistent 401 — a Texas outage, an unrefreshable token —
    // is reload → init → 401 → reload from every open tab.
    await open(page, { provider: "entra" });
    const first = await page.evaluate(() =>
      (window as unknown as { __muninnAuthRefusal: (c: string) => string }).__muninnAuthRefusal("ws"));
    expect(first).toBe("reload");

    // The reload above is real; wait for the page to come back, then refuse
    // again inside the 60 s window. The stamp lives in sessionStorage, so it
    // survives the navigation — which is the whole mechanism.
    await page.waitForLoadState("load");
    await page.waitForFunction(() => typeof (window as { authedFetch?: unknown }).authedFetch === "function");
    const second = await page.evaluate(() =>
      (window as unknown as { __muninnAuthRefusal: (c: string) => string }).__muninnAuthRefusal("ws"));
    expect(second).toBe("banner");
    await expect(banner(page)).toBeVisible();
  });

  test("the breaker is shared with the EventSource channel", async ({ page }) => {
    await open(page, { provider: "entra" });
    const verdicts = await page.evaluate(() => {
      const w = window as unknown as { __muninnAuthRefusal: (c: string) => string };
      return [w.__muninnAuthRefusal("sse"), w.__muninnAuthRefusal("ws"), w.__muninnAuthRefusal("sse")];
    });
    // One budget across all three channels, not one each.
    expect(verdicts).toEqual(["reload", "banner", "banner"]);
  });
});
