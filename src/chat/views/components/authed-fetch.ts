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
 * all on the HTTP side: 40 bare `fetch(` call sites across 9 files, several of
 * which (the Jira card's poller most sharply) swallow a non-OK and keep
 * retrying to their cap — so a 401 there was silent for the whole window.
 *
 * ## Three channels, three predicates, one decision
 *
 * They cannot share a predicate, because they do not carry the same evidence:
 *
 *  - **HTTP** has a body. The 401 payload's `loginUrl` is `/oauth2/login`
 *    exactly when the sidecar is what would sign the reader back in
 *    (`unauthenticatedBody`, `src/auth/middleware.ts`); in `local` mode it is
 *    the `?muninn_token=` form, where there IS no login page and a reload would
 *    replace the chat with raw 401 JSON.
 *  - **The WebSocket** has neither status nor body — a `close` event carries a
 *    CODE. So it keys on the provider `/chat/me` already returns, cached here
 *    at load.
 *  - **`EventSource`** has neither, and cannot be routed through a fetch
 *    wrapper at all: it takes a URL and exposes no status, so the `loginUrl`
 *    predicate is structurally unreadable there. It keys on the same cached
 *    provider as the socket. (A permanent 403 also lands as `readyState === 2`
 *    and is indistinguishable here — the breaker below is what bounds that.)
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
 * ⚠️ The successful-`/chat/me` clear is deliberately WINDOW-GUARDED: it drops
 * the stamp only when it is already outside the window, so the clear can never
 * SHORTEN the breaker. Unguarded it re-opens the loop the breaker exists to
 * close — reload, `/chat/me` succeeds from cache or from a half-recovered
 * sidecar, stamp cleared, next call 401s, reload again. The window alone
 * already delivers the hourly case (an hour-old stamp is outside it), so the
 * guard costs nothing.
 */

/** At most one automatic reload per this window, across all three channels. */
export const RELOAD_WINDOW_MS = 60_000;

/** `sessionStorage` — per TAB, which is the right scope: two tabs expiring
 *  together should each get their own one reload, and nothing here should
 *  survive the browser session. */
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

  // The provider from GET /chat/me — "entra", "local", or null with auth off.
  // loadSessionUser() publishes it; until it has, nothing reloads, which is the
  // safe default (a refusal before the identity is known is not evidence that a
  // login page exists).
  var authProvider = null;
  window.__muninnSetAuthProvider = function(provider) {
    authProvider = provider || null;
  };

  function readStamp() {
    try { return parseInt(sessionStorage.getItem(STAMP_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }

  /** True when a reload is allowed now; stamps the window as a side effect. */
  function armReload() {
    var now = Date.now();
    if (now - readStamp() < RELOAD_WINDOW_MS) return false;
    try { sessionStorage.setItem(STAMP_KEY, String(now)); } catch (e) {}
    return true;
  }

  // Called from loadSessionUser's success path. Window-guarded on purpose: see
  // the module doc — an unguarded clear re-opens the reload loop.
  window.__muninnClearAuthReloadStamp = function() {
    if (Date.now() - readStamp() < RELOAD_WINDOW_MS) return;
    try { sessionStorage.removeItem(STAMP_KEY); } catch (e) {}
  };

  function showExpiredBanner() {
    var host = document.getElementById('chatMessages');
    if (!host || document.getElementById(BANNER_ID)) return;
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'empty-state';
    banner.textContent = 'Your session expired — reload the page to sign in again.';
    host.appendChild(banner);
  }
  window.__muninnShowExpiredBanner = showExpiredBanner;

  /**
   * The shared decision. Returns 'reload' (and reloads), 'banner' (and shows
   * one) or 'ignore'.
   *
   *   channel 'http' — hint is the 401 body's loginUrl.
   *   channel 'ws' / 'sse' — hint is unused; the cached provider decides.
   *
   * 'ignore' is the HTTP non-sidecar case ONLY: in local mode a 401 is handled
   * by whichever call site made it, exactly as before this module existed, and
   * a page-level banner over every such response would be new noise. A ws/sse
   * refusal has always shown the banner, so it keeps doing so.
   */
  window.__muninnAuthRefusal = function(channel, hint) {
    var isLoginable = channel === 'http' ? hint === '/oauth2/login' : authProvider === 'entra';
    if (!isLoginable) {
      if (channel === 'http') return 'ignore';
      showExpiredBanner();
      return 'banner';
    }
    if (!armReload()) {
      showExpiredBanner();
      return 'banner';
    }
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
   */
  window.authedFetch = function(input, init) {
    var p = fetch(input, init);
    p.then(function(res) {
      if (!res || res.status !== 401) return;
      var probe;
      try { probe = res.clone(); } catch (e) { return; }
      probe.json().then(function(body) {
        window.__muninnAuthRefusal('http', body && body.loginUrl);
      }, function() {
        // A 401 with no JSON body is not evidence of a login page.
      });
    }, function() {
      // A transport failure is not a refusal; the caller's own catch owns it.
    });
    return p;
  };
})();
`;
}
