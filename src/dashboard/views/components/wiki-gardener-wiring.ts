/**
 * Pure, DOM-free HTML builder for the /wiki/gardener proposal card's "Wiring on
 * approve" preview — what the apply step's wire stage WILL do: the planned
 * index.md line (or the entity-skip note) and the related pages that will gain an
 * inbound `## See also` link. Computed read-time by the route from the proposal's
 * `related_pages` + the live wiki index (no extra persisted state); this module
 * just lays out the already-computed model, so the link/skip decisions stay
 * unit-testable without a DOM — same split rationale as `wiki-gardener-sources.ts`.
 */

import { escHtml as esc } from "./escape.ts";

/** The read-time wiring projection the route attaches to a reviewable proposal. */
export interface WiringPreview {
  /** The planned `- [[Title]] — …` index line, or null (skipped / no section). */
  indexLine: string | null;
  /**
   * Why the index insertion is skipped, or null when a line IS planned:
   *  - `"entity"` — an entity page (the Entities index is split People /
   *    Organizations / Products, which one isn't derivable — file manually);
   *  - `"not-in-policy"` — the kind isn't in this wiki's cataloging policy
   *    (`catalogKinds`), e.g. a `source` page on a concept-only wiki.
   */
  indexSkip: "entity" | "not-in-policy" | null;
  /** Titles of related pages that will gain an inbound See-also link (resolved, ≤3). */
  seeAlso: string[];
  /** True on a pre-migration row (`related_pages` NULL) — no inbound-link data. */
  legacyNoRelated: boolean;
}

/** Render the "Wiring on approve" block; returns "" for a null model (terminal rows). */
export function wiringHtml(w: WiringPreview | null | undefined): string {
  if (!w) return "";

  let indexItem: string;
  if (w.indexSkip === "entity") {
    indexItem = "skipped (entity — file manually)";
  } else if (w.indexSkip === "not-in-policy") {
    indexItem = "skipped (not in this wiki's cataloging policy)";
  } else if (w.indexLine) {
    indexItem = `<code>${esc(w.indexLine)}</code>`;
  } else {
    indexItem = "none";
  }

  let linkItem: string;
  if (w.legacyNoRelated) {
    linkItem = "no related-pages data (pre-migration proposal)";
  } else if (w.seeAlso.length) {
    linkItem = w.seeAlso.map((t) => esc(t)).join(", ");
  } else {
    linkItem = "none";
  }

  return (
    '<div class="gard-section-label">Wiring on approve</div><ul class="gard-wiring">' +
    `<li><span class="gw-k">index entry:</span> ${indexItem}</li>` +
    `<li><span class="gw-k">inbound links:</span> ${linkItem}</li>` +
    "</ul>"
  );
}
