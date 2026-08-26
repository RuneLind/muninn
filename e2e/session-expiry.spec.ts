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
}

/** The intercepted socket, closable from the test AFTER the page has settled. */
let wsRoute: { close: (o: { code: number }) => void } | null = null;

async function open(page: Page, opts: Opts): Promise<void> {
  await page.route("**/chat/me", (route) => route.fulfill({ json: meFor(opts.provider) }));
  await page.route("**/chat/bots", (route) => route.fulfill({ json: { bots: [BOT], connectors: [] } }));
  await page.route("**/chat/conversations*", (route) => route.fulfill({ json: { conversations: [] } }));
  await page.route("**/chat/events*", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "\n\n" }));
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
 * Timing is load-bearing in two ways, and both were real failures: a close
 * during init is judged before `/chat/me` has published the provider, and the
 * banner it appends to `#chatMessages` is then wiped by `clearChat()`'s
 * `innerHTML =` a moment later.
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
