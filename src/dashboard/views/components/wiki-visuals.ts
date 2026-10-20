/**
 * The reader's toggles for a `<Chart>` (MDX visual components PR 3). The
 * server draws every variant (`src/format/chart-view.ts`); this file only
 * shows one: Chart/Table, the scale or bar variant, and a steps series.
 * No third-party imports; part of the /wiki bundle (`wiki-browser.ts`).
 *
 * State lives on the DOM (`aria-pressed`, `hidden`, a class), so a page
 * render starts every chart as the server wrote it.
 */

const CHART_SELECTOR = "section.vc-chart.vc-has-plot";

/** One chart: wire its buttons once. */
function wireChart(chart: HTMLElement): void {
  if (chart.dataset.vcWired === "1") return;
  chart.dataset.vcWired = "1";
  chart.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest?.("button");
    if (!btn || !chart.contains(btn)) return;
    if (btn.dataset.vcMode) {
      const table = btn.dataset.vcMode === "table";
      chart.classList.toggle("vc-table-on", table);
      pressOne(btn, "vcMode");
    } else if (btn.dataset.vcVariant) {
      const id = btn.dataset.vcVariant;
      chart.querySelectorAll<HTMLElement>(":scope > .vc-plot").forEach((plot) => { plot.hidden = plot.dataset.vcVariant !== id; });
      pressOne(btn, "vcVariant");
    } else if (btn.dataset.vcSeries !== undefined) {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      const k = btn.dataset.vcSeries;
      chart.querySelectorAll<SVGGElement>(`g.vc-series[data-vc-series="${k}"]`).forEach((g) => g.classList.toggle("vc-off", !on));
    }
  });
}

/** Press `btn` and release its siblings in the same group. */
function pressOne(btn: HTMLElement, key: "vcMode" | "vcVariant"): void {
  const group = btn.closest(".vc-group");
  group?.querySelectorAll<HTMLElement>("button").forEach((b) => {
    if (b.dataset[key] !== undefined) b.setAttribute("aria-pressed", String(b === btn));
  });
}

/** Wire every chart under `root`. A no-op on a page with none, and inside a
 *  peek card (its chrome is stripped). */
export function enhanceVisuals(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(CHART_SELECTOR).forEach((chart) => {
    if (!chart.closest(".wiki-ref-peek")) wireChart(chart);
  });
}
