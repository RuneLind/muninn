/**
 * Pure, DOM-free string builders for the `/summaries` doc panel's Fact check
 * section and the Latest rail badge. The answer itself goes through the wiki
 * reader's own renderer (`renderStreamingBody`: `formatWebHtml` + the
 * confidence chips), so a verdict block looks the same on both surfaces.
 */

import { escHtml } from "./escape.ts";
import { renderStreamingBody } from "./wiki-ask-render.ts";

export const FACTCHECK_VERDICTS = ["✅", "⚠️", "❌", "❓"] as const;

const VERDICT_LABEL: Record<string, string> = {
  "✅": "supported",
  "⚠️": "partly supported",
  "❌": "contradicted",
  "❓": "unverified",
};

/** A finished fact-check answer as reader HTML, sources clickable and every
 *  `Confidence: NN/100` line a band-coloured chip. */
export function factcheckAnswerHtml(answer: string): string {
  return renderStreamingBody(answer);
}

/** Count per verdict emoji, in the fixed ✅ ⚠️ ❌ ❓ order. */
export function factcheckVerdictCounts(claims: { verdict?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of FACTCHECK_VERDICTS) counts[v] = 0;
  for (const c of claims) {
    const v = c.verdict === "⚠" ? "⚠️" : c.verdict;
    if (v && v in counts) counts[v]! += 1;
  }
  return counts;
}

/** The verdict chips: one per verdict present, e.g. `✅ 3` `❌ 1`. */
export function factcheckVerdictChipsHtml(claims: { verdict?: string }[]): string {
  const counts = factcheckVerdictCounts(claims);
  return FACTCHECK_VERDICTS.filter((v) => counts[v]! > 0)
    .map(
      (v) =>
        `<span class="sum-fc-chip" data-verdict="${escHtml(VERDICT_LABEL[v]!)}" title="${counts[v]} ${escHtml(VERDICT_LABEL[v]!)}">` +
        `${v} ${counts[v]}</span>`,
    )
    .join("");
}

/** One row of the live checklist while a run streams. */
export interface FactcheckProgressRow {
  index: number;
  title: string;
  /** Absent while the claim is still being verified. */
  verdict?: string;
}

export function factcheckProgressHtml(rows: FactcheckProgressRow[]): string {
  if (!rows.length) return '<div class="sum-fc-wait">Extracting claims…</div>';
  return (
    '<ol class="sum-fc-progress">' +
    rows
      .map(
        (r) =>
          `<li class="${r.verdict ? "done" : "pending"}"><span class="sum-fc-v">${r.verdict ? escHtml(r.verdict) : "⏳"}</span>` +
          `<span class="sum-fc-t">${escHtml(r.title)}</span></li>`,
      )
      .join("") +
    "</ol>"
  );
}

/** "checked just now" / "checked 3 h ago" / "checked 2 d ago". */
export function factcheckCheckedLabel(createdAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 60) return "checked just now";
  if (s < 3600) return `checked ${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `checked ${Math.floor(s / 3600)} h ago`;
  return `checked ${Math.floor(s / 86_400)} d ago`;
}

/** The Latest rail badge: ✓ for a check with no ❌ claim, ❌N otherwise. */
export function factcheckBadgeHtml(badge: { bad: number; total: number } | undefined): string {
  if (!badge) return "";
  return badge.bad > 0
    ? `<span class="sum-fc-badge bad" title="Fact-checked: ${badge.bad} of ${badge.total} claims contradicted">❌${badge.bad}</span>`
    : `<span class="sum-fc-badge ok" title="Fact-checked: no claim contradicted">✓</span>`;
}
