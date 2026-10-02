/**
 * The page-TYPE icon that leads every /wiki rail row (`renderList`), in place of
 * the coloured type dot the other surfaces keep. An icon says what the page is
 * without a legend; a dot only said that two pages differ. One fixed 14px column
 * on every row, so a row's title starts at the same x whatever else it carries.
 *
 * `stroke="currentColor"`, coloured by `.ti-<type>` with the dot's own tokens
 * (`wiki-page.ts`). The `<title>` is the accessible name and the hover word.
 */

const PATHS = new Map<string, string>(Object.entries({
  plan: '<rect x="2.5" y="1.5" width="9" height="11" rx="1.5"/><path d="M5 5h4M5 7.5h4M5 10h2.5"/>',
  archive: '<rect x="1.5" y="2" width="11" height="3" rx="1"/><path d="M2.5 5v6.5h9V5M5.5 7.5h3"/>',
  explainer: '<rect x="1.5" y="2" width="11" height="10" rx="1.5"/><path d="M1.5 5h11"/>',
  flow: '<circle cx="3.5" cy="3.5" r="2"/><circle cx="10.5" cy="10.5" r="2"/><path d="M5.5 3.5h2a3 3 0 0 1 3 3v2"/>',
  concept:
    '<path d="M5.2 10h3.6M5.6 12.3h2.8M7 1.6a3.6 3.6 0 0 0-2.1 6.6c.4.3.6.8.6 1.3v.5h3v-.5c0-.5.2-1 .6-1.3A3.6 3.6 0 0 0 7 1.6z"/>',
  entity: '<circle cx="7" cy="4.6" r="2.4"/><path d="M2.5 12.5a4.5 4.5 0 0 1 9 0"/>',
  source: '<path d="M7 3.5C5.6 2.5 3.6 2.3 1.8 2.6v8.6c1.8-.3 3.8-.1 5.2.9 1.4-1 3.4-1.2 5.2-.9V2.6C10.4 2.3 8.4 2.5 7 3.5zM7 3.5v8.6"/>',
  analysis: '<path d="M2 12.5h10M3.8 10V7M7 10V3.5M10.2 10V5.5"/>',
  note: '<path d="M9.5 2.2l2.3 2.3-6.6 6.6-2.9.6.6-2.9z"/>',
  blog: '<circle cx="3.6" cy="10.4" r="1.1"/><path d="M2.5 6.5a5 5 0 0 1 5 5M2.5 2.5a9 9 0 0 1 9 9"/>',
}));
/** A page with a folded corner — any type the reader has no icon for. */
const GENERIC = '<path d="M3 1.5h5.5L11 4v8.5H3z"/><path d="M8.5 1.5V4H11"/>';

const escAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The icon's markup for a page type, matched case-insensitively (a `Map`, so an
 *  inherited key like `constructor` is no icon). An empty type reads as `page`. */
export function railTypeIconHtml(type: string | undefined): string {
  const t = (type || "").trim();
  const key = t.toLowerCase();
  // The class part as ONE token: `design doc` must not emit a stray `doc` class.
  const slug = key.replace(/[^a-z0-9-]/g, "-");
  const word = escAttr(t || "page");
  return (
    `<svg class="wiki-type-icon ti-${slug || "page"}" viewBox="0 0 14 14" width="14" height="14" fill="none"` +
    ` stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"` +
    ` role="img" aria-label="${word}"><title>${word}</title>${PATHS.get(key) ?? GENERIC}</svg>`
  );
}
