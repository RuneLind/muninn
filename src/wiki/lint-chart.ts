/**
 * Lint check 17 — what a `<Chart>` cannot draw from its table. One key,
 * `chart-table`, page text only (`checkPageText`, so `wiki-check` reports it).
 * Each finding is one of `readChart`'s (`src/format/chart-block.ts`), the
 * reading the reader's view draws from, so the lint and the chart agree:
 *
 * - warning: a finding that stops the chart — the reader shows the table
 *   with it (a named column missing or written twice, a non-number in a value
 *   column, a funnel row larger than its parent or matching no parent count, a
 *   negative count, mixed units in a gate row, a steps series with no values
 *   or no step rows, a missing or ambiguous `ref=` row);
 * - info: a note beside a drawn chart (a gap cell that differs from
 *   target − value by more than half a unit of its last decimal).
 *
 * A chart with no usable `kind=` is left to check 15.
 */

import { chartBlocks, chartBody, chartTable, readChart } from "../format/chart-block.ts";
import { readChartKind } from "../format/component-spec.ts";
import { parseBlocks } from "../format/markdown-ast.ts";
import { visibleText } from "../format/report-top.ts";
import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import { stripFrontmatter, type WikiPageMeta } from "./store.ts";
import { findUnfencedLine } from "./lint-lines.ts";
import { WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import type { LintFinding } from "./lint.ts";

export const CHART_LINT_CHECKS = ["chart-table"] as const;

export function checkCharts(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
  if (!rawContent.includes("<Chart")) return [];
  const body = stripFrontmatter(rawContent);
  // Lines the frontmatter strip removed: a block's `line` counts from the body.
  const bodyAt = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  const findings: LintFinding[] = [];
  // The reader parks each wikilink before it parses (`renderWikiHtml`), so a
  // `|` in `[[t|l]]` splits no cell there; park them the same way here.
  const linkTexts: string[] = [];
  const parked = body.replace(WIKILINK_WITH_LABEL_RE, (_w, t: string, l?: string) => `\x00L${linkTexts.push(wikiLinkText(t, l)) - 1}\x00`);
  const unpark = (raw: string) => raw.replace(/\x00L(\d+)\x00/g, (_m, i: string) => linkTexts[Number(i)] ?? "");
  const cellText = (raw: string) => visibleText(unpark(raw));
  for (const block of chartBlocks(parseBlocks(parked))) {
    const kind = readChartKind(block.attrs.kind).value;
    if (kind === null) continue;
    const { table } = chartBody(block.children);
    const read = readChart(kind, block.attrs, table ? chartTable(table, cellText) : null);
    const tagLine = block.line === undefined ? undefined : bodyAt + block.line + 1;
    // The table's header line, the first table line after the tag; data row
    // r sits two lines under it (header, delimiter row).
    const headerLine = tagLine === undefined ? undefined : findUnfencedLine(lines, fenced, tagLine, (l) => l.trim().startsWith("|"));
    const caption = block.attrs.caption === undefined ? undefined : unpark(block.attrs.caption).trim();
    for (const f of read.findings) {
      const line = f.row !== undefined && headerLine !== undefined ? headerLine + 2 + f.row : tagLine;
      findings.push({
        check: "chart-table",
        relPath: page.relPath,
        message: `<Chart kind="${kind}"${caption ? ` caption="${caption}"` : ""}> ${f.message}${f.fatal ? "; it renders as its table" : ""}`,
        ...(line === undefined ? {} : { line }),
        ...(f.fatal ? {} : { severity: "info" as const }),
      });
    }
  }
  return findings;
}
