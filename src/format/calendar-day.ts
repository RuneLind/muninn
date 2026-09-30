/**
 * The one strict `YYYY-MM-DD` check: true only for a day the calendar has.
 * Dependency-free so the formatters, the wiki and the browser bundle can share it.
 * `setUTCFullYear`, not `Date.UTC`, which maps years 0–99 to the 1900s.
 */
export function isCalendarDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
