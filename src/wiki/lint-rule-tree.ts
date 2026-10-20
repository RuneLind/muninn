/**
 * Lint check 18 — what a `<RuleTree>` cannot read. One key, `rule-tree`, page
 * text only (`checkPageText`, so `wiki-check` reports it). Each finding is one
 * of `readRuleTree`'s (`src/format/rule-tree.ts`), the reading the reader's
 * tree is drawn from, so the lint and the tree agree:
 *
 * - warning: the block holds no list (it renders as written), an `outcomes=`
 *   entry it cannot read, a leaf with no outcome after `→`, an outcome with no
 *   tone, a case on two leaves that do not each name a different year;
 * - info: an `outcomes=` label that names no leaf outcome, or names one twice.
 *
 * The lint reads no CaseBoard file, so a case id counts here only by its
 * grammar (`CASE_ID_RE`); the reader also takes a board id.
 */

import { componentBlocks, parseBlocks } from "../format/markdown-ast.ts";
import { visibleText } from "../format/report-top.ts";
import { readRuleTree, type RuleNode } from "../format/rule-tree.ts";
import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import { stripFrontmatter, type WikiPageMeta } from "./store.ts";
import { findUnfencedLine } from "./lint-lines.ts";
import { WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import type { LintFinding } from "./lint.ts";

export const RULE_TREE_LINT_CHECKS = ["rule-tree"] as const;

const LIST_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

export function checkRuleTrees(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
  if (!rawContent.includes("<RuleTree")) return [];
  const body = stripFrontmatter(rawContent);
  const bodyAt = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  // The reader parks each wikilink before it parses; park them the same way.
  const linkTexts: string[] = [];
  const parked = body.replace(WIKILINK_WITH_LABEL_RE, (_w, t: string, l?: string) => `\x00L${linkTexts.push(wikiLinkText(t, l)) - 1}\x00`);
  const unpark = (raw: string) => raw.replace(/\x00L(\d+)\x00/g, (_m, i: string) => linkTexts[Number(i)] ?? "");
  const text = (raw: string) => visibleText(unpark(raw));
  const lines = parked.split("\n");
  const fenced = fencedLineMask(lines);
  const findings: LintFinding[] = [];
  for (const block of componentBlocks(parseBlocks(parked), "RuleTree")) {
    const read = readRuleTree(block.children, block.attrs, { text });
    const tagLine = block.line === undefined ? undefined : block.line + 1;
    // Each item's line, found in source order from the tag down.
    const nodeLine = new Map<RuleNode, number>();
    if (tagLine !== undefined) {
      let from = tagLine;
      const place = (ns: readonly RuleNode[]) => {
        for (const n of ns) {
          const head = (n.raw.split("\n")[0] ?? "").trim().slice(0, 40);
          const at = findUnfencedLine(lines, fenced, from, (l) => LIST_MARKER_RE.test(l) && l.replace(LIST_MARKER_RE, "").startsWith(head));
          if (at !== undefined) {
            nodeLine.set(n, at);
            from = at;
          }
          for (const u of n.under) if (u.kind === "list") place(u.nodes);
        }
      };
      place(read.nodes);
    }
    const title = block.attrs.title === undefined ? "" : text(block.attrs.title).trim();
    for (const f of read.findings) {
      const at = (f.node && nodeLine.get(f.node)) ?? tagLine;
      findings.push({
        check: "rule-tree",
        relPath: page.relPath,
        message: `<RuleTree${title ? ` title="${title}"` : ""}> ${f.message}`,
        ...(at === undefined ? {} : { line: bodyAt + at }),
        ...(f.level === "info" ? { severity: "info" as const } : {}),
      });
    }
  }
  return findings;
}
