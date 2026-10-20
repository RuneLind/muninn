/**
 * Lint check 17 — a `<Chart>` whose table its kind cannot read (MDX visual
 * components PR 3). One warning per finding, report-only:
 *
 * | kind     | fires when                                                              |
 * |----------|-------------------------------------------------------------------------|
 * | any      | the body holds no pipe table                                            |
 * | gap      | `value=`/`target=`/`gap=` (or `mark=`) names no column; a non-number in |
 * |          | a value column; a gap cell that differs from target − value             |
 * | steps    | `x=` names no column; `ref=` names no row; `normalize="ref"` without a  |
 * |          | ref row or with a zero ref value; a non-number in a series cell         |
 * | gate     | `bar=`/`pass=`/`hold=` names no column; a bar cell that does not start  |
 * |          | with a number; a non-number in the pass or hold column                  |
 * | funnel   | no «Av»/«Of» column; a non-number; a row larger than its parent         |
 *
 * A missing or unknown `kind=` is check 15's (`component-value`). The findings
 * are `readChart`'s (`src/format/chart-block.ts`), the function the reader's
 * view reads, over the same visible cell text: the reader reads a wikilink
 * sentinel as its link text, the lint the wikilink as its text
 * (`wikiLinksAsText`), so the two agree on every header and row name.
 */

import { chartBlocks, chartTableIndex, readChart, type ChartTable } from "../format/chart-block.ts";
import { readChartKind } from "../format/component-spec.ts";
import { parseBlocks, type Block } from "../format/markdown-ast.ts";
import { visibleText } from "../format/report-top.ts";
import { fencedLineMask, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { wikiLinksAsText } from "./decision-text.ts";
import type { LintFinding } from "./lint.ts";
import { stripFrontmatter, type WikiPageMeta } from "./store.ts";

export const CHART_LINT_CHECKS = ["chart-table"] as const;

/** A chart's table as the lint reads it, cells as their visible text. */
export function chartTableOf(children: readonly Block[]): ChartTable | null {
  const k = chartTableIndex(children);
  if (k < 0) return null;
  const t = children[k] as Extract<Block, { type: "table" }>;
  const cell = (c: string) => visibleText(c).trim();
  return { headers: t.headers.map(cell), rows: t.rows.map((r) => r.map(cell)) };
}

export function checkCharts(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
  if (!rawContent.includes("<Chart")) return [];
  // Wikilinks hold no newline, so the line numbers are the file's; a `|` in a
  // link's label no longer splits a table cell, as on the reader.
  const text = wikiLinksAsText(rawContent);
  const blocks = parseBlocks(stripFrontmatter(text));
  const lines = text.split("\n");
  const fenced = fencedLineMask(lines);
  let from = frontmatterEndLine(lines);
  const findings: LintFinding[] = [];
  for (const b of chartBlocks(blocks)) {
    let line: number | undefined;
    for (let i = from; i < lines.length; i++) {
      if (!fenced[i] && /^\s*<Chart\b/.test(lines[i]!)) {
        line = i + 1;
        from = i + 1;
        break;
      }
    }
    const kind = readChartKind(b.attrs.kind).value;
    if (kind === null) continue;
    const read = readChart(kind, b.attrs, chartTableOf(b.children));
    for (const f of read.findings) {
      findings.push({
        check: "chart-table",
        relPath: page.relPath,
        message: `<Chart kind="${kind}"> ${f.message}${f.fatal ? " — the reader shows the table instead" : ""}`,
        ...(line !== undefined ? { line } : {}),
      });
    }
  }
  return findings;
}
