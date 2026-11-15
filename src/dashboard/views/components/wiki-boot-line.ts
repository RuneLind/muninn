/// <reference lib="dom" />
/**
 * The boot line on the Your work card (mimir plan «Drain the owner-step
 * queue», P1): one line from `GET /api/wiki/boot-line` naming the commit this
 * muninn started from and what moved in its checkout since. The line is
 * PROCESS-WIDE, not per wiki: one muninn, one checkout, so one state here
 * serves every wiki the reader shows.
 *
 * `wiki-start-cards.ts` calls {@link placeBootLine} after each card paint, and
 * {@link askBootLine} on each map load and on each return to the card from its
 * cached body; this module asks again when the tab becomes visible and once a
 * minute, both only while the card shows, so a restart or a pull shows without
 * a reload. The line goes in as the card's last child, outside the HTML the
 * card compares, so its landing never repaints the card. A failed read shows
 * no line and waits for the next ask like any other.
 */

import type { BootLine } from "../../../wiki/step-checks/boot-line.ts";
import { escHtml as esc } from "./escape.ts";

export const BOOT_LINE_URL = "/api/wiki/boot-line";
/** The periodic ask while the tab is visible. */
export const BOOT_LINE_EVERY_MS = 60_000;
/** A request still open past the route's own bound (`BOOT_LINE_BOUND_MS`, 15 s) is dead: abort it so later asks go out. */
export const BOOT_LINE_ABORT_MS = 20_000;

let line: Pick<BootLine, "row" | "text" | "restart"> | null = null;
let inFlight = false;
let installed = false;
let landed: () => void = () => {};
let showing: () => boolean = () => false;

export function bootLineHtml(): string {
  if (!line) return "";
  return `<div class="wiki-boot-line${line.restart ? " restart" : ""}" data-boot-row="${esc(line.row)}" title="What this muninn started from, and what moved in its checkout since">${esc(line.text)}</div>`;
}

/** Does `card` need {@link placeBootLine}? False when its last child already is the current line: a re-insert would end a selection on it. */
export function bootLineChanged(card: Element | null): boolean {
  if (!card || typeof card.querySelector !== "function") return false;
  const el = card.querySelector(":scope > .wiki-boot-line");
  if (!line) return !!el;
  return !el || el !== card.lastElementChild || el.getAttribute("data-boot-row") !== line.row || el.textContent !== line.text || el.classList.contains("restart") !== line.restart;
}

/** Puts the current line at the end of `card`, replacing the one there (none when there is no line). */
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
      const body = (await res.json().catch(() => null)) as Partial<BootLine> | null;
      line = res.ok && body && typeof body.text === "string" && typeof body.row === "string" ? { row: body.row, text: body.text, restart: body.restart === true } : null;
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
 * Asks for the line now; `onLanded` places it once it lands. The first call also starts the visible-tab asks,
 * which go out only while `isShowing` says the card is on screen: each ask runs git on the server, and the
 * caller asks again when the card comes back (a map load, or a return to it from the cached body).
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
