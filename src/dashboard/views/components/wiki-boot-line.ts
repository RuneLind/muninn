/// <reference lib="dom" />
/**
 * The boot line on the Your work card (mimir plan «Drain the owner-step
 * queue», P1): one line from `GET /api/wiki/boot-line` naming the commit this
 * muninn started from and what moved in its checkout since. The line is
 * PROCESS-WIDE, not per wiki: one muninn, one checkout, so one state here
 * serves every wiki the reader shows.
 *
 * With `MUNINN_PEERS` and `MUNINN_MACHINE` set (P1b) the payload carries `machine` and `peers`: the
 * block then holds one row per machine, this one first and each prefixed with
 * its name, a restart row in the attention colour and a peer that gave no
 * answer muted. Without peers the block is the single line it always was.
 *
 * `wiki-start-cards.ts` calls {@link placeBootLine} after each card paint, and
 * {@link askBootLine} on each map load and on each return to the card from its
 * cached body; this module asks again when the tab becomes visible and once a
 * minute, both only while the tab is visible AND the card shows, so a restart
 * or a pull shows without a reload. The block goes in as the card's last
 * child, outside the HTML the card compares, so its landing never repaints the
 * card. A failed read shows no block and waits for the next ask like any other.
 */

import type { BootLine } from "../../../wiki/step-checks/boot-line.ts";
import { escHtml as esc } from "./escape.ts";

export const BOOT_LINE_URL = "/api/wiki/boot-line";
/** The periodic ask while the tab is visible. */
export const BOOT_LINE_EVERY_MS = 60_000;
/** A request still open past the route's own bound (`BOOT_LINE_BOUND_MS`, 15 s) is dead: abort it so later asks go out. */
export const BOOT_LINE_ABORT_MS = 20_000;

/** One machine's row in the block, as shown. */
export interface BootLineRowView {
  machine: string;
  text: string;
  restart: boolean;
  /** A peer that gave no answer. */
  muted: boolean;
  row: string | null;
  why: string | null;
}

export interface BootLineView {
  row: string;
  text: string;
  restart: boolean;
  /** Null without peers: the block is the single line. */
  rows: BootLineRowView[] | null;
}

let line: BootLineView | null = null;
let inFlight = false;
let installed = false;
let landed: () => void = () => {};
let showing: () => boolean = () => false;

/** The payload as the block shows it, or null when it is not a line. Exported for tests. */
export function bootLineView(body: unknown): BootLineView | null {
  const b = body as (Partial<BootLine> & { machine?: unknown; peers?: unknown }) | null;
  if (!b || typeof b.text !== "string" || typeof b.row !== "string") return null;
  const view: BootLineView = { row: b.row, text: b.text, restart: b.restart === true, rows: null };
  if (!Array.isArray(b.peers) || typeof b.machine !== "string") return view;
  const rows: BootLineRowView[] = [{ machine: b.machine, text: `${b.machine}: ${b.text}`, restart: view.restart, muted: false, row: b.row, why: null }];
  for (const raw of b.peers) {
    const p = raw as { machine?: unknown; answered?: unknown; text?: unknown; restart?: unknown; row?: unknown; why?: unknown } | null;
    if (!p || typeof p.machine !== "string") continue;
    if (p.answered === true && typeof p.text === "string" && typeof p.row === "string") {
      rows.push({ machine: p.machine, text: `${p.machine}: ${p.text}`, restart: p.restart === true, muted: false, row: p.row, why: null });
    } else {
      rows.push({ machine: p.machine, text: `${p.machine}: no answer`, restart: false, muted: true, row: null, why: typeof p.why === "string" ? p.why : null });
    }
  }
  return { ...view, rows };
}

/** What `bootLineChanged` compares besides the text: everything the block shows. A row's `why` is only its tooltip
 *  and alternates for one down peer between asks («timed out», «unreachable a moment ago»), so it is synced in place. */
