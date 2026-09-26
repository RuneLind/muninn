/// <reference lib="dom" />
/**
 * Browser entry for the issue board (`/wiki/issues?wiki=`). Bundled by
 * `wiki-board-client.ts`. ONE fetch of `GET /api/wiki/graph` with the board's
 * opt-ins; everything else is `wiki-board-view.ts`. The filter lives in the
 * address bar (`show=`, `q=`), replaced rather than pushed.
 *
 * Rows render only once the graph call has answered: a filter or a keystroke
 * before that (still "Loading…") or after a failed load (the error) changes
 * the filter and the URL, never the table.
 */

import type { GraphPayload } from "../../../wiki/graph-types.ts";
import {
  boardFilterHtml,
  boardKpisHtml,
  boardNotes,
  boardRows,
  boardTableHtml,
  filterBoardRows,
  keylessTableHtml,
  parseBoardFilter,
  searchWithBoardFilter,
  type BoardFilter,
  type BoardRow,
  type BoardShow,
} from "./wiki-board-view.ts";
import { escHtml as esc } from "./escape.ts";

declare global {
  interface Window {
    __WIKI_BOARD__?: { wiki: string };
  }
}

const wiki = window.__WIKI_BOARD__?.wiki ?? "";
const $ = (id: string) => document.getElementById(id);
let filter: BoardFilter = parseBoardFilter(location.search);
/** Null until the graph call answered; stays null after a failed load. */
let rows: BoardRow[] | null = null;

function renderRows(): void {
  if (!rows) return;
  const shown = filterBoardRows(rows, filter, Date.now());
  $("boardTableWrap")!.innerHTML = boardTableHtml(shown, wiki);
  $("boardShown")!.textContent = shown.length === rows.length ? `${rows.length} keys` : `${shown.length} of ${rows.length} keys`;
}

/** Typing's URL write is debounced: Safari throws SecurityError past ~100
 *  `replaceState` calls in 30 s, and each keystroke would make one. */
const URL_WRITE_MS = 300;
let urlTimer: ReturnType<typeof setTimeout> | undefined;
function writeFilterToUrl(): void {
  clearTimeout(urlTimer);
  try {
    history.replaceState(history.state, "", location.pathname + searchWithBoardFilter(location.search, filter) + location.hash);
  } catch {
    /* The address bar lags the filter; the table does not. */
  }
}

/** Render first, then the URL — a throwing write can never skip the render. */
function setFilter(next: BoardFilter, debounce = false): void {
  filter = next;
  document.querySelectorAll<HTMLButtonElement>("[data-board-show]").forEach((b) => {
    const on = b.dataset.boardShow === filter.show;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  renderRows();
  if (!debounce) writeFilterToUrl();
  else {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(writeFilterToUrl, URL_WRITE_MS);
  }
}

async function load(): Promise<void> {
  const q = new URLSearchParams({ wiki, scope: "wiki", level: "1", depth: "0", keyless: "1", fields: "issue", ledger: "keys" });
  let p: GraphPayload;
  try {
    const res = await fetch(`/api/wiki/graph?${q}`);
    if (!res.ok) {
      // The status first: a proxy's HTML error page is not JSON.
      const body = await res.json().catch(() => null);
      throw new Error(`HTTP ${res.status}${typeof body?.error === "string" ? `: ${body.error}` : ""}`);
    }
    p = (await res.json()) as GraphPayload;
  } catch (err) {
    $("boardTableWrap")!.innerHTML = `<p class="board-note board-error">Could not load the board: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
    return;
  }
  rows = boardRows(p);
  const keyless = p.keylessPages ?? [];
  $("boardKpis")!.innerHTML = boardKpisHtml(rows, keyless.length, p.keylessTruncated === true);
  $("boardNotes")!.innerHTML = boardNotes(p).map((n) => `<p class="board-note" data-board-note>${esc(n)}</p>`).join("");
  $("boardKeylessWrap")!.innerHTML = keylessTableHtml(keyless, wiki);
  renderRows();
}

$("boardFilters")!.innerHTML = boardFilterHtml(filter);
$("boardFilters")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-board-show]");
  if (b) setFilter({ ...filter, show: b.dataset.boardShow as BoardShow });
});
$("boardQuery")!.addEventListener("input", (e) => setFilter({ ...filter, q: (e.target as HTMLInputElement).value }, true));
// A click on a row follows its graph link, unless it landed on a link of its
// own (the key, the tracker ↗, a plan) or the reader is selecting text. A
// modifier click (Cmd/Ctrl/Shift) or a middle click opens a new tab, as the
// key link itself would.
function followRow(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest("a")) return;
  if (window.getSelection()?.toString()) return;
  const href = target.closest<HTMLTableRowElement>("tr[data-graph-href]")?.dataset.graphHref;
  if (!href) return;
  if (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey) window.open(href, "_blank", "noopener");
  else if (e.button === 0) location.href = href;
}
$("boardTableWrap")!.addEventListener("click", followRow);
$("boardTableWrap")!.addEventListener("auxclick", (e) => {
  if (e.button === 1) followRow(e);
});
void load();
