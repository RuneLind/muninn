/**
 * A `<Steps>` item's focus ids, and its `<li>` open tag. Dependency-light: the
 * web formatter (bundled into chat) and the lint read it; the reader's view
 * (`steps-block.ts`) does not belong in that bundle.
 *
 * A paragraph's closing spans are the code spans that END its last line,
 * separated by commas and white space only; each span holds one id or several,
 * separated by commas or white space. `` - Saken opprettes `opprettet`, `grunnlag` ``
 * and `` - Saken opprettes `opprettet, grunnlag` `` both focus two ids. A span
 * followed by any other text (`` `a`. ``) is prose: that paragraph has no
 * closing spans, and an earlier paragraph's still count. A span on an earlier
 * line of the paragraph (a continuation line follows it) is not focus.
 * The focus is the closing spans of the item's LAST paragraph that has any:
 * its own text or a further paragraph under it, never a nested list or a
 * fence (those are the step's text). A plain paragraph after the spans keeps
 * them; an item with no closing spans anywhere has no focus.
 */
import { codeSpanContent, lineCodeSpanRanges } from "./code-spans.ts";
import { escapeHtml } from "./markdown-core.ts";
import type { Block, ListChild } from "./markdown-ast.ts";

/** An item's closing span run: its ids, and the item's text before the run. */
function focusRun(item: string): { ids: string[]; before: string } {
  const at = item.lastIndexOf("\n") + 1;
  const line = item.slice(at);
  const ranges = lineCodeSpanRanges(line);
  const out: string[][] = [];
  let end = line.trimEnd().length;
  let cut = end;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const r = ranges[k]!;
    if (r.end !== end) break;
    out.unshift(codeSpanContent(line, r).split(/[\s,]+/).filter(Boolean));
    end = r.start;
    while (end > 0 && /[\s,]/.test(line[end - 1]!)) end--;
    cut = end;
  }
  return { ids: [...new Set(out.flat())], before: item.slice(0, at + cut) };
}

/** The focus ids an item names, in order, each once. */
export function stepFocusOf(item: string): string[] {
  return focusRun(item).ids;
}

/** A list item's focus ids: `stepFocusOf` over its last paragraph that has any. */
export function stepItemFocus(text: string, children: readonly ListChild[] | undefined): string[] {
  const paras = [text, ...(children ?? []).flatMap((c) => (c.type === "paragraph" ? [c.text] : []))];
  for (let k = paras.length - 1; k >= 0; k--) {
    const focus = stepFocusOf(paras[k]!);
    if (focus.length) return focus;
  }
  return [];
}

/** A step's caption source: the item's own first paragraph, without the
 *  closing spans when they are the step's focus (no later paragraph has any).
 *  Nested lists, fences and further paragraphs are not part of it. */
export function stepItemCaption(text: string, children: readonly ListChild[] | undefined): string {
  const later = (children ?? []).some((c) => c.type === "paragraph" && stepFocusOf(c.text).length > 0);
  const run = focusRun(text);
  return later || !run.ids.length ? text : run.before;
}

/** A `<Steps>` body with each ordered list numbered by its items' step places,
 *  so the list reads as the toolbar counts: a later list starts after the
 *  steps before it, and source numbers give way to the step's place. A `<ul>`
 *  keeps its bullets but uses up step numbers. */
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

/** The caption while every step shows (`cur` -1). */
export const STEPS_ALL_CAPTION = "All steps shown.";

/** One step's `<li>`: its index, focus and caption (plain text) as data the
 *  client reads. */
export function stepItemOpen(index: number, focus: readonly string[], caption: string, value: string): string {
  return (
    `<li class="stp-step" data-stp-i="${index}" data-stp-focus="${escapeHtml(focus.join(" "))}"` +
    ` data-stp-cap="${escapeHtml(caption)}"${value}>`
  );
}
