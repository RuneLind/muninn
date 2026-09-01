/// <reference lib="dom" />
/**
 * The drag handle on the /wiki page rail. Pointer events on `#wikiRailResizer`
 * set `--wiki-rail-w` on `.wiki-layout` (the grid's first column reads it) and
 * persist the result; a double-click clears the stored width and the variable,
 * so the CSS default is what comes back. The rules are in `wiki-rail-width.ts`.
 *
 * Storage is best-effort: a private window or a blocked-storage browser leaves
 * the drag working for the session and forgets it on reload, which is the same
 * behaviour the Ask-session persistence in `wiki-browser.ts` settles for.
 */
import { RAIL_WIDTH_KEY, parseStoredRailWidth, railWidthFromPointer } from "./wiki-rail-width.ts";

const VAR = "--wiki-rail-w";

function readStored(): number | null {
  try {
    return parseStoredRailWidth(localStorage.getItem(RAIL_WIDTH_KEY));
  } catch {
    return null;
  }
}

function persist(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(RAIL_WIDTH_KEY);
    else localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    /* best-effort */
  }
}

function apply(layout: HTMLElement, width: number | null): void {
  if (width === null) layout.style.removeProperty(VAR);
  else layout.style.setProperty(VAR, width + "px");
}

export function initRailResize(): void {
  const layout = document.querySelector<HTMLElement>(".wiki-layout");
  const handle = document.getElementById("wikiRailResizer");
  const rail = handle?.parentElement;
  if (!layout || !handle || !rail) return;

  apply(layout, readStored());

  let dragging = false;
  let last: number | null = null;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("wiki-rail-dragging");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // Measured from the RAIL's left edge, not the layout's: the layout carries
    // 24px of padding, and measuring from it made every drag land ~24px wider
    // than the pointer (caught by the e2e spec, not by the unit tests).
    last = railWidthFromPointer(e.clientX, rail.getBoundingClientRect().left);
    apply(layout, last);
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("wiki-rail-dragging");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (last !== null) persist(last);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => {
    last = null;
    apply(layout, null);
    persist(null);
  });
}
