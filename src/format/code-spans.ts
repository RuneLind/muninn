/**
 * Inline code-span pairing: the one grammar the renderer and the fact-check strip
 * share, so they agree on what is code. Dependency-free and browser-safe.
 */

/**
 * Every inline code span on ONE line, as `[start, end)` ranges over that line,
 * by CommonMark's pairing rule: a run of N backticks opens a span that only a run
 * of exactly N closes. The range covers the whole span, delimiters included.
 *
 * A `` `[^`]*` `` replace mis-pairs the double-backtick form the syntax exists
 * for — `` `` [[x `` `` is how a page writes a literal containing a backtick.
 * An UNMATCHED run opens no span and the scan continues past it, so a stray
 * backtick cannot swallow the rest of the line either.
 *
 * Backslash escapes, opener side only (CommonMark §2.4, §6.1): outside a span,
 * a backtick after an odd number of backslashes is literal, so the rest of its
 * run opens one backtick shorter. Inside a span a backslash is literal, so a
 * closer ignores backslashes.
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
    let slashes = 0;
    while (i - slashes > 0 && line[i - slashes - 1] === "\\") slashes++;
    if (slashes % 2 === 1) i++; // the escaped backtick is literal
    const runLen = openEnd - i;
    if (runLen === 0) continue;
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

/**
 * A span's content per CommonMark: the text between the delimiters, with one
 * U+0020 stripped from each end when it both begins and ends with one and is not
 * made entirely of U+0020 (a tab or NBSP is not a space here) — what lets
 * `` `` `x` `` `` read as `` `x` ``.
 */
export function codeSpanContent(line: string, range: { start: number; end: number; runLen: number }): string {
  const inner = line.slice(range.start + range.runLen, range.end - range.runLen);
  if (inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
    return inner.slice(1, -1);
  }
  return inner;
}
