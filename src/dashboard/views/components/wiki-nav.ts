/**
 * The reader's navigation IDENTITY rules — which page a click opens, and which
 * row is drawn active — as pure functions, so both can be tested without a DOM.
 *
 * Why they exist at all: the /wiki reader used to navigate and highlight by page
 * NAME (the filename stem). `index.resolve(name)` is first-registration-wins on
 * the lowercased stem, so on a wiki where two pages share a stem EVERY row for
 * that stem opened the same page — measured on the `memory` wiki, whose 30
 * per-project `MEMORY.md` hubs all opened the AI-2027 one — and, because the
 * active-row test was `p.name === currentName`, opening one drew all 30 rows
 * active at once. relPath is unique by construction, so every row emitter now
 * carries a `data-relpath` beside its `data-page` and both rules prefer it.
 *
 * The `data-page` half stays: server-rendered wikilinks (`data-wiki-page`) are
 * name-keyed by definition, and a page opened by name has no relPath to compare
 * until its response lands.
 */

/** Attribute a row/card/node carries with its exact wiki-relative path. */
export const NAV_RELPATH_ATTR = "data-relpath";

/** Selector for every in-reader page link the shell's body delegate handles. */
export const NAV_LINK_SELECTOR = "[data-wiki-page], [data-page], [data-relpath]";

/** Just enough of an Element for the resolver — keeps this module DOM-free. */
export interface AttrSource {
  getAttribute(name: string): string | null;
}

/** Where a click should navigate: an exact page, or a stem to resolve server-side. */
export type NavTarget = { kind: "relPath"; relPath: string } | { kind: "name"; name: string };

/**
 * The target of a click on a navigation link. `data-relpath` wins whenever it is
 * present and non-blank — it is the only attribute that names ONE page — and the
 * name attributes are the fallback for links that have no relPath to give
 * (rendered wikilinks, Ask citations). Returns null when neither carries a value,
 * so the caller leaves the click alone instead of navigating nowhere.
 */
export function navTargetFrom(el: AttrSource | null | undefined): NavTarget | null {
  if (!el) return null;
  const rel = (el.getAttribute(NAV_RELPATH_ATTR) || "").trim();
  if (rel) return { kind: "relPath", relPath: rel };
  const name = (el.getAttribute("data-wiki-page") || el.getAttribute("data-page") || "").trim();
  if (name) return { kind: "name", name };
  return null;
}

/** Page identity as the reader holds it for the open article. Both may be null
 *  (nothing open); `relPath` is absent only until a page response has landed. */
export interface OpenPageRef {
  name: string | null;
  relPath: string | null;
}

/** Normalize a relPath for comparison the way `store.ts`'s `normalizeRelPath`
 *  does for the graph: posix separators, lowercased. No `path` module in the
 *  browser, so the `.`/`..` normalization is deliberately skipped — every relPath
 *  compared here comes from the index, which already emits clean posix paths. */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").toLowerCase();
}

/**
 * Find the listing for an exact relPath, compared the way {@link isActivePage}
 * compares — normalized on BOTH sides.
 *
 * It exists because `loadPageByRelPath`'s explainer branch was a raw `===` over
 * `allPages`. Case reaches that comparison from two directions the index does not
 * control: an Atlas node key (lowercased before it becomes a graph id) and a
 * `?relPath=` typed or copied by hand. A near-miss there does not degrade to "page
 * not found" — it falls THROUGH to `/api/wiki/page`, which happily returns an
 * explainer's raw `.html` as if it were markdown, and the reader paints escaped
 * HTML source into the article pane.
 */
export function findPageByRelPath<T extends { relPath: string }>(
  pages: readonly T[],
  relPath: string,
): T | undefined {
  const want = normalizeRel((relPath || "").trim());
  if (!want) return undefined;
  return pages.find((p) => normalizeRel(p.relPath) === want);
}

/**
 * Is this list row / card the page currently open?
 *
 * relPath decides whenever BOTH sides have one — that is the only test that
 * separates two pages sharing a stem. The name comparison is kept as the
 * fallback for the window before the open page's response has landed (and for
 * hand-built rows carrying no relPath), which is exactly the pre-existing
 * behaviour on every wiki with no colliding stems.
 */
export function isActivePage(
  page: { name: string; relPath?: string },
  current: OpenPageRef,
): boolean {
  if (current.relPath && page.relPath) {
    return normalizeRel(page.relPath) === normalizeRel(current.relPath);
  }
  return !!current.name && page.name === current.name;
}
