/// <reference lib="dom" />
/**
 * The /wiki reader's effort page (work map P3): `?effort=<id>` fills the
 * article pane with one effort or theme, joined from the work map that
 * `wiki-work-map-cache.ts` holds. Moved out of the shell (`wiki-browser.ts`)
 * whole, in source order (mimir plan muninn-wiki-browser-split, C3).
 *
 * Importing this module runs nothing and it registers no listener: its links
 * are claimed by the shell's body click delegate. The shell's `boot()` calls
 * {@link initEffort} beside `initRail`. This module never imports the shell:
 * what it reads and calls there arrives through {@link EffortDeps}.
 */
import { EFFORT_PARAM, canonicalEffortParam, effortStatusHtml, effortView } from "./wiki-effort-page.ts";
import { themeView } from "./wiki-theme-page.ts";
import type { WorkMapGetBody } from "./wiki-work-card.ts";
import { isThemeMap, type AnyWorkMap } from "../../../wiki/work-map/join.ts";
import { adoptIfNewer, effortHrefFor as cacheEffortHref, getWorkMapCache, workMapFetchFor } from "./wiki-work-map-cache.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import { abortAgentRuns } from "./wiki-agent-pane.ts";
import { workMapDoneSet } from "./wiki-start-cards.ts";
import { statusPillHtml } from "./wiki-status-pills.ts";
import { closeRailPanel } from "./wiki-pane-toggle.ts";
import { renderList } from "./wiki-rail-controller.ts";
import { getWorkMapRunAt, setCurrentName } from "./wiki-shell-state.ts";

/** What the effort page reads and calls on the shell, read live. */
export interface EffortDeps {
  WIKI(): string;
  allPages(): WikiListing[];
  /** The shell's one filter object: read for the facets an effort URL carries. */
  readonly filters: WikiFilters;
  /** The shell's page-view counter: a paint for an older view is dropped. */
  pageViewSeq(): number;
  /** The listing's `workMap.kind === "themes"`: the status panes say theme. */
  workMapThemes(): boolean;
  withWiki(url: string): string;
  pageUrlByRelPath(relPath: string): string;
  currentStartUrl(): string;
  applyPendingPages(): void;
  consumeUrlLens(): void;
  setAtlasFull(on: boolean): void;
  /** No page is shown: the shown page, its hash, graph mode and the breadcrumb
   *  are cleared, in `renderEffort`'s original order. */
  clearShownPage(): void;
}

/** Set once, by {@link initEffort}, before anything here runs. */
let deps!: EffortDeps;

// ── Effort page (work map P3) ─────────────────────────────────────────
/** The effort the article pane shows, or null. Read only while
 *  `#wikiEffortPage` is in the pane: every other view replaces it. */
let effortOpen: string | null = null;
/** An effort's reader URL, carrying the facets an article URL carries. */
export function effortHrefFor(id: string): string {
  return cacheEffortHref(deps.WIKI(), deps.filters, id);
}

/** A map the card's ↻ poll fetched: when it is a newer run than the listing's,
 *  it becomes the cache and the run time (`adoptIfNewer`), and the rail and an
 *  open effort page repaint from it without waiting for a listing refresh. */
export function adoptWorkMap(body: WorkMapGetBody): void {
  if (!adoptIfNewer(body)) return;
  renderList();
  if (effortOpen !== null && document.getElementById("wikiEffortPage")) paintEffort(effortOpen, true);
}

/** The effort a URL's `?effort=` names, or null for none. A blank value is
 *  dropped from the address bar and a case variant (`Drift`) is written as its
 *  slug, both in place (`replaceState`): neither is a navigation. A value that
 *  is already a valid effort id (`a--b`) is kept as typed. */
export function effortFromUrl(params: URLSearchParams): string | null {
  const raw = params.get(EFFORT_PARAM);
  if (raw === null) return null;
  const id = canonicalEffortParam(raw);
  if (id !== raw) {
    const u = new URL(location.href);
    if (id === null) u.searchParams.delete(EFFORT_PARAM);
    else u.searchParams.set(EFFORT_PARAM, id);
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }
  return id;
}

/** Open an effort from a link: push its URL (unless already there), render. */
export function openEffort(id: string): void {
  const target = effortHrefFor(id);
  if (location.pathname + location.search !== target) history.pushState({}, "", target);
  renderEffort(id);
}

/** The markup the effort page last wrote into the article and Connections
 *  panes, so a background re-join that changes nothing writes nothing. */
let effortShown: { article: string; conn: string } | null = null;

/** A selector that finds the focused control again after a re-render: the
 *  `data-focus-key` the effort view gives every focusable element. */
function effortFocusKey(el: Element | null): string | null {
  const key = el instanceof HTMLElement ? el.getAttribute("data-focus-key") : null;
  return key === null ? null : `[data-focus-key="${CSS.escape(key)}"]`;
}

/** Write the effort page's two panes. A navigation paints and scrolls to the
 *  top. A background re-join (`background`) skips the write when the markup is
 *  unchanged (a swap drops focus and wipes a selection), and otherwise keeps
 *  the scroll as it is at paint time and focus on the same control. */
