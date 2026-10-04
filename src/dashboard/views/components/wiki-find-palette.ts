/**
 * The find palette's DOM half: open on `/` or ⌘K (Ctrl-K off a Mac), rank as
 * the reader types, open a row. Ranking is `wiki-find.ts`; markup and key
 * predicates are `wiki-find-view.ts`. The shell wires it with ONE call,
 * `initFindPalette(port)`.
 *
 * **The dialog root owns every key pressed inside it.** Its keydown handles the
 * palette's own keys and then stops propagation on EVERY keydown it receives,
 * so none of the reader's document-level shortcuts (`]`, `f`, `g`, `t`, the
 * pane ladder's Escape, the Tools menu's Escape) sees a key typed in the
 * palette. Native typing and activation are untouched. Capture-phase listeners
 * still run first: the graph card's Escape stands aside under `modalOpen`
 * (the palette is `aria-modal`), and the ref-link peek's is never armed,
 * because opening the palette hides any peek.
 *
 * Closing REMOVES the node — opacity or visibility would keep client rects
 * and leave `modalOpen` true — and returns focus to the opener. The shell also
 * closes it on Back/Forward. A page load does NOT close it: the boot's own
 * `?relPath=` load lands after a palette the reader opened while the listing
 * was still in flight, a fact-check reload or a boot heal can land under it
 * too, and every page load the reader starts from inside the palette closes
 * it first (`openRow`).
 *
 * During an IME composition the root still stops every key but acts on none:
 * Enter and Escape belong to the composition there.
 */

import { anchorNow, displayTitleOf, type WikiListing } from "./wiki-filter.ts";
import { applySeriesChip, rankFind, type FindResult } from "./wiki-find.ts";
import {
  FIND_CHIPS_ID,
  FIND_ID,
  FIND_INPUT_ID,
  FIND_LIST_ID,
  FIND_SCRIM_ID,
  findChipsHtml,
  findFailedHtml,
  findListHtml,
  findLoadingHtml,
  findPaletteHtml,
  findRowId,
  isFindToggleKey,
  isMacPlatform,
} from "./wiki-find-view.ts";
import { modalOpen, navMenuOpen, readerKeyEventOf, readerKeyRefused } from "./wiki-panes.ts";

/** What the palette needs from the shell. */
export interface FindPalettePort {
  /** The listing the rail holds. */
  getPages(): readonly WikiListing[];
  /** Has the first listing arrived — or did the boot request for it fail? */
  listingState(): FindListingState;
  /** The open page's `near` map, `{}` when no page is open. */
  getNear(): Record<string, number>;
  /** The listing's scan instant, for `anchorNow`. */
  getScannedAt(): number | null;
  /** Open a page in this tab. */
  openPage(relPath: string): void;
  /** The page's shareable URL (new-tab opens). */
  hrefFor(relPath: string): string;
  /** Called as the palette opens — hides any hover peek. */
  onOpen(): void;
}

export type FindListingState = "loading" | "ready" | "failed";

/** Debounce between a keystroke and a re-rank. */
export const FIND_DEBOUNCE_MS = 120;

let port: FindPalettePort | null = null;
let opener: HTMLElement | null = null;
let result: FindResult | null = null;
let active = 0;
/** The listing state the open palette last painted. */
let shownState: FindListingState = "loading";
let debounce: ReturnType<typeof setTimeout> | null = null;
const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform || navigator.userAgent || "");

export function isFindOpen(): boolean {
  return !!document.getElementById(FIND_SCRIM_ID);
}

function input(): HTMLInputElement | null {
  return document.getElementById(FIND_INPUT_ID) as HTMLInputElement | null;
}

function titleOf(relPath: string): string | undefined {
  const key = relPath.toLowerCase();
  const p = port?.getPages().find((x) => x.relPath.toLowerCase() === key);
  return p ? displayTitleOf(p) : undefined;
}

function render(): void {
  if (!port) return;
  const box = input();
  const list = document.getElementById(FIND_LIST_ID);
  const chips = document.getElementById(FIND_CHIPS_ID);
  if (!box || !list || !chips) return;
  const query = box.value;
  shownState = port.listingState();
  if (shownState !== "ready") {
    result = null;
    chips.innerHTML = "";
    list.innerHTML = shownState === "failed" ? findFailedHtml() : findLoadingHtml();
    box.removeAttribute("aria-activedescendant");
    return;
  }
  result = rankFind(port.getPages(), query, {
    near: port.getNear(),
    now: anchorNow(Date.now(), port.getScannedAt()),
  });
  if (active >= result.rows.length) active = 0;
  chips.innerHTML = query.trim() ? findChipsHtml(result) : "";
  list.innerHTML = findListHtml(result, query, active, port.hrefFor, titleOf);
  syncActive();
}

function syncActive(): void {
  const box = input();
  if (!box || !result) return;
  if (!result.rows.length) {
    box.removeAttribute("aria-activedescendant");
    return;
  }
  box.setAttribute("aria-activedescendant", findRowId(active));
  document.querySelectorAll<HTMLElement>(`#${FIND_LIST_ID} .wiki-find-row`).forEach((el, i) => {
    el.classList.toggle("active", i === active);
    el.setAttribute("aria-selected", String(i === active));
    if (i === active) el.scrollIntoView({ block: "nearest" });
  });
}

