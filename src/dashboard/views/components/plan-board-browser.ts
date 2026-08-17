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
  if (!payload || !root) return;
  mountPlanBoard(payload, root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
