/**
 * The `/wiki/gardener` lint group labels. Pure and DOM-free so a test can load
 * it (`wiki-gardener-browser.ts` touches `document` at import time).
 */
// TYPE-ONLY: a value import from the lint engine would drag `node:path` + `Bun.file`
// into the browser bundle. The limits module is dependency-free.
import type { LintCheck } from "../../../wiki/lint.ts";
import { DRAFT_LANE_MAX_DAYS } from "../../../wiki/lint-drift-limits.ts";

// Grouped display order + labels. `Record<LintCheck, string>` so a check added to
// the engine cannot compile without a label here — `renderLint` iterates THIS map,
// so an unlabelled check renders nothing at all, findings and count included.
export const LINT_LABELS: Record<LintCheck, string> = {
  "broken-link": "Broken links",
  orphan: "Orphan pages",
  "stale-updated": "Unusable updated: (missing / unparseable / future)",
  "missing-sources": "Missing sources",
  "index-truncation": "Truncated wikilinks (unclosed [[)",
  "nested-annotation": "Markup nested inside a wikilink",
  "unrendered-fact-mark": "Fact-check marks that render as literal markup",
  "stem-collision": "Same-stem pages (one is hidden from the wiki)",
  "question-block": "Question blocks the DecisionLog cannot close",
  "same-work-no-link": "Same work, no link between the pages",
  "series-unnamed": "Linked pages that declare no series:",
  "series-inconsistent": "Half-written series: (spelling, label, or a missing member)",
  "draft-lane-stale": `Draft lanes older than ${DRAFT_LANE_MAX_DAYS} days`,
  "loose-sql": "SQL fences outside a <Query>",
  "case-table": "Case tables with statuses and no <CaseBoard>",
  "long-page-no-fold": "Long pages with no <Fold>",
  "decision-first-sentence": "DecisionLog first sentences over 160 chars",
  "status-row-long": "<StatusRows> rows over 160 chars",
};

/** A group's heading: its label, plus `(info)` when every finding in it carries
 *  `severity: "info"` — the suffix is read off the findings, never the label. */
export function lintGroupLabel(check: LintCheck, findings: readonly { severity?: "info" }[]): string {
  const info = findings.length > 0 && findings.every((f) => f.severity === "info");
  return info ? `${LINT_LABELS[check]} (info)` : LINT_LABELS[check];
}
