/**
 * A single gate card's drift note and Approve button (finding 63).
 *
 * Its own module because `wiki-gardener-browser.ts` reads `window` at module
 * scope and cannot be unit-tested (the `wiki-gardener-group.ts` rule). Pure and
 * DOM-free.
 *
 * A drifted row keeps an ENABLED Approve: the apply's CAS refuses it and marks
 * the row `stale`, which frees its topic key at once. Reject frees the key too,
 * but the drafters skip a recently rejected topic for the suppression window
 * (`GARDENER_DEFAULTS.rejectedSkipDays`), so a card with only Reject left
 * delays the re-draft by that window.
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
export function approveButtonHtml(opts: {
  factcheckLocked: boolean;
  drifted: boolean;
  factcheckUnknown?: boolean;
}): string {
  if (opts.factcheckUnknown) {
    return `<button class="gard-btn gard-approve" data-action="approve" data-fc-locked disabled title="${FACTCHECK_UNKNOWN_TITLE}">Approve</button>`;
  }
  if (opts.factcheckLocked) {
    return `<button class="gard-btn gard-approve" data-action="approve" data-fc-locked disabled title="Drafted without the current fact-check — redraft it first">Approve</button>`;
  }
  if (opts.drifted) {
    return `<button class="gard-btn gard-approve" data-action="approve" data-drifted title="The page changed since this was drafted — Approve writes nothing and marks it stale">Approve</button>`;
  }
  return `<button class="gard-btn gard-approve" data-action="approve">Approve</button>`;
}

/** The single card's Approve, from the row as the listing sends it: locked by
 *  the fact-check (or an unknown fact-check state) alone, never by drift. */
export function approveButtonFor(p: {
  factcheck?: { needsRedraft?: boolean } | null;
  factcheckUnknown?: boolean;
  drifted?: string | null;
}): string {
  return approveButtonHtml({
    factcheckLocked: !!p.factcheck?.needsRedraft,
    drifted: !!p.drifted,
    factcheckUnknown: !!p.factcheckUnknown,
  });
}

const FACTCHECK_UNKNOWN_TITLE = "The fact-check status could not be read — reload to retry";

/** The card note when the listing could not read the fact-checks: the lock this
 *  card would carry is unknown, so Approve stays locked until a reload reads it. */
export const FACTCHECK_UNKNOWN_NOTE =
  "Fact-check status unavailable: the saved checks could not be read, so Approve is locked until they can. Reload the page to retry.";
