/**
 * What a `/summaries` fact check reads, and how its saved result is compared
 * against the document later.
 *
 * The checked text is the SUMMARY: the source file (frontmatter already
 * stripped by `readSummarySourceText`) cut at `## Transcript`, and also at a
 * YouTube `## Visual reference` appendix when one sits above the transcript.
 * A transcript is what the speaker said, not what the summary claims, and the
 * appendix is frame captions.
 */
import { createHash } from "node:crypto";
import { mapProseLines, splitTranscript } from "./transcript-split.ts";
import { VISUAL_REFERENCE_HEADING_RE } from "./visual-detail.ts";

export function summaryFactcheckBody(sourceText: string): string {
  const { body } = splitTranscript(sourceText);
  let at = -1;
  mapProseLines(body, (line, i) => {
    if (at === -1 && VISUAL_REFERENCE_HEADING_RE.test(line)) at = i;
    return line;
  });
  const cut = at === -1 ? body : body.split("\n").slice(0, at).join("\n");
  return cut.trim();
}

/** sha256 of the checked text — the `body_sha256` a saved row carries. */
export function factcheckBodySha256(sourceText: string): string {
  return createHash("sha256").update(summaryFactcheckBody(sourceText)).digest("hex");
}

const SOURCES_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*|__)?Sources?(?:\*\*|__)?\s*:/i;
const URL_RE = /https?:\/\/[^\s<>()\]]+(?:\([^\s<>()]*\)[^\s<>()\]]*)*/gi;

/** The URLs on a verdict block's `Sources:` line(s), de-duplicated, in order. */
export function claimSourceUrls(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split("\n")) {
    if (!SOURCES_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?'"]+$/, "");
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}
