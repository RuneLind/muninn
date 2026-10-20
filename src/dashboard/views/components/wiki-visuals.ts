/**
 * The reader's `<Chart>` toggles. The server draws every variant
 * (`src/format/chart-view.ts`); this file only shows one: Chart or Table,
 * and the variant (points or % of target, the bar as decided or after).
 * No third-party imports; part of the /wiki bundle via `wiki-browser.ts`.
 *
 * State lives on the DOM (`aria-pressed`, `hidden`, the `vc-mode-table`
 * class), so a fresh render starts every chart as the server wrote it, and
 * one document-level listener serves every render without re-wiring.
 */

/** Press `btn` and release the other buttons of its group. */
function pressOne(btn: HTMLElement): void {
  btn.closest(".vc-group")?.querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
}

/** Apply one toggle click; false when `target` is not a chart toggle. */
export function applyChartToggle(target: Element | null): boolean {
  const btn = target?.closest?.<HTMLElement>("button[data-vc-mode], button[data-vc-variant]");
  const chart = btn?.closest<HTMLElement>("section.vc");
  if (!btn || !chart || chart.closest(".wiki-ref-peek")) return false;
  const mode = btn.dataset.vcMode;
  if (mode) {
    chart.classList.toggle("vc-mode-table", mode === "table");
  } else {
    const id = btn.dataset.vcVariant;
    chart.querySelectorAll<HTMLElement>(":scope > .vc-plot").forEach((plot) => {
      plot.hidden = plot.dataset.vcPlot !== id;
    });
  }
  pressOne(btn);
  return true;
}

let installed = false;

/** Install the one delegated listener; later calls do nothing. */
export function initWikiVisuals(doc: Document = document): void {
  if (installed) return;
  installed = true;
  doc.addEventListener("click", (e) => {
    applyChartToggle(e.target instanceof Element ? e.target : null);
  });
}
