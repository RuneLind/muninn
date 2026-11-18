/**
 * The match key the Discuss locator compares on, shared by the server
 * (`discuss-locate.ts`, over the page source) and the reader's client (over the
 * rendered article, for the context it reads around a selection).
 * Dependency-free: the reader bundle imports it.
 *
 * The key drops every whitespace character and the markup characters
 * {@link isDroppedChar} names, and lowercases the rest, one character for one.
 * Whitespace goes because a selection across list items, table cells or blocks
 * carries newlines, tabs or nothing at all between them depending on how it was
 * read (`Selection.toString` versus `textContent`); the markup characters go
 * because a list marker, a quote marker, a heading's `#`, a table pipe and an
 * emphasis or code marker are in the source and not in the render. Dropping a
 * character from both sides never makes two equal texts differ: the cost is
 * only that two texts differing by those characters alone read as equal.
 * Lowercase: a CSS `text-transform` reaches `Selection.toString` in Chrome.
 */

/** Characters the key never holds besides whitespace. */
const DROPPED = new Set(["*", "_", "`", "~", "|", "#", "<", ">", "\\", ":", "-", "+"]);

export function isDroppedChar(ch: string): boolean {
  return DROPPED.has(ch) || /\s/.test(ch);
}

/** One character as the key holds it, or "" when the key drops it. A
 *  character whose lowercase form is longer than itself (`İ`) is kept as is,
 *  so the key stays one character per kept character. */
export function keyChar(ch: string): string {
  if (isDroppedChar(ch)) return "";
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
}

/** The key of a rendered text: what a selection or the article reads as. */
export function locateKey(text: string): string {
  let out = "";
  for (const ch of text) out += keyChar(ch);
  return out;
}

/** Start offsets of every match of `needle` in `hay`, overlapping ones included. */
export function matchStarts(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}
