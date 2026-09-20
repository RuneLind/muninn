/**
 * The lint GROUP card's status chip — what it says, and what colour it is.
 *
 * Its own module because `wiki-gardener-browser.ts` reads `window` at module
 * scope, so nothing in it can be unit-tested; the `wiki-gardener-strip.ts` /
 * `-sources.ts` / `-wiring.ts` split is the same rule. Pure and DOM-free.
 */

/**
 * `2 applied · 1 stale` — the chip's TEXT.
 *
 * A group card renders one chip over N rows that can be in different statuses,
 * which on a stopped group reads `applied` off `rows[0]` and claims the whole
 * fix landed. Counts are in the rows' own order of first appearance, so the chip
 * is stable across re-renders.
 */
export function groupStatusSummary(statuses: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(" · ");
}

/**
 * Which status TONE the chip takes, as a function of the whole set.
 *
 * The chip summarises N statuses, so a class read off one row is a claim the
 * text beside it denies: a stopped group rendered `chip-applied` over
 * `1 applied · 1 draft · 1 stale`. Precedence is by what the reviewer still has
 * to do, and the WHOLE order is a decision rather than the first three rungs
 * plus a tail — a permutation of the middle four survived the round that pinned
 * the ends, so every adjacent pair is pinned by a table test now:
 *
 *  `draft` — the card offers a verb, whatever else it holds.
 *  `approved` — a decision is in flight over these pages; the next Accept 409s.
 *  `error` — an apply failed and the reviewer has to look.
 *  `stale` — the page moved under the draft; re-propose.
 *  `rejected` — dismissed on purpose; nothing is owed.
 *  `applied` — done, and only an all-`applied` group reads as done.
 *
 * `error` over `stale` because a failure asks a question a retry does not, and
 * `stale` over `rejected` because a dismissal is an answer already given.
 */
const CHIP_TONE_ORDER = ["draft", "approved", "error", "stale", "rejected", "applied"] as const;

export function groupChipTone(statuses: readonly string[]): string {
  const present = new Set(statuses);
  for (const status of CHIP_TONE_ORDER) if (present.has(status)) return status;
  // A status this file has never heard of keeps its own class, so a new one
  // renders as itself rather than silently borrowing `draft`'s colour.
  return statuses[0] ?? "draft";
}
