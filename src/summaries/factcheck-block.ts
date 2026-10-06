/**
 * The fact-check block a `/summaries` write-back adds to a stored summary, and
 * its exact inverse.
 *
 * The block (D3) is the wiki's sentinel pair around a `## Fact check (date)`
 * heading and a `> [!factcheck]` callout. The heading gives huginn a chunk of its
 * own; the sentinels let {@link stripSummaryFactcheckBlock} find it again with
 * the wiki's own live-block walker (`findLiveSentinelBlocks`).
 *
 * Insert and strip are EXACT INVERSES (D11): the insert writes the block plus
 * one `\n\n` separator, and the strip removes the block plus that separator. So `checkedTextOfRaw` of a written-back file equals that of the file before
 * the write, and Add never moves `body_sha256`. The wiki's `stripFactcheckBlock`
 * is not used: it collapses every run of 3+ newlines across the whole body, code
 * fences included, which would change the hash of any summary carrying one.
 *
 * Exported for PR 4 (export and share), which inserts the block the same way.
 */

import {
  FACTCHECK_SENTINEL_END,
  FACTCHECK_SENTINEL_START,
  findLiveSentinelBlocks,
} from "../wiki/factcheck-context.ts";
import { findAppendixSection } from "./visual-detail.ts";
import { markdownCodeRegions } from "../format/markdown-ast.ts";

/** The callout's marker, which the reader and the export style. */
export const SUMMARY_FACTCHECK_CALLOUT_MARKER = "[!factcheck]";
/** The callout's title line. The date is the heading's, so it is not repeated. */
export const SUMMARY_FACTCHECK_CALLOUT_TITLE = "Claims checked against the web";

/**
 * The block for one saved check. `dateOslo` is the check's date (`YYYY-MM-DD`).
 *
 * The answer is quoted line by line under a title line and one bare `>`, so the
 * title is a paragraph of its own; claim headings are demoted to bold because a
 * blockquote cannot carry a heading the reader would style. Embedded sentinel
 * strings are neutralized, or one on its own line would end the block early.
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
 * `text` with every live fact-check block removed, each with ONE `\n\n`: the one
 * directly after it (the separator {@link insertSummaryFactcheckBlock} wrote in
 * front of the visual-reference section, or the one the save writes in front of
 * `## Transcript`), else the one directly before it (the insert's separator at
 * the end of a body). Nothing else moves.
 * Works on a raw file (frontmatter included) or on a stored body.
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

/**
 * `body` — a stored summary WITHOUT its transcript (`readStoredCapture().body`)
 * — with `block` in place of any earlier one: above the `## Visual reference`
 * section when there is one, else at the end of the body, which the save puts
 * above `## Transcript`.
 */
export function insertSummaryFactcheckBlock(body: string, block: string): string {
  const base = stripSummaryFactcheckBlock(body);
  const appendix = findAppendixSection(base, markdownCodeRegions(base));
  if (appendix) return base.slice(0, appendix.start) + block + "\n\n" + base.slice(appendix.start);
  return `${base.trimEnd()}\n\n${block}`;
}

/** The check's date as the block names it: the Oslo calendar day of `epochMs`. */
export function factcheckBlockDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}
