/// <reference lib="dom" />
/**
 * Client half of `<Embed src="…" />` (see `src/format/embed.ts`): the server
 * render leaves `<figure class="embed" data-embed-src data-embed-height
 * data-embed-title>` around a fallback line; this swaps the line for the same
 * sandboxed `<iframe>` the reader uses for a standalone explainer, pointed at
 * `/api/wiki/html?relPath=<resolved>` on the active wiki.
 *
 *  - Resolution is against the OPEN page's relPath (`..` allowed, escaping the
 *    root refused), because the server render does not know which page it is
 *    rendering. A `src` that escapes leaves the fallback line in place.
 *  - `sandbox="allow-scripts allow-popups"` — identical to the explainer view's
 *    frame, and deliberately without `allow-same-origin`, so the embedded page
 *    runs on an opaque origin and cannot reach the reader's cookies or DOM.
 *  - Idempotent: a figure already carrying a frame is left alone, so a repaint
 *    that re-runs the enhancers never stacks two frames.
 */

import { resolveEmbedRelPath } from "../../../format/embed.ts";

export const EMBED_FRAME_CLASS = "wiki-embed-frame";

export function enhanceEmbeds(
  root: ParentNode,
  pageRelPath: string,
  withWiki: (url: string) => string,
): void {
  const figures = root.querySelectorAll<HTMLElement>("figure.embed[data-embed-src]");
  for (const fig of Array.from(figures)) {
    if (fig.querySelector(`iframe.${EMBED_FRAME_CLASS}`)) continue;
    const src = fig.dataset.embedSrc ?? "";
    const resolved = resolveEmbedRelPath(pageRelPath, src);
    if (resolved === null) continue;
    const height = Number(fig.dataset.embedHeight) || 640;
    const frame = document.createElement("iframe");
    frame.className = EMBED_FRAME_CLASS;
    frame.setAttribute("sandbox", "allow-scripts allow-popups");
    frame.setAttribute("loading", "lazy");
    frame.title = fig.dataset.embedTitle || src;
    frame.style.height = `${height}px`;
    frame.src = withWiki("/api/wiki/html?relPath=" + encodeURIComponent(resolved));
    const fallback = fig.querySelector(".embed-fallback");
    if (fallback) fallback.replaceWith(frame);
    else fig.appendChild(frame);
  }
}
