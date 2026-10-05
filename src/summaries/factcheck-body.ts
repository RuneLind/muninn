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
 * captions.
 */
import { createHash } from "node:crypto";
import { splitTranscript } from "./transcript-split.ts";
import { findAppendixSection } from "./visual-detail.ts";
import { markdownCodeRegions } from "../format/markdown-ast.ts";
import { splitClosingTakeaway } from "./takeaway-check.ts";

export function summaryFactcheckBody(sourceText: string): string {
  const { body } = splitTranscript(sourceText);
  const appendix = findAppendixSection(body, markdownCodeRegions(body));
  if (!appendix) return body.trim();
  const closer = splitClosingTakeaway(body);
  const closerAt = closer ? closer.before.length + (closer.hasLead ? 1 : 0) : -1;
  const end = closerAt > appendix.start && closerAt < appendix.end ? closerAt : appendix.end;
  const cut = body.slice(0, appendix.start) + body.slice(end);
  return cut.trim();
}

/** sha256 of the checked text — the `body_sha256` a saved row carries. */
export function factcheckBodySha256(sourceText: string): string {
  return createHash("sha256").update(summaryFactcheckBody(sourceText)).digest("hex");
}
