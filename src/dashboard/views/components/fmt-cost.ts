/**
 * `fmtCost` — the ONE money rule for a run or session cost.
 *
 * Its own leaf module (the `escape.ts` precedent) because the /wiki client
 * bundle needs the rule and `helpers.ts` is a barrel that also re-exports the
 * trace/span/search-summary helpers; importing it there would drag all of them
 * into a bundle that renders none. `helpers.ts` re-exports this, so every
 * existing caller — and `helpers-browser.ts` — is unchanged.
 */

/**
 * Format a run cost in USD.
 * - `null`/`undefined` ⇒ `—` (unknown: direct-SDK Haiku backends, drains,
 *   extractor rows, externally-traced chat turns).
 * - An explicit `0` ⇒ `$0.00` — truthful for subscription connectors
 *   (copilot-sdk / openai-compat report a real `0`), and deliberately distinct
 *   from the unknown dash.
 * - Sub-cent positive costs keep 4 decimals so a real ~$0.003 run isn't
 *   flattened to `$0.00` and confused with a genuine zero.
 */
export function fmtCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}
