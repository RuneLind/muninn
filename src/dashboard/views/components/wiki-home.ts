/**
 * The /wiki reader's two "where was I" rules, DOM-free so they are unit-testable:
 * which wiki a bare `/wiki` should open, and which start tab (Hubs / Timeline /
 * Atlas) the overview should show. The shell (`wiki-browser.ts`) and the site
 * nav (`shared-styles.ts`) apply them; nothing here touches the DOM or storage.
 *
 * Why: the selected wiki lived only in the URL. The nav's "Wiki" link is bare
 * `/wiki`, which the server resolves to jarvis (else the first registered wiki),
 * so every trip through the nav dropped the reader back to the default. And the
 * start tab was a module `let`, reset to Hubs on every reload — Atlas was not
 * even linkable. Both are remembered in localStorage now: the wiki globally (one
 * reader, one "current wiki"), the tab per wiki, since a wiki with a timeline
 * worth watching and one without are different habits.
 *
 * Switching wiki stays a FULL navigation. `WIKI`/`WIKI_ROOT` are boot-time facts
 * across the whole client (ask session, chat target, read-only flag, the rail
 * stores, every fetch), so the redirect below is a `location.replace`, never a
 * client-side swap.
 */

/** localStorage key holding the canonical name of the wiki last opened by URL. */
export const LAST_WIKI_KEY = "muninn.wiki.last.v1";

/** localStorage key prefix for the remembered start tab; suffixed `:<wiki>`. */
export const START_TAB_KEY_PREFIX = "muninn.wiki.startTab.v1";

export type StartTab = "hubs" | "timeline" | "atlas";

/** The default tab, and the one a start URL carries no `view=` for. */
export const DEFAULT_START_TAB: StartTab = "hubs";

/** Query param naming the start tab. Absent ⇒ Hubs, so existing links are unchanged. */
export const START_VIEW_PARAM = "view";

export function startTabKey(wiki: string): string {
  return START_TAB_KEY_PREFIX + ":" + wiki;
}

/** A tab name from a URL param or a stored value; `null` for anything else. */
export function parseStartTab(raw: string | null | undefined): StartTab | null {
  if (raw === "hubs" || raw === "timeline" || raw === "atlas") return raw;
  return null;
}

/** The tab the overview opens on: the URL's `view=` wins, then the stored
 *  per-wiki value, then Hubs. A garbage value at either level is skipped, not
 *  applied. */
export function resolveStartTab(urlValue: string | null, stored: string | null): StartTab {
  return parseStartTab(urlValue) ?? parseStartTab(stored) ?? DEFAULT_START_TAB;
}

/** The shareable overview URL for a wiki + tab. Hubs is the bare form: a bare
 *  `/wiki?wiki=X` means "the overview as I left it" (the stored tab, else Hubs),
 *  so every existing link keeps working; `?view=hubs` is the explicit form. */
export function startUrl(wiki: string, tab: StartTab): string {
  const params = new URLSearchParams();
  if (wiki) params.set("wiki", wiki);
  if (tab !== DEFAULT_START_TAB) params.set(START_VIEW_PARAM, tab);
  const q = params.toString();
  return q ? "/wiki?" + q : "/wiki";
}

export interface RedirectInput {
  /** `location.search` of the page that just booted. */
  search: string;
  /** The remembered wiki (`localStorage[LAST_WIKI_KEY]`), or null. */
  stored: string | null;
  /** The wiki the server rendered (`window.__WIKI_NAME__`); `""` under the
   *  `WIKI_DIR` env override, which claims no wiki. */
  rendered: string;
  /** The picker's option values — the wikis registered on THIS server. */
  known: readonly string[];
}

/**
 * Where a freshly booted reader should go instead, or `null` to stay put.
 *
 * Only a URL that named NO wiki (no `wiki=`/`bot=`) and NO page is a candidate:
 * a shared `?wiki=` link must open the wiki it names, and a `?relPath=` with no
 * wiki param is an old-style link into the default wiki, not a "take me home".
 * Beyond that, the stored wiki must differ from what was rendered (or the
 * redirect loops), must still be registered (a wiki unregistered since would
 * render the unknown-wiki page — worse than the default), and the server must
 * have rendered a real default: under the `WIKI_DIR` override `rendered` is
 * `""` and the override is left to mean what it means. Every other param on the
 * URL (`view=` in particular) rides along.
 */
export function lastWikiRedirect(input: RedirectInput): string | null {
  const params = new URLSearchParams(input.search);
  if (urlNamesWiki(input.search)) return null;
  if (nonBlank(params, "relPath") || nonBlank(params, "page")) return null;
  const stored = (input.stored ?? "").trim();
  if (!stored) return null;
  if (!input.rendered) return null;
  if (stored === input.rendered) return null;
  if (!input.known.includes(stored)) return null;
  params.set("wiki", stored);
  return "/wiki?" + params.toString();
}

/**
 * Whether a URL's query already DENOTES the overview of `wiki` on `tab` — the
 * guard for pushing a return-to-overview entry. Compared on what the URL means,
 * never on its string: the address bar can spell the same overview many ways
 * (bare `/wiki` for the rendered default, `bot=`, `+` vs `%20`, a `view=` the
 * store would resolve to anyway), and a string compare pushed a DEAD entry on
 * every one of them (measured: bare boot + stored Timeline → coverage-footer
 * click → Back was a no-op). Enumerated: same wiki (a URL naming none means the
 * rendered one; names compare case-insensitively, as `findWiki` does), no page,
 * and the tab the URL resolves to — through the SAME rule the boot uses, so
 * `stored` is the per-wiki value `resolveStartTab` would read.
 */
export function sameStartUrl(search: string, wiki: string, tab: StartTab, stored: string | null): boolean {
  const params = new URLSearchParams(search);
  const named = (params.get("wiki") ?? params.get("bot") ?? "").trim();
  if (named && named.toLowerCase() !== wiki.toLowerCase()) return false;
  if (nonBlank(params, "relPath") || nonBlank(params, "page")) return false;
  return resolveStartTab(params.get(START_VIEW_PARAM), stored) === tab;
}

/** A param with a non-blank value — the server's own test (`trim() ||`), so
 *  `?wiki=` reads as "no wiki named", exactly as the route resolves it. */
function nonBlank(params: URLSearchParams, name: string): boolean {
  return (params.get(name) ?? "").trim() !== "";
}

/** Whether a boot URL named its wiki explicitly — the only case worth
 *  remembering. Remembering the resolved DEFAULT would make the redirect
 *  inert exactly when it matters (bare `/wiki` → jarvis → "remember jarvis"). */
export function urlNamesWiki(search: string): boolean {
  const params = new URLSearchParams(search);
  return nonBlank(params, "wiki") || nonBlank(params, "bot");
}

/**
 * The wiki name to remember after a boot, or `null` for "leave the store
 * alone". Three things must hold: the URL named the wiki (`urlNamesWiki`), the
 * server rendered it, and the picker OFFERS it — `__WIKI_NAME__` is the
 * REQUESTED name even on the "No wiki named X" page, and remembering that
 * pointed the nav's Wiki link at the error page on every dashboard page, where
 * landing on it re-stored it (measured in review).
 */
export function rememberWikiName(search: string, rendered: string, known: readonly string[]): string | null {
  if (!rendered || !urlNamesWiki(search)) return null;
  return known.includes(rendered) ? rendered : null;
}
