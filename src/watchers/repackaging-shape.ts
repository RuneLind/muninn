/**
 * "Secondhand repackaging" shape detector for the X capture gate's post-gate clamp.
 *
 * The gate prompt asks Haiku to cap repackaging long-form notes at 0.8. Measured over the
 * 21 days after #399 (380 `summary_candidates` rows): **93 of 95** repackaging-shaped
 * `x-post` rows sit ABOVE 0.8 — the prompt cap is not honored. This predicate is the
 * deterministic half the prompt could not deliver.
 *
 * It is deliberately the census predicate verbatim (`title ~ '[A-Z]{8,}'`, `title like
 * '🚨%'`, `title ~* 'just (dropped|released|launched|published)'`), which has a clean
 * false-positive record on real data: **0 of 96** shape rows were ever summarized, and
 * neither of the 2 rows Rune accepted carries the shape. **Do not widen it** — every
 * clause here costs a row that would otherwise have been captured at its true score.
 */

/** ALL-CAPS run of ≥8 consecutive letters — "EXO JUST SHOWED HOW …". */
const ALL_CAPS_RUN = /[A-Z]{8,}/;
/** "Anthropic just released a 4-hour course…" — the announcement-recap opener. */
const JUST_VERB = /just (dropped|released|launched|published)/i;

/**
 * Is this first line repackaging-SHAPED?
 *
 * Feed it the same text the candidate title is built from — `doc.firstLine.trim() ||
 * doc.text` — WITHOUT the `@handle: ` prefix, and never the 1200-char `gateExcerpt`
 * (which would over-match: any long body eventually contains an acronym run or a "just
 * released" deep in the text).
 */
export function isRepackagingShaped(firstLine: string): boolean {
  const line = firstLine.trim();
  if (line.startsWith("🚨")) return true;
  return ALL_CAPS_RUN.test(line) || JUST_VERB.test(line);
}
