/**
 * Lint check 11 — the top of a report page reads at a glance (reader lenses
 * PR 2). Report-only warnings; neither proposes a fix, since both need the
 * author to rewrite a sentence.
 *
 * | check                     | fires when                                                                 |
 * |---------------------------|----------------------------------------------------------------------------|
 * | `decision-first-sentence` | an id-led `<DecisionLog>` item, not dimmed, whose first sentence (what the |
 * |                           | Overview lens shows, D6) is over `FIRST_SENTENCE_MAX` (160) visible chars  |
 * | `status-row-long`         | a `<StatusRows>` row over `STATUS_ROW_MAX` (160) chars as written (D11)    |
 *
 * Both read the page through the renderer's own parser and the shared rules in
 * `src/format/report-top.ts`, so the finding and the reader agree on where a
 * first sentence ends and what a row is. A struck or superseded item is
 * skipped: it is history, and the reader dims it.
 */

import { parseBlocks } from "../format/markdown-ast.ts";
import { decisionLogEntries } from "../format/question.ts";
import {
  FIRST_SENTENCE_MAX,
  firstSentence,
  STATUS_ROW_MAX,
  statusRowBlocks,
  visibleText,
} from "../format/report-top.ts";
import { fencedLineMask, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { stripFrontmatter, type WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const REPORT_TOP_LINT_CHECKS = ["decision-first-sentence", "status-row-long"] as const;

/** `text` cut to `n` chars with an ellipsis, on one line, quoted. */
function quote(text: string, n = 50): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > n ? `${flat.slice(0, n - 1)}…` : flat);
}

/** The 1-based line of the first unfenced body line at or after `from`
 *  (0-based) that `test` accepts; undefined when none does. */
function findLine(lines: readonly string[], fenced: readonly boolean[], from: number, test: (line: string) => boolean): number | undefined {
  for (let i = from; i < lines.length; i++) {
    if (!fenced[i] && test(lines[i]!)) return i + 1;
  }
  return undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function checkReportTop(page: WikiPageMeta, rawContent: string): LintFinding[] {
  const hasLog = rawContent.includes("<DecisionLog");
  const hasRows = rawContent.includes("<StatusRows");
  if (!hasLog && !hasRows) return [];
  const blocks = parseBlocks(stripFrontmatter(rawContent));
  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  const body = frontmatterEndLine(lines);
  const findings: LintFinding[] = [];

  if (hasLog) {
    // Items are located in source order, each search starting after the last
    // hit, so a repeated id points at its own item.
    let from = body;
    for (const e of decisionLogEntries(blocks)) {
      const idLine = new RegExp(`^\\s*(?:[-*+]|\\d+[.)])\\s+(?:~~)?\\*\\*${escapeRe(e.id)}\\*\\*`);
      const line = findLine(lines, fenced, from, (l) => idLine.test(l));
      if (line !== undefined) from = line;
      if (e.dim) continue;
      const first = visibleText(firstSentence(e.itemText));
      if (first.length <= FIRST_SENTENCE_MAX) continue;
      findings.push({
        check: "decision-first-sentence",
        relPath: page.relPath,
        message: `DecisionLog item ${e.id}: the first sentence is ${first.length} chars (max ${FIRST_SENTENCE_MAX}) — Overview shows only it, so let it state the decision on its own (${quote(first)})`,
        ...(line !== undefined ? { line } : {}),
      });
    }
  }

  if (hasRows) {
    let from = body;
    for (const rows of statusRowBlocks(blocks)) {
      const open = findLine(lines, fenced, from, (l) => l.trim().startsWith("<StatusRows"));
      if (open !== undefined) from = open;
      for (const row of rows) {
        const head = row.text.split("\n")[0]!.slice(0, 40);
        const line = findLine(lines, fenced, from, (l) => l.includes(head));
        if (line !== undefined) from = line;
        if (row.text.length <= STATUS_ROW_MAX) continue;
        findings.push({
          check: "status-row-long",
          relPath: page.relPath,
          message: `<StatusRows> row of ${row.text.length} chars (max ${STATUS_ROW_MAX}) — a row reads at a glance; move the detail into the page (${quote(row.text)})`,
          ...(line !== undefined ? { line } : {}),
        });
      }
    }
  }
  return findings;
}
