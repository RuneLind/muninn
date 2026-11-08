/// <reference lib="dom" />
/**
 * The /wiki reader's article controller (mimir plan muninn-wiki-browser-split,
 * C5): the article tools (⧉ Copy path, the provenance strip, issue links),
 * 📤 Share on the open article, and the right pane (Connections with its
 * mini-graph, the rail tabs, Related work, Similar articles).
 *
 * Stage 1 holds the port only; the code moves from the shell (`wiki-browser.ts`)
 * in a later change. The controller will own its state outright (the issue
 * rows and Link locks, `connData`, `currentOutgoingTitles`, `relatedOrder`, the
 * provenance and related-hop fetch state), and `initArticle` will set
 * `relatedOrder` where `boot()` assigns it today. It never imports the shell:
 * what it reads and calls there arrives through {@link ArticlePort}. Leaf
 * modules, `wiki-rail-controller.ts` (`renderList`, `renderJiraChips`) and
 * `wiki-stale-controller.ts` (`staleTabAvailable`) are imported directly and
 * are not port members.
 */
import type { WikiListing } from "./wiki-filter.ts";
import type { WorkedGate } from "./wiki-activity-rank.ts";

/** What the article controller reads and calls on the shell, read live through
 *  a function so a value the shell reassigns is never a stale copy. Every
 *  member is shell-owned: the shell is its only writer. */
export interface ArticlePort {
  /** The shell's `WIKI` let: share, issue links, related hops, `readRelatedOrder`. */
  WIKI(): string;
  /** The shell's `WIKI_ROOT` let: ⧉ Copy path's absolute path. */
  WIKI_ROOT(): string | null;
  /** The shell's `allPages` let (the listing): issue rows, related freshness. */
  allPages(): WikiListing[];
  /** The shell's `currentRelPath` let (`setCurrentRelPath` is its one writer). */
  currentRelPath(): string | null;
  /** The shell's `currentArticle` let, set by `renderBreadcrumb`: Copy path and Share. */
  currentArticle(): WikiListing | null;
  /** The shell's `typeOrder` let (from the listing): Connections' type order. */
  typeOrder(): string[];
  /** The shell's `typeLabel()`: Connections' type headings. */
  typeLabel(t: string): string;
  /** The shell's `workedGate` let (from the listing): Related work's worked axis. */
  workedGate(): WorkedGate | null;
  /** The shell's `workedAxisOn` let (View options): Related work's worked sort. */
  workedAxisOn(): boolean;
  /** The shell's `jiraKeys` let (the Jira facet): issue rows and Link all. */
  jiraKeys(): Record<string, number>;
  /** The shell's `trackerLabels` let: issue rows and the mini-graph. */
  trackerLabels(): Record<string, string>;
  /** The shell's `withWiki()`: provenance, related-hop and similar URLs. */
  withWiki(url: string): string;
  /** The shell's `recencyNow()`: Related work's recency. */
  recencyNow(): number;
}