const keyOf = (v: BootLineView) => (v.rows ? JSON.stringify(v.rows.map(({ why: _why, ...shown }) => shown)) : "");
const textOf = (v: BootLineView) => (v.rows ? v.rows.map((r) => r.text).join("") : v.text);
const outerRestart = (v: BootLineView) => !v.rows && v.restart;

const TITLE = "What this muninn started from, and what moved in its checkout since";

function rowHtml(r: BootLineRowView): string {
  const cls = `wiki-boot-row${r.restart ? " restart" : ""}${r.muted ? " muted" : ""}`;
  const row = r.row !== null ? ` data-boot-row="${esc(r.row)}"` : "";
  const title = r.why ? ` title="${esc(r.why)}"` : "";
  return `<div class="${cls}" data-boot-machine="${esc(r.machine)}"${row}${title}>${esc(r.text)}</div>`;
}

/** The block's markup for `view` (the current line when omitted). */
export function bootLineHtml(view: BootLineView | null = line): string {
  if (!view) return "";
  const key = keyOf(view);
  const inner = view.rows ? view.rows.map(rowHtml).join("") : esc(view.text);
  return `<div class="wiki-boot-line${outerRestart(view) ? " restart" : ""}" data-boot-row="${esc(view.row)}"${key ? ` data-boot-key="${esc(key)}"` : ""} title="${TITLE}">${inner}</div>`;
}

/** Each row's tooltip set to `view`'s reason, on the block in place (rows in the same order: the keys matched). */
function syncTitles(el: Element, view: BootLineView): void {
  if (!view.rows) return;
  const rows = el.querySelectorAll(":scope > .wiki-boot-row");
  view.rows.forEach((r, i) => {
    const row = rows[i];
    if (!row) return;
    if (r.why) {
      if (row.getAttribute("title") !== r.why) row.setAttribute("title", r.why);
    } else row.removeAttribute("title");
  });
}

/** Does `card` need {@link placeBootLine}? False when its last child already shows the current block: a re-insert
 *  would end a selection on it. Then a row's reason that alone changed is set on its `title` in place. */
export function bootLineChanged(card: Element | null, view: BootLineView | null = line): boolean {
  if (!card || typeof card.querySelector !== "function") return false;
  const el = card.querySelector(":scope > .wiki-boot-line");
  if (!view) return !!el;
  const changed =
    !el ||
    el !== card.lastElementChild ||
    el.getAttribute("data-boot-row") !== view.row ||
    (el.getAttribute("data-boot-key") ?? "") !== keyOf(view) ||
    el.textContent !== textOf(view) ||
    el.classList.contains("restart") !== outerRestart(view);
  if (!changed) syncTitles(el, view);
  return changed;
}

/** Puts the current block at the end of `card`, replacing the one there (none when there is no line). */
export function placeBootLine(card: Element | null): void {
  if (!card || typeof card.querySelector !== "function") return;
  card.querySelector(":scope > .wiki-boot-line")?.remove();
  const html = bootLineHtml();
  if (html) card.insertAdjacentHTML("beforeend", html);
}

function ask(): void {
  if (inFlight) return;
  inFlight = true;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), BOOT_LINE_ABORT_MS) : null;
  fetch(BOOT_LINE_URL, ctl ? { signal: ctl.signal } : {})
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      line = res.ok ? bootLineView(body) : null;
    })
    .catch(() => {
      line = null;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      inFlight = false;
      landed();
    });
}

/**
 * Asks for the line now; `onLanded` places it once it lands. The first call also starts the asks on a tab
 * becoming visible and once a minute, which go out only while the tab is visible and `isShowing` says the
 * card is on screen: each ask runs git on the server, and the caller asks again when the card comes back
 * (a map load, or a return to it from the cached body).
 */
export function askBootLine(onLanded: () => void, isShowing: () => boolean): void {
  landed = onLanded;
  showing = isShowing;
  ask();
  if (installed || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  installed = true;
  const maybeAsk = () => {
    if (document.visibilityState === "visible" && showing()) ask();
  };
  document.addEventListener("visibilitychange", maybeAsk);
  setInterval(maybeAsk, BOOT_LINE_EVERY_MS);
}
