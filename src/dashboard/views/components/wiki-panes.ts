/**
 * The /wiki reader's pane toggles — the rules, DOM-free so they are unit-testable.
 * The DOM half (`wiki-pane-toggle.ts`) applies them as classes on `.wiki-layout`.
 *
 * Two independent states:
 *  - `rightCollapsed` — the Connections/Ask pane folds to a 40px icon strip
 *    (`.right-collapsed`). Persisted: hiding it is a preference, and re-hiding
 *    it on every reload is the chore the rail width already solved (PR #501).
 *  - `focus` — both side panes go (`.focus-mode`), the article takes the whole
 *    viewport. NOT persisted: it is a reading mode for one sitting, and a
 *    reload with no rail and no pane is a "where did everything go" moment; the
 *    strip's ⤢ and F bring it back in one act. Focus survives in-page navigation
 *    (a wikilink is a pushState, not a load) on purpose — the Atlas tab's
 *    restore-on-open rule would be the wrong one here, since following a link is
 *    the reading it was entered for.
 */

/** localStorage key. Versioned so a future shape change can start clean. */
export const PANES_KEY = "muninn.wiki.panes.v1";

/** Width of the collapsed strip's grid column; the CSS reads it interpolated. */
export const STRIP_WIDTH = 40;

/** Read the stored preference. Anything but the exact literal is "open". */
export function parseStoredRightCollapsed(raw: string | null | undefined): boolean {
  return raw === "collapsed";
}

export function serializeRightCollapsed(collapsed: boolean): string | null {
  return collapsed ? "collapsed" : null;
}

export type PaneKeyAction = "toggle-right" | "toggle-focus" | "exit-focus";

export interface PaneKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  /** Tag name of the event target, upper- or lower-case. */
  targetTag?: string | null;
  /** Whether the target sits inside an editable region or a dialog. */
  targetEditable?: boolean;
  targetInDialog?: boolean;
}

/**
 * Which action a keydown maps to, or null. `]` toggles the right pane, `F`
 * toggles focus, `Escape` leaves focus. Every one of them is refused while the
 * reader is typing (an input, a textarea, contenteditable — `]` and `f` are
 * letters there), with a modifier held (⌘F is the browser's find), or on key
 * repeat. Escape inside a dialog belongs to the dialog.
 */
export function paneKeyAction(e: PaneKeyEvent): PaneKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  const tag = (e.targetTag || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.targetEditable) return null;
  if (e.key === "]") return "toggle-right";
  if (e.key === "f" || e.key === "F") return "toggle-focus";
  if (e.key === "Escape") return e.targetInDialog ? null : "exit-focus";
  return null;
}
