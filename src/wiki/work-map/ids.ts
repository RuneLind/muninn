/**
 * The work map's two dependency-free helpers: the effort-id slug and the Oslo
 * day. Kept apart from `normalize.ts` (which imports the zod schema) so the
 * /wiki client bundle can read them without pulling zod in.
 */

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
