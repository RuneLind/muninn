/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for `/plans`. Reads the payload the page embedded as
 * `window.PLAN_BOARD` and mounts the board — no fetch on load: the server
 * already assembled exactly this object for the HTML it sent, and a second
 * round-trip would render the page twice with two different `generatedAt`s.
 *
 * `GET /api/plans/board` serves the same object for a later refresh.
 */

import { mountPlanBoard } from "./plan-board.ts";
import type { BoardPayload } from "../../../plans/board.ts";

function start(): void {
  const payload = (globalThis as { PLAN_BOARD?: BoardPayload }).PLAN_BOARD;
  const root = document.getElementById("pbRoot");
  if (!root) return;
  if (!payload) {
    // A silent return here is a blank page with no explanation — the exact
    // state where the reader most needs to be told where the data lives. The
    // server-rendered banners above are still on screen; this replaces only
    // the board area.
    const board = document.getElementById("pbBoard") ?? root;
    board.textContent = "";
    const note = document.createElement("p");
    note.className = "pb-empty";
    note.textContent =
      "The board payload did not arrive — nothing embedded this page's data. The same object is served by GET /api/plans/board.";
    board.append(note);
    return;
  }
  mountPlanBoard(payload, root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
