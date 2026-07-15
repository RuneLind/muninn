export { escHtml, escAttr } from "./escape.ts";
export { fmtTokens } from "../../../utils/fmt-tokens.ts";
export {
  TOOL_INPUT_PRIORITY_KEYS,
  TOOL_INPUT_MAX_LENGTH,
  extractToolInputLabel,
  TOOL_NAME_PREFIX_RE,
  normalizeToolName,
} from "./tool-helpers.ts";
export {
  summarizeSearchTrace,
  collectionsFor,
  COLLECTION_PRIORITY,
  sortCollectionsByPriority,
} from "./search-helpers.ts";
export {
  abbreviateCollection,
  deriveSpanLabelHtml,
} from "./span-label.ts";

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + "d ago";
  return new Date(ts).toLocaleDateString();
}

export function deadlineText(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = ts - Date.now();
  const days = Math.floor(diff / 86400000);
  if (days < 0) return Math.abs(days) + "d overdue";
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return "in " + days + "d";
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

/**
 * Format a run cost in USD for the `/agents` Recent table.
 * - `null`/`undefined` ⇒ `—` (unknown: direct-SDK Haiku backends, drains,
 *   extractor rows, externally-traced chat turns).
 * - An explicit `0` ⇒ `$0.00` — truthful for subscription connectors
 *   (copilot-sdk / openai-compat report a real `0`), and deliberately distinct
 *   from the unknown dash.
 * - Sub-cent positive costs keep 4 decimals so a real ~$0.003 run isn't
 *   flattened to `$0.00` and confused with a genuine zero.
 */
export function fmtCost(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  return fmtMs(ms);
}

interface ScheduleLike {
  scheduleIntervalMs?: number | null;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDays?: number[] | null;
}

export function formatSchedule(task: ScheduleLike): string {
  if (task.scheduleIntervalMs) {
    const mins = Math.round(task.scheduleIntervalMs / 60000);
    if (mins < 60) return "Every " + mins + "min";
    return "Every " + (mins / 60).toFixed(1) + "h";
  }
  const h = String(task.scheduleHour ?? 0).padStart(2, "0");
  const m = String(task.scheduleMinute ?? 0).padStart(2, "0");
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let days = "";
  if (task.scheduleDays && task.scheduleDays.length < 7) {
    days = " on " + task.scheduleDays.map((d) => dayNames[d] ?? String(d)).join(", ");
  }
  return h + ":" + m + days;
}
