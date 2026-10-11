/**
 * D20 — the dates "new since last read" marks by: one parser that the reader
 * uses and plan-card ports, both pinned by `fixtures/reader-shared.json`'s
 * `itemDateCases`.
 *
 *  - a `<Query>` by its `run=`, every item in a `<Lane>` by the lane's
 *    `since=`, and a `<DecisionLog>` item by its text: each is the LAST date
 *    in the value (`lastItemDate`), so «Fag, 07.10 (runde 6)» after
 *    «Spurt 01.10» reads 07.10;
 *  - a date is `YYYY-MM-DD`, `D.M.YYYY` or `D.M` (one or two digits each,
 *    but a yearless one needs a two-digit month), a real calendar day;
 *  - a date with no year takes the year that puts it nearest the reference
 *    day — the page's `status_date`, else today — and only within six months
 *    (183 days) of it; further than that from every candidate year is no
 *    date, never a guess. Three candidate years always leave one within 183
 *    days, so in practice only a 29.02 far from a leap year reads null.
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

/** The reference day for a yearless date: `status_date` when it is a real
 *  `YYYY-MM-DD` day, else `today`'s local day. */
export function itemDateReference(statusDate: string | null | undefined, today: Date): string {
  const m = statusDate ? ISO_DAY_RE.exec(statusDate.trim()) : null;
  const fromStatus = m ? isoDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  return fromStatus ?? isoDay(today.getFullYear(), today.getMonth() + 1, today.getDate())!;
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
 *  parked-wikilink sentinels. */
function scannable(text: string): string {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\x00[A-Z]+\d+\x00/g, " ");
}

/**
 * Every date token, in text order: ISO, then day-first with or without a
 * year. Not inside a longer number or word (`v1.2`, `1.2.3`, `2026-10-03-wiki`,
 * `1.2,5`), not after a currency or sign (`$0.07`, `~1.10`), and a yearless
 * one not after a section word (`§ 13.1`, `art. 12.2`) nor before `%` or a
 * ratio's `:` (`4.12:1`). A yearless date needs a two-digit month: on the
 * real plan pages every one-digit-month token was a decimal (`14.5`,
 * `Sonnet 5.5`), never a date.
 */
const DATE_TOKEN_RE =
  /(?<![\p{L}\p{N}_.,/:#§$€£~+±×≈−-])(?:(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}_/-])|(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?![\p{L}\p{N}_]|[.,]\d|\s?%|:\d))/gu;

/** The word before a yearless `D.M` that makes it a section number, any case. */
const SECTION_WORD_RE =
  /(?:§|\b(?:art|artikkel|artikler|article|kap|kapittel|chapter|pkt|punkt|nr|ledd|section|versjon|version|v))\.?\s*$/iu;

/** The dates in `text`, in order, each resolved against `ref`; a token that
 *  is no calendar day, or a yearless one outside the window, is left out. */
export function itemDates(text: string, ref: string): string[] {
  const s = scannable(text);
  const out: string[] = [];
  for (const m of s.matchAll(DATE_TOKEN_RE)) {
    if (m[1]) {
      const iso = isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) out.push(iso);
      continue;
    }
    const day = Number(m[4]);
    const month = Number(m[5]);
    if (m[6]) {
      const iso = isoDay(Number(m[6]), month, day);
      if (iso) out.push(iso);
      continue;
    }
    if (m[5]!.length !== 2) continue;
    if (SECTION_WORD_RE.test(s.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    const iso = resolveYearless(day, month, ref);
    if (iso) out.push(iso);
  }
  return out;
}

/** D20: an item's date is the LAST date in its text (or its `run=` /
 *  `since=` value), null when it holds none. */
export function lastItemDate(text: string, ref: string): string | null {
  const all = itemDates(text, ref);
  return all.length ? all[all.length - 1]! : null;
}
