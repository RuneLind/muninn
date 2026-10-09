/**
 * Abbreviations whose dot ends no sentence, in the two languages the wikis are
 * written in. One rule for every first-sentence reader: the reader's
 * DecisionLog split (`report-top.ts`) and the NextMoves lead step
 * (`src/wiki/next-moves.ts`). Lower-cased, without the final dot. Not `no`:
 * it ends "Say no." far more often than it opens "No. 5".
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  // English
  "e.g", "i.e", "etc", "vs", "cf", "approx", "incl", "excl",
  // Norwegian
  "f.eks", "bl.a", "dvs", "osv", "mht", "ca", "jf", "jfr", "evt", "ev", "inkl", "ekskl",
  "iht", "i.h.t", "mtp", "pga", "vha", "ift", "ang", "o.l", "m.m", "mv", "t.o.m", "f.o.m",
]);

/** Also ordinary words (`jul`, `Jan`, `kr`) or a common last word: an
 *  abbreviation only before a number (`kr. 500`, `kap. 3`, `Oct. 9`). */
const BEFORE_NUMBER: ReadonlySet<string> = new Set([
  "kr", "kap", "pkt", "nr", "kl", "fig",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "okt", "nov", "dec", "des",
]);

/** A title: an abbreviation only written capitalised before a capitalised
 *  name (`Dr. Smith`); `… about mr. Then …` ends a sentence. */
const BEFORE_NAME: ReadonlySet<string> = new Set(["dr", "mr", "mrs"]);

/** An abbreviation only where the sentence goes on in lower case or a
 *  number: `the U.S. market`, `i ref. nedenfor`. */
const BEFORE_LOWER: ReadonlySet<string> = new Set(["u.s", "ref"]);

/** Abbreviations that count only as written in lower case: `pr.` is
 *  Norwegian "per" (`5 kr pr. dag`), `PR.` an English sentence end. */
const LOWER_CASE_ONLY: ReadonlySet<string> = new Set(["pr"]);

/** Whether `word`, the run of letters and dots before a dot, is an
 *  abbreviation, so that dot is no sentence end. `following` is the text
 *  after the dot; its first letter or digit decides the gated sets. */
export function isAbbreviation(word: string, following: string): boolean {
  if (LOWER_CASE_ONLY.has(word)) return true;
  const w = word.toLowerCase();
  if (ABBREVIATIONS.has(w)) return true;
  const next = /[\p{L}\p{N}]/u.exec(following)?.[0] ?? "";
  if (BEFORE_NUMBER.has(w)) return /\p{N}/u.test(next);
  if (BEFORE_NAME.has(w)) return /^\p{Lu}/u.test(word) && /\p{Lu}/u.test(next);
  if (BEFORE_LOWER.has(w)) return !/\p{Lu}/u.test(next);
  return false;
}
