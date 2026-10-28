/**
 * The Stale check's status words (D18), with no other import: the server's
 * hit rule (`stale.ts`) and the reader's mark placement
 * (`wiki-stale-marks.ts`, D21) read the same table, so a mark lands on the
 * word the hit was found on.
 */

export type StatusKind = "proposed" | "in-flight" | "shipped" | "blocked";

/** Edges that work on `æøå`: JS `\b` treats them as non-word characters. */
const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";
const words = (xs: string) => new RegExp(`${L}(?:${xs})${R}`, "iu");

/** A negation (F7a): the word `ikke`/`not`, any whitespace run, at most one
 *  adverb (`yet`, `ennå`, `enda`, `still`, `fortsatt`) and whitespace again. */
const NEGATION = `${L}(?:ikke|not)(?:\\s+(?:yet|ennå|enda|still|fortsatt))?\\s+`;

/**
 * The status words (D18): the measured union of English and Norwegian, read on
 * every wiki whatever its `language`. A shipped word right after a
 * {@link NEGATION} is not shipped; a negated `merget`/`merged` is in-flight,
 * any other negated shipped word (`not yet shipped`) names no status.
 */
export const STATUS_WORDS: readonly (readonly [StatusKind, RegExp])[] = [
  ["proposed", words("proposed|forslag|foreslått|utkast|draft")],
  ["in-flight", new RegExp(`${L}(?:in[- ]flight|pågår|i gang|påbegynt|under arbeid|open PRs?|åpen PR|åpne PR-er|åpne PR-ene)${R}|${NEGATION}(?:merget|merged)${R}`, "iu")],
  ["shipped", new RegExp(`(?<!${NEGATION})${L}(?:shipped|levert|landet|ferdig|done|merget|merged)${R}`, "iu")],
  ["blocked", words("blocked|blokkert")],
];

/** The status word of `text` nearest its start: the earliest first match of a
 *  kind in `said`, as `[start, end]`, or `null` when none matches. The server
 *  windows a hit on it (`stale.ts`) and the reader marks it
 *  (`wiki-stale-marks.ts`), so a mark lands on the word the hit was found on. */
export function saidSpan(text: string, said: readonly string[]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const [kind, re] of STATUS_WORDS) {
    if (!said.includes(kind)) continue;
    const m = re.exec(text);
    if (m && (!best || m.index < best[0])) best = [m.index, m.index + m[0].length];
  }
  return best;
}
