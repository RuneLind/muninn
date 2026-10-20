/**
 * D20 (amended by D49) — the dates "new since last read" marks by: one parser,
 * pinned by `fixtures/reader-shared.json`'s `itemDateCases`, which PR 5's
 * plan-card port will read too.
 *
 *  - a `<Query>` by its `run=`, every item in a `<Lane>` by the lane's
 *    `since=`, and a `<DecisionLog>` item by its text (nested lines and
 *    wikilink labels included): each is the LATEST date in the value that is
 *    not after the render day (`itemDate`). A later date is a deadline, not an
 *    event, and is skipped; a `run=`/`since=` after the render day gives no
 *    date at all;
 *  - a date is `YYYY-MM-DD` (a time may follow: `T14:05`, `T14:05Z`),
 *    `D.M.YYYY` or `D.M` (one or two digits each, but a yearless one needs a
 *    two-digit month), a real calendar day;
 *  - the unit is a date EXPRESSION: one date, or a pair or range of them
 *    (`07.10-08.10`, `07.10/08.10`, `07.10,08.10`, `7.-8.10`,
 *    `01.01.–14.03.2025`). What makes a yearless date something else (a time
 *    after `kl.`, an amount, a section number) is read before the
 *    expression's first date and after its last, and refuses every date in
 *    it;
 *  - in an expression, a yearless date next to a dated one takes its year
 *    from it: a start the end's year (one less when the start's day of year
 *    is later), an end the start's (one more when it is earlier), never the
 *    nearest-year rule below;
 *  - otherwise a date with no year takes the year that puts it nearest the
 *    reference day — the page's `status_date`, else the render day — and
 *    only within six months (183 days) of it; further than that from every
 *    candidate year is no date, never a guess. Three candidate years always
 *    leave one within 183 days, so in practice only a 29.02 far from a leap
 *    year reads null.
 *
 * Dependency-free (its one import, `code-spans.ts`, is too) so the browser
 * bundle and a port can share it.
 */

import { lineCodeSpanRanges } from "./code-spans.ts";

/** The attribute the reader's render stamps with an item's ISO day. */
export const ITEM_DATE_ATTR = "data-item-date";

/** "Six months either side", in days. */
export const NEAREST_YEAR_WINDOW_DAYS = 183;

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` for a real calendar day, else null. */
function isoDay(y: number, m: number, d: number): string | null {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days since the epoch for an ISO day (UTC, so no DST). */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return Math.round(dt.getTime() / 86_400_000);
}

let osloDayFormat: Intl.DateTimeFormat | null | undefined;

/** The render day: `now`'s day in Europe/Oslo (the wikis' timezone), else
 *  its local day where the runtime has no such zone. */
export function renderDay(now: Date = new Date()): string {
  if (osloDayFormat === undefined) {
    try {
      osloDayFormat = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Oslo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      osloDayFormat = null;
    }
  }
  if (osloDayFormat) {
    const parts = Object.fromEntries(osloDayFormat.formatToParts(now).map((p) => [p.type, p.value]));
    const iso = isoDay(Number(parts.year), Number(parts.month), Number(parts.day));
    if (iso) return iso;
  }
  return isoDay(now.getFullYear(), now.getMonth() + 1, now.getDate())!;
}

/** The reference day for a yearless date: `status_date` when it is a real
 *  `YYYY-MM-DD` day, else `today` (the render day, `YYYY-MM-DD`). */
export function itemDateReference(statusDate: string | null | undefined, today: string): string {
  const m = statusDate ? ISO_DAY_RE.exec(statusDate.trim()) : null;
  return (m ? isoDay(Number(m[1]), Number(m[2]), Number(m[3])) : null) ?? today;
}

/**
 * `D.M` without a year: the year (the reference's, the one before or the one
 * after) that puts the day nearest `ref`, if that is within
 * {@link NEAREST_YEAR_WINDOW_DAYS}. A tie goes to the earlier day.
 */
export function resolveYearless(day: number, month: number, ref: string): string | null {
  const refYear = Number(ref.slice(0, 4));
  const refN = dayNumber(ref);
  let best: { iso: string; dist: number } | null = null;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const iso = isoDay(y, month, day);
    if (!iso) continue;
    const dist = Math.abs(dayNumber(iso) - refN);
    if (!best || dist < best.dist) best = { iso, dist };
  }
  return best && best.dist <= NEAREST_YEAR_WINDOW_DAYS ? best.iso : null;
}

/** Text that holds no date the author wrote as one: inline code, a link's
 *  destination, an HTML or component tag, a bare URL and the reader's
 *  parked-wikilink sentinels (a caller that knows the labels puts them back
 *  first). */
function scannable(text: string): string {
  return blankCodeSpans(text)
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\x00[A-Z]+\d+\x00/g, " ");
}

/** Each inline code span (the reader's pairing, `lineCodeSpanRanges`) as one
 *  space, line by line: a `` `[^`]*` `` replace mis-pairs a double-backtick
 *  span holding one tick and blanks the prose up to the next stray tick. */
function blankCodeSpans(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const ranges = lineCodeSpanRanges(line);
      if (ranges.length === 0) return line;
      let out = "";
      let cursor = 0;
      for (const r of ranges) {
        out += line.slice(cursor, r.start) + " ";
        cursor = r.end;
      }
      return out + line.slice(cursor);
    })
    .join("\n");
}

