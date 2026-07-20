/**
 * Summary tiles (dashboard redesign, PR 1) — the stat row that sits under a
 * page header on `/agents`, `/models` and `/indexing`.
 *
 * `summaryTilesHtml(id)` renders an empty flex row; the page fills it client-side
 * from its JSON payload by joining `tileHtml({...})` calls (the builder is a
 * global installed by `summaryTilesScript()`).
 *
 * The tile CSS lives in `shared-styles.ts` (SHARED_STYLES) so it is available on
 * every dashboard page without per-page injection — like `.pulse-dot` /
 * `.shimmer-bar`. `summaryTilesStyles()` therefore returns "" (kept for the
 * three-export component convention).
 *
 * Attention rule: `tone` drives the attention border + label color. A tile with
 * no tone stays neutral (no colored border) — colored borders mean "needs
 * attention", nothing more.
 */

/** Styles live centrally in SHARED_STYLES (shared-styles.ts). */
export function summaryTilesStyles(): string {
  return "";
}

/** An empty flex row the page fills client-side via `tileHtml(...)`. */
export function summaryTilesHtml(id: string): string {
  return `<div class="summary-tiles" id="${id}"></div>`;
}

/**
 * Installs the global `tileHtml({label, value, sub, tone?})` builder used by the
 * three pages' client render loops. `tone` ∈ warning | success | error | info
 * (absent ⇒ neutral). All fields are text (escaped).
 */
export function summaryTilesScript(): string {
  return `
    if (!window.__summaryTiles) {
      window.__summaryTiles = true;
      window.tileHtml = function(t) {
        var e = window.esc || function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
        t = t || {};
        var cls = 's-tile' + (t.tone ? ' s-tile-' + String(t.tone) : '');
        var sub = (t.sub != null && t.sub !== '') ? '<div class="s-tile-sub">' + e(t.sub) + '</div>' : '';
        return '<div class="' + cls + '">' +
          '<div class="s-tile-label">' + e(t.label) + '</div>' +
          '<div class="s-tile-value">' + e(t.value) + '</div>' +
          sub +
        '</div>';
      };
    }
  `;
}
