/**
 * The /summaries doc panel's Latest rail: the pure logic.
 *
 * The rail lists the last 14 days of summaries under day headings, newest
 * first, with an unread dot per row. Everything here is dependency-free and
 * written as plain `export function` declarations, because the page has no
 * bundler: `sum-latest-rail.ts` injects each function into the page script
 * with `.toString()`. A function here may call only other functions in this
 * file, and every one of them is in `RAIL_FUNCTIONS` below.
 *
 * Two day notions, on purpose:
 * - A row's day is its stored `date`, a UTC calendar day. The reader's own
 *   "today" (local) only decides the labels and the 14-day window.
 * - The unread watermark is a UTC day, so it compares with `date` directly.
 *   `modifiedTime` is never read for unread state: a re-run or a backfill
 *   rewrites it and must not mark a row unread again.
 */

export interface RailDoc {
  id: string;
  source: string;
  date?: unknown;
  modifiedTime?: unknown;
  url?: unknown;
}

export interface RailDayGroup {
  day: string;
  docs: RailDoc[];
}

export interface RailWindow {
  days: RailDayGroup[];
  /** Dated rows older than the cutoff. */
  hidden: number;
  /** The newest day among the hidden rows, or null when none is hidden. */
  newestHidden: string | null;
}

export interface RailReadState {
  /** A UTC day: rows dated before it count as read. */
  watermark: string;
  /** `railKey` of every row the reader opened. */
  opened: string[];
}

export interface RailCategory {
  key: string;
  label: string;
  count: number;
}

/** The `YYYY-MM-DD` day a stored date names, or null for anything else. */
export function railDay(date: unknown): string | null {
  if (typeof date !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : null;
}

/** `day` moved by `n` calendar days. */
export function railAddDays(day: string, n: number): string {
  const p = day.split("-").map(Number);
  return new Date(Date.UTC(p[0]!, p[1]! - 1, p[2]! + n)).toISOString().slice(0, 10);
}

/** The UTC day of an instant — the watermark's unit. */
export function railUtcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The reader's local calendar day — what "Today" means in a heading. */
export function railLocalDay(now: Date): string {
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}

/** The first day of the default window: today and the 13 days before it. */
export function railInitialCutoff(today: string): string {
  return railAddDays(today, -13);
}

/** The cutoff after "Show older": the newest hidden day and the 13 before it,
 *  so every click reveals at least one day even across a gap. */
export function railNextCutoff(newestHidden: string): string {
  return railAddDays(newestHidden, -13);
}

/** `Today`, `Yesterday`, else `Fri 26 Sep` (with the year when it differs). */
export function railDayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === railAddDays(today, -1)) return "Yesterday";
  const p = day.split("-").map(Number);
  const dt = new Date(Date.UTC(p[0]!, p[1]! - 1, p[2]!));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = day.slice(0, 4) === today.slice(0, 4) ? "" : " " + p[0];
  return days[dt.getUTCDay()] + " " + p[2] + " " + months[p[1]! - 1] + year;
}

/** "ai/claude-code/Some Title.md" -> "Some Title". */
export function railTitle(id: string): string {
  const parts = id.split("/");
  return (parts[parts.length - 1] || id).replace(/\.md$/, "");
}

/** "ai/claude-code/Some Title.md" -> "ai/claude-code". */
export function railCategory(id: string): string {
  const parts = id.split("/");
  return parts.length >= 2 ? parts.slice(0, -1).join("/") : "uncategorized";
}

/** "ai/claude-code" -> "claude-code". */
export function railCategoryLabel(category: string): string {
  const parts = category.split("/");
  return parts[parts.length - 1] || category;
}

/** A row's identity: doc ids are collection-relative, so the source is part of it. */
export function railKey(doc: { id: string; source: string }): string {
  return doc.source + "|" + doc.id;
}

/**
 * Newest day first; within a day `modifiedTime` descending, then title. The
 * listing's `modifiedTime` values share one ISO shape with microseconds and
 * no offset, so they compare as strings — `Date.parse` would cut them to
 * milliseconds and tie rows that are not tied.
 */
