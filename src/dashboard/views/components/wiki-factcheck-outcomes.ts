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
