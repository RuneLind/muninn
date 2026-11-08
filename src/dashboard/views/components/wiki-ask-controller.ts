/// <reference lib="dom" />
/**
 * The /wiki reader's Ask tab: `runAskStream` and its handlers, claim retry (↻),
 * integrate into article and session persistence (mimir plan
 * muninn-wiki-browser-split, C4). Stage 1 holds only the port; the code moves
 * out of the shell (`wiki-browser.ts`) in a later stage, behind it.
 *
 * This module will never import the shell: what Ask reads, writes and calls
 * there arrives through {@link AskTurnPort}, the `RailDeps` shape. The member
 * list comes from a checker scan of the shell's Ask region. Ask owns its turn
 * state (`askTurns`, `askShownTurn`, `integratePreview`) and exports accessors
 * for the shell, so the port carries no `getShownTurn()` or `repaintBody()`:
 * those flow the other way. Leaf imports (`wiki-ask-render.ts`,
 * `wiki-ask-session.ts`, `wiki-shell-state.ts`'s `setCurrentName`, the rail's
 * `renderList`) are imported directly and are not port members.
 */

/** What Ask reads and calls on the shell, read live through a function so a
 *  value the shell reassigns is never a stale copy. */
export interface AskTurnPort {
  /** The shell's `WIKI` let (the active wiki's name), read for every Ask URL. */
  WIKI(): string;
  /** The shell's `clearShownPage()`: an Ask answer replaces the page, so
   *  `showAskAnswer` clears `currentRelPath`, `currentPageHash`, graph mode and
   *  the breadcrumb, the C3 command `renderEffort` already uses. */
  clearShownPage(): void;
  /** The shell's `switchConnTab()` (right-rail tabs, C5): `runAskStream` shows the Ask tab. */
  switchConnTab(tab: string, focus?: boolean): void;
  /** The shell's `reloadPageInPlace()` (page loading; the walkthrough's Reload
   *  calls it too): a fact-check write re-opens the checked page. */
  reloadPageInPlace(relPath: string | undefined, name?: string): void;
}
