/**
 * "Secondhand repackaging" shape detector for the X capture gate's post-gate clamp.
 *
 * Three clauses: an ALL-CAPS run of ≥8 letters, a leading 🚨, or `just
 * (dropped|released|launched|published)`. **Do not widen them** — the clean false-positive
 * record that justifies clamping at all was measured on exactly these three, and every
 * extra clause costs a row that would otherwise be captured at its true score.
 *
 * Feed it the candidate TITLE with the `@handle: ` prefix stripped — the handle-stripped,
 * whitespace-collapsed, 140-char-truncated slice the census measured — and never the
 * `gateExcerpt` (1200 chars eventually contain an acronym run). The census counts, the
 * float4 acceptance-query trap and the clamp's known cost live in the "Repackaging clamp"
 * block of `src/watchers/CLAUDE.md`, which owns those numbers.
 */

/** ALL-CAPS run of ≥8 consecutive letters — "EXO JUST SHOWED HOW …". */
const ALL_CAPS_RUN = /[A-Z]{8,}/;
/** "Anthropic just released a 4-hour course…" — the announcement-recap opener. */
const JUST_VERB = /just (dropped|released|launched|published)/i;

/** Is this handle-stripped title repackaging-SHAPED? */
export function isRepackagingShaped(title: string): boolean {
  const line = title.trim();
  if (line.startsWith("🚨")) return true;
  return ALL_CAPS_RUN.test(line) || JUST_VERB.test(line);
}

/**
 * The ceiling the X capture-gate prompt asks for on secondhand repackaging, enforced
 * deterministically by `clampScores` at its x.ts call site. It lives beside the predicate
 * because shape + cap are one X policy; `clampScores` itself is generic mechanism and
 * deliberately holds no default.
 */
export const REPACKAGING_SCORE_CAP = 0.8;

/**
 * When the deterministic clamp merged (#454, `1c6cc01`). Rows captured before this
 * instant are OUT of the "shaped above the cap" metric: `upsertCandidate` keeps
 * `GREATEST(stored, incoming)`, so a pre-clamp high is ratcheted in forever and no
 * later capture can lower it — a target-0 count over those rows measures the ratchet,
 * not the clamp.
 */
export const REPACKAGING_CLAMP_SHIPPED_AT = new Date("2026-08-19T12:04:10Z");
