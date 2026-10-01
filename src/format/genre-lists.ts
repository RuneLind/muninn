/**
 * The grammars of the four list-wrapper blocks (`Tldr`, `Timeline`,
 * `DecisionLog`, `RunChecklist`). Wiki-only, like `Historic`: not in
 * `COMPONENT_VOCABULARY_RULES`. Pure and dependency-light, so the formatters,
 * the chat bundle and the unit tests share one reading.
 *
 * Every grammar is an enumerated table of accepted shapes, not a tokenizer:
 * anything outside the table reads as plain text.
 */
import { isCalendarDay } from "./calendar-day.ts";
import type { ChecklistList, ChecklistRow } from "./markdown-ast.ts";

/** The separator after a leading date or id. The tail after the token must be
 *  one of: nothing; `:` (spaces allowed before it); spaces, then `—`, `–` or
 *  `-`, then spaces or the end; spaces, then text. Anything else (`x`, `,`,
 *  `.` right after the token) is not a match. Returns the text after it. */
function afterSeparator(tail: string): string | null {
  if (tail === "") return "";
  const m = /^(?:[ \t]*:|[ \t]+[—–-](?=[ \t]|$)|(?=[ \t]))[ \t]*([\s\S]*)$/.exec(tail);
  return m ? m[1]! : null;
}

// ── Timeline ────────────────────────────────────────────────────────────────

/** The date shapes a Timeline item may start with, each optionally wrapped in
 *  one `**…**`. Day-first dates are `DD.MM.YYYY` with the year. */
const TIMELINE_DATE_RES: readonly RegExp[] = [
  /^\*\*(\d{4}-\d{2}-\d{2})\*\*/,
  /^\*\*(\d{2}\.\d{2}\.\d{4})\*\*/,
  /^(\d{4}-\d{2}-\d{2})/,
  /^(\d{2}\.\d{2}\.\d{4})/,
];

/** True for a `YYYY-MM-DD` or `DD.MM.YYYY` the calendar has. */
function isTimelineDate(d: string): boolean {
  const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d);
  return isCalendarDay(dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : d);
}

export interface TimelineItem {
  /** The date as written, without its `**`; null for an undated item. */
  date: string | null;
  /** The item's text after the date and its separator; the whole item when undated. */
  text: string;
}

/** One Timeline item: a leading date from {@link TIMELINE_DATE_RES} that is a
 *  real calendar day, followed by a separator ({@link afterSeparator}). */
export function parseTimelineItem(item: string): TimelineItem {
  for (const re of TIMELINE_DATE_RES) {
    const m = re.exec(item);
    if (!m) continue;
    const rest = afterSeparator(item.slice(m[0].length));
    if (rest === null || !isTimelineDate(m[1]!)) return { date: null, text: item };
    return { date: m[1]!, text: rest };
  }
  return { date: null, text: item };
}

// ── DecisionLog ─────────────────────────────────────────────────────────────

