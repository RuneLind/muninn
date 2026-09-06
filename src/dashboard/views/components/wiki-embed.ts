/// <reference lib="dom" />
/**
 * Client half of `<Embed src="…" />` (see `src/format/embed.ts`): the server
 * render leaves `<figure class="embed" data-embed-src data-embed-height
 * data-embed-title>` around a fallback line; this swaps the line for the same
 * sandboxed `<iframe>` the reader uses for a standalone explainer, pointed at
 * `/api/wiki/html?relPath=<resolved>` on the active wiki.
 *
 *  - Every decision — resolve against the OPEN page's relPath (`..` allowed,
 *    escaping the root refused), skip a figure already carrying a frame, plan
 *    nothing for an unknown page relPath — is `planEmbeds`, DOM-free and
 *    unit-tested; this module only reads the figures and applies the plan.
 *  - `sandbox="allow-scripts allow-popups"` — identical to the explainer view's
 *    frame, and deliberately without `allow-same-origin`, so the embedded page
 *    runs on an opaque origin and cannot reach the reader's cookies or DOM.
 *  - Runs at the ARTICLE render site only. The Ask/Explain/fact-check answer
 *    panes and `/research` have no page relPath to resolve against, so an
 *    `<Embed>` there stays its fallback line.
 */

import { planEmbeds, type EmbedFigure } from "../../../format/embed.ts";

export const EMBED_FRAME_CLASS = "wiki-embed-frame";

export function enhanceEmbeds(
  root: ParentNode,
  pageRelPath: string,
  withWiki: (url: string) => string,
): void {
  const figures = Array.from(root.querySelectorAll<HTMLElement>("figure.embed[data-embed-src]"));
  const items: EmbedFigure[] = figures.map((fig) => ({
    hasFrame: fig.querySelector(`iframe.${EMBED_FRAME_CLASS}`) !== null,
    src: fig.dataset.embedSrc ?? "",
    height: fig.dataset.embedHeight ?? "",
    title: fig.dataset.embedTitle ?? "",
  }));
  for (const plan of planEmbeds(items, pageRelPath)) {
    const fig = figures[plan.index]!;
    const frame = document.createElement("iframe");
    frame.className = EMBED_FRAME_CLASS;
    frame.setAttribute("sandbox", "allow-scripts allow-popups");
    frame.setAttribute("loading", "lazy");
    frame.title = plan.title;
    frame.style.height = `${plan.height}px`;
    const url = withWiki("/api/wiki/html?relPath=" + encodeURIComponent(plan.relPath));
    frame.setAttribute("src", url);
    // The standalone viewer is reachable ONLY from here: the embedded html is
    // shadowed out of the page list, and the markdown renderer keeps no
    // relative links. Same url as the frame, so the two cannot disagree.
    const open = document.createElement("a");
    open.className = "embed-open";
    open.setAttribute("href", url);
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open in new tab ↗";
    const fallback = fig.querySelector(".embed-fallback");
    if (fallback) fallback.replaceWith(frame);
    else fig.appendChild(frame);
    fig.appendChild(open);
  }
}
