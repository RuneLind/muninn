/**
 * D20 (amended by D49) — the dates "new since last read" marks by: one parser
 * that the reader uses and plan-card ports, both pinned by
 * `fixtures/reader-shared.json`'s `itemDateCases`.
 *
 *  - a `<Query>` by its `run=`, every item in a `<Lane>` by the lane's
 *    `since=`, and a `<DecisionLog>` item by its text (nested lines and
 *    wikilink labels included): each is the LATEST date in the value that is
 *    not after the render day (`itemDate`). A later date is a deadline or a
 *    yearless range start that resolved into next year, not an event, and is
 *    skipped; a `run=`/`since=` after the render day gives no date at all;
 *  - a date is `YYYY-MM-DD` (a time may follow: `T14:05`, `T14:05Z`),
 *    `D.M.YYYY` or `D.M` (one or two digits each, but a yearless one needs a
 *    two-digit month), a real calendar day; a pair or range gives both ends
 *    (`07.10-08.10`, `07.10/08.10`, `7.-8.10`);
 *  - a date with no year takes the year that puts it nearest the reference
 *    day — the page's `status_date`, else the render day — and only within
 *    six months (183 days) of it; further than that from every candidate year
 *    is no date, never a guess. Three candidate years always leave one within
 *    183 days, so in practice only a 29.02 far from a leap year reads null.
 *
 * Dependency-free so the browser bundle and a port can share it.
 */

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
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\x00[A-Z]+\d+\x00/g, " ");
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
 * that day, then the end's month and year). A yearless one is not before `%`,
 * a ratio's `:` (`4.12:1`) or a decimal comma (`1.2,5`); an ISO one not before
 * a file extension (`2026-10-08.md`) or a path (`2026-10-03-wiki`).
 */
const DATE_TOKEN_RE = new RegExp(
  String.raw`(?:${TOKEN_START})(?:` +
    String.raw`(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\p{L}\p{N}_-]|\/(?!${ISO})|\.[\p{L}\p{N}])` +
    String.raw`|(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?![\p{L}\p{N}]|_[\p{L}\p{N}]|\.\d|,(?!${DM})\d|\s?%|:\d)` +
    String.raw`|(\d{1,2})\.(?=-\d{1,2}\.(\d{1,2})(?:\.(\d{4}))?(?![\p{L}\p{N}]|\.\d))` +
    `)`,
  "gu",
);

/** The word before a yearless `D.M` that makes it a section number, any case. */
const SECTION_WORD_RE =
  /(?:§|\b(?:art|artikkel|artikler|article|kap|kapittel|chapter|pkt|punkt|nr|ledd|avsn|avsnitt|section|versjon|version|v|jf))\.?\s*$/iu;

/** The word before a yearless `D.M` that makes it a time of day (`kl. 09.10`). */
const TIME_WORD_RE = /(?<!\p{L})(?:kl|klokka|klokken)\.?\s*$/iu;

/** A currency before or after a yearless `D.M` makes it an amount
 *  (`NOK 1.10`, `~ 1.10 kr`). */
const CURRENCY_BEFORE_RE = /(?:[~$€£]|(?<!\p{L})(?:NOK|USD|EUR|kr))\.?\s*$/iu;
const CURRENCY_AFTER_RE = /^\s?(?:kr(?!\p{L})|kroner|NOK|USD|EUR|[$€£])/iu;

/** Whether the text around a yearless token makes it something other than a date. */
function notAYearlessDate(s: string, start: number, end: number): boolean {
  const before = s.slice(Math.max(0, start - 12), start);
  return (
    SECTION_WORD_RE.test(before) ||
    TIME_WORD_RE.test(before) ||
    CURRENCY_BEFORE_RE.test(before) ||
    CURRENCY_AFTER_RE.test(s.slice(end, end + 8))
  );
}

/** The dates in `text`, in order, each resolved against `ref`; a token that
 *  is no calendar day, or a yearless one outside the window, is left out. */
export function itemDates(text: string, ref: string): string[] {
  const s = scannable(text);
  const out: string[] = [];
  for (const m of s.matchAll(DATE_TOKEN_RE)) {
    const at = m.index!;
    if (m[1]) {
      const iso = isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) out.push(iso);
      continue;
    }
    // A `D.M` token, or the bare-day start of a range with the end's month.
    const [day, month, year, monthText] = m[4]
      ? [Number(m[4]), Number(m[5]), m[6], m[5]!]
      : [Number(m[7]), Number(m[8]), m[9], m[8]!];
    if (year) {
      const iso = isoDay(Number(year), month, day);
      if (iso) out.push(iso);
      continue;
    }
    if (monthText.length !== 2) continue;
    if (notAYearlessDate(s, at, at + m[0].length)) continue;
    const iso = resolveYearless(day, month, ref);
    if (iso) out.push(iso);
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
