/**
 * A single gate card's drift note and Approve button (finding 63).
 *
 * Its own module because `wiki-gardener-browser.ts` reads `window` at module
 * scope and cannot be unit-tested (the `wiki-gardener-group.ts` rule). Pure and
 * DOM-free.
 *
 * A drifted row keeps an ENABLED Approve: the apply's CAS refuses it and marks
 * the row `stale`, which is the way out. A live `draft` row holds its topic key
 * (the partial unique index), and Reject puts the topic into the
 * recently-rejected suppression, so a card with only Reject left could never be
 * re-drafted.
 */

/** The note above a drifted single card's diff. */
export function singleDriftNote(drifted: string): string {
  return (
    `Page changed since this was drafted (${drifted}) — the diff below is against the page as it is now. ` +
    "Approve writes nothing and marks this proposal stale, which frees its topic for a fresh draft."
  );
}

/**
 * The Approve button. `data-fc-locked` (kept disabled by `unlockButtons`) is the
 * fact-check lock and nothing else; a drifted row's Approve stays enabled.
 */
export function approveButtonHtml(opts: { factcheckLocked: boolean; drifted: boolean }): string {
  if (opts.factcheckLocked) {
    return `<button class="gard-btn gard-approve" data-action="approve" data-fc-locked disabled title="Drafted without the current fact-check — redraft it first">Approve</button>`;
  }
  if (opts.drifted) {
    return `<button class="gard-btn gard-approve" data-action="approve" data-drifted title="The page changed since this was drafted — Approve writes nothing and marks it stale">Approve</button>`;
  }
  return `<button class="gard-btn gard-approve" data-action="approve">Approve</button>`;
}