const ISO = String.raw`\d{4}-\d{2}-\d{2}`;
const DM = String.raw`\d{1,2}\.\d{1,2}(?:\.\d{4})?`;

/** What may sit right before a date token. */
const TOKEN_START = [
  // Glued to nothing: not inside a longer number or word (`v1.2`, `1.2.3`,
  // `D10-07.10`), not after a currency or sign (`$0.07`, `~1.10`).
  String.raw`(?<![\p{L}\p{N}_.,/:#§$€£~+±×≈−-])`,
  // The second date of a pair or range: `07.10-08.10`, `07.10/08.10`,
  // `07.10,08.10`, `2026-10-07/2026-10-08`.
  String.raw`(?<=(?<![\p{L}\p{N}_.])(?:${ISO}|${DM})[-/,])`,
  // The end of a range whose start is a bare day: `7.-8.10`.
  String.raw`(?<=(?<![\p{L}\p{N}_.])\d{1,2}\.-)`,
  // Glued to a word by `,` `/` `:`: `(D10,08.10)`, `Lukket:07.10`, `Fag/07.10`.
  String.raw`(?<=\p{L}[\p{L}\p{N}]*[,/:])`,
  // Markdown emphasis: `_07.10_`.
  String.raw`(?<=(?<![\p{L}\p{N}_])_)`,
].join("|");

/**
 * Every date token, in text order: ISO (a time may follow), day-first with or
 * without a year, and the bare-day start of a `7.-8.10` range (groups 7–9:
 * that day, then the end's month and year). A day-first one is not part of a
 * longer number (`1.2.3`, `1.2,5`); an ISO one is not before a file extension
 * (`2026-10-08.md`) or a path (`2026-10-03-wiki`). What the words around an
 * expression make of it is {@link refusedExpression}'s.
 */
const DATE_TOKEN_RE = new RegExp(
  String.raw`(?:${TOKEN_START})(?:` +
    String.raw`(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\p{L}\p{N}_-]|\/(?!${ISO})|\.[\p{L}\p{N}])` +
    String.raw`|(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?![\p{L}\p{N}]|_[\p{L}\p{N}]|\.\d|,(?!${DM})\d)` +
    String.raw`|(\d{1,2})\.(?=-\d{1,2}\.(\d{1,2})(?:\.(\d{4}))?(?![\p{L}\p{N}]|\.\d))` +
    `)`,
  "gu",
);

/** What joins two dates into one expression: `-` or `–` (a dot and spaces
 *  around it allowed: `01.01.–14.03.2025`, `07.10 - 08.10`), or a glued `/`
 *  or `,`. */
const JOINER_RE = /^(?:\.?\s*[-–]\s*|[/,])$/u;

/** How a guard word may meet the date: `kl. 09.10`, `kl 09.10`, `kl:09.10`,
 *  `Versjon:01.10`. */
const WORD_GLUE = String.raw`(?:\.?\s*|\.?[,:/])$`;

/** The word before a yearless expression that makes it a section number, any case. */
const SECTION_WORD_RE = new RegExp(
  String.raw`(?:§|\b(?:art|artikkel|artikler|article|kap|kapittel|chapter|pkt|punkt|nr|ledd|avsn|avsnitt|section|versjon|version|v|jf))` +
    WORD_GLUE,
  "iu",
);

/** The word before a yearless expression that makes it a time of day (`kl. 09.10`). */
const TIME_WORD_RE = new RegExp(String.raw`(?<!\p{L})(?:kl|klokka|klokken)` + WORD_GLUE, "iu");

/** A currency before or after a yearless expression makes it an amount
 *  (`NOK 1.10`, `~ 1.10 kr`). */
const CURRENCY_BEFORE_RE = new RegExp(String.raw`(?:[~$€£]|(?<!\p{L})(?:NOK|USD|EUR|kr))` + WORD_GLUE, "iu");
const CURRENCY_AFTER_RE = /^\s?(?:kr(?!\p{L})|kroner|NOK|USD|EUR|[$€£])/iu;
/** After a yearless expression: a percentage (`12.10 %`) or a ratio's `:` (`4.12:1`). */
const NUMBER_AFTER_RE = /^(?:\s?%|:\d)/u;

