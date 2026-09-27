/**
 * Inline code-span pairing, shared by every scanner that must agree on where a
 * line's code spans are — the web renderer (`renderInline` in
 * `src/web/web-format.ts`), the fact-check strip (`pushInlineCodeSpans` in
 * `markdown-ast.ts`) and the wiki line scanners (`wiki-integrate.ts`).
 *
 * Dependency-free: `web-format.ts` ships in the browser bundle.
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

/**
 * A span's content per CommonMark: the text between the delimiters, with one
 * space stripped from each end when it both begins and ends with a space and is
 * not all spaces — what lets `` `` `x` `` `` read as `` `x` ``.
 */
export function codeSpanContent(line: string, range: { start: number; end: number; runLen: number }): string {
  const inner = line.slice(range.start + range.runLen, range.end - range.runLen);
  if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
    return inner.slice(1, -1);
  }
  return inner;
}
