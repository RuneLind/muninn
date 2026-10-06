/**
 * The fact-check block a `/summaries` write-back adds to a stored summary (D3):
 * the wiki's sentinel pair around a `## Fact check (date)` heading (a huginn
 * chunk of its own) and a `> [!factcheck]` callout.
 *
 * Insert and strip are EXACT INVERSES (D11), so adding the block never moves
 * `body_sha256`. The wiki's `stripFactcheckBlock` is not used: it collapses
 * every run of 3+ newlines across the body, code fences included.
 */

import {
  FACTCHECK_SENTINEL_END,
  FACTCHECK_SENTINEL_START,
  findLiveSentinelBlocks,
} from "../wiki/factcheck-context.ts";
import { findAppendixSection } from "./visual-detail.ts";
import { markdownCodeRegions } from "../format/markdown-ast.ts";
import { todayOslo } from "../gardener/util.ts";

/** The callout's marker, which the reader and the export style. */
export const SUMMARY_FACTCHECK_CALLOUT_MARKER = "[!factcheck]";
/** The callout's title line. The date is the heading's, so it is not repeated. */
export const SUMMARY_FACTCHECK_CALLOUT_TITLE = "Claims checked against the web";

/**
 * The block for one saved check, dated `dateOslo` (`YYYY-MM-DD`). Claim headings
 * are demoted to bold (a blockquote carries no heading the reader styles), and
 * embedded sentinels are neutralized, or one would end the block early.
 */
export function buildSummaryFactcheckBlock(answer: string, dateOslo: string): string {
  const safe = answer
    .replaceAll(FACTCHECK_SENTINEL_START, "factcheck:start")
    .replaceAll(FACTCHECK_SENTINEL_END, "factcheck:end")
    .trim();
  const quoted = [`> ${SUMMARY_FACTCHECK_CALLOUT_MARKER} ${SUMMARY_FACTCHECK_CALLOUT_TITLE}`, ">"];
  for (const line of safe.split("\n")) {
    const demoted = /^#{1,6}\s+/.test(line) ? `**${line.replace(/^#{1,6}\s+/, "").trim()}**` : line;
    quoted.push(demoted.trim() === "" ? ">" : `> ${demoted}`);
  }
  return [FACTCHECK_SENTINEL_START, `## Fact check (${dateOslo})`, "", quoted.join("\n"), FACTCHECK_SENTINEL_END].join("\n");
}

/**
 * `text` with every live block removed, each with ONE `\n\n` — the one after it,
 * else the one before it (the insert's separator at the end of a body). Works on
 * a raw file or a stored body.
 */
export function stripSummaryFactcheckBlock(text: string): string {
  const spans = findLiveSentinelBlocks(text);
  if (spans.length === 0) return text;
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start);
    if (text.startsWith("\n\n", span.end)) {
      at = span.end + 2;
    } else {
      // Nothing (or a lone newline) follows: the insert's separator is the
      // one in front of the block.
      if (out.endsWith("\n\n")) out = out.slice(0, -2);
      at = span.end;
    }
  }
  return out + text.slice(at);
}

/** `body` (no transcript) with `block` in place of any earlier one: above the
 *  `## Visual reference` section, else at the end. */
export function insertSummaryFactcheckBlock(body: string, block: string): string {
  const base = stripSummaryFactcheckBlock(body);
  const appendix = findAppendixSection(base, markdownCodeRegions(base));
  if (appendix) return base.slice(0, appendix.start) + block + "\n\n" + base.slice(appendix.start);
  return `${base.trimEnd()}\n\n${block}`;
}

/** The check's date as the block names it: the Oslo calendar day of `epochMs`. */
export function factcheckBlockDate(epochMs: number): string {
  return todayOslo(epochMs);
}
