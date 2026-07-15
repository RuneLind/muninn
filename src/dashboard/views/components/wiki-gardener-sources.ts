/**
 * Pure, DOM-free HTML builder for the /wiki/gardener proposal card's "Sources"
 * list. Split out of `wiki-gardener-browser.ts` (which touches the DOM at module
 * load, so it can't be imported in tests) so the link/plain-text decision is
 * unit-testable without a DOM — the same split rationale as
 * `wiki-gardener-strip.ts` / `wiki-filter.ts`.
 *
 * A proposal's `source_docs` JSONB deliberately keeps the RAW url as provenance,
 * including the machine-local `file://…` path huginn stored for a not-yet-
 * ingested doc. The review gate must show that path (provenance the reviewer can
 * see) WITHOUT pretending it is navigable, so only http/https urls render as an
 * `<a href>`; everything else renders as plain escaped text.
 */

import { escHtml as esc } from "./escape.ts";

/** Minimal shape of a proposal source doc (mirrors browser.ts `SourceDoc`). */
export interface GardenerSourceDoc {
  collection: string;
  docId: string;
  title: string;
  url: string;
}

/** A public, navigable URL — `http://` or `https://` only. */
export function isHttpUrl(u: string | null | undefined): boolean {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

/** Render the "Sources (N)" block; non-http(s) urls render as plain text. */
export function sourcesHtml(docs: GardenerSourceDoc[]): string {
  if (!docs.length) return "";
  let html =
    '<div class="gard-section-label">Sources (' + docs.length + ')</div><ul class="gard-sources">';
  docs.forEach((d) => {
    const label = d.title || d.docId;
    html += "<li>";
    html += isHttpUrl(d.url)
      ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(label)}</a>`
      : esc(label);
    html += ` <span class="gard-src-coll">${esc(d.collection)}</span></li>`;
  });
  return html + "</ul>";
}
