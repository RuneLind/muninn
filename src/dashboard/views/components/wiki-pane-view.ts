/**
 * The one owner of "which view the article pane shows" (architecture review
 * 2026-11-16, F22). Every view entry — a page, an explainer, the start view, an
 * issue graph, an effort page, an Ask answer — calls {@link enterView}, which
 * runs the shell's teardown of the view being left once and returns this view's
 * token. An async result holds its token and asks {@link viewIsLive} before it
 * paints or starts new work: a later entry of any kind, or a page fetch the
 * reader started, has made it stale.
 *
 * A leaf: the shell registers its teardown at boot ({@link setViewTeardown}),
 * so the controllers import this without importing the shell.
 */

/** What the pane is entering. `page` is entered when its response is about to
 *  paint (its fetch holds a {@link beginPageEntry} until then); its identity
 *  lands with that response, so the teardown leaves the shown page's identity
 *  alone for it. */
export type PaneViewKind = "page" | "explainer" | "start" | "graph" | "effort" | "ask";

let token = 0;
let pageEntrySeq = 0;
/** The token a page fetch started from: while it equals `token`, the reader has
 *  asked to leave the shown view and only its response is still to come. */
let leaving = -1;
let teardown: (kind: PaneViewKind, relPath: string | null) => void = () => {};

/** The shell's teardown, set once in `boot()`. */
export function setViewTeardown(fn: (kind: PaneViewKind, relPath: string | null) => void): void {
  teardown = fn;
}

/** Leave the shown view for a new one: the old view's results go stale, the
 *  teardown runs, and the new view's token comes back. `relPath` is the page
 *  the new view shows (an explainer), null for every other kind. */
export function enterView(kind: PaneViewKind, relPath: string | null = null): number {
  const t = ++token;
  teardown(kind, relPath);
  return t;
}

/** Is the view `t` was returned for still on screen? True through a pending
 *  page fetch: only the Ask answer asks this, so its stream keeps painting
 *  until the page replaces it. */
export function viewIsShown(t: number): boolean {
  return t === token;
}

/** May the view `t` was returned for still act: paint a late result, reload,
 *  start a fetch? False once a later view is entered, and from the moment a
 *  page fetch starts, though the old view stays on screen until it paints. */
export function viewIsLive(t: number): boolean {
  return t === token && leaving !== token;
}

/** A page fetch's hold on the pane, from its start to its response. */
export interface PageEntry {
  /** May the response no longer paint: a later page fetch started, or a view was entered? */
  superseded(): boolean;
  /** The response is about to paint: enter the page view (once) and return its token. */
  enter(): number;
}

/** Start a page fetch without leaving the shown view: an Ask answer still
 *  streaming keeps painting until the page replaces it ({@link viewIsShown}),
 *  while every other result of the shown view goes stale now ({@link viewIsLive}).
 *  Every older entry not yet entered goes stale, so only the newest page fetch
 *  may paint. */
export function beginPageEntry(): PageEntry {
  const base = token;
  const seq = ++pageEntrySeq;
  leaving = token;
  let view = 0;
  return {
    superseded: () => (view ? !viewIsShown(view) : base !== token || seq !== pageEntrySeq),
    enter: () => (view ||= enterView("page")),
  };
}
