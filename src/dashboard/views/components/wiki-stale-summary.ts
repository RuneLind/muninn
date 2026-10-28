/**
 * The Stale check's counts outside the STALE tab (plan muninn-wiki-drift-check,
 * PR 2b): the rail badge, the article head's pill, the wiki home's line
 * beside the Index card and its Stale tab. Pure and DOM-free; `wiki-browser.ts` fetches and
 * paints.
 *
 * One source each, so every surface shows the tab's two numbers (D26):
 * confirmed stale status lines on the page, and its linking pages to check.
 * The rail and the home read the wiki-wide summary (`GET /api/wiki/stale`
 * with no page, D31); the pill reads the open page's report, the one the
 * STALE tab renders, and that report's counts overwrite the page's summary
 * row, so the rail never disagrees with the tab on the open page.
 */
import { escHtml as esc } from "./escape.ts";
import { staleCounts, staleCountsText, type StalePageCounts, type StaleReportView } from "./wiki-stale-tab.ts";

export interface StaleSummaryRow {
  relPath: string;
  title: string;
  staleLines: number;
  toCheck: number;
  changed?: boolean;
}

export interface StaleSummaryView {
  pages?: StaleSummaryRow[];
  totals?: { staleLines: number; toCheck: number; changedPages?: number };
  verdicts?: "unavailable";
  error?: string;
}

