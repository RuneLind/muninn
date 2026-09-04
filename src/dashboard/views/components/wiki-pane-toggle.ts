/// <reference lib="dom" />
/**
 * The /wiki reader's pane toggles, DOM half. Rules in `wiki-panes.ts`.
 *
 * Two classes on `.wiki-layout`, styled in `wiki-page.ts`:
 *  - `.right-collapsed` — the Connections/Ask pane is a 40px icon strip. The
 *    strip's Connections/Ask icons expand the pane AND select that tab (by
 *    clicking the real tab button, so the tab's own handler runs); its ⤢ enters
 *    focus. The pane's tab row carries the collapse (›) and focus (⤢) buttons.
 *  - `.focus-mode` — both side panes hidden. The only control left on screen is
 *    the exit pill at the article pane's top-right (`#wikiFocusExit`).
 *
 * Keys: `]` right pane, `F` focus, `Escape` leaves focus. The Explain pill's own
 * Escape handler runs too; both are "dismiss", so they do not conflict.
 *
 * The right-pane state persists (localStorage, best-effort like the rail width);
 * focus does not — see the rationale in `wiki-panes.ts`.
 */
import { PANES_KEY, paneKeyAction, parseStoredRightCollapsed, serializeRightCollapsed } from "./wiki-panes.ts";

const RIGHT = "right-collapsed";
const FOCUS = "focus-mode";

function readStored(): boolean {
  try {
    return parseStoredRightCollapsed(localStorage.getItem(PANES_KEY));
  } catch {
    return false;
  }
}

function persist(collapsed: boolean): void {
  try {
    const v = serializeRightCollapsed(collapsed);
    if (v === null) localStorage.removeItem(PANES_KEY);
    else localStorage.setItem(PANES_KEY, v);
  } catch {
    /* best-effort */
  }
}

export function initPaneToggles(): void {
  const layout = document.querySelector<HTMLElement>(".wiki-layout");
  if (!layout) return;

  const syncButtons = (): void => {
    const right = layout.classList.contains(RIGHT);
    const focus = layout.classList.contains(FOCUS);
    document.querySelectorAll<HTMLElement>("[data-pane-toggle='right']").forEach((b) => b.setAttribute("aria-pressed", String(right)));
    document.querySelectorAll<HTMLElement>("[data-pane-toggle='focus']").forEach((b) => b.setAttribute("aria-pressed", String(focus)));
  };

  const setRight = (collapsed: boolean): void => {
    layout.classList.toggle(RIGHT, collapsed);
    persist(collapsed);
    syncButtons();
  };
  const setFocus = (on: boolean): void => {
    layout.classList.toggle(FOCUS, on);
    syncButtons();
  };

  // Boot: apply the stored preference before first paint of the pane.
  layout.classList.toggle(RIGHT, readStored());
  syncButtons();

  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest?.("[data-pane-toggle], [data-pane-open]") as HTMLElement | null;
    if (!btn) return;
    const toggle = btn.getAttribute("data-pane-toggle");
    if (toggle === "right") return setRight(!layout.classList.contains(RIGHT));
    if (toggle === "focus") return setFocus(!layout.classList.contains(FOCUS));
    if (toggle === "focus-exit") return setFocus(false);
    // Strip icon: expand, then select the named tab through its real button so
    // the tab handler (Ask input focus, session restore) runs as on a plain click.
    const tab = btn.getAttribute("data-pane-open");
    if (tab) {
      setRight(false);
      document.querySelector<HTMLElement>(`.wiki-conn-tab[data-conntab="${tab}"]`)?.click();
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const action = paneKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      repeat: e.repeat,
      targetTag: t?.tagName,
      targetEditable: !!t?.isContentEditable,
      targetInDialog: !!t?.closest?.("dialog, [role='dialog']"),
    });
    if (!action) return;
    if (action === "toggle-right") setRight(!layout.classList.contains(RIGHT));
    else if (action === "toggle-focus") setFocus(!layout.classList.contains(FOCUS));
    else if (layout.classList.contains(FOCUS)) setFocus(false);
    else return;
    e.preventDefault();
  });
}
