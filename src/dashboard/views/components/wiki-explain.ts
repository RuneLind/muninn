/**
 * Pure, side-effect-free helpers for the /wiki reader's **Select-to-Explain**
 * pill. Split out of `wiki-browser.ts` (which runs DOM code at module load, so
 * it can't be imported in tests) so the label-truncation + URL-building logic
 * can be unit-tested directly — the same split rationale as `wiki-filter.ts`
 * and `wiki-ask-render.ts`.
 */

/** Client-side cap on the selected passage — mirrors the server's
 *  `EXPLAIN_SELECTION_MAX` (`src/wiki/explain-context.ts`) so an over-long
 *  selection is trimmed identically before it rides the GET URL. */
export const EXPLAIN_SEL_MAX = 1500;

/** How many chars of the selection to echo in the turn's display label. */
export const EXPLAIN_LABEL_CHARS = 80;

/** Display-only turn label, e.g. `Explain: "the coverage gate…"`. This is what
 *  the user sees in the history list + answer headline; the SERVER builds its
 *  own question from `sel`, so this never has to be exact. */
export function explainLabel(sel: string): string {
  const s = sel.trim().replace(/\s+/g, " ");
  const short = s.length > EXPLAIN_LABEL_CHARS ? s.slice(0, EXPLAIN_LABEL_CHARS) + "…" : s;
  return 'Explain: "' + short + '"';
}

/** Build the `/api/wiki/explain` GET URL, omitting empty `ctx`/`history`/`wiki`
 *  params and capping `sel` at `EXPLAIN_SEL_MAX` to match the server. */
export function buildExplainUrl(opts: {
  sel: string;
  page: string;
  wiki?: string;
  ctx?: string;
  history?: string;
}): string {
  // Cap by code points, not UTF-16 units — a plain slice can bisect a surrogate
  // pair and make encodeURIComponent throw on the lone half.
  const sel =
    opts.sel.length > EXPLAIN_SEL_MAX ? [...opts.sel].slice(0, EXPLAIN_SEL_MAX).join("") : opts.sel;
  let url = "/api/wiki/explain?sel=" + encodeURIComponent(sel);
  url += "&page=" + encodeURIComponent(opts.page);
  if (opts.wiki) url += "&wiki=" + encodeURIComponent(opts.wiki);
  if (opts.ctx) url += "&ctx=" + encodeURIComponent(opts.ctx);
  if (opts.history) url += "&history=" + encodeURIComponent(opts.history);
  return url;
}
