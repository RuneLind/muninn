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
 *    the exit pill in the bar above the breadcrumb (`#wikiFocusExit`) — in FLOW,
 *    not floated over the breadcrumb, whose right end is where Share/Discuss
 *    live (a floated pill sat exactly on Share; measured in review).
 *
 * Keys: `]` right pane, `F` focus, `Escape` leaves focus. The Explain pill's own
 * Escape handler runs too; both are "dismiss", so they do not conflict.
 *
 * `]` is inert while the pane is not on screen — in focus mode, and below the
 * 1100px breakpoint where the media rule hides it — because a toggle with no
 * visible effect still PERSISTED: a `]` on a narrow window folded the pane on the
 * reader's next wide session with no memory of asking.
 *
 * The right-pane state persists (localStorage, best-effort like the rail width);
 * focus does not — see the rationale in `wiki-panes.ts`.
 */
import { PANES_KEY, paneKeyAction, parseStoredRightCollapsed } from "./wiki-panes.ts";

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
    if (collapsed) localStorage.setItem(PANES_KEY, "collapsed");
    else localStorage.removeItem(PANES_KEY);
  } catch {
    /* best-effort */
  }
}

let layoutEl: HTMLElement | null = null;
let syncButtons: () => void = () => {};

/** Un-collapse the right pane and leave focus — for code that is about to show
 *  something IN that pane (the Ask/Explain/Fact-check stream reveals the Ask tab
 *  there): with the pane folded the reveal was a 38px sliver, and in focus mode
 *  it was nothing at all, with no sign the session history existed. */
export function revealRightPane(): void {
  if (!layoutEl) return;
  layoutEl.classList.remove(FOCUS);
  if (layoutEl.classList.contains(RIGHT)) {
    layoutEl.classList.remove(RIGHT);
    persist(false);
  }
  syncButtons();
  window.dispatchEvent(new Event("resize"));
}

export function initPaneToggles(): void {
  const layout = document.querySelector<HTMLElement>(".wiki-layout");
  if (!layout) return;
  layoutEl = layout;
  const connPane = layout.querySelector<HTMLElement>(".wiki-conn-pane");

  // aria-pressed goes ONLY on the buttons the markup declares as toggles (they
  // carry the attribute from the start). The strip's expand button is the same
  // data-pane-toggle but the OPPOSITE verb ("Show connections"), and stamping
  // `true` on it while collapsed announced "Show connections, pressed" and
  // painted it as engaged.
  syncButtons = (): void => {
    const right = String(layout.classList.contains(RIGHT));
    const focus = String(layout.classList.contains(FOCUS));
    document.querySelectorAll<HTMLElement>("[data-pane-toggle='right'][aria-pressed]").forEach((b) => b.setAttribute("aria-pressed", right));
    document.querySelectorAll<HTMLElement>("[data-pane-toggle='focus'][aria-pressed]").forEach((b) => b.setAttribute("aria-pressed", focus));
  };

  /** The pane is toggleable only while it is on screen (not in focus, not
   *  hidden by the ≤1100px media rule). */
  const rightOnScreen = (): boolean =>
    !layout.classList.contains(FOCUS) && !!connPane && getComputedStyle(connPane).display !== "none";

  // A toggle changes the article's width with no window resize; the atlas redraws
  // its edges on that event, so send one.
  const setRight = (collapsed: boolean): void => {
    layout.classList.toggle(RIGHT, collapsed);
    persist(collapsed);
    syncButtons();
    window.dispatchEvent(new Event("resize"));
  };
  const setFocus = (on: boolean): void => {
    layout.classList.toggle(FOCUS, on);
    syncButtons();
    window.dispatchEvent(new Event("resize"));
  };

  // Boot: apply the stored preference before the pane's first paint.
  layout.classList.toggle(RIGHT, readStored());
  syncButtons();

  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest?.("[data-pane-toggle], [data-pane-open]") as HTMLElement | null;
    if (!btn) return;
    const toggle = btn.getAttribute("data-pane-toggle");
    if (toggle === "right") return setRight(!layout.classList.contains(RIGHT));
    if (toggle === "focus") return setFocus(!layout.classList.contains(FOCUS));
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
    if (action === "toggle-right") {
      if (!rightOnScreen()) return;
      setRight(!layout.classList.contains(RIGHT));
    } else if (action === "toggle-focus") setFocus(!layout.classList.contains(FOCUS));
    else if (layout.classList.contains(FOCUS)) setFocus(false);
    else return;
    e.preventDefault();
  });
}
