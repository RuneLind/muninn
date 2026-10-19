/**
 * Lint check 16 — what the decision views cannot draw. Both info-level and
 * report-only: the reader degrades (an `unknown` square, the question's own
 * close wins), so neither is a defect, but the author can fix both in a line.
 *
 * | check                  | fires when                                                          |
 * |------------------------|---------------------------------------------------------------------|
 * | `ledger-row-state`     | a PR ledger with a state column has a row no state rule reads        |
 * |                        | (`src/format/pr-ledger.ts`); the strip shows it as `unknown`         |
 * | `chain-close-conflict` | a decision says «Lukker Sn» / «Closes On» while On's own item closes |
 * |                        | it with another decision; the chain view keeps the question's close  |
 *
 * Both read the page through `pageDecisionDataOf` (`decision-text.ts`), the
 * text and pass the reader draws from, so a finding and the view agree.
 */

import { pageDecisionDataOf, wikiLinksAsText } from "./decision-text.ts";
import { escapeRegExp } from "../utils/escape-regexp.ts";
import { fencedLineMask, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import type { WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const DECISION_CHAIN_LINT_CHECKS = ["ledger-row-state", "chain-close-conflict"] as const;

/** The 1-based line of the first unfenced line at or after `from` (0-based)
 *  that `test` accepts. */
function findLine(lines: readonly string[], fenced: readonly boolean[], from: number, test: (line: string) => boolean): number | undefined {
  for (let i = from; i < lines.length; i++) if (!fenced[i] && test(lines[i]!)) return i + 1;
  return undefined;
}

/** A table row whose first cell, flattened, is `cell`. */
function rowTest(cell: string): (line: string) => boolean {
  const want = cell.replace(/\s+/g, " ").trim();
  return (line) => {
    const t = line.trim();
    if (!t.startsWith("|")) return false;
    const first = t.slice(1).split("|")[0] ?? "";
    return first.replace(/\s+/g, " ").trim() === want;
  };
}

export function checkDecisionChain(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
  const hasLedger = /PR[ -]ledger|PR-oversikt/i.test(rawContent);
  const hasCloses = rawContent.includes("<DecisionLog") && /[Ll]ukker|[Cc]loses/.test(rawContent);
  if (!hasLedger && !hasCloses) return [];
  // Glance tables are never linted, so the `proposed` gate does not matter here.
  const { ledgers, analysis } = pageDecisionDataOf(rawContent, false);
  // Rows are matched on the text the analysis read: a wikilink as its label.
  // Wikilinks hold no newline, so the line numbers are the file's.
  const lines = wikiLinksAsText(rawContent).split("\n");
  const fenced = fencedLineMask(lines);
  const body = frontmatterEndLine(lines);
  const findings: LintFinding[] = [];

  // Rows are located in source order, each search after the last hit, so two
  // ledgers sharing a first cell point at their own rows.
  let from = body;
  for (const l of ledgers) {
    if (l.source !== "ledger" || l.stateColumn < 0) continue;
    for (const r of l.rows) {
      const line = findLine(lines, fenced, from, rowTest(r.cells[0] ?? ""));
      if (line !== undefined) from = line;
      if (r.state !== "unknown") continue;
      const stateCell = (r.cells[l.stateColumn] ?? "").replace(/\s+/g, " ").trim();
      findings.push({
        check: "ledger-row-state",
        relPath: page.relPath,
        severity: "info",
        message: `PR ledger row PR ${r.pr}: no state the strip can read (${JSON.stringify(stateCell.slice(0, 60))}) — start the ${l.headers[l.stateColumn]?.trim() || "state"} cell with a state word (merged, dropped, open, planned …), or write the word before the PR link`,
        ...(line !== undefined ? { line } : {}),
      });
    }
  }

  for (const c of analysis.conflicts) {
    const idLine = new RegExp(`^\\s*(?:[-*+]|\\d+[.)])\\s+(?:~~)?\\*\\*${escapeRegExp(c.claimant)}\\*\\*`);
    const line = findLine(lines, fenced, body, (l) => idLine.test(l));
    findings.push({
      check: "chain-close-conflict",
      relPath: page.relPath,
      severity: "info",
      message: `DecisionLog item ${c.claimant} closes ${c.question}, but ${c.question}'s own item is closed by ${c.closedBy} — the chain keeps ${c.closedBy}; drop the «Lukker ${c.question}» or fix ${c.question}'s close`,
      ...(line !== undefined ? { line } : {}),
    });
  }
  return findings;
}
