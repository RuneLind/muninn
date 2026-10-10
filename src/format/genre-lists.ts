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
 *  one of: nothing; whitespace (a newline and U+00A0 included), then text; or
 *  one of `—` `–` `-` `:`, with optional whitespace on either side. A dash
 *  right before a digit is a range or a minus sign, never a separator
 *  (`27.09–28.09`, `-1`). Anything else (`x`, `,`, `.` right after the token)
 *  is not a match. Returns the text after it. */
function afterSeparator(tail: string): string | null {
  if (tail === "") return "";
  const m = /^(?:\s*(?::|[—–-](?!\d))|\s)\s*([\s\S]*)$/.exec(tail);
  return m ? m[1]! : null;
}

// ── Timeline ────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD`. */
const ISO_DATE = String.raw`\d{4}-\d{2}-\d{2}`;
/** ` HH:MM`, one space, 00–23 and 00–59. */
const TIME = String.raw` (?:[01]\d|2[0-3]):[0-5]\d`;
/** `D.M.YYYY` to `DD.MM.YYYY`. */
const DAY_FIRST_DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;
/** `D.M` to `DD.MM`, no year. */
const DAY_MONTH = String.raw`\d{1,2}\.\d{1,2}`;

/** One marker shape: the date (and time) alone, or the same wrapped in one
 *  `**…**` that may hold a trailing `:` (`**30.09.2026:**`). */
const plain = (shape: string) => new RegExp(`^(${shape})`);
const bold = (shape: string) => new RegExp(`^\\*\\*(${shape}):?\\*\\*`);

/**
 * The marker shapes a Timeline item may start with, longest first. The parser
 * takes the first row that matches AND is followed by a tail
 * {@link afterSeparator} accepts; a refused tail falls through to the next,
 * shorter row. `tail: "yearless"` also requires `:`, `—` or `–` after the
 * token, so `1.2 million` stays text.
 *
 * | # | shape                       | example                 |
 * |---|-----------------------------|-------------------------|
 * | 1 | `**YYYY-MM-DD HH:MMZ:?**`   | `**2026-09-28 20:50Z**` |
 * | 2 | `**YYYY-MM-DD HH:MM:?**`    | `**2026-09-28 20:50**`  |
 * | 3 | `**YYYY-MM-DD:?**`          | `**2026-09-28:**`       |
 * | 4 | `**D.M.YYYY:?**`            | `**30.09.2026**`        |
 * | 5 | `**D.M:?**`                 | `**29.09:**`            |
 * | 6 | `YYYY-MM-DD HH:MMZ`         | `2026-09-28 20:50Z`     |
 * | 7 | `YYYY-MM-DD HH:MM`          | `2026-09-28 20:50`      |
 * | 8 | `YYYY-MM-DD`                | `2026-09-28`            |
 * | 9 | `D.M.YYYY`                  | `30.09.2026`            |
 * |10 | `D.M` (yearless)            | `29.09:`                |
 *
 * So a time that starts a range (`20:50–21:10`, `20:50Z-21:10`) is refused
 * by rows 6–7 and the date-only row 8 takes the item, leaving the range in
 * the text. A bold wrap closes the token: `**2026-09-28 20:50**–21:10` has no
 * shorter bold row to fall back to and stays undated.
 */
const TIMELINE_DATE_TABLE: readonly { re: RegExp; tail: "separator" | "yearless" }[] = [
  { re: bold(`${ISO_DATE}${TIME}Z`), tail: "separator" },
  { re: bold(`${ISO_DATE}${TIME}`), tail: "separator" },
  { re: bold(ISO_DATE), tail: "separator" },
  { re: bold(DAY_FIRST_DATE), tail: "separator" },
  { re: bold(DAY_MONTH), tail: "separator" },
  { re: plain(`${ISO_DATE}${TIME}Z`), tail: "separator" },
  { re: plain(`${ISO_DATE}${TIME}`), tail: "separator" },
  { re: plain(ISO_DATE), tail: "separator" },
  { re: plain(DAY_FIRST_DATE), tail: "separator" },
  { re: plain(DAY_MONTH), tail: "yearless" },
];

/** True for a date the calendar has. A date without a year is checked
 *  against a leap year, so `29.02` passes and `31.04` does not. */
