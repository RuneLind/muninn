/** Small helpers shared by the gardener's runner (draft time) and apply step. */

const OSLO_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in Europe/Oslo — the wiki's date convention. */
export function todayOslo(nowMs: number): string {
  return OSLO_DATE_FMT.format(new Date(nowMs));
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
