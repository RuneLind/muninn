/// <reference lib="dom" />
/** Browser entrypoint: re-exports the canonical TS helpers onto globalThis
 *  so the dashboard pages' inline `<script>` IIFEs can call them by bare name. */

import { escHtml, escAttr } from "./escape.ts";
import { extractToolInputLabel } from "./tool-helpers.ts";
import { deriveSpanLabelHtml } from "./span-label.ts";
import { summarizeSearchTrace } from "./search-helpers.ts";
import {
  formatTime,
  timeAgo,
  deadlineText,
  fmtMs,
  fmtTokens,
  formatSchedule,
} from "./helpers.ts";

Object.assign(globalThis, {
  esc: escHtml,
  escapeHtml: escHtml,
  escapeAttr: escAttr,
  toolInputLabel: extractToolInputLabel,
  deriveSpanLabelHtml,
  summarizeSearchTrace,
  formatTime,
  timeAgo,
  deadlineText,
  fmtMs,
  fmtTokens,
  formatSchedule,
});
