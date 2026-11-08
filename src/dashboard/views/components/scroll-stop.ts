/// <reference lib="dom" />
/**
 * One rule for a picture box that may scroll sideways, shared by `<Diagram>`
 * (`wiki-visuals.ts`, whose state table above `syncDiagramStop` this follows)
 * and the mermaid enhancer (`wiki-mermaid.ts`): while its drawing is wider than
 * the box the box is a named, focusable region (`role="region"`, `aria-label`,
 * `tabindex="0"`) so the keyboard can scroll it; while it fits it has none of
 * the three, except that a box holding focus keeps the stop until blur. This
 * code never moves focus. No imports: it lands in the /research bundle too.
 */
export function syncScrollStop(box: HTMLElement, label: string): void {
  if (box.scrollWidth > box.clientWidth) {
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", label);
    box.tabIndex = 0;
  } else if (box.ownerDocument.activeElement !== box) {
    box.removeAttribute("role");
    box.removeAttribute("aria-label");
    box.removeAttribute("tabindex");
  }
}