function writeEffortPanes(wrap: HTMLElement, article: string, connHtml: string, background: boolean): void {
  const conn = document.getElementById("connBody");
  if (background && effortShown && effortShown.article === article && effortShown.conn === connHtml) return;
  const active = document.activeElement;
  const holder = background && active ? (wrap.contains(active) ? wrap : conn?.contains(active) ? conn : null) : null;
  const key = holder ? effortFocusKey(active) : null;
  const scroll = background ? wrap.scrollTop : 0;
  wrap.innerHTML = article;
  wrap.scrollTop = scroll;
  if (conn) conn.innerHTML = connHtml;
  effortShown = { article, conn: connHtml };
  if (holder && key) (holder.querySelector(key) as HTMLElement | null)?.focus({ preventScroll: true });
}

/** `?effort=<id>`: the effort page fills the article pane, as the issue graph
 *  does, with no page behind it. A navigation: it applies a stashed listing
 *  first (as `renderStart`/`loadPage` do), then paints. */
export function renderEffort(id: string): void {
  closeRailPanel(); // an effort link in the rail: the page it opens is under the panel
  // A listing stashed while an article was open lands now, before the map is
  // joined to `allPages`; the list is repainted from it like `renderStart` does.
  deps.applyPendingPages();
  deps.consumeUrlLens();
  abortAgentRuns();
  if (!document.getElementById("articleWrap")) return;
  deps.setAtlasFull(false);
  setCurrentName(null);
  deps.clearShownPage();
  // No page is open: repaint the rail, so the highlight goes and a fold the
  // page forced open gets its caret back.
  renderList();
  effortOpen = id;
  paintEffort(id, false);
}

/** Join the map to the listing and paint it. The map comes from the cache when
 *  the listing's run time still matches it. A navigation paints a loading
 *  state before a fetch and the error pane when it fails; a background re-join
 *  keeps the effort on screen through both. */
function paintEffort(id: string, background: boolean): void {
  const wrap = document.getElementById("articleWrap");
  if (!wrap) return;
  const seq = deps.pageViewSeq();
  // Built at each write, so a pane painted after the GET carries the facets
  // set while it was in flight.
  // The listing's map kind is known before the map loads, so a themes wiki's
  // status panes say theme.
  const head = () => ({ wiki: deps.WIKI(), startHref: deps.currentStartUrl(), id, themes: deps.workMapThemes() });
  const noMapConn = `<div class="wiki-ef-conn-empty">No ${deps.workMapThemes() ? "theme" : "work"} map.</div>`;
  const paint = (map: AnyWorkMap) => {
    // A themes map draws the theme page (theme map P3) on the reader's clock,
    // so the run's week reads as running only while it has not ended.
    if (isThemeMap(map)) {
      const view = themeView({
        map,
        pages: deps.allPages(),
        id,
        wiki: deps.WIKI(),
        startHref: deps.currentStartUrl(),
        hrefFor: deps.pageUrlByRelPath,
        effortHref: effortHrefFor,
        done: workMapDoneSet(map.runAtMs),
        now: Date.now(),
      });
      writeEffortPanes(wrap, view.article, view.connections, background);
      return;
    }
    const view = effortView({
      map,
      pages: deps.allPages(),
      id,
      wiki: deps.WIKI(),
      startHref: deps.currentStartUrl(),
      hrefFor: deps.pageUrlByRelPath,
      effortHref: effortHrefFor,
      pill: statusPillHtml,
      done: workMapDoneSet(map.runAtMs),
      now: Date.now(),
    });
    writeEffortPanes(wrap, view.article, view.connections, background);
  };
  const runAt = getWorkMapRunAt();
  if (runAt === null) {
    writeEffortPanes(wrap, effortStatusHtml(head(), "no-map"), noMapConn, background);
    return;
  }
  const cached = getWorkMapCache();
  if (cached?.runAt === runAt) {
    paint(cached.body.map);
    return;
  }
  if (!background) writeEffortPanes(wrap, effortStatusHtml(head(), "loading"), '<div class="wiki-ef-conn-empty">Loading…</div>', false);
  const current = () => effortOpen === id && deps.pageViewSeq() === seq && !!document.getElementById("wikiEffortPage");
  workMapFetchFor(runAt, deps.withWiki)
    .then((r) => {
      const body = r.body;
      if (!current()) return;
      if (!r.ok || !body || typeof body !== "object") throw new Error(r.ok ? "malformed response" : `HTTP ${r.status}`);
      if (!body.map) {
        writeEffortPanes(wrap, effortStatusHtml(head(), "no-map"), noMapConn, background);
        return;
      }
      paint(body.map);
    })
    .catch((err: Error) => {
      if (!current()) return;
      // A background re-join that fails keeps the effort being read; the next
      // adopt or a navigation tries again.
      if (background) return;
      writeEffortPanes(wrap, effortStatusHtml(head(), "error", err.message), noMapConn, false);
    });
}

/** A listing adopted, or a facet changed, while the effort page is open:
 *  re-join it (a page may have been renamed, a new run landed, or the hrefs
 *  carry another facet). Paint only: no navigation side effects, and nothing
 *  written when the markup is unchanged. */
export function refreshEffortFromListing(): void {
  if (effortOpen === null || !document.getElementById("wikiEffortPage")) return;
  paintEffort(effortOpen, true);
}
/** The effort the article pane shows, or null (the body click delegate's Retry). */
export function getEffortOpen(): string | null {
  return effortOpen;
}

// ── Boot: called by the shell's boot() ────────────────────────────────
/** Take the port. */
export function initEffort(d: EffortDeps): void {
  deps = d;
}
