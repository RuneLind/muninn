/**
 * What a `/summaries` fact check reads, and how its saved result is compared
 * against the document later.
 *
 * The checked text is the SUMMARY: the source file (frontmatter already
 * stripped by `readSummarySourceText`) cut at `## Transcript`, minus a YouTube
 * `## Visual reference` appendix SECTION. The section is `findAppendixSection`'s
 * (it ends at the next heading of its level) and ALSO ends at the closing
 * `> 💬 **Takeaway:**` block, which is the summary's own claim even when the
 * model put it under the appendix — no heading separates them. A transcript is what
 * the speaker said, not what the summary claims, and the appendix is frame
 * captions. A fact-check block a write-back added (`factcheck-block.ts`) is
 * removed first, with its exact-inverse strip, so a re-check never sees its own
 * verdicts and adding the block never moves the hash (D11).
 */
import { createHash } from "node:crypto";
import { splitTranscript } from "./transcript-split.ts";
import { findAppendixSection } from "./visual-detail.ts";
import { markdownCodeRegions } from "../format/markdown-ast.ts";
import { splitClosingTakeaway } from "./takeaway-check.ts";
import { hasFactcheckBlock } from "../wiki/factcheck-context.ts";
import { stripSummaryFactcheckBlock } from "./factcheck-block.ts";
import { sourceTextOfRaw } from "./source-text.ts";

/** A `[start, end)` range of a transcript-less summary body. */
export interface CheckedRange {
  start: number;
  end: number;
}

/**
 * The ranges of `body` (a summary with no transcript and no fact-check block)
 * the check reads: everything above the visual-reference section, and
 * everything after its cut — the closing takeaway, or a later section. One
 * range when there is no section. The integrate route edits these ranges of the
 * RAW body and splices each back on its own (D12).
 */
export function summaryCheckedRanges(body: string): CheckedRange[] {
  const appendix = findAppendixSection(body, markdownCodeRegions(body));
  if (!appendix) return [{ start: 0, end: body.length }];
  const closer = splitClosingTakeaway(body);
  const closerAt = closer ? closer.before.length + (closer.hasLead ? 1 : 0) : -1;
  const end = closerAt > appendix.start && closerAt < appendix.end ? closerAt : appendix.end;
  return end < body.length
    ? [{ start: 0, end: appendix.start }, { start: end, end: body.length }]
    : [{ start: 0, end: appendix.start }];
}

export function summaryFactcheckBody(sourceText: string): string {
  const text = hasFactcheckBlock(sourceText) ? stripSummaryFactcheckBlock(sourceText) : sourceText;
  const { body } = splitTranscript(text);
  return summaryCheckedRanges(body)
    .map((r) => body.slice(r.start, r.end))
    .join("")
    .trim();
}

/**
 * The checked text of a RAW file, as huginn's `?raw=1` serves it — the ONE hash
 * input (D12): `summaryFactcheckBody(filterDocumentText(stripFrontmatter(raw)))`.
 * The write routes' CAS and the apply's re-stamp call it; the check route and
 * `/result` hash `summaryFactcheckBody` over `readSummarySourceText`, which is
 * the same {@link sourceTextOfRaw} read over the network.
 */
export function checkedTextOfRaw(raw: string): string {
  return summaryFactcheckBody(sourceTextOfRaw(raw));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 of the checked text — the `body_sha256` a saved row carries. */
export function factcheckBodySha256(sourceText: string): string {
  return sha256Hex(summaryFactcheckBody(sourceText));
}

/** sha256 of {@link checkedTextOfRaw}. */
export function checkedSha256OfRaw(raw: string): string {
  return sha256Hex(checkedTextOfRaw(raw));
}
