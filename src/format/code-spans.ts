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

/**
 * The SAME-LENGTH form of `stripLineCodeSpans` (`wiki-integrate.ts`): every
 * code-span code unit becomes a `\n`, so offsets into the result index the raw
 * line unchanged.
 *
 * `\n` is the blank on purpose rather than a space or a private-use sentinel: the
 * wikilink scanners reading this string are line-scoped by a `\n` exclusion in
 * their own regex (`WIKILINK_SPAN_SOURCE`, `NESTED_MARKUP_RE`,
 * `firstDanglingWikilinkOpen`'s callers), so a blanked span cannot be read as part
 * of a match NOR supply a bracket to one — which a space would. The `<Question>`
 * closing-phrase regexes in `question.ts` are NOT line-scoped: their white space
 * admits one `\n`. They are safe because a span is at least three code units
 * (`` `x` ``), so its blank is at least three line breaks, more than one fits.
 *
 * This is what the code-span exclusion has to be for anything that reports an
 * offset: `stripLineCodeSpans` moves every offset left by the length of the spans
 * before it, so a finding located in the stripped text and quoted from the raw line
 * quotes the wrong place (measured: on a line carrying a live occurrence AND a
 * backticked one, the excerpt was the DOCUMENTATION).
 */
export function maskLineCodeSpans(line: string): string {
  const ranges = lineCodeSpanRanges(line);
  if (ranges.length === 0) return line;
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    out += line.slice(cursor, r.start) + "\n".repeat(r.end - r.start);
    cursor = r.end;
  }
  return out + line.slice(cursor);
}
