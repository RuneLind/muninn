/// <reference lib="dom" />
/** Browser entrypoint: re-exports the inspector panel's pure helpers onto
 *  globalThis so the surrounding inline script (CHAT_SCRIPT in page.ts, plus the
 *  DOM-touching functions injected via inspectorPanelScript()) can call them by
 *  bare name — the SAME functions the server-side tests exercise, no hand-ported
 *  JS-string copies to keep in sync. */

import {
  aggregateToolCalls,
  fmtToolTime,
  fmtNum,
  computeContextUsage,
  fmtDuration,
  computeLastResponseRows,
  mergeDevRunEventsById,
  latestNoteForHandoff,
  devRunEventKindClass,
  devRunEventIcon,
} from "./inspector-panel.ts";

Object.assign(globalThis, {
  aggregateToolCalls,
  fmtToolTime,
  fmtNum,
  computeContextUsage,
  fmtDuration,
  computeLastResponseRows,
  mergeDevRunEventsById,
  latestNoteForHandoff,
  devRunEventKindClass,
  devRunEventIcon,
});
