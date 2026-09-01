/// <reference lib="dom" />
/**
 * The drag handle on the /wiki page rail. Pointer events on `#wikiRailResizer`
 * set `--wiki-rail-w` on `.wiki-layout` (the grid's first column reads it) and
 * persist the result; a double-click, or Home on the focused handle, clears the
 * stored width and the variable so the CSS default comes back; arrow keys move
 * it by `RAIL_WIDTH_KEY_STEP`. The rules are in `wiki-rail-width.ts`.
 *
 * Two things the first cut got wrong, both caught in review: the applied width
 * is bounded by the viewport (`effectiveRailWidth`) at boot, on every drag step
 * and on window resize — the STORED value is not touched; and a drag ends on
 * `lostpointercapture` too. A right-click's context-menu gesture drops the
 * capture, so the handle never sees the pointerup, and without this the body kept
 * `user-select: none` + col-resize until a reload while every later hover over the
 * handle resized the rail with no button held.
 *
 * Storage is best-effort: a private window or a blocked-storage browser leaves
 * the drag working for the session and forgets it on reload, which is the same
 * behaviour the Ask-session persistence in `wiki-browser.ts` settles for.
 */
import {
  RAIL_WIDTH_KEY,
  RAIL_WIDTH_KEY_STEP,
  clampRailWidth,
  effectiveRailWidth,
  nextStoredWidth,
  parseStoredRailWidth,
  railWidthFromPointer,
} from "./wiki-rail-width.ts";

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

export function initRailResize(): void {
  const layout = document.querySelector<HTMLElement>(".wiki-layout");
  const handle = document.getElementById("wikiRailResizer");
  const rail = handle?.parentElement;
  if (!layout || !handle || !rail) return;

  /** The width the reader chose (stored or mid-drag); null ⇒ the CSS default. */
  let chosen: number | null = readStored();

  const apply = (): void => {
    if (chosen === null) layout.style.removeProperty(VAR);
    else layout.style.setProperty(VAR, effectiveRailWidth(chosen, window.innerWidth) + "px");
  };
  const set = (width: number | null): void => {
    chosen = width;
    apply();
    persist(width);
  };
  apply();
  window.addEventListener("resize", apply);

  let dragging = false;
  let dragWidth: number | null = null;
  /** The rule is judged against the state at the START of the gesture. Fed its
   *  own running result, a drag that overshot the bound and came back stored the
   *  maximum the pointer ever reached (measured: out to 500, back to 330, stored
   *  500) — the shown width pins at the bound, so once past it every move was a
   *  "grow" over the previous move. */
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
      return; // a pointer that is no longer active — no drag
    }
    dragging = true;
    dragWidth = null;
    dragStartStored = chosen;
    dragStartShown = Math.round(rail.getBoundingClientRect().width);
    handle.classList.add("dragging");
    document.body.classList.add("wiki-rail-dragging");
    // preventDefault (keeps the selection from starting) also suppresses the
    // click's focus, which made the arrow keys reachable only by tabbing.
    handle.focus({ preventScroll: true });
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    // `buttons`: a move with no button held is a SECOND, uncaptured pointer (a
    // mouse hovering while a pen drags) — never a drag step. The same pointer
    // after a lost capture is already stopped by `!dragging`.
    if (!dragging || !(e.buttons & 1)) return;
    // The pointer asks for a width; what gets remembered follows the same rule
    // as the arrow keys (`nextStoredWidth`), judged against what is on screen.
    const requested = railWidthFromPointer(e.clientX, rail.getBoundingClientRect().left);
    dragWidth = nextStoredWidth(dragStartStored, dragStartShown, requested);
    chosen = dragWidth;
    apply();
  });
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("lostpointercapture", end);
  handle.addEventListener("dblclick", () => set(null));

  handle.addEventListener("keydown", (e) => {
    // Step from what is SHOWN: stepping the stored value moved nothing press
    // after press in a window where the bound had it at 315, while rewriting
    // the stored value. Below 1100px the CSS default is 260, so the shown width
    // is also the only base that is right there.
    const shown = Math.round(rail.getBoundingClientRect().width);
    const step = (d: number): void =>
      set(nextStoredWidth(chosen, shown, clampRailWidth(shown + d)));
    if (e.key === "ArrowRight") step(RAIL_WIDTH_KEY_STEP);
    else if (e.key === "ArrowLeft") step(-RAIL_WIDTH_KEY_STEP);
    else if (e.key === "Home") set(null);
    else return;
    e.preventDefault();
  });
}
