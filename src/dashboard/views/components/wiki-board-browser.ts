/// <reference lib="dom" />
/**
 * Browser entry for the issue board (`/wiki/issues?wiki=`). Bundled by
 * `wiki-board-client.ts`. ONE fetch of `GET /api/wiki/graph` with the board's
 * opt-ins; everything else is `wiki-board-view.ts`. The filter lives in the
 * address bar (`show=`, `q=`), replaced rather than pushed.
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
let rows: BoardRow[] = [];

function renderRows(): void {
  const shown = filterBoardRows(rows, filter, Date.now());
  $("boardTableWrap")!.innerHTML = boardTableHtml(shown, wiki);
  $("boardShown")!.textContent = shown.length === rows.length ? `${rows.length} keys` : `${shown.length} of ${rows.length} keys`;
}

function setFilter(next: BoardFilter): void {
  filter = next;
  history.replaceState(history.state, "", location.pathname + searchWithBoardFilter(location.search, filter));
  document.querySelectorAll<HTMLButtonElement>("[data-board-show]").forEach((b) => {
    const on = b.dataset.boardShow === filter.show;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  renderRows();
}

async function load(): Promise<void> {
  const q = new URLSearchParams({ wiki, scope: "wiki", level: "1", depth: "0", keyless: "1", fields: "issue", ledger: "keys" });
  let p: GraphPayload;
  try {
    const res = await fetch(`/api/wiki/graph?${q}`);
    const body = await res.json();
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
    p = body as GraphPayload;
  } catch (err) {
    $("boardTableWrap")!.innerHTML = `<p class="board-note board-error">Could not load the board: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
    return;
  }
  rows = boardRows(p);
  const keyless = p.keylessPages ?? [];
  $("boardKpis")!.innerHTML = boardKpisHtml(rows, keyless.length);
  $("boardNotes")!.innerHTML = boardNotes(p).map((n) => `<p class="board-note" data-board-note>${esc(n)}</p>`).join("");
  $("boardKeylessWrap")!.innerHTML = keylessTableHtml(keyless, wiki);
  renderRows();
}

$("boardFilters")!.innerHTML = boardFilterHtml(filter);
$("boardFilters")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-board-show]");
  if (b) setFilter({ ...filter, show: b.dataset.boardShow as BoardShow });
});
$("boardQuery")!.addEventListener("input", (e) => setFilter({ ...filter, q: (e.target as HTMLInputElement).value }));
// A click on a row follows its graph link, unless it landed on a link of its
// own (the key, the tracker ↗, a plan) or the reader is selecting text.
$("boardTableWrap")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("a")) return;
  if (window.getSelection()?.toString()) return;
  const tr = target.closest<HTMLTableRowElement>("tr[data-graph-href]");
  if (tr?.dataset.graphHref) location.href = tr.dataset.graphHref;
});
void load();
