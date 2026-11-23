/** Oslo date and sha256 helpers (gardener, plans and wiki writers). Server-only: `sha256` uses `Bun.CryptoHasher`, so no browser bundle may import this file. */

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
