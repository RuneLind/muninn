/**
 * The chat page's session-expiry seam: `authedFetch`, the WebSocket rule, the
 * `EventSource` rule, and the ONE breaker all three share.
 *
 * ## Why this exists
 *
 * In `MUNINN_AUTH=entra` the credential behind a page is an Entra ACCESS TOKEN
 * with an `exp` about an hour out. Nothing on the page renews it — wonderwall
 * does, on the next navigation — so an open tab reliably reaches the moment
 * every request it makes is refused. Before this module the page's answer was a
 * static "reload to sign in again" banner on the WebSocket close and nothing at
 * all on the HTTP side: 41 bare `fetch(` call sites across 9 files, several of
 * which (the Jira card's poller most sharply) swallow a non-OK and keep
 * retrying to their cap — so a 401 there was silent for the whole window.
 *
 * ## Three channels, three predicates, one decision
 *
 * They cannot share a predicate, because they do not carry the same evidence:
 *
 *  - **HTTP** has a body. The 401 payload's `loginUrl` is `LOGIN_URL_HINT`
 *    exactly when the sidecar is what would sign the reader back in
 *    (`unauthenticatedBody`, `src/auth/middleware.ts`); in `local` mode it is
 *    the `?muninn_token=` form, where there IS no login page and a reload would
 *    replace the chat with raw 401 JSON. A 401 whose body cannot be read at all
 *    (a proxy's own HTML page) is not evidence a login page exists, so it never
 *    reloads — but on an `entra` instance it is still a refusal, and it banners
 *    rather than saying nothing. NB a **HEAD** request carries no body either,
 *    so it lands in that same "refused, unexplained" branch by construction.
 *  - **The WebSocket** has neither status nor body — a `close` event carries a
 *    CODE. So it keys on the provider `/chat/me` already returns, cached here
 *    at load. Two closes reach the rule: the server's own 4401 cap, and a
 *    handshake REFUSED by the middleware, which the browser reports as an
 *    ordinary 1006 — see `page.ts`'s `connectWs`, which probes the session
 *    before it believes a socket that never opened.
 *  - **`EventSource`** has neither, and cannot be routed through a fetch
 *    wrapper at all: it takes a URL and exposes no status, so the `loginUrl`
 *    predicate is structurally unreadable there. It keys on the same cached
 *    provider as the socket. (A permanent 403 also lands as `readyState === 2`
 *    and is indistinguishable here — the breaker and the LATCH below are what
 *    bound that.)
 *
 * ## `provider === null` is TWO states, and neither reloads
 *
 * It is "auth is off" and "`/chat/me` has not answered yet". For `ws`/`sse` the
 * verdict there is **`ignore`** — today's silent reconnect. Banner'ing instead
 * put "Your session expired" in front of readers of an auth-OFF instance, which
 * has no sessions at all, on any permanent stream failure (a 500, a restart).
 *
 * ## The breaker, and why it is a TIMESTAMP
 *
 * A persistent refusal — a Texas outage, a token that cannot be refreshed —
 * turns "reload on 401" into reload → init → 401 → reload, from every open tab,
 * against the very service that is already struggling. So: at most ONE reload
 * per `RELOAD_WINDOW_MS`.
 *
 * A boolean would give one transparent re-login and then a static banner for
 * every later hourly expiry, which is the opposite of the intent. A timestamp
 * gives a transparent re-login every hour and a banner only when refusals
 * arrive back-to-back.
 *
 * The stamp is kept in `sessionStorage` AND in a module-scope variable, because
 * `sessionStorage` can THROW — a browser configured to block site data, a
 * sandboxed frame. `armReload` used to return `true` on that throw, i.e. the
 * breaker was inert exactly where it could not be observed: measured, 11.5
 * reloads per second. The in-memory half cannot survive a reload (nothing
 * there can), but it bounds the page it lives on.
 *
 * ## The LATCH: a terminal refusal has to be terminal
 *
 * A `banner` verdict is the end of the road for that channel, but the SSE
 * client's own error path used to fall through to a 3-second reconnect — which
 * re-entered the rule every 3 s and re-armed the breaker every 60 s. Measured
 * on a permanent 403 for `/chat/events`: a reload every minute, forever, plus a
 * "session expired" banner about a session that had not expired. So a channel
 * that has spent a verdict is LATCHED (`__muninnAuthLatched`), and the page
 * reads that flag instead of rescheduling.
 *
 * ⚠️ The `/chat/me` clear releases the LATCHES but is **window-guarded for the
 * stamp**: it drops the stamp only when it is already outside the window, so it
 * can never SHORTEN the breaker. That guard is not ceremony — it is what keeps
 * a PARTIAL refusal bounded. In the measured case `/chat/me` answers 200 while
 * `/chat/events` answers 403: every reload re-runs init, `/chat/me` succeeds,
 * and an unconditional clear would re-arm the budget before the stream failed
 * again — one reload per page load, forever. The hourly case is unaffected: an
 * hour-old stamp is outside the window and drops on its own.
 *
 * ## …and a latch has to be RELEASABLE, or it is a permanent outage
 *
 * `__muninnClearAuthReloadStamp` runs at init and nowhere else, so a latch set
 * after init survived for the life of the tab. Measured on a `local` instance:
 * one transient `/chat/events` failure banner'd the channel and killed the
 * stream permanently, where before the latch existed it recovered in 3 s. So
 * there are two more releases, both driven by evidence rather than by a timer:
 *
 *  - **`__muninnAuthChannelRecovered(channel)`** — the channel actually OPENED.
 *    That is proof the refusal is over, so the latch is dropped AND the banner
 *    is removed — but only once NO channel is still latched, or an SSE recovery
 *    would hide a WebSocket expiry that is still live.
 *  - **`__muninnAuthReleaseLatch(channel)`** — an explicit, user-driven
 *    reconnect (`reconnectChatSse`). It clears the latch so the retry ladder
 *    works again and deliberately leaves the banner alone: asking for a
 *    reconnect is not evidence that one succeeded.
 *
 * ⚠️ **The `http` channel has no `open` event, so a 2xx IS its recovery.**
 * `banner('http')` latches like any other channel, and for one round nothing
 * could ever release it: the two releases above are a stream opening and an
 * explicit SSE reconnect, and neither exists for `fetch`. A latched `http` then
 * pinned the shared banner up for the life of the tab — no later WebSocket or
 * SSE recovery could take it down, because `__muninnAuthChannelRecovered` only
 * clears it once NOTHING is latched. So `authedFetch` routes a 2xx response
 * through the same recovery, and only while `http` is latched: an ordinary
 * successful request on a page where nothing was refused must not become a
 * second, decision-free door onto removing someone else's banner.
 *
 * ## Accepted: a FLAPPING stream on an `entra` instance
 *
 * The releases are evidence-driven, so a stream that alternates open → error →
 * open → error re-enters the rule on every cycle: each error is a fresh
 * unlatched refusal, and on `entra` that verdict is a reload. The breaker is
 * what bounds it — at most one reload per `RELOAD_WINDOW_MS` per tab — so the
 * worst case is **one reload per 60 s window while the flapping lasts**, with a
 * banner in between. That is accepted rather than fixed: the alternative is a
 * failure COUNTER that outlives a genuine recovery, which is exactly the latch
 * that could not be released, and this shape at least converges the moment the
 * stream settles either way.
 */

