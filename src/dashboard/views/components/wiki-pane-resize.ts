/// <reference lib="dom" />
/**
 * The drag handle on the /wiki right pane's left edge, a copy of the rail's
 * (`wiki-rail-resize.ts`) with the two fixes its header records built in: the
 * applied width is bounded at boot, on every drag step, on window resize and
 * when the rail's width changes (`effectivePaneWidth`; the stored value is not
 * touched), and a drag ends on `lostpointercapture` too. Pointer events on
 * `#wikiPaneResizer` set `--wiki-pane-w` on `.wiki-layout` (the grid's last
 * column reads it) and persist it; a double-click, or Home on the focused
 * handle, clears both; ArrowLeft widens and ArrowRight narrows (the handle is on
 * the pane's left). Collapsed (`.right-collapsed`), the strip's column ignores
 * the variable and the CSS hides the handle; in focus mode and under 1100px the
 * pane is not drawn at all.
 */
import {
  PANE_WIDTH_KEY,
  PANE_WIDTH_KEY_STEP,
  clampPaneWidth,
  effectivePaneWidth,
  nextStoredWidth,
  paneWidthFromPointer,
  parseStoredPaneWidth,
} from "./wiki-pane-width.ts";

const VAR = "--wiki-pane-w";

function readStored(): number | null {
  try {
    return parseStoredPaneWidth(localStorage.getItem(PANE_WIDTH_KEY));
  } catch {
    return null;
  }
}

function persist(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(PANE_WIDTH_KEY);
    else localStorage.setItem(PANE_WIDTH_KEY, String(width));
  } catch {
    /* best-effort */
  }
}

export function initPaneResize(): void {
  const layout = document.querySelector<HTMLElement>(".wiki-layout");
  const handle = document.getElementById("wikiPaneResizer");
  const pane = handle?.parentElement;
  const rail = layout?.querySelector<HTMLElement>(":scope > .wiki-pane:first-child");
  if (!layout || !handle || !pane) return;

  /** The width the reader chose (stored or mid-drag); null ⇒ the CSS default. */
  let chosen: number | null = readStored();

  const railWidth = (): number => (rail ? rail.getBoundingClientRect().width : 0);
  const apply = (): void => {
    if (chosen === null) layout.style.removeProperty(VAR);
    else layout.style.setProperty(VAR, effectivePaneWidth(chosen, window.innerWidth, railWidth()) + "px");
  };
  const set = (width: number | null): void => {
    chosen = width;
    apply();
    persist(width);
  };
  apply();
  window.addEventListener("resize", apply);
  // A rail drag changes what the pane may take; the pane's own width changes
  // nothing the bound reads, so this cannot loop.
  if (rail && typeof ResizeObserver !== "undefined") new ResizeObserver(apply).observe(rail);

  let dragging = false;
  let dragWidth: number | null = null;
  /** Judged against the state at the START of the gesture (the rail's measured
   *  overshoot trap: fed its running result, a drag stored its maximum). */
  let dragStartStored: number | null = null;
  let dragStartShown = 0;

  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("wiki-rail-dragging");
    if (dragWidth !== null) set(dragWidth);
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    dragging = true;
    dragWidth = null;
    dragStartStored = chosen;
    dragStartShown = Math.round(pane.getBoundingClientRect().width);
    handle.classList.add("dragging");
    document.body.classList.add("wiki-rail-dragging");
    handle.focus({ preventScroll: true });
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging || !(e.buttons & 1)) return;
    const requested = paneWidthFromPointer(e.clientX, pane.getBoundingClientRect().right);
    dragWidth = nextStoredWidth(dragStartStored, dragStartShown, requested);
    chosen = dragWidth;
    apply();
  });
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("lostpointercapture", end);
  handle.addEventListener("dblclick", () => set(null));

  handle.addEventListener("keydown", (e) => {
    // Step from what is SHOWN, as the rail does.
    const shown = Math.round(pane.getBoundingClientRect().width);
    const step = (d: number): void => set(nextStoredWidth(chosen, shown, clampPaneWidth(shown + d)));
    if (e.key === "ArrowLeft") step(PANE_WIDTH_KEY_STEP);
    else if (e.key === "ArrowRight") step(-PANE_WIDTH_KEY_STEP);
    else if (e.key === "Home") set(null);
    else return;
    e.preventDefault();
  });
}
