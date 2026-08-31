/// <reference lib="dom" />
/**
 * Which wiki the reader page is browsing, and the `?wiki=` param that keeps every
 * `/api/wiki/*` fetch on it.
 *
 * A leaf module so BOTH `wiki-browser.ts` (the shell, which resolves the name
 * once at boot) and `wiki-start-cards.ts` (whose injected-deps default has to
 * work even if a card ever renders before the shell wires it) apply the SAME
 * rule. A second copy of the rule would be free to drift, and the failure mode
 * of the cards' copy drifting is silent: dropping `?wiki=` doesn't error, it
 * reads — and REINDEXES — the default wiki instead of the one on screen.
 */

/** The wiki the current page is browsing; `""` = the default/env wiki.
 *
 *  The server injects the *canonical* name (case-corrected, or the resolved
 *  default) as `window.__WIKI_NAME__` (see `views/wiki-page.ts`), so fetches and
 *  the picker's selected option always agree. Falls back to the raw `?wiki=`
 *  (or legacy `?bot=`) query if the global is somehow absent. Read lazily —
 *  never at module scope — so importing this file outside a browser (unit tests)
 *  is harmless. */
export function readActiveWikiName(): string {
  const injected = (globalThis as { __WIKI_NAME__?: unknown }).__WIKI_NAME__;
  if (typeof injected === "string") return injected;
  const search = typeof location === "undefined" ? "" : location.search;
  const params = new URLSearchParams(search);
  return params.get("wiki") || params.get("bot") || "";
}

/** The absolute filesystem root the open wiki is served from, or `null` when the
 *  server named none (an unknown `?wiki=`), or when this page is not the reader.
 *
 *  Injected as `window.__WIKI_ROOT__` by `views/wiki-page.ts`, and read here for
 *  the same reason the name is: one rule, read LAZILY so importing this file
 *  outside a browser is harmless. Anything that is not a non-empty string is
 *  `null` — the copy-path button then copies the relPath alone rather than
 *  splicing `undefined` into the middle of a path. */
export function readActiveWikiRoot(): string | null {
  const injected = (globalThis as { __WIKI_ROOT__?: unknown }).__WIKI_ROOT__;
  return typeof injected === "string" && injected.trim() !== "" ? injected : null;
}

/** Append the active `wiki` param to a URL so the fetch stays on-wiki. */
export function withWikiParam(url: string, wiki: string): string {
  if (!wiki) return url;
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "wiki=" + encodeURIComponent(wiki);
}
