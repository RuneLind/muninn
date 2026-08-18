/**
 * Pure, DOM-free tally + summary helpers for the /wiki reader's fact-check meta
 * line. Split out of `wiki-browser.ts` (which has DOM side effects at module load,
 * so it can't be imported in tests) so these unit-test directly — the same split
 * rationale as `wiki-ask-render.ts` / `wiki-filter.ts`.
 */

/** Per-outcome tally for a committed fact-check turn (drives the honest meta line). */
export interface ClaimOutcomeCounts {
  verified?: number;
  unverifiable?: number;
  timeout?: number;
  skipped?: number;
  error?: number;
}

/** Minimal shape `tallyClaimOutcomes` reads off a checklist row (a full `ClaimRow`
 *  structurally satisfies it). */
export interface OutcomeRow {
  status: string;
  outcome?: string;
}

/** Tally a checklist's per-outcome counts (verified / unverifiable / timeout /
 *  skipped / error) for the committed turn's honest meta line. Rows that never
 *  reached `done` are skipped entirely — a still-pending row has no outcome and
 *  must NOT default to `verified` and inflate the count. A `done` row with an
 *  absent outcome (pre-outcome server) counts as `verified` (it was a real verdict
 *  block). */
export function tallyClaimOutcomes(claims: OutcomeRow[] | undefined): ClaimOutcomeCounts {
  const counts: ClaimOutcomeCounts = {};
  (claims || []).forEach((c) => {
    if (c.status !== "done") return;
    const k = c.outcome || "verified";
    if (k === "verified" || k === "unverifiable" || k === "timeout" || k === "skipped" || k === "error") {
      counts[k] = (counts[k] || 0) + 1;
    }
  });
  return counts;
}

/** Render an outcome tally as "5 checked · 1 unverifiable · 2 skipped", omitting
 *  zero-count categories (empty ⇒ empty string). The `verified` outcome (= "got a
 *  ruling", covering ✅/⚠️/❌) is displayed as "checked" — a debunked ❌ claim did
 *  get checked, it wasn't "verified" as true. The wire enum stays `verified`. */
export function factcheckOutcomeSummary(counts: ClaimOutcomeCounts): string {
  const parts: string[] = [];
  const push = (n: number | undefined, label: string) => { if (n) parts.push(n + " " + label); };
  push(counts.verified, "checked");
  push(counts.unverifiable, "unverifiable");
  push(counts.timeout, "timed out");
  push(counts.skipped, "skipped");
  push(counts.error, "failed");
  return parts.join(" · ");
}

/**
 * The ➕ "Add to article" success line, folding in the route's `supersededNote`
 * when the write removed marks from a previous check.
 *
 * The note is the ONLY place a reader is ever told that clicking ➕ deleted the
 * `<Fact>` marks an earlier ✎ Integrate put on the page — the write is silent
 * otherwise, and the reload that follows shows a page whose underlines are simply
 * gone. A fixed "✓ Added to article" makes that look like a rendering bug.
 *
 * Pure so it unit-tests; the caller does the DOM. An absent/blank note ⇒ the plain
 * confirmation, byte-identical to what shipped before.
 *
 * Joined with ": ", not " — ": the note is `supersededMarksNote`'s output, which
 * already carries an em-dash between its lead and its per-route tail, and a second
 * one made the line read as three peer clauses instead of a confirmation and its
 * explanation.
 */
export function appendSuccessStatus(supersededNote?: string): string {
  const note = (supersededNote || "").trim();
  return note ? "✓ Added to article: " + note : "✓ Added to article";
}
