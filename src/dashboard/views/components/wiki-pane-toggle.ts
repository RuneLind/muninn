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
 * Keys: `]` right pane, `F` focus, `Escape` leaves focus — none of them from
 * inside a dialog or a menu, whose keys are their own. The Explain pill's own
 * Escape handler runs too; both are "dismiss", so they do not conflict.
 *
 * `]` is inert while the pane is not on screen — in focus mode, on the start
 * view's Atlas tab, and below the 1100px breakpoint where the media rule hides
 * it (the check is the pane's computed display, so it covers every such state)
 * — because a toggle with no visible effect still PERSISTED: a `]` on a narrow
 * window folded the pane on the reader's next wide session with no memory of
 * asking.
 *
 * A third class, `.rail-open`, means something only at or under
 * `RAIL_DRAWER_MAX` (issue #623), where the rail has no column: the Pages
 * button (`#wikiRailToggle`, shown only there) opens it in the article's
 * place. Escape, the button and opening a page close it. Not persisted: a
 * phone reader came for the page.
 *
 * The right-pane state persists (localStorage, best-effort like the rail width);
 * focus does not — see the rationale in `wiki-panes.ts`.
 */
import { RAIL_DRAWER_MAX } from "./wiki-rail-width.ts";
import { PANES_KEY, modalOpen, paneKeyAction, parseStoredRightCollapsed } from "./wiki-panes.ts";

const RIGHT = "right-collapsed";
const FOCUS = "focus-mode";
const RAIL_OPEN = "rail-open";

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
 *  it was nothing at all, with no sign the session history existed.
 *  For THIS sitting only: the stored preference is not touched, so a reader who
 *  keeps the pane folded gets it back on the next load rather than losing the
 *  preference the first time they click Explain (round-1 verify finding). */
export function revealRightPane(): void {
  if (!layoutEl) return;
  layoutEl.classList.remove(FOCUS, RIGHT);
  syncButtons();
  window.dispatchEvent(new Event("resize"));
}

/** Leave focus mode — for code about to show something in the RAIL, which
 *  focus mode hides. The right pane's own collapse is left as it is. */
export function leaveFocusMode(): void {
  if (!layoutEl) return;
  // Where the rail is a panel, showing something in it means opening it.
  if (document.getElementById("wikiRailToggle")?.getClientRects().length) openRailPanel();
  const focus = layoutEl.classList.contains(FOCUS);
  layoutEl.classList.remove(FOCUS);
  syncButtons();
  if (focus) window.dispatchEvent(new Event("resize"));
}

/** Open the rail panel and put focus on it: the article it replaces is hidden,
 *  so focus left on a control there (or on the button, the layout's last
 *  child) would have nowhere to Tab to. The pane, not the search box: an
 *  input's focus raises a phone's keyboard over the list. */
function openRailPanel(): void {
  if (!layoutEl) return;
  layoutEl.classList.add(RAIL_OPEN);
  syncButtons();
  // Focusable only while it is the panel: at desktop width the pane takes no
  // focus, as before.
  const pane = document.getElementById("wikiRailPane");
  pane?.setAttribute("tabindex", "-1");
  pane?.focus({ preventScroll: true });
}

/** Close the rail panel: a page is opening, and under it is where it shows.
 *  Focus the closing would strand, in the rail or already on the body, goes
 *  to the button. */
export function closeRailPanel(): void {
  if (!layoutEl?.classList.contains(RAIL_OPEN)) return;
  const active = document.activeElement;
  const stranded = !active || active === document.body || !!active.closest("#wikiRailPane");
  layoutEl.classList.remove(RAIL_OPEN);
  document.getElementById("wikiRailPane")?.removeAttribute("tabindex");
  syncButtons();
  if (stranded) document.getElementById("wikiRailToggle")?.focus({ preventScroll: true });
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
    document.getElementById("wikiRailToggle")?.setAttribute("aria-expanded", String(layout.classList.contains(RAIL_OPEN)));
  };

  /** The pane is toggleable only while it is on screen — its computed display,
   *  so focus mode, the Atlas tab and the ≤1100px media rule all count. */
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

  // The panel is a narrow-window state. Back and Forward render a view under
  // it whichever loader they reach (a page, the start view, an effort), and a
  // window grown past the breakpoint has no button left to close it with.
  window.addEventListener("popstate", closeRailPanel);
  matchMedia(`(max-width: ${RAIL_DRAWER_MAX}px)`).addEventListener("change", (m) => {
    if (!m.matches) closeRailPanel();
  });

  // Boot: apply the stored preference before the pane's first paint.
  layout.classList.toggle(RIGHT, readStored());
  syncButtons();

  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest?.("[data-pane-toggle], [data-pane-open]") as HTMLElement | null;
    if (btn?.getAttribute("data-pane-toggle") === "rail") {
      return layout.classList.contains(RAIL_OPEN) ? closeRailPanel() : openRailPanel();
    }
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
    // The rail panel's Escape, from a typing target too (its search box). A
    // rendered dialog or menu owns its Escape wherever focus is (`modalOpen`:
    // the Group menu leaves focus on its opener or on the body).
    if (e.key === "Escape" && layout.classList.contains(RAIL_OPEN) && !modalOpen(document)) {
      if (document.getElementById("wikiRailToggle")?.getClientRects().length) {
        closeRailPanel();
        document.getElementById("wikiRailToggle")?.focus({ preventScroll: true });
        e.preventDefault();
        return;
      }
    }
    const action = paneKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      repeat: e.repeat,
      targetTag: t?.tagName,
      targetEditable: !!t?.isContentEditable,
      // A menu's keys are the menu's: the rail's Group menu and the reader's
      // ⋯ popovers (`#wikiSeriesMenu`, `#wikiWorkPop`) are all `role="menu"`.
      targetInDialog: !!t?.closest?.("dialog, [role='dialog'], [role='menu']"),
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