export function railCompare(a: RailDoc, b: RailDoc): number {
  const da = railDay(a.date) || "";
  const db = railDay(b.date) || "";
  if (da !== db) return da < db ? 1 : -1;
  const ma = typeof a.modifiedTime === "string" ? a.modifiedTime : "";
  const mb = typeof b.modifiedTime === "string" ? b.modifiedTime : "";
  if (ma !== mb) return ma < mb ? 1 : -1;
  const t = railTitle(a.id).localeCompare(railTitle(b.id));
  if (t !== 0) return t;
  const ka = railKey(a);
  const kb = railKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Sorted day groups for every dated row on or after `cutoff`. Undated rows
 *  have no day, so the rail leaves them out. */
export function railGroup(docs: RailDoc[], cutoff: string): RailWindow {
  const dated = docs.filter((d) => railDay(d.date) !== null).slice().sort(railCompare);
  const days: RailDayGroup[] = [];
  let hidden = 0;
  let newestHidden: string | null = null;
  for (const doc of dated) {
    const day = railDay(doc.date)!;
    if (day < cutoff) {
      hidden++;
      if (newestHidden === null) newestHidden = day;
      continue;
    }
    const last = days[days.length - 1];
    if (last && last.day === day) last.docs.push(doc);
    else days.push({ day, docs: [doc] });
  }
  return { days, hidden, newestHidden };
}

/** The `n` categories with the most dated rows on or after `since`. A label
 *  two categories share (`ai/tools`, `life/tools`) shows the full path. */
export function railBusiestCategories(docs: RailDoc[], since: string, n: number): RailCategory[] {
  const counts: Record<string, number> = {};
  for (const doc of docs) {
    const day = railDay(doc.date);
    if (day === null || day < since) continue;
    const cat = railCategory(doc.id);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  const top = Object.keys(counts)
    .sort((a, b) => counts[b]! - counts[a]! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, n);
  const labels: Record<string, number> = {};
  for (const key of top) {
    const label = railCategoryLabel(key);
    labels[label] = (labels[label] || 0) + 1;
  }
  return top.map((key) => {
    const label = railCategoryLabel(key);
    return { key, label: labels[label]! > 1 ? key : label, count: counts[key]! };
  });
}

/** True when the row is dated on or after the watermark and was never opened.
 *  No state (storage failed) means every row reads as read. */
export function railIsUnread(state: RailReadState | null, doc: RailDoc): boolean {
  if (!state) return false;
  const day = railDay(doc.date);
  if (day === null || day < state.watermark) return false;
  return state.opened.indexOf(railKey(doc)) === -1;
}

/**
 * The rows the rail shows under a filter. `chip` is `all`, `unread`, or
 * `cat:<category path>`; `query` matches the title or the category path,
 * case-insensitively.
 */
export function railFilter(
  docs: RailDoc[],
  query: string,
  chip: string,
  state: RailReadState | null,
): RailDoc[] {
  const q = query.trim().toLowerCase();
  return docs.filter((doc) => {
    if (chip === "unread" && !railIsUnread(state, doc)) return false;
    if (chip.indexOf("cat:") === 0 && railCategory(doc.id) !== chip.slice(4)) return false;
    if (q && (railTitle(doc.id) + " " + railCategory(doc.id)).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}

/** A stored read state, or null when `raw` is not one. */
export function railReadStateParse(raw: unknown): RailReadState | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { watermark?: unknown; opened?: unknown };
  if (typeof o.watermark !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.watermark)) return null;
  if (!Array.isArray(o.opened)) return null;
  return { watermark: o.watermark, opened: o.opened.filter((k): k is string => typeof k === "string") };
}

/**
 * The state for a page load. No stored value (a first visit) or an unreadable
 * one starts over with today's UTC day as the watermark, and `write` carries
 * the value to store; a valid stored value is kept as is (`write` null).
 */
export function railReadStateInit(
  raw: string | null,
  todayUtc: string,
): { state: RailReadState; write: string | null } {
  const parsed = railReadStateParse(raw);
  if (parsed) return { state: parsed, write: null };
  const state = { watermark: todayUtc, opened: [] as string[] };
  return { state, write: JSON.stringify(state) };
}

/** The state with `key` marked opened. */
export function railMarkOpened(state: RailReadState, key: string): RailReadState {
  if (state.opened.indexOf(key) !== -1) return state;
  return { watermark: state.watermark, opened: state.opened.concat([key]) };
}

/**
 * Drops opened keys that no longer matter: a row the listing no longer has
 * (deleted), or one dated before the watermark (read anyway). Pass the FULL
 * listing, never a filtered one, and never an empty one — an empty listing is
 * a failed load, not a deleted archive.
 */
export function railPrune(state: RailReadState, docs: RailDoc[]): RailReadState {
  if (docs.length === 0) return state;
  const days: Record<string, string> = {};
  for (const doc of docs) days[railKey(doc)] = railDay(doc.date) || "";
  const opened = state.opened.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(days, key)) return false;
    const day = days[key];
    return !day || day >= state.watermark;
  });
  return opened.length === state.opened.length ? state : { watermark: state.watermark, opened };
}

export interface RailKeyContext {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** The doc panel is open. */
  panelOpen: boolean;
  /** Focus is in an input, textarea, select or contenteditable element. */
  editing: boolean;
  /** A dialog is open over the panel (share dialog, prompt modal, <dialog>). */
  dialogOpen: boolean;
  /** A `role="menu"` popup is open. */
  menuOpen: boolean;
}

/** `next` for `j`, `prev` for `k`, null when the key is not the rail's. */
export function railKeyAction(ctx: RailKeyContext): "next" | "prev" | null {
  if (ctx.key !== "j" && ctx.key !== "k") return null;
  if (ctx.altKey || ctx.ctrlKey || ctx.metaKey) return null;
  if (!ctx.panelOpen || ctx.editing || ctx.dialogOpen || ctx.menuOpen) return null;
  return ctx.key === "j" ? "next" : "prev";
}

/**
 * The row index a step lands on, or -1 for no move. With no current row, `j`
 * goes to the first row and `k` to the last; at either end the step stops
 * rather than wraps.
 */
export function railStep(count: number, current: number, action: "next" | "prev"): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return action === "next" ? 0 : count - 1;
  const next = action === "next" ? current + 1 : current - 1;
  return next < 0 || next >= count ? -1 : next;
}

/** Every function the page script needs, in dependency order. The injection
 *  and its guard test both read this list. */
export const RAIL_FUNCTIONS = [
  railDay,
  railAddDays,
  railUtcDay,
  railLocalDay,
  railInitialCutoff,
  railNextCutoff,
  railDayLabel,
  railTitle,
  railCategory,
  railCategoryLabel,
  railKey,
  railCompare,
  railGroup,
  railBusiestCategories,
  railIsUnread,
  railFilter,
  railReadStateParse,
  railReadStateInit,
  railMarkOpened,
  railPrune,
  railKeyAction,
  railStep,
] as const;
