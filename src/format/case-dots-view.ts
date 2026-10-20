/**
 * The reader's `<CaseBoard view="dots">`: one square per shown case, grouped
 * by status, before the board's rows (which stay). Server-only: `renderWikiHtml`
 * passes it to `formatWebHtml` as `caseDotsView`, so the chat bundle never
 * carries it. The squares are buttons named by case id and status; one tab
 * stop for the set (the arrow keys move between squares), and pressing one
 * says its `kort:` in a polite live line. The client half is
 * `wiki-visuals.ts`.
 */

import { caseKort, caseStatusLabel, groupCases, type BoardCase, type CaseLabels, type CaseStatus } from "./case-board.ts";
import { escapeHtml } from "./markdown-core.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { visibleText } from "./report-top.ts";

/** A glyph per status, so a square never rests on its colour alone. */
const GLYPH: Record<CaseStatus | "unknown", string> = { hold: "‖", wait: "…", wrong: "✕", none: "–", ok: "✓", unknown: "?" };

export function caseDotsViewHtml(cases: readonly BoardCase[], labels: CaseLabels): string {
  if (cases.length === 0) return "";
  let first = true;
  const groups = groupCases([...cases])
    .map((g) => {
      const label = caseStatusLabel(g.status, labels);
      const glyph = GLYPH[g.status];
      const dots = g.cases
        .map((c) => {
          const name = `${c.id}: ${label}`;
          const kort = visibleText(caseKort(c));
          const say = kort ? `${c.id} — ${label}: ${kort}` : `${c.id} — ${label}`;
          const tab = first ? "0" : "-1";
          first = false;
          return (
            `<button type="button" class="cb-dot cb-dot-${g.status}" tabindex="${tab}" aria-pressed="false" ` +
            `aria-label="${escapeHtml(name)}" title="${escapeHtml(name)}" data-cb-say="${escapeHtml(say)}"><span aria-hidden="true">${glyph}</span></button>`
          );
        })
        .join("");
      return (
        `<div class="cb-dots-group" data-status="${g.status}"><span class="cb-dots-label"><span aria-hidden="true">${glyph} </span>` +
        `${escapeHtml(label)} · ${g.cases.length}</span><span class="cb-dots-row">${dots}</span></div>`
      );
    })
    .join("");
  return `<div class="cb-dots" ${READER_ONLY_ATTR} role="group" aria-label="Cases by status">${groups}<p class="cb-dots-say" aria-live="polite"></p></div>`;
}
