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
 * | `status-tones`            | a `<StatusRows tones>` entry that names no row, names a row twice, or is   |
 * |                           | not `Label=good|warn|info|muted`                                           |
 * | `status-tile-long`        | in `view="tiles"`, a row whose first ` · ` part (the tile's big value) is  |
 * |                           | over `STATUS_TILE_FIRST_MAX` (24) visible chars                            |
 * | `missing-tldr`            | an `.mdx` page in {@link isTldrScope} whose first non-blank block after the H1 is |
 * |                           | not `<Tldr>` (the In short / Kort fortalt box)                             |
 * | `tldr-no-more` (info)     | that `<Tldr>` holds no `<More>`                                            |
 *
 * The first two read the page through the renderer's own parser; the first
 * sentence is the reader's own guarded split (`decisionFirstSentence`) and a row
 * the rule in `src/format/report-top.ts`, so the finding and the reader agree. A
 * struck or superseded DecisionLog item is skipped: it is history, and the
 * reader dims it.
 *
 * The two Tldr checks run from {@link checkTldr}, which `lint.ts` calls only
 * for pages that are neither reserved nor culled, as check 9 does.
 */

import { parseBlocks, type Block } from "../format/markdown-ast.ts";
import { decisionLogEntries } from "../format/question.ts";
import {
  FIRST_SENTENCE_MAX,
  parseStatusTones,
  STATUS_ROW_MAX,
  STATUS_TILE_FIRST_MAX,
  statusRowBlocks,
  statusSegments,
  statusToneWarnings,
  visibleText,
} from "../format/report-top.ts";
import { readStatusRowsView } from "../format/component-spec.ts";
import { decisionFirstSentence } from "../web/web-format.ts";
import { escapeRegExp } from "../utils/escape-regexp.ts";
import { fencedLineMask, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { parseFrontmatter, stripFrontmatter, type WikiPageMeta } from "./store.ts";
import { isLiveReportPage } from "./lint-drift.ts";
import type { LintFinding } from "./lint.ts";

export const REPORT_TOP_LINT_CHECKS = [
  "decision-first-sentence",
  "status-row-long",
  "status-tones",
  "status-tile-long",
  "missing-tldr",
  "tldr-no-more",
] as const;

/** Folders whose `.mdx` pages are reference pages and open with the box
 *  (mdx-explainer «Reference page shape», 2026-10-13). */
const TLDR_REFERENCE_DIRS = new Set(["flows", "concepts", "repos", "integrations", "projects", "reading"]);

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

export function checkReportTop(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
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
      const idLine = new RegExp(`^\\s*(?:[-*+]|\\d+[.)])\\s+(?:~~)?\\*\\*${escapeRegExp(e.id)}\\*\\*`);
      const line = findLine(lines, fenced, from, (l) => idLine.test(l));
      if (line !== undefined) from = line;
      if (e.dim) continue;
      const first = visibleText(decisionFirstSentence(e.itemText, e.id));
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
    for (const { attrs, rows } of statusRowBlocks(blocks)) {
      const open = findLine(lines, fenced, from, (l) => l.trim().startsWith("<StatusRows"));
      if (open !== undefined) from = open;
      // The reader reads tones in tile view only; a wrong entry is wrong either way.
      if (attrs.tones !== undefined) {
        for (const warning of statusToneWarnings(parseStatusTones(attrs.tones), rows.map((r) => r.label))) {
          findings.push({ check: "status-tones", relPath: page.relPath, message: `<StatusRows> ${warning}`, ...(open !== undefined ? { line: open } : {}) });
        }
      }
      const tiles = readStatusRowsView(attrs.view).value === "tiles";
      for (const row of rows) {
        const head = row.text.split("\n")[0]!.slice(0, 40);
        const line = findLine(lines, fenced, from, (l) => l.includes(head));
        if (line !== undefined) from = line;
        const at = line !== undefined ? { line } : {};
        const big = tiles ? visibleText(statusSegments(row.value)[0] ?? "") : "";
        if (big.length > STATUS_TILE_FIRST_MAX) {
          findings.push({
            check: "status-tile-long",
            relPath: page.relPath,
            message: `<StatusRows view="tiles"> row's first part is ${big.length} chars (max ${STATUS_TILE_FIRST_MAX}) and does not read as a tile; put a number or a short state first and the rest after " · " (${quote(big)})`,
            ...at,
          });
        }
        if (row.text.length <= STATUS_ROW_MAX) continue;
        findings.push({
          check: "status-row-long",
          relPath: page.relPath,
          message: `<StatusRows> row of ${row.text.length} chars (max ${STATUS_ROW_MAX}) — a row reads at a glance; move the detail into the page (${quote(row.text)})`,
          ...at,
        });
      }
    }
  }
  return findings;
}

/** An `.mdx` page that is a live report page or sits in a reference folder.
 *  A `.md` page renders no components, so it cannot carry the box. */
export function isTldrScope(relPath: string, fm: Record<string, unknown>, planStatus: string | undefined): boolean {
  if (!relPath.endsWith(".mdx")) return false;
  return isLiveReportPage(relPath, fm, planStatus) || TLDR_REFERENCE_DIRS.has(relPath.split("/")[0]!);
}

const isBlank = (b: Block) => b.type === "text" && b.lines.every((l) => l.trim() === "");

function hasMore(blocks: readonly Block[]): boolean {
  return blocks.some((b) => b.type === "component" && (b.name === "More" || hasMore(b.children)));
}

/**
 * `missing-tldr` and `tldr-no-more`: the first non-blank block after the
 * leading `# ` heading (or the first block, on a page with none) must be a
 * `<Tldr>`, and that box should hold a `<More>`. The line named is the first
 * non-blank body line after the H1, where the box goes.
 */
export function checkTldr(page: Pick<WikiPageMeta, "relPath" | "plan_status">, rawContent: string): LintFinding[] {
  if (!isTldrScope(page.relPath, parseFrontmatter(rawContent), page.plan_status)) return [];
  const blocks = parseBlocks(stripFrontmatter(rawContent)).filter((b) => !isBlank(b));
  const h1 = blocks[0]?.type === "heading" && blocks[0].level === 1;
  const first = blocks[h1 ? 1 : 0];

  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  let from = frontmatterEndLine(lines);
  if (h1) {
    const h1Line = findLine(lines, fenced, from, (l) => /^#\s/.test(l));
    if (h1Line !== undefined) from = h1Line;
  }
  const line = findLine(lines, [], from, (l) => l.trim() !== "");
  const at = line !== undefined ? { line } : {};

  if (first?.type !== "component" || first.name !== "Tldr") {
    return [
      {
        check: "missing-tldr",
        relPath: page.relPath,
        message: "No In short box: the first block after the title is not <Tldr> — open the page with <Tldr> + <More> (mdx-explainer «Reference page shape» / «Report genres»)",
        ...at,
      },
    ];
  }
  if (hasMore(first.children)) return [];
  return [
    {
      check: "tldr-no-more",
      relPath: page.relPath,
      message: "The <Tldr> box has no <More>: put the background, the question the page answers and «Words on the page» in a <More> inside it",
      severity: "info",
      ...at,
    },
  ];
}