import { LOGIN_URL_HINT } from "../../../auth/zones.ts";

/** At most one automatic reload per this window, across all three channels. */
export const RELOAD_WINDOW_MS = 60_000;

/** `sessionStorage` — per TAB. That is the scope on purpose: two tabs expiring
 *  together should each get their own one reload, and nothing here should
 *  survive the browser session. The bound this delivers is therefore per-tab,
 *  not per-browser: ten open tabs can spend ten reloads in one window. */
export const RELOAD_STAMP_KEY = "muninn.authReload.v1";

/** The id of the one-per-page expiry banner, so the append is idempotent. */
export const EXPIRED_BANNER_ID = "authExpiredBanner";

/**
 * The script, installed on `window` rather than imported.
 *
 * Every client script on this page is an inline `<script>` template string
 * composed in `renderChatPage()` — there is no module graph to import through,
 * which is the same reason `window.__muninnViewerId` and
 * `window.reconnectChatSse` are globals. It is interpolated FIRST, ahead of
 * every other script constant: a call site that ran before the definition would
 * be a `ReferenceError` on a path whose whole job is to degrade gracefully.
 */
export function authedFetchScript(): string {
  return `
(function() {
  var RELOAD_WINDOW_MS = ${RELOAD_WINDOW_MS};
  var STAMP_KEY = ${JSON.stringify(RELOAD_STAMP_KEY)};
  var BANNER_ID = ${JSON.stringify(EXPIRED_BANNER_ID)};
  // The producer is unauthenticatedBody() in src/auth/middleware.ts; this is
  // the same exported constant, not a second copy of the string.
  var LOGIN_URL_HINT = ${JSON.stringify(LOGIN_URL_HINT)};

  // The provider from GET /chat/me — "entra", "local", or null. NB null is BOTH
  // "auth is off" and "/chat/me has not answered yet", and neither of those is
  // a session that can expire: ws/sse refusals are IGNORED while it is null.
  var authProvider = null;
  window.__muninnSetAuthProvider = function(provider) {
    authProvider = provider || null;
  };

  // The in-memory half of the breaker. sessionStorage throws outright in a
  // context that blocks site data, and a breaker that is inert exactly there is
  // no breaker: measured 11.5 reloads/second before this existed.
  var memoryStamp = 0;
  // Channels that have spent a verdict. The page reads this to stop a reconnect
  // loop that would otherwise re-enter the rule (and re-arm the breaker) for as
  // long as the refusal lasts.
  var latched = {};
  window.__muninnAuthLatched = function(channel) { return latched[channel] === true; };

  function readStamp() {
    var stored = 0;
    try { stored = parseInt(sessionStorage.getItem(STAMP_KEY) || '0', 10) || 0; } catch (e) {}
    return stored > memoryStamp ? stored : memoryStamp;
  }

  /** True when a reload is allowed now; stamps the window as a side effect. */
  function armReload() {
    var now = Date.now();
    if (now - readStamp() < RELOAD_WINDOW_MS) return false;
    // In memory FIRST and unconditionally — the storage write is the half that
    // can throw, and the stamp must land whether or not it does.
    memoryStamp = now;
    try { sessionStorage.setItem(STAMP_KEY, String(now)); } catch (e) {}
    return true;
  }

  // Called from loadSessionUser's success path. The LATCHES are released
  // unconditionally (a working identity answer is the evidence a stream is
  // worth re-opening); the STAMP is window-guarded, because an unconditional
  // clear turns a partial refusal — /chat/me 200, /chat/events 403 — into one
  // reload per page load forever. See the module doc.
  window.__muninnClearAuthReloadStamp = function() {
    latched = {};
    if (Date.now() - readStamp() < RELOAD_WINDOW_MS) return;
    memoryStamp = 0;
    try { sessionStorage.removeItem(STAMP_KEY); } catch (e) {}
  };

  /**
   * A FIXED page-level bar, deliberately not a child of #chatMessages.
   *
   * clearChat() and loadThreadMessages() both assign innerHTML on that
   * container, so a banner inside it vanishes on the next thread or bot switch
   * while the session it reports on is still expired. Same shape as the
   * build-hash banner in src/dashboard/views/components/helpers-browser.ts.
   */
  function hideExpiredBanner() {
    var existing = document.getElementById(BANNER_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    restackNotices();
  }

  // The chat page's amber "live updates are unavailable" bar (ws-retry.ts) is
  // fixed to the same top:0 as this banner and sits BELOW it in z-index, so
  // without this it is invisible whenever both are up. The page owns the
  // offset — it is the module that knows where its own bar is — and this is
  // the notification that the offset just changed. Optional by construction:
  // authedFetchScript() is interpolated FIRST, so it must not depend on
  // anything the rest of the page defines later.
  function restackNotices() {
    try {
      if (typeof window.__muninnRestackNotices === 'function') window.__muninnRestackNotices();
    } catch (e) {}
  }

  // Release a channel's latch without touching the banner. The caller is an
  // EXPLICIT reconnect: it makes the retry ladder work again, and it is not
  // evidence that anything reconnected.
  window.__muninnAuthReleaseLatch = function(channel) {
    delete latched[channel];
  };

  // The channel OPENED. That IS the evidence, so the banner goes too — but only
  // when nothing else is still latched: an SSE recovery must not clear a banner
  // a live WebSocket expiry is still asking for.
  window.__muninnAuthChannelRecovered = function(channel) {
    delete latched[channel];
    for (var other in latched) {
      if (latched[other] === true) return;
    }
    hideExpiredBanner();
  };

  function showExpiredBanner() {
    if (document.getElementById(BANNER_ID) || !document.body) return;
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'alert');
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 14px;' +
      'background:#ef4444;color:#fff;font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif;' +
      'text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    banner.textContent = 'Your session expired — reload the page to sign in again.';
    document.body.appendChild(banner);
    restackNotices();
  }

  function banner(channel) {
    latched[channel] = true;
    showExpiredBanner();
    return 'banner';
  }

  /**
   * The shared decision. Returns 'reload' (and reloads), 'banner' (and shows
   * one) or 'ignore'.
   *
   *   channel 'http' — hint is the 401 body's loginUrl, or undefined when the
   *                    body was unreadable (a proxy's HTML 401, a HEAD).
   *   channel 'ws' / 'sse' — hint is unused; the cached provider decides.
   *
   * 'ignore' means "nothing page-level happens": the call site's own handling
   * is unchanged, exactly as before this module existed. It is the answer for
   * an HTTP 401 on a non-entra instance (in local mode a reload would replace
   * the chat with raw 401 JSON) and for a ws/sse failure while the provider is
   * null — auth off, or /chat/me not yet answered, neither of which is an
   * expired session.
   */
  window.__muninnAuthRefusal = function(channel, hint) {
    if (channel === 'http') {
      if (hint !== LOGIN_URL_HINT) {
        // Refused, but with no evidence that reloading lands on a login page.
        // On entra that is still an expiry the reader must be told about; on
        // anything else it is an ordinary 401 its own call site owns.
        return authProvider === 'entra' ? banner(channel) : 'ignore';
      }
    } else if (authProvider !== 'entra') {
      return authProvider === null ? 'ignore' : banner(channel);
    }
    if (!armReload()) return banner(channel);
    latched[channel] = true;
    window.location.reload();
    return 'reload';
  };

  /**
   * The ONE fetch every call site under src/chat/views/ goes through.
   *
   * Deliberately transparent: same arguments, same promise, same response
   * object. It only ever OBSERVES — a caller that reads res.status === 401 and
   * renders its own message keeps working byte for byte. The 401 body is read
   * off a CLONE so the caller's own .json() is untouched.
   *
   * Only 401 is a refusal. A 503 is what an authenticating instance answers
   * when the token introspection endpoint is UNAVAILABLE (src/auth/middleware.ts):
   * an outage, not an expiry, and reloading into it would be the reload storm
   * the breaker exists to prevent. It falls through untouched.
   *
   * A 2xx is the one thing this channel has instead of an open event, so it
   * releases a latched 'http' — see the module doc. Only while it IS latched:
   * on an ordinary page every response would otherwise be a decision-free door
   * onto removing another channel's banner.
   */
  window.authedFetch = function(input, init) {
    var p = fetch(input, init);
    p.then(function(res) {
      if (!res) return;
      if (res.status >= 200 && res.status < 300) {
        if (latched['http'] === true) window.__muninnAuthChannelRecovered('http');
        return;
      }
      if (res.status !== 401) return;
      var probe;
      try { probe = res.clone(); } catch (e) { return; }
      probe.json().then(function(body) {
        window.__muninnAuthRefusal('http', body && body.loginUrl);
      }, function() {
        // No JSON body: not evidence of a login page, but still a refusal.
        window.__muninnAuthRefusal('http', undefined);
      });
    }, function() {
      // A transport failure is not a refusal; the caller's own catch owns it.
    });
    return p;
  };
})();
`;
}