/** Rank a query change the debounce still holds, NOW, from the top row —
 *  so a key pressed inside the debounce acts on the fresh results. */
function flushPending(): void {
  if (!debounce) return;
  clearTimeout(debounce);
  debounce = null;
  active = 0;
  render();
}

/**
 * Repaint an open palette that is still showing "Loading" or the failure line
 * — the shell calls it whenever the listing arrives or its boot request fails.
 * A palette already showing rows is left alone: a background adoption (focus
 * refetch, heartbeat) would otherwise replace the rows and chips under a
 * Tab-focused one, dropping focus to `<body>`, where reader keys fire behind
 * the open dialog. Its rows re-rank over the new listing on the next keystroke.
 */
export function refreshFind(): void {
  if (isFindOpen() && shownState !== "ready") render();
}

function scheduleRender(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    active = 0;
    render();
  }, FIND_DEBOUNCE_MS);
}

function openRow(i: number, newTab: boolean): void {
  const row = result?.rows[i];
  if (!row || !port) return;
  if (newTab) {
    window.open(port.hrefFor(row.page.relPath), "_blank", "noopener");
    return;
  }
  const rel = row.page.relPath;
  closeFind(false);
  port.openPage(rel);
}

export function openFind(): void {
  if (!port || isFindOpen()) return;
  port.onOpen();
  const focused = document.activeElement;
  opener = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  const scrim = document.createElement("div");
  scrim.className = "wiki-find-scrim";
  scrim.id = FIND_SCRIM_ID;
  scrim.innerHTML = findPaletteHtml();
  document.body.appendChild(scrim);
  const root = document.getElementById(FIND_ID)!;
  root.addEventListener("keydown", onRootKeydown);
  root.addEventListener("click", onRootClick);
  root.querySelector(`#${FIND_INPUT_ID}`)!.addEventListener("input", scheduleRender);
  // Outside click: a press on the scrim itself, not on anything inside the dialog.
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) {
      e.preventDefault();
      closeFind(true);
    }
  });
  active = 0;
  result = null;
  render();
  input()!.focus();
}

/** Close and, unless a row is being opened, give focus back to the opener. */
export function closeFind(returnFocus = true): void {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  document.getElementById(FIND_SCRIM_ID)?.remove();
  result = null;
  const back = opener;
  opener = null;
  if (returnFocus && back && back.isConnected) back.focus();
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`#${FIND_INPUT_ID}, .wiki-find-chip, .wiki-find-row`),
  );
}

function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = focusables(root);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  const next = e.shiftKey
    ? at <= 0 ? items.length - 1 : at - 1
    : at === -1 || at === items.length - 1 ? 0 : at + 1;
  items[next]!.focus();
}

/** The dialog root's one keydown: the palette's keys, then stop EVERY key. */
function onRootKeydown(e: KeyboardEvent): void {
  const root = e.currentTarget as HTMLElement;
  const target = e.target as HTMLElement | null;
  const inInput = target?.id === FIND_INPUT_ID;
  // 229: Safari's keydown during a composition reports `isComposing` false.
  if (e.isComposing || e.keyCode === 229) {
    // the composition's key, not the palette's
  } else if (e.key === "Escape" || isFindToggleKey(e, mac)) {
    e.preventDefault();
    closeFind(true);
  } else if (e.key === "Tab") {
    trapTab(e, root);
  } else if (inInput && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    flushPending();
    const n = result?.rows.length ?? 0;
    if (n) {
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      syncActive();
    }
  } else if (inInput && e.key === "Enter") {
    e.preventDefault();
    flushPending();
    openRow(active, e.shiftKey);
  } else if (e.key === " " && target?.hasAttribute("data-find-row")) {
    // A link does not activate on Space; a row is an option, which does.
    e.preventDefault();
    openRow(Number(target.getAttribute("data-find-row")), false);
  }
  e.stopPropagation();
}

function onRootClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const chip = t.closest<HTMLElement>("[data-find-chip]");
  if (chip) {
    const box = input();
    if (!box) return;
    box.value = applySeriesChip(box.value, chip.getAttribute("data-find-chip") ?? "");
    active = 0;
    render();
    box.focus();
    return;
  }
  const row = t.closest<HTMLElement>("[data-find-row]");
  if (row) {
    // A modifier click or a middle click is the link's own; a plain one opens
    // in place without a page load.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openRow(Number(row.getAttribute("data-find-row")), false);
  }
}

/**
 * The opening listener, on the document in the bubble phase. `/` opens from
 * the page but types into a text field; ⌘K (Ctrl-K off a Mac) opens from
 * anywhere, a text field included. Both are refused while another dialog or
 * menu is open — the header's Tools menu included, which `modalOpen` cannot
 * see. Keys pressed inside the palette never reach here: its root stops them.
 */
function onDocumentKeydown(e: KeyboardEvent): void {
  if (isFindOpen() || navMenuOpen(document)) return;
  if (isFindToggleKey(e, mac)) {
    if (modalOpen(document)) return;
    e.preventDefault();
    openFind();
    return;
  }
  if (e.key !== "/" || readerKeyRefused(readerKeyEventOf(e))) return;
  e.preventDefault();
  openFind();
}

export function initFindPalette(p: FindPalettePort): void {
  port = p;
  document.addEventListener("keydown", onDocumentKeydown);
}
