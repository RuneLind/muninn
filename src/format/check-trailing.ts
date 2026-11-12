/**
 * Where a step's `<Check …/>` counts (decision D5): the last thing on the
 * step item's first line, well formed and self-closing, followed only by
 * spaces or tabs. Browser-safe: the list renderers, `leadSentence` and the
 * server's `stepCheck` (`check-tag.ts`) all read placement from here.
 */

/**
 * The first line's text up to its last non-blank character before the tag,
 * the spaces or tabs before the tag, then the tag: self-closing, attributes
 * double-quoted in the inline scanner's name shape, and only spaces or tabs
 * after it on the line. Anchored at the start, so a line costs one pass. A
 * backtick in a value refuses the tag, so no code span can hold one that
 * ends the line.
 */
const TRAILING_CHECK = /^(.*[^ \t\n])[ \t]*<Check((?:[ \t]+[A-Za-z][\w-]*="[^"`\n]*")*)[ \t]*\/>(?=[ \t]*(?:\n|$))/;

/** `item`'s validly placed tag as `[the item without it and the spaces or
 *  tabs before it, its raw attribute run]`; what follows the tag is kept.
 *  Undefined when there is none. An item with no `<Check` meets no regex. */
export function trailingCheck(item: string): [text: string, attrs: string] | undefined {
  const m = item.includes("<Check") ? TRAILING_CHECK.exec(item) : null;
  return m ? [m[1] + item.slice(m[0].length), m[2]!] : undefined;
}
