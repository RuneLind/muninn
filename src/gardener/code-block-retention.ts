/**
 * How much of a summary's fenced code reached a wiki page drafted from it.
 *
 * A block is measured by its lines of {@link MIN_MEASURED_LINE_CHARS} or more
 * characters, each looked up whitespace-normalized anywhere in the page. A fence
 * marker is not evidence: a drafted page carries fences of its own (a mermaid
 * block the model drew), and paraphrase counts as lost. This is the measurement
 * the 2026-09-15 census used (mimir `plans/muninn-summary-code-in-wiki.mdx`),
 * committed so a re-draft can be judged the same way.
 *
 * Pure and import-light: `scripts/measure-summary-code.ts` runs it against live
 * drafts.
 */
import { splitTranscript } from "../summaries/transcript-split.ts";

/** Shorter lines (a closing brace, `---`) match by accident, so they are not counted. */
export const MIN_MEASURED_LINE_CHARS = 12;

export type RetentionVerdict = "kept" | "partial" | "lost";

export interface BlockRetention {
  /** 0-based position among the summary's measurable blocks. */
  index: number;
  /** The fence's info string (`yaml`, `markdown`, …), or "". */
  lang: string;
  /** Lines of {@link MIN_MEASURED_LINE_CHARS}+ characters in the block. */
  lines: number;
  /** How many of those lines the page contains. */
  found: number;
  verdict: RetentionVerdict;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Fenced blocks outside the `## Transcript` appendix, with the closing rule
 * `mapProseLines` uses: a fence closes only on its own marker character at the
 * opening length or longer.
 */
export function summaryCodeBlocks(summary: string): { lang: string; lines: string[] }[] {
  const blocks: { lang: string; lines: string[] }[] = [];
  let open: { marker: string; lang: string; lines: string[] } | null = null;
  for (const line of splitTranscript(summary).body.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m) open = { marker: m[1]!, lang: m[2]!.trim(), lines: [] };
      continue;
    }
    if (m && m[1]!.charAt(0) === open.marker.charAt(0) && m[1]!.length >= open.marker.length && !m[2]!.trim()) {
      blocks.push({ lang: open.lang, lines: open.lines });
      open = null;
      continue;
    }
    open.lines.push(line);
  }
  return blocks;
}

/** One entry per summary block that has at least one measurable line. */
export function measureCodeRetention(summary: string, page: string): BlockRetention[] {
  const haystack = normalize(page);
  const out: BlockRetention[] = [];
  for (const block of summaryCodeBlocks(summary)) {
    const lines = block.lines.map(normalize).filter((l) => l.length >= MIN_MEASURED_LINE_CHARS);
    if (lines.length === 0) continue;
    const found = lines.filter((l) => haystack.includes(l)).length;
    const ratio = found / lines.length;
    out.push({
      index: out.length,
      lang: block.lang,
      lines: lines.length,
      found,
      verdict: ratio >= 0.8 ? "kept" : ratio >= 0.3 ? "partial" : "lost",
    });
  }
  return out;
}
