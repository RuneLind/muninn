/**
 * The work map's dependency-light helpers: the effort-id slug, the Oslo day
 * and the reader's newness test. Kept apart from `normalize.ts` (which imports
 * the zod schema) so the /wiki client bundle can read them without pulling zod
 * in; the one import is the reader's own future-date rule.
 */

import { isImplausibleFutureDate } from "../../dashboard/views/components/wiki-filter.ts";

const OSLO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
/** `YYYY-MM-DD` of `ms` in Europe/Oslo: the day key of an effort's `daily`. */
export const osloDay = (ms: number) => OSLO_DAY.format(new Date(ms));

/** An effort id, as the stored map's schema accepts it. Numeric slugs are
 *  valid. An `?effort=` value it accepts is kept as typed; any other value is
 *  slugged. Here rather than in `schema.ts` so the client bundle reads it
 *  without zod; `schema.ts` re-exports it. */
export const EFFORT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** NFKD, `å`→`aa`, `ø`→`o`, `æ`→`ae`, lowercase, `_` and spaces → `-`, other
 *  marks and characters dropped, dashes collapsed and trimmed. */
export function slugifyEffortId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/å/g, "aa")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The role a declared page gets where no model answer names one (P6): from
 *  its folder — `plans/` a plan, `archive/` a report — an `.html` page an
 *  explainer, anything else a reference. */
export function roleFromFolder(relPath: string): "plan" | "report" | "explainer" | "reference" {
  if (/\.html?$/i.test(relPath)) return "explainer";
  const first = relPath.split("/")[0]!.toLowerCase();
  if (first === "plans") return "plan";
  if (first === "archive") return "report";
  return "reference";
}

/** A page's declared effort as the run and the reader read it: the
 *  frontmatter value when it passes {@link EFFORT_ID_RE} as written, else
 *  none (lint warns about it; the run never slugs a declaration). */
export function declaredEffortOf(page: { effort?: string }): string | undefined {
  const v = page.effort;
  return v !== undefined && EFFORT_ID_RE.test(v) ? v : undefined;
}

/** The listing date fields the reader's same-day join reads (all optional on
 *  the listing; see `WikiPageMeta`). */
export interface DatedPage {
  gitDirty?: boolean;
  gitCreatedMs?: number;
  gitTouchedMs?: number;
  workedMs?: number;
  mtimeMs?: number;
  /** Not read: never newer than the mtime. Kept so a listing row type-checks. */
  birthtimeMs?: number;
}

/** A page's newest creation, touch, worked-on or uncommitted-edit date, on
 *  the reader's update rules (`updatedSignal`, `wiki-filter.ts`): the mtime
 *  counts only when the index marks the page dirty (a clean file's mtime is
 *  checkout or pull time). A date past `now` + 48 h is ignored
 *  (`isImplausibleFutureDate`). */
export function pageNewestMs(p: DatedPage, now: number = Date.now()): number {
  const dates = [p.gitCreatedMs, p.gitTouchedMs, p.workedMs];
  if (p.gitDirty === true) dates.push(p.mtimeMs);
  let best = 0;
  for (const ms of dates) {
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || isImplausibleFutureDate(ms, now)) continue;
    if (ms > best) best = ms;
  }
  return best;
}

/** True when the page is newer than a run at `runAtMs`: uncommitted or
 *  untracked (`gitDirty`), or created, touched or worked on after it. A page
 *  with no git dates (no history, or a degraded git walk) is newer only when
 *  dirty. `now` is anchored to the run, so a slow viewer clock cannot judge a
 *  real post-run date implausible. */
export function pageNewerThanRun(p: DatedPage, runAtMs: number, now: number = Date.now()): boolean {
  return p.gitDirty === true || pageNewestMs(p, Math.max(now, runAtMs)) > runAtMs;
}
