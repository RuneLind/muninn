import { test, expect, type Page } from "@playwright/test";

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

/** The intercepted socket, closable from the test AFTER the page has settled. */
let wsRoute: { close: (o: { code: number }) => void } | null = null;

async function open(page: Page, opts: Opts): Promise<void> {
  hits.events = 0;
  hits.me = 0;
  hits.sockets = 0;

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
    return route.fulfill({ json: meFor(opts.provider) });
  });
  await page.route("**/chat/bots", (route) => route.fulfill({ json: { bots: [BOT], connectors: [] } }));
  await page.route("**/chat/conversations*", (route) => route.fulfill({ json: { conversations: [] } }));
  await page.route("**/chat/events*", (route) => {
    hits.events += 1;
    if (opts.eventsStatus) return route.fulfill({ status: opts.eventsStatus, body: "denied" });
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
    await open(page, { provider: "entra", eventsStatus: 403 });
    await markPage(page);
    expect(await reloaded(page)).toBe(true);

    await page.waitForFunction(() => typeof (window as { authedFetch?: unknown }).authedFetch === "function");
    await expect(banner(page)).toBeVisible();
    await markPage(page);
    const afterReload = hits.events;
    // Two full 3 s poll cycles and then some: neither a reconnect nor a reload.
    await page.waitForTimeout(7000);
    expect(hits.events).toBe(afterReload);
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
