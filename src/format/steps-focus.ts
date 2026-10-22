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
 * The last line is the item's last paragraph's: its own text or a further
 * paragraph under it. A nested list or a fence under the item is part of the
 * step's text, not its focus, so the paragraph before it counts.
 */
import { codeSpanContent, lineCodeSpanRanges } from "./code-spans.ts";
import { escapeHtml } from "./markdown-core.ts";
import type { Block, ListChild } from "./markdown-ast.ts";

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

/** A list item's focus ids: `stepFocusOf` over its last paragraph. */
export function stepItemFocus(text: string, children: readonly ListChild[] | undefined): string[] {
  const paras = (children ?? []).filter((c) => c.type === "paragraph");
  return stepFocusOf(paras.length ? paras[paras.length - 1]!.text : text);
}

/** A `<Steps>` body with each ordered list numbered by its items' step places,
 *  so the list reads as the toolbar counts: a later list starts after the
 *  steps before it, and source numbers that skip give way. */
export function numberStepLists(blocks: Block[]): Block[] {
  let n = 0;
  return blocks.map((b) => {
    if (b.type !== "ul" && b.type !== "ol") return b;
    const at = n;
    n += b.items.length;
    if (b.type === "ul") return b;
    const { values: _values, ...rest } = b;
    return { ...rest, start: at + 1 };
  });
}

/** The toolbar's position text (`cur` -1: Show all). */
export function stepsPosText(cur: number, count: number): string {
  return cur < 0 ? `${count} ${count === 1 ? "step" : "steps"}` : `Step ${cur + 1} of ${count}`;
}

/** One step's `<li>`: its index and focus as data the client reads. */
export function stepItemOpen(index: number, focus: readonly string[], value: string): string {
  return `<li class="stp-step" data-stp-i="${index}" data-stp-focus="${escapeHtml(focus.join(" "))}"${value}>`;
}