function isTimelineDate(d: string): boolean {
  const dm = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(d);
  if (!dm) return isCalendarDay(d.slice(0, 10));
  return isCalendarDay(`${dm[3] ?? "2024"}-${dm[2]!.padStart(2, "0")}-${dm[1]!.padStart(2, "0")}`);
}

export interface TimelineItem {
  /** The date as written, without its `**`; null for an undated item. */
  date: string | null;
  /** The item's text after the date and its separator; the whole item when undated. */
  text: string;
}

/** One Timeline item: the first {@link TIMELINE_DATE_TABLE} row whose tail is
 *  accepted decides; its date must be a real calendar day, else the item is
 *  undated. */
export function parseTimelineItem(item: string): TimelineItem {
  for (const { re, tail } of TIMELINE_DATE_TABLE) {
    const m = re.exec(item);
    if (!m) continue;
    const after = item.slice(m[0].length);
    const rest = tail === "yearless" && !/^\s*[—–:]/.test(after) ? null : afterSeparator(after);
    if (rest === null) continue;
    if (!isTimelineDate(m[1]!)) return { date: null, text: item };
    return { date: m[1]!, text: rest };
  }
  return { date: null, text: item };
}

// ── DecisionLog ─────────────────────────────────────────────────────────────

/** A log id: one to three ASCII letters, then one to four digits (`D1`, `S12`). */
const LOG_ID = "[A-Za-z]{1,3}[0-9]{1,4}";
/** The id at an item's start: in bold, or bold inside one strike (a struck id,
 *  which dims the item). */
const LOG_ID_TABLE: readonly { re: RegExp; struck: boolean }[] = [
  { re: new RegExp(`^\\*\\*(${LOG_ID})\\*\\*`), struck: false },
  { re: new RegExp(`^~~\\*\\*(${LOG_ID})\\*\\*~~`), struck: true },
];
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
 * the rest keeps its strike. Dim when struck — the whole item, the id alone,
 * or the whole text after the id — or when the text outside code spans says
 * `superseded by Dn` / `erstattet av Dn` (any case).
 */
export function parseLogItem(item: string): LogItem {
  const inner = wholeStrike(item);
  const source = inner ?? item;
  const superseded = SUPERSEDED_RE.test(withoutCodeSpans(item));
  for (const { re, struck } of LOG_ID_TABLE) {
    const m = re.exec(source);
    if (!m) continue;
    const rest = afterSeparator(source.slice(m[0].length));
    if (rest === null) break;
    const text = inner === null ? rest : rest ? `~~${rest}~~` : "";
    return { id: m[1]!, text, dim: struck || inner !== null || wholeStrike(rest) !== null || superseded };
  }
  return { id: null, text: item, dim: inner !== null || superseded };
}

/** A decision item's trailing «<who>, DD.MM[.YYYY] (runde N).» (D41). */
export interface DecisionWhen {
  who: string;
  /** `DD.MM` or `DD.MM.YYYY`, as written. */
  date: string;
  /** `5`, `5 og 6`; null when the item names no round. */
  round: string | null;
  /** Where the tail starts in the text. */
  start: number;
  /** Where the hidden part ends: the end of the text, or the start of a
   *  trailing `→ …` pointer, which stays with the rest. */
  end: number;
}

const WHEN_RE = new RegExp(
  String.raw`(?:^|(?<=[.!?»)*_]\s))` +
    // who: a capitalised name or role, up to four words, no comma.
    String.raw`(\p{Lu}[\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]+){0,3}), ` +
    String.raw`(\d{1,2}\.\d{1,2}(?:\.\d{4})?)` +
    String.raw`(?: \((?:runde|round) (\d{1,3}(?:(?: og | and |, ?|[–/-])\d{1,3})*)\))?` +
    String.raw`(\s*→[^\n]*?)?\.\s*$`,
  "u",
);

/** The item's trailing date line, or null. Day and month must be a real
 *  calendar day (a leap year when the year is absent). */
export function parseDecisionWhen(text: string): DecisionWhen | null {
  const m = WHEN_RE.exec(text);
  if (!m) return null;
  const [d, mo, y] = m[2]!.split(".");
  if (!isCalendarDay(`${y ?? "2024"}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`)) return null;
  const end = m[4] ? m.index + m[0].indexOf(m[4]) : text.length;
  return { who: m[1]!, date: m[2]!, round: m[3] ?? null, start: m.index, end };
}