/** Whether the text around a yearless expression (`start`…`end`) makes it
 *  something other than dates. */
function refusedExpression(s: string, start: number, end: number): boolean {
  const before = s.slice(Math.max(0, start - 12), start);
  const after = s.slice(end, end + 8);
  return (
    SECTION_WORD_RE.test(before) ||
    TIME_WORD_RE.test(before) ||
    CURRENCY_BEFORE_RE.test(before) ||
    CURRENCY_AFTER_RE.test(after) ||
    NUMBER_AFTER_RE.test(after)
  );
}

interface DateToken {
  start: number;
  end: number;
  day: number;
  month: number;
  /** The written year, or null for `D.M`. */
  year: number | null;
  /** A yearless token with a one-digit month: never a date. */
  unreadable: boolean;
  /** The resolved day, once known. */
  iso: string | null;
}

/** Each token the regex finds, unresolved, in text order. */
function dateTokens(s: string): DateToken[] {
  const out: DateToken[] = [];
  for (const m of s.matchAll(DATE_TOKEN_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (m[1]) {
      out.push({ start, end, day: Number(m[3]), month: Number(m[2]), year: Number(m[1]), unreadable: false, iso: null });
      continue;
    }
    // A `D.M` token, or the bare-day start of a range with the end's month.
    const [day, monthText, year] = m[4] ? [m[4], m[5]!, m[6]] : [m[7]!, m[8]!, m[9]];
    out.push({
      start,
      end,
      day: Number(day),
      month: Number(monthText),
      year: year ? Number(year) : null,
      unreadable: !year && monthText.length !== 2,
      iso: null,
    });
  }
  return out;
}

/** The tokens grouped into expressions: neighbours joined by {@link JOINER_RE}. */
function expressions(s: string, tokens: DateToken[]): DateToken[][] {
  const out: DateToken[][] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && JOINER_RE.test(s.slice(prev.end, t.start))) last.push(t);
    else out.push([t]);
  }
  return out;
}

/** An ISO day's month and day as `MMDD`, for a day-of-year comparison. */
const monthDay = (iso: string): number => Number(iso.slice(5, 7)) * 100 + Number(iso.slice(8, 10));

/** Year inference inside one expression: each yearless date next to a
 *  resolved one takes its year from it — from the right first (a start from
 *  its end), then from the left (an end from its start). */
function resolveFromNeighbours(expr: DateToken[]): void {
  const open = (t: DateToken) => t.iso === null && t.year === null && !t.unreadable;
  for (let i = expr.length - 2; i >= 0; i--) {
    const t = expr[i]!;
    const next = expr[i + 1]!.iso;
    if (!open(t) || !next) continue;
    const y = Number(next.slice(0, 4)) - (t.month * 100 + t.day > monthDay(next) ? 1 : 0);
    t.iso = isoDay(y, t.month, t.day);
  }
  for (let i = 1; i < expr.length; i++) {
    const t = expr[i]!;
    const prev = expr[i - 1]!.iso;
    if (!open(t) || !prev) continue;
    const y = Number(prev.slice(0, 4)) + (t.month * 100 + t.day < monthDay(prev) ? 1 : 0);
    t.iso = isoDay(y, t.month, t.day);
  }
}

/** The dates in `text`, in order, each resolved against `ref`; a token that
 *  is no calendar day, or a yearless one outside the window, is left out, and
 *  a refused expression gives none. */
export function itemDates(text: string, ref: string): string[] {
  const s = scannable(text);
  const out: string[] = [];
  for (const expr of expressions(s, dateTokens(s))) {
    if (expr.some((t) => t.year === null) && refusedExpression(s, expr[0]!.start, expr[expr.length - 1]!.end)) continue;
    for (const t of expr) if (t.year !== null) t.iso = isoDay(t.year, t.month, t.day);
    resolveFromNeighbours(expr);
    // No written year in the expression: each by the reference day.
    for (const t of expr) {
      if (t.iso === null && t.year === null && !t.unreadable) t.iso = resolveYearless(t.day, t.month, ref);
    }
    for (const t of expr) if (t.iso) out.push(t.iso);
  }
  return out;
}

/** D20 as amended by D49: an item's date is the LATEST date in its text (or
 *  its `run=` / `since=` value) that is not after `today` (the render day,
 *  `YYYY-MM-DD`); null when it holds none. */
export function itemDate(text: string, ref: string, today: string): string | null {
  let best: string | null = null;
  for (const d of itemDates(text, ref)) if (d <= today && (best === null || d > best)) best = d;
  return best;
}
