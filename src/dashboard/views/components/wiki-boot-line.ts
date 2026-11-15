/// <reference lib="dom" />
/**
 * The boot line on the Your work card (mimir plan «Drain the owner-step
 * queue», P1): one muted line from `GET /api/wiki/boot-line`, naming the
 * commit muninn started from and what moved since. Imported by
 * `wiki-start-cards.ts`, which calls {@link placeBootLine} after each card
 * paint and {@link loadBootLine} when the card's map loads. The line is placed
 * as the card's last child, outside the card's compared HTML, so its landing
 * never repaints the card. A failed load shows nothing.
 */

import type { BootLine } from "../../../wiki/step-checks/boot-line.ts";
import { escHtml as esc } from "./escape.ts";

export const BOOT_LINE_URL = "/api/wiki/boot-line";
/** The route caches 30 s; asking more often than this reads the same answer. */
const REASK_MS = 30_000;

let line: Pick<BootLine, "row" | "text"> | null = null;
let fetchedAt = 0;
let inFlight = false;

export function bootLineHtml(): string {
  if (!line) return "";
  return `<div class="wiki-boot-line" data-boot-row="${esc(line.row)}" title="What this muninn started from, and what moved in its checkout since">${esc(line.text)}</div>`;
}

/** Puts the current line at the end of `card`, replacing the one there (none when there is no line). */
export function placeBootLine(card: Element | null): void {
  if (!card || typeof card.querySelector !== "function") return;
  card.querySelector(":scope > .wiki-boot-line")?.remove();
  const html = bootLineHtml();
  if (html) card.insertAdjacentHTML("beforeend", html);
}

/** Fetches the line unless one was fetched within {@link REASK_MS}; `landed` runs once it lands. */
export function loadBootLine(landed: () => void): void {
  if (inFlight || (line && Date.now() - fetchedAt < REASK_MS)) return;
  inFlight = true;
  fetch(BOOT_LINE_URL)
    .then(async (res) => {
      const body = (await res.json().catch(() => null)) as Partial<BootLine> | null;
      line = res.ok && body && typeof body.text === "string" && typeof body.row === "string" ? { row: body.row, text: body.text } : null;
    })
    .catch(() => {
      line = null;
    })
    .finally(() => {
      inFlight = false;
      fetchedAt = Date.now();
      landed();
    });
}
