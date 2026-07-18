/// <reference lib="dom" />
/**
 * Client-side tab switching for the CodeTabs block component in the /wiki
 * reader, the /research answer pane, and web chat. The server renders a
 * `.code-tabs` container with a `.code-tabs-bar` of `.code-tabs-tab` buttons and
 * a `.code-tabs-panels` list where the first tab + panel carry `.is-active`
 * (component-styles.ts hides the rest). This module wires each tab button so a
 * click moves `.is-active` onto that tab and its index-matched panel.
 *
 * Design (mirrors the wiki-mermaid enhancer's zero-cost + idempotent shape):
 *  - No-op when a root has no `.code-tabs` — nothing loads, nothing runs.
 *  - Purely structural + index-based (no data attributes) so it survives the
 *    web-chat sanitizer, which strips everything but an allowlist of classes.
 *  - Idempotent: a container already wired is skipped, so re-enhancing after an
 *    article swap or a chat re-render never double-binds the same nodes.
 *  - Fail-safe: with the enhancer absent or a container malformed, the
 *    server-rendered first panel simply stays visible (CSS-only), so CodeTabs
 *    degrades to "first tab shown" rather than breaking.
 */

const ENHANCED = "data-code-tabs-enhanced";

/** Wire every not-yet-enhanced `.code-tabs` container under `root`. */
export function enhanceCodeTabs(root: ParentNode): void {
  root.querySelectorAll(".code-tabs").forEach((container) => {
    if (container.getAttribute(ENHANCED)) return;
    const tabs = Array.from(container.querySelectorAll(".code-tabs-tab"));
    const panels = Array.from(container.querySelectorAll(".code-tabs-panel"));
    if (tabs.length === 0 || panels.length === 0) return;
    container.setAttribute(ENHANCED, "1");
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t, j) => t.classList.toggle("is-active", i === j));
        panels.forEach((p, j) => p.classList.toggle("is-active", i === j));
      });
    });
  });
}