/** The date cell's text: `Fag, 07.10 · runde 6`. */
export function decisionWhenLabel(w: DecisionWhen, roundWord = "runde"): string {
  return `${w.who}, ${w.date}${w.round ? ` · ${roundWord} ${w.round}` : ""}`;
}

/** The text with every inline code span (a backtick run, then the same run)
 *  removed. */
function withoutCodeSpans(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1/g, "");
}

/** The inside of a text that is one `~~…~~` strike from end to end; null otherwise. */
function wholeStrike(text: string): string | null {
  const m = /^~~([\s\S]+)~~$/.exec(text);
  return m && !m[1]!.includes("~~") ? m[1]! : null;
}

// ── RunChecklist ────────────────────────────────────────────────────────────

export type RunLabel = "command" | "expect" | "stop";

/** The label words a nested entry may start with. The first letter may be
 *  either case; the rest is as written. `nb` marks the Norwegian ones, which
 *  set the step-count line's language. */
export const RUN_LABELS: readonly { text: string; kind: RunLabel; nb: boolean }[] = [
  { text: "Kommando", kind: "command", nb: true },
  { text: "Command", kind: "command", nb: false },
  { text: "Forventet", kind: "expect", nb: true },
  { text: "Expected", kind: "expect", nb: false },
  { text: "Expect", kind: "expect", nb: false },
  { text: "Stopp hvis", kind: "stop", nb: true },
  { text: "Stop if", kind: "stop", nb: false },
];

/** How a label word is written: `Word:`, `**Word:**` or `**Word**:`. */
const RUN_LABEL_FORMS: readonly ((word: string) => string)[] = [(w) => `${w}:`, (w) => `**${w}:**`, (w) => `**${w}**:`];

export interface RunEntry {
  kind: RunLabel;
  /** The label word as written, without bold or colon (`Kommando`, `forventet`). */
  label: string;
  /** The text after the label. */
  value: string;
  /** The label word is a Norwegian one. */
  nb: boolean;
}

/** A nested entry's label: the row must be plain (no `[ ]`/`[x]` marker) and
 *  start with a {@link RUN_LABELS} word in one of {@link RUN_LABEL_FORMS}, then
 *  a space, a tab, U+00A0 or the end. */
export function parseRunEntry(row: ChecklistRow): RunEntry | null {
  if (!row.plain) return null;
  for (const l of RUN_LABELS) {
    for (const word of [l.text, l.text[0]!.toLowerCase() + l.text.slice(1)]) {
      for (const form of RUN_LABEL_FORMS) {
        const head = form(word);
        if (!row.text.startsWith(head)) continue;
        const tail = row.text.slice(head.length);
        if (tail !== "" && !/^[ \t\u00a0]/.test(tail)) return null;
        return { kind: l.kind, label: word, value: tail.trim(), nb: l.nb };
      }
    }
  }
  return null;
}

/** A command value that is exactly one single-backtick code span: its code,
 *  rendered as a one-line block so the reader's copy button reaches it. */
export function commandCode(value: string): string | null {
  const m = /^`([^`\n]+)`$/.exec(value);
  return m ? m[1]! : null;
}

/** The header line over the steps (`runChecklistSteps`). Norwegian
 *  (`3 av 7 steg`) when an entry nested directly under a step carries a
 *  Norwegian label, else English (`3 of 7 steps`). */
export function runStepLine(steps: ChecklistRow[]): string {
  const done = steps.filter((r) => r.checked).length;
  const total = steps.length;
  const nb = steps.some((s) =>
    (s.children ?? []).some((c) => c.type === "checklist" && c.rows.some((r) => parseRunEntry(r)?.nb)),
  );
  return nb ? `${done} av ${total} steg` : `${done} of ${total} ${total === 1 ? "step" : "steps"}`;
}

/** A `Tldr` label for a plain-text surface, which adds its own `:`: the label,
 *  `TL;DR` when there is none, with one trailing `:` dropped. */
export function tldrFallbackLabel(label: string | undefined): string {
  return (label?.trim() || "TL;DR").replace(/\s*:\s*$/, "") || "TL;DR";
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
