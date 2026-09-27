/**
 * Inline code-span pairing: the one grammar the renderer and the fact-check strip
 * share, so they agree on what is code. Dependency-free and browser-safe.
 */

/**
 * Every inline code span in `line`, as `[start, end)` ranges over it,
 * by CommonMark's pairing rule: a run of N backticks opens a span that only a run
 * of exactly N closes. The range covers the whole span, delimiters included.
 *
 * A `` `[^`]*` `` replace mis-pairs the double-backtick form the syntax exists
 * for — `` `` [[x `` `` is how a page writes a literal containing a backtick.
 * An UNMATCHED run opens no span and the scan continues past it, so a stray
 * backtick cannot swallow the rest of the line either.
 */
export function lineCodeSpanRanges(line: string): { start: number; end: number; runLen: number }[] {
  const ranges: { start: number; end: number; runLen: number }[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let openEnd = i;
    while (openEnd < line.length && line[openEnd] === "`") openEnd++;
    const runLen = openEnd - i;
    let closeAt = -1;
    let k = openEnd;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let runEnd = k;
      while (runEnd < line.length && line[runEnd] === "`") runEnd++;
      if (runEnd - k === runLen) {
        closeAt = k;
        break;
      }
      k = runEnd;
    }
    if (closeAt === -1) {
      i = openEnd; // unmatched run — literal backticks, no span
    } else {
      ranges.push({ start: i, end: closeAt + runLen, runLen });
      i = closeAt + runLen;
    }
  }
  return ranges;
}

/** Blank per CommonMark: spaces and tabs only (a `\r` left by an unnormalized CRLF body is its line ending). */
const BLANK_LINE_RE = /^[ \t]*\r?$/;

/**
 * A list item start, which interrupts a paragraph in CommonMark. `parseBlocks`
 * leaves a `+`, `1)` or indented item inside a `text` block, so the pairing below
 * breaks there itself (measured: one wiki paragraph wrapped a span onto a `+ ` line).
 */
const LIST_ITEM_START_RE = /^ {0,3}(?:[-+*]|1[.)])[ \t]+\S/;

/**
 * Every inline code span in a `text` block, as ranges over `lines.join("\n")`.
 * CommonMark pairs a span across a paragraph's soft line breaks but never across
 * a blank line or into a list item, so each such paragraph is scanned as one string.
 */
export function textCodeSpanRanges(lines: readonly string[]): { start: number; end: number; runLen: number }[] {
  const ranges: { start: number; end: number; runLen: number }[] = [];
  let offset = 0;
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && !BLANK_LINE_RE.test(lines[j]!) && (j === i || !LIST_ITEM_START_RE.test(lines[j]!))) j++;
    if (j > i) {
      const para = lines.slice(i, j).join("\n");
      for (const r of lineCodeSpanRanges(para)) ranges.push({ ...r, start: offset + r.start, end: offset + r.end });
      offset += para.length + 1;
      i = j;
    } else {
      offset += lines[i]!.length + 1;
      i++;
    }
  }
  return ranges;
}

/**
 * A span's content per CommonMark: the text between the delimiters, each line
 * ending plus the next line's indent (a paragraph line's leading whitespace is
 * not content) turned into one space FIRST, then one U+0020 stripped from each
 * end when it both begins and ends with one and is not made entirely of U+0020
 * (a tab or NBSP is not a space here) — what lets `` `` `x` `` `` read as `` `x` ``.
 */
export function codeSpanContent(line: string, range: { start: number; end: number; runLen: number }): string {
  const inner = line.slice(range.start + range.runLen, range.end - range.runLen).replace(/\r?\n[ \t]*/g, " ");
  if (inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
    return inner.slice(1, -1);
  }
  return inner;
}
