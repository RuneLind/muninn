/**
 * The selectors the in-page ref linker (`wiki-ref-links.ts`) and the
 * cross-page id matcher (`wiki-cross-refs.ts`) share. Their own module, so
 * the linker can call the matcher without an import cycle.
 */

import { XREF_RUN_CLASS } from "../../../wiki/core/cross-ref.ts";
import { FACT_CHIP_CLASS } from "../../../wiki/core/live-facts-chip.ts";

/** PR 3b's live chip beside a key or PR mention. */
export const FACT_CHIP_SELECTOR = `.${FACT_CHIP_CLASS}`;

export const PEEK_CLASS = "wiki-ref-peek";

// `.tl-lanes` and a glossary's `.gl-tip`: hidden text (visually hidden labels, a
// role=tooltip definition), where a link would be an unseen tab stop. A
// cross-page id run (`D9 i [[page]]`) waits in its wrapper for the linked
// page's answer: it never links to this page's item. A live chip's text
// (PR 3b) is reader chrome, never a reference.
export const REF_SKIP =
  `a, code, pre, summary, h1, h2, h3, h4, h5, h6, button, textarea, input, select, svg, script, style, .mermaid, .query-result, .tl-lanes, .gl-tip, .${XREF_RUN_CLASS}, ${FACT_CHIP_SELECTOR}`;

/** The inline elements the text before an id is read back through; any other
 *  element (a heading, a list, a fold, a `<br>`) ends the read-back. */
export const INLINE = "strong, em, b, i, u, s, del, mark, code, kbd, sup, sub, small, abbr, span, a";