/** The summary's counts by relPath; rows with nothing stale are kept, at 0 · 0. */
export function staleCountMap(s: StaleSummaryView | null | undefined): Map<string, StalePageCounts> {
  const out = new Map<string, StalePageCounts>();
  if (!s || s.error || !Array.isArray(s.pages)) return out;
  for (const { r, c } of countedRows(s)) out.set(r.relPath, c);
  return out;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The rail row's badge: «⚠ N · M» with the words on hover, "" when both are 0. */
export function staleRailBadgeHtml(c: StalePageCounts | undefined): string {
  if (!c || (!c.staleLines && !c.toCheck)) return "";
  const words = staleCountsText(c).replace(/^⚠ /, "");
  return `<span class="wiki-stale-rail" data-stale-rail="${c.staleLines}·${c.toCheck}" title="${esc(words)}">⚠ ${c.staleLines} · ${c.toCheck}</span>`;
}

/** The article head's pill, from the open page's report: "" until it loads
 *  or when it failed, so the pill never shows another page's numbers. */
export function stalePillHtml(r: StaleReportView | null | undefined): string {
  if (!r || r.error) return "";
  const c = staleCounts(r);
  const none = !c.staleLines && !c.toCheck;
  return (
    `<button type="button" class="wiki-stale-pill${none ? " none" : ""}" data-stale-pill="${c.staleLines}·${c.toCheck}" title="Open the STALE tab">` +
    esc(staleCountsText(c)) +
    `</button>`
  );
}

/** Every row with its two counts read as numbers once, in the summary's order. */
const countedRows = (s: StaleSummaryView) =>
  (s.pages ?? []).map((r) => ({ r, c: { staleLines: Number(r.staleLines) || 0, toCheck: Number(r.toCheck) || 0 } }));

const isStale = (c: StalePageCounts) => c.staleLines + c.toCheck > 0;

/** The wiki's totals as the route sends them (confirmed stale lines, D26). */
const totalsOf = (s: StaleSummaryView): StalePageCounts => ({ staleLines: Number(s.totals?.staleLines) || 0, toCheck: Number(s.totals?.toCheck) || 0 });

/** The wiki home line: the wiki's totals and a way into the Stale tab. */
export function staleHomeLineHtml(s: StaleSummaryView | null | undefined): string {
  if (!s) return `<span class="wiki-stale-home-k">Stale check</span> <span class="wiki-stale-home-v">Loading…</span>`;
  if (s.error) return `<span class="wiki-stale-home-k">Stale check</span> <span class="wiki-stale-home-v">unavailable</span>`;
  const t = totalsOf(s);
  const pages = countedRows(s).filter((x) => isStale(x.c)).length;
  return (
    `<span class="wiki-stale-home-k">Stale check</span> ` +
    `<span class="wiki-stale-home-v" data-stale-home-totals="${t.staleLines}·${t.toCheck}">${esc(staleCountsText(t))}${pages ? ` on ${plural(pages, "page")}` : ""}</span>` +
    (s.verdicts === "unavailable" ? ` <span class="wiki-stale-home-note">verdicts unavailable</span>` : "") +
    (pages ? ` <button type="button" class="wiki-stale-home-open" data-stale-home-open>Show</button>` : "")
  );
}

/** The wiki home's Stale tab: each page with something stale, its two numbers. */
export function staleHomeBodyHtml(s: StaleSummaryView | null | undefined): string {
  if (!s) return `<div class="wiki-conn-empty">Loading…</div>`;
  if (s.error) return `<div class="wiki-conn-empty">Stale check unavailable: ${esc(s.error)}</div>`;
  const rows = countedRows(s);
  let html = `<div class="wiki-stale-home-head">${esc(staleCountsText(totalsOf(s)))}</div>`;
  if (s.verdicts === "unavailable") html += `<div class="wiki-stale-note">Verdicts are unavailable right now, so no status line shows as confirmed.</div>`;
  for (const { r, c } of rows) {
    if (!isStale(c)) continue;
    html +=
      `<div class="wiki-stale-home-row" data-relpath="${esc(r.relPath)}" data-stale-home-row="${c.staleLines}·${c.toCheck}">` +
      `<span class="wiki-stale-home-title">${esc(r.title || r.relPath)}</span>` +
      `<span class="wiki-stale-home-counts">${esc(staleCountsText(c))}</span>` +
      `<span class="wiki-stale-home-path">${esc(r.relPath)}</span>` +
      `</div>`;
  }
  // An unchanged page with unconfirmed hits is a row too (`changed: false`).
  const quiet = rows.filter((x) => x.r.changed && !isStale(x.c)).length;
  if (quiet > 0) html += `<div class="wiki-stale-note">+ ${plural(quiet, "changed page")} with nothing stale.</div>`;
  return html;
}

/** CSS for the badge, the pill and the home line and tab, injected by `wiki-page.ts`. */
export function wikiStaleSummaryStyles(): string {
  return `
    .wiki-stale-rail { font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 8px; white-space: nowrap; background: color-mix(in srgb, var(--status-warning) 22%, transparent); color: var(--text-primary); }
    .wiki-stale-pill-slot:empty { display: none; }
    .wiki-stale-pill { font: inherit; font-size: 11.5px; padding: 1px 8px; border-radius: 10px; cursor: pointer; border: 1px solid color-mix(in srgb, var(--status-warning) 55%, transparent); background: color-mix(in srgb, var(--status-warning) 14%, transparent); color: var(--text-primary); }
    .wiki-stale-pill.none { border-color: var(--border-primary); background: transparent; color: var(--text-dim); }
    .wiki-stale-pill:hover { border-color: var(--accent); }
    .wiki-stale-home { font-size: 12.5px; color: var(--text-secondary); padding: 8px 12px; margin: 0 0 12px; border-radius: 8px; border: 1px solid var(--border-primary); background: var(--bg-panel); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .wiki-stale-home-k { font-weight: 600; color: var(--text-muted); }
    .wiki-stale-home-note { font-size: 11px; color: var(--text-faint); }
    .wiki-stale-home-open { font: inherit; font-size: 11.5px; padding: 1px 8px; border-radius: 5px; border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--accent-light); cursor: pointer; }
    .wiki-stale-home-head { font-size: 13px; font-weight: 600; color: var(--text-secondary); padding: 4px 4px 10px; }
    .wiki-stale-home-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 8px 10px; margin: 4px 0; border-radius: 6px; border: 1px solid var(--border-primary); background: var(--bg-surface); cursor: pointer; }
    .wiki-stale-home-row:hover { border-color: var(--accent); }
    .wiki-stale-home-title { color: var(--text-primary); font-size: 13px; overflow-wrap: anywhere; }
    .wiki-stale-home-counts { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
    .wiki-stale-home-path { grid-column: 1 / -1; font-size: 11px; color: var(--text-faint); overflow-wrap: anywhere; }
  `;
}
