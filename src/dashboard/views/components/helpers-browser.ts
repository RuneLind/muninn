/// <reference lib="dom" />
/**
 * Browser entrypoint for the dashboard inline helpers. Bundled by
 * Bun.build() (see helpers-client.ts) and injected as an IIFE into the
 * dashboard pages that previously inlined helpersScript().
 *
 * The TS impls below are re-exported as-is from their canonical modules so
 * the browser runs the SAME code the test suite covers — replacing the
 * hand-maintained JS string twins that used to live in helpersScript() /
 * deriveSpanLabelScript() / toolInputLabelScript().
 *
 * Names attached to globalThis are the ones callers already use (esc,
 * escapeHtml, escapeAttr, toolInputLabel, deriveSpanLabelHtml, etc.).
 */

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