/** A log id: one to three ASCII letters, then one to four digits (`D1`, `S12`). */
const LOG_ID = "[A-Za-z]{1,3}[0-9]{1,4}";
/** The id at an item's start, in bold. */
const LOG_ID_RE = new RegExp(`^\\*\\*(${LOG_ID})\\*\\*`);
/** A later decision named as the replacement, anywhere in the item. */
const SUPERSEDED_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:superseded by|erstattet av)[ \\t]+${LOG_ID}(?![\\p{L}\\p{N}])`, "iu");

export interface LogItem {
  /** The id as written (`D1`); null when the item does not start with one. */
  id: string | null;
  /** The text after the id and its separator, still wrapped in `~~` when the
   *  whole item was struck; the whole item when there is no id. */
  text: string;
  /** Struck through or superseded: the reader dims it. */
  dim: boolean;
}

/**
 * One DecisionLog item. A whole-item `~~…~~` is read through for the id, and
 * the rest keeps its strike. Dim when struck — the whole item, or the whole
 * text after the id — or when the text says `superseded by Dn` /
 * `erstattet av Dn` (any case).
 */
export function parseLogItem(item: string): LogItem {
  const inner = wholeStrike(item);
  const source = inner ?? item;
  const superseded = SUPERSEDED_RE.test(item);
  const m = LOG_ID_RE.exec(source);
  const rest = m ? afterSeparator(source.slice(m[0].length)) : null;
  if (!m || rest === null) return { id: null, text: item, dim: inner !== null || superseded };
  const text = inner === null ? rest : rest ? `~~${rest}~~` : "";
  return { id: m[1]!, text, dim: inner !== null || wholeStrike(rest) !== null || superseded };
}

/** The inside of a text that is one `~~…~~` strike from end to end; null otherwise. */
function wholeStrike(text: string): string | null {
  const m = /^~~([\s\S]+)~~$/.exec(text);
  return m && !m[1]!.includes("~~") ? m[1]! : null;
}

// ── RunChecklist ────────────────────────────────────────────────────────────

export type RunLabel = "command" | "expect" | "stop";

/** The labels a nested entry may start with, exactly as written, then `:`. */
export const RUN_LABELS: readonly { text: string; kind: RunLabel }[] = [
  { text: "Kommando", kind: "command" },
  { text: "Command", kind: "command" },
  { text: "Forventet", kind: "expect" },
  { text: "Expect", kind: "expect" },
  { text: "Stopp hvis", kind: "stop" },
  { text: "Stop if", kind: "stop" },
];

export interface RunEntry {
  kind: RunLabel;
  /** The label as written (`Kommando`). */
  label: string;
  /** The text after `label:`. */
  value: string;
}

/** A nested entry's label: the row must be plain (no `[ ]`/`[x]` marker) and
 *  start with a {@link RUN_LABELS} text, then `:`, then spaces or the end. */
export function parseRunEntry(row: ChecklistRow): RunEntry | null {
  if (!row.plain) return null;
  for (const l of RUN_LABELS) {
    if (!row.text.startsWith(`${l.text}:`)) continue;
    const tail = row.text.slice(l.text.length + 1);
    if (tail !== "" && !/^[ \t]/.test(tail)) return null;
    return { kind: l.kind, label: l.text, value: tail.trim() };
  }
  return null;
}

/** A command value that is exactly one single-backtick code span: its code,
 *  rendered as a one-line block so the reader's copy button reaches it. */
export function commandCode(value: string): string | null {
  const m = /^`([^`\n]+)`$/.exec(value);
  return m ? m[1]! : null;
}

/** Done and total over the TOP-level rows. */
export function runStepCount(rows: ChecklistRow[]): { done: number; total: number } {
  return { done: rows.filter((r) => r.checked).length, total: rows.length };
}

/** The header line. English, like the Query and CaseBoard lines: the page's
 *  language is unknown here. */
export function runStepLine(rows: ChecklistRow[]): string {
  const { done, total } = runStepCount(rows);
  return `${done} of ${total} ${total === 1 ? "step" : "steps"}`;
}

/** A nested list split into runs: consecutive unlabelled rows stay a list
 *  (keeping their source numbers), each labelled row stands alone. */
export type RunPart = { kind: "list"; list: ChecklistList } | { kind: "entry"; entry: RunEntry; row: ChecklistRow };

export function runParts(list: ChecklistList, nums: number[]): RunPart[] {
  const out: RunPart[] = [];
  let run: { rows: ChecklistRow[]; first: number } | null = null;
  const flush = () => {
    if (!run) return;
    const values = list.ordered ? run.rows.map((_, k) => nums[run!.first + k]) : undefined;
    out.push({
      kind: "list",
      list: { type: "checklist", ordered: list.ordered, start: nums[run.first]!, rows: run.rows, ...(values ? { values } : {}) },
    });
    run = null;
  };
  list.rows.forEach((row, k) => {
    const entry = parseRunEntry(row);
    if (entry) {
      flush();
      out.push({ kind: "entry", entry, row });
    } else {
      run ??= { rows: [], first: k };
      run.rows.push(row);
    }
  });
  flush();
  return out;
}
