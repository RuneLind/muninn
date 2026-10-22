/**
 * A `<Steps>` item's focus ids, and its `<li>` open tag. Dependency-light: the
 * web formatter (bundled into chat) and the lint read it; the reader's view
 * (`steps-block.ts`) does not belong in that bundle.
 *
 * An item's focus ids are the code spans that END its last line, separated by
 * commas and white space only; each span holds one id or several, separated
 * by commas or white space. `` - Saken opprettes `opprettet`, `grunnlag` ``
 * and `` - Saken opprettes `opprettet, grunnlag` `` both focus two ids. A span
 * followed by any other text (`` `a`. ``) is prose: the step has no focus.
 */
import { codeSpanContent, lineCodeSpanRanges } from "./code-spans.ts";
import { escapeHtml } from "./markdown-core.ts";

/** The focus ids an item names, in order, each once. */
export function stepFocusOf(item: string): string[] {
  const line = item.slice(item.lastIndexOf("\n") + 1);
  const ranges = lineCodeSpanRanges(line);
  const out: string[][] = [];
  let end = line.trimEnd().length;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const r = ranges[k]!;
    if (r.end !== end) break;
    out.unshift(codeSpanContent(line, r).split(/[\s,]+/).filter(Boolean));
    end = r.start;
    while (end > 0 && /[\s,]/.test(line[end - 1]!)) end--;
  }
  return [...new Set(out.flat())];
}

/** One step's `<li>`: its index and focus as data the client reads. */
export function stepItemOpen(index: number, focus: readonly string[], value: string): string {
  return `<li class="stp-step" data-stp-i="${index}" data-stp-focus="${escapeHtml(focus.join(" "))}"${value}>`;
}
