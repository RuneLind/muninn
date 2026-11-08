/// <reference lib="dom" />
/**
 * The /wiki reader's series editor (mimir plan muninn-wiki-browser-split, C5):
 * the popover `#wikiSeriesMenu`, its CAS-guarded writes and the repaint after
 * them.
 *
 * Stage 1 holds the port only; the code moves from the shell (`wiki-browser.ts`)
 * in a later change. The controller will own `seriesMenu` and `postSeriesWrite`
 * (exported getters; `initSeries` sets the poster where `boot()` assigns it
 * today) and `seriesBaseHash`. It never imports the shell: what it reads and
 * calls there arrives through {@link SeriesPort}. It imports the ⋯ menus'
 * focus rule and row items (`wiki-menus-controller.ts`), the rail's
 * `railControlSelector` and the article controller's `repaintRelatedBlock`
 * directly; none of those imports it back, so the ⋯ menus keep reaching the
 * editor through the shell's `menusDeps()` relay.
 */
import type { WikiListing } from "./wiki-filter.ts";
import type { OpenPageAtLoad } from "./wiki-series-write.ts";
import type { ReceiveOutcome } from "./wiki-refresh.ts";

/** What the series editor reads and calls on the shell, read live through a
 *  function so a value the shell reassigns is never a stale copy. Every member
 *  is shell-owned. */
export interface SeriesPort {
  /** The shell's `WIKI` let: `initSeries` builds the series POST for it. */
  WIKI(): string;
  /** The shell's `allPages` let (the listing): the menu model and the head repaint. */
  allPages(): WikiListing[];
  /** The shell's `currentRelPath` let: which page's head to repaint. */
  currentRelPath(): string | null;
  /** The shell's `withWiki()`: the CAS base reader's page URL. */
  withWiki(url: string): string;
  /** The shell's `recencyNow()`: the menu model's recency. */
  recencyNow(): number;
  /** The shell's `requestPagesAwaited()` (listing refresh): the refetch after a write. */
  requestPagesAwaited(opts: { refresh: boolean; boot?: boolean; force?: boolean }): Promise<ReceiveOutcome | "error">;
  /** The shell's `seriesStripHtml()` (the article head): the strip a write repaints. */
  seriesStripHtml(m: WikiListing): string;
  /** The shell's `openPageAtLoad()`, the same member `MenusDeps` has: it reads
   *  only shell lets (`currentRelPath`, `currentPageHash`). */
  openPageAtLoad(): OpenPageAtLoad;
  /** The shell's `adoptOwnSeriesHashes()`, the same member `MenusDeps` has: it
   *  writes `currentPageHash`, which stays single-writer in the shell. */
  adoptOwnSeriesHashes(hashes: ReadonlyMap<string, string>): void;
}
