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
 * Find the listing a page NAME identifies — the reader's route whenever no
 * relPath is in hand: `?page=<stem>` at boot and on popstate, the no-relPath
 * fallback in the click delegate, an Ask citation (`data-page` with no
 * `data-relpath`) and a chat wiki citation.
 *
 * It exists because a raw `pages.find(p => p.name === name)` over the
 * relPath-ordered listing answers `x.html` for a page whose diagram sits beside
 * it — `plans/y.html` sorts before `plans/y.md` — and the caller's explainer
 * branch then opens the diagram in the iframe. The server never does that: a
 * rule-1 attachment registers NO stem key, so `index.resolve(name)` answers the
 * markdown page, and `/api/wiki/page?name=` with it.
 *
 * It mirrors that registration in ONE rule, so the answer does not depend on the
 * order the listing arrives in — which is the point, since nothing on the wire
 * promises one: **a `pairedBy === "stem"` child is never the answer, and among
 * the rest the LOWEST relPath wins**, which is what "first-wins over a
 * relPath-sorted `pages`" resolves to on the server.
 *
 * Deliberately ONE rule and not two. An extension-rank preference beside the
 * skip reads like a second lock, but after the same-stem drop no two SURVIVING
 * pages of different extensions can share a stem by any other route — so it can
 * never decide anything the skip has not already decided, and two mechanisms for
 * one outcome is how NEITHER ends up pinned (measured: with both here, deleting
 * either one kept this module's tests green).
 */
export function findPageByName<T extends { name: string; relPath: string; pairedBy?: string }>(
  pages: readonly T[],
  name: string,
): T | undefined {
  const want = (name || "").trim();
  if (!want) return undefined;
  let best: T | undefined;
  for (const p of pages) {
    if (p.name !== want || p.pairedBy === "stem") continue;
    if (!best || normalizeRel(p.relPath) < normalizeRel(best.relPath)) best = p;
  }
  return best;
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
