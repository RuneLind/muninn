/**
 * Inline code-span pairing: the one grammar the renderer and the fact-check strip
 * share, so they agree on what is code. Dependency-free and browser-safe.
 */

/**
 * Every inline code span in `text`, as `[start, end)` ranges over it, by
 * CommonMark's pairing rule: a run of N backticks opens a span that only a run
 * of exactly N closes. The range covers the whole span, delimiters included.
 * `text` is one line, or one paragraph's lines joined by `\n` (see
 * {@link textCodeSpanRanges}); a newline is ordinary content here.
 *
 * A `` `[^`]*` `` replace mis-pairs the double-backtick form the syntax exists
 * for — `` `` [[x `` `` is how a page writes a literal containing a backtick.
 * An UNMATCHED run opens no span and the scan continues past it, so a stray
 * backtick cannot swallow the rest of the text either.
 *
 * Linear: every backtick run is found in one pass, and each run's closer — the
 * next run of the same length — is looked up rather than rescanned for, which is
 * the same answer as scanning forward. The rescan was O(n·√n) on a paragraph of
 * unmatched runs of distinct lengths.
 */
export function lineCodeSpanRanges(text: string): { start: number; end: number; runLen: number }[] {
  const starts: number[] = [];
  const lens: number[] = [];
  for (let i = text.indexOf("`"); i !== -1; ) {
    let end = i;
    while (end < text.length && text[end] === "`") end++;
    starts.push(i);
    lens.push(end - i);
    i = text.indexOf("`", end);
  }
  // nextSame[r]: the index of the first run after run r with r's length, or -1.
  const nextSame = new Array<number>(starts.length);
  const latest = new Map<number, number>();
  for (let r = starts.length - 1; r >= 0; r--) {
    nextSame[r] = latest.get(lens[r]!) ?? -1;
    latest.set(lens[r]!, r);
  }
  const ranges: { start: number; end: number; runLen: number }[] = [];
  for (let r = 0; r < starts.length; ) {
    const close = nextSame[r]!;
    if (close === -1) {
      r++; // unmatched run — literal backticks, no span
      continue;
    }
    ranges.push({ start: starts[r]!, end: starts[close]! + lens[r]!, runLen: lens[r]! });
    r = close + 1;
  }
  return ranges;
}

/** Blank per CommonMark: spaces and tabs only (a `\r` left by an unnormalized CRLF body is its line ending). */
const BLANK_LINE_RE = /^[ \t]*\r?$/;

/**
 * A line that could begin or interrupt a block in SOME CommonMark context, at
 * any indent: a list item (`-`, `+`, `*`, or 1–9 digits then `.`/`)`, followed
 * by a space, tab or line end), an ATX heading, a blockquote, an HTML or
 * component tag, a fence, or a table row. A deliberate SUPERSET — splitting a
 * paragraph where CommonMark would not only reverts that stretch to per-line
 * pairing, never pairs wrongly.
 */
const MAY_START_BLOCK_RE = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)]|#{1,6})(?=[ \t\r]|$)|[>|<]|`{3}|~{3})/;
/** A thematic break or setext underline (`---`, `***`, `___`, `===`, spaced or not), or a table delimiter row. */
const RULE_LINE_RE = /^[ \t]*(?:[-*_=][-*_= \t]*|(?=[^|\r]*\|)[-:| \t]+)\r?$/;
/**
 * A block that can hold blank lines and whose content is never a paragraph: a
 * fence, or an HTML block of CommonMark types 1–5. Once one opens in a `text`
 * block, the rest of that block pairs per line (this module does not track
 * where it closes).
 */
const RAW_BLOCK_START_RE = /^[ \t]*(?:`{3}|~{3}|<(?:!--|\?|![A-Za-z]|!\[CDATA\[|(?:script|pre|style|textarea)(?=[ \t>\r]|$)))/i;
/** Indented ≥ 4 columns: an indented code block after a blank line, in any list depth. */
const INDENTED_CODE_RE = /^(?: {0,3}\t| {4})/;

/** Whether `line` could begin or interrupt a block — the per-line fallback test of {@link textCodeSpanRanges}. */
export function mayInterruptParagraph(line: string): boolean {
  return MAY_START_BLOCK_RE.test(line) || RULE_LINE_RE.test(line);
}

/**
 * Every inline code span in a `text` block, as ranges over `lines.join("\n")`.
 *
 * A span pairs across lines only inside a stretch that is certainly ONE
 * CommonMark paragraph: it starts after a blank line (or at a block start the
 * caller vouches for, `opensParagraph`), is not indented ≥ 4 columns, and runs
 * until the next blank line or {@link mayInterruptParagraph} line. Every other
 * line pairs on its own, which is the per-line result: a line that interrupts,
 * each line after it until a blank line (it may be a list item's lazy
 * continuation), a block that did not open a paragraph, and everything after a
 * fence or raw-HTML-block opener. Doubt never pairs worse than per line.
 */
export function textCodeSpanRanges(
  lines: readonly string[],
  opensParagraph: boolean,
): { start: number; end: number; runLen: number }[] {
  const ranges: { start: number; end: number; runLen: number }[] = [];
  const push = (text: string, offset: number) => {
    for (const r of lineCodeSpanRanges(text)) ranges.push({ ...r, start: offset + r.start, end: offset + r.end });
  };
  let open = opensParagraph;
  let rawBlock = false;
  let offset = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK_LINE_RE.test(line)) {
      open = !rawBlock;
      offset += line.length + 1;
      i++;
      continue;
    }
    if (open && !INDENTED_CODE_RE.test(line) && !mayInterruptParagraph(line)) {
      let j = i + 1;
      while (j < lines.length && !BLANK_LINE_RE.test(lines[j]!) && !mayInterruptParagraph(lines[j]!)) j++;
      const para = lines.slice(i, j).join("\n");
      push(para, offset);
      offset += para.length + 1;
      i = j;
    } else {
      if (RAW_BLOCK_START_RE.test(line)) rawBlock = true;
      push(line, offset);
      offset += line.length + 1;
      i++;
    }
    open = false;
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
export function codeSpanContent(text: string, range: { start: number; end: number; runLen: number }): string {
  const inner = text.slice(range.start + range.runLen, range.end - range.runLen).replace(/\r?\n[ \t]*/g, " ");
  if (inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
    return inner.slice(1, -1);
  }
  return inner;
}
