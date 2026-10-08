/**
 * Abbreviations whose dot ends no sentence, in the two languages the wikis are
 * written in. One set for every first-sentence rule: the reader's DecisionLog
 * split (`report-top.ts`) and the NextMoves lead step (`src/wiki/next-moves.ts`).
 * Lower-cased, without the final dot. Not `no`: it ends "Say no." far more
 * often than it opens "No. 5".
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  // English
  "e.g", "i.e", "etc", "vs", "cf", "approx", "incl", "excl", "fig", "ref", "dr", "mr", "mrs", "u.s",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  // Norwegian
  "f.eks", "bl.a", "dvs", "osv", "mht", "ca", "jf", "jfr", "nr", "kl", "evt", "ev", "inkl", "ekskl",
  "iht", "i.h.t", "mtp", "pga", "vha", "ift", "ang", "pkt", "kap", "o.l", "m.m", "mv", "t.o.m", "f.o.m",
  "kr", "okt", "des",
]);

/** Abbreviations that count only as written in lower case: `pr.` is
 *  Norwegian "per" (`5 kr pr. dag`), `PR.` an English sentence end. */
const LOWER_CASE_ONLY: ReadonlySet<string> = new Set(["pr"]);

/** Whether `word`, the run of letters and dots before a dot, is an
 *  abbreviation, so that dot is no sentence end. */
export function isAbbreviation(word: string): boolean {
  if (LOWER_CASE_ONLY.has(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}
