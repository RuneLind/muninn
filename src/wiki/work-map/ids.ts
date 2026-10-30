/**
 * The work map's two dependency-free helpers: the effort-id slug and the Oslo
 * day. Kept apart from `normalize.ts` (which imports the zod schema) so the
 * /wiki client bundle can read them without pulling zod in.
 */

const OSLO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
/** `YYYY-MM-DD` of `ms` in Europe/Oslo: the day key of an effort's `daily`. */
export const osloDay = (ms: number) => OSLO_DAY.format(new Date(ms));

/** An effort id: what the `?effort=` URL and the wiki lint accept. Numeric
 *  slugs are valid. Here rather than in `schema.ts` so the client bundle reads
 *  it without zod; `schema.ts` re-exports it. */
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
