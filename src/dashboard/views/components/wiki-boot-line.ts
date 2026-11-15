/// <reference lib="dom" />
/**
 * The boot line on the Your work card (mimir plan «Drain the owner-step
 * queue», P1): one line from `GET /api/wiki/boot-line` naming the commit this
 * muninn started from and what moved in its checkout since. The line is
 * PROCESS-WIDE, not per wiki: one muninn, one checkout, so one state here
 * serves every wiki the reader shows.
 *
 * `wiki-start-cards.ts` calls {@link placeBootLine} after each card paint and
 * {@link askBootLine} on each map load; this module asks again when the tab
 * becomes visible and once a minute while it is, so a restart or a pull shows
 * without a reload. The line goes in as the card's last child, outside the
 * HTML the card compares, so its landing never repaints the card. A failed
 * read shows no line and waits for the next ask like any other.
 */

import type { BootLine } from "../../../wiki/step-checks/boot-line.ts";
import { escHtml as esc } from "./escape.ts";

export const BOOT_LINE_URL = "/api/wiki/boot-line";
/** The periodic ask while the tab is visible. */
export const BOOT_LINE_EVERY_MS = 60_000;

let line: Pick<BootLine, "row" | "text" | "restart"> | null = null;
let inFlight = false;
let installed = false;
let landed: () => void = () => {};

export function bootLineHtml(): string {
  if (!line) return "";
  return `<div class="wiki-boot-line${line.restart ? " restart" : ""}" data-boot-row="${esc(line.row)}" title="What this muninn started from, and what moved in its checkout since">${esc(line.text)}</div>`;
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
  fetch(BOOT_LINE_URL)
    .then(async (res) => {
      const body = (await res.json().catch(() => null)) as Partial<BootLine> | null;
      line = res.ok && body && typeof body.text === "string" && typeof body.row === "string" ? { row: body.row, text: body.text, restart: body.restart === true } : null;
    })
    .catch(() => {
      line = null;
    })
    .finally(() => {
      inFlight = false;
      landed();
    });
}

/** Asks for the line now; `onLanded` places it once it lands. The first call also starts the visible-tab asks. */
export function askBootLine(onLanded: () => void): void {
  landed = onLanded;
  ask();
  if (installed || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ask();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") ask();
  }, BOOT_LINE_EVERY_MS);
}
