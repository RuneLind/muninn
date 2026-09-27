/**
 * Inline code-span pairing: the one grammar the renderer and the fact-check strip
 * share, so they agree on what is code. Dependency-free and browser-safe.
 */

/** A code span: `[start, end)` over the scanned text, delimiters included, and its delimiter length. */
export interface CodeSpanRange {
  start: number;
  end: number;
  runLen: number;
}

/**
 * Every inline code span in `text`, by CommonMark's pairing rule: a run of N
 * backticks opens a span that only a run of exactly N closes. `text` is one line,
 * or one cross-line stretch joined by `\n` ({@link crossLineStretches}); a newline
 * is ordinary content here. Backslash escapes are not read.
 *
 * A `` `[^`]*` `` replace mis-pairs the double-backtick form the syntax exists
 * for — `` `` [[x `` `` is how a page writes a literal containing a backtick.
 * An UNMATCHED run opens no span and the scan continues past it, so a stray
 * backtick cannot swallow the rest of the text either.
 *
 * Linear: each opener's closer — the next run of that length — comes from a
 * per-length cursor that only moves forward. A forward rescan per run is
 * O(n·√n) on a paragraph of unmatched runs of distinct lengths.
 */
export function lineCodeSpanRanges(text: string): CodeSpanRange[] {
  const starts: number[] = [];
  const lens: number[] = [];
  const byLen = new Map<number, { runs: number[]; next: number }>();
  for (let i = text.indexOf("`"); i !== -1; ) {
    let end = i;
    while (text[end] === "`") end++;
    const entry = byLen.get(end - i) ?? { runs: [], next: 0 };
    entry.runs.push(starts.length);
    byLen.set(end - i, entry);
    starts.push(i);
    lens.push(end - i);
    i = text.indexOf("`", end);
  }
  const ranges: CodeSpanRange[] = [];
  for (let r = 0; r < starts.length; ) {
    const len = lens[r]!;
    const entry = byLen.get(len)!;
    while (entry.next < entry.runs.length && entry.runs[entry.next]! <= r) entry.next++;
    if (entry.next === entry.runs.length) {
      r++; // unmatched run — literal backticks, no span
      continue;
    }
    const close = entry.runs[entry.next]!;
    ranges.push({ start: starts[r]!, end: starts[close]! + len, runLen: len });
    r = close + 1;
  }
  return ranges;
}

// ── Cross-line pairing ──────────────────────────────────────────────────────
// CommonMark pairs a span across the soft line breaks of ONE paragraph. This
// module pairs across only a stretch that is CERTAINLY a whole paragraph
// (`crossLineStretches`); every other line pairs on its own, exactly as before.

/** Half-open `[first, end)` line indices of a stretch that pairs across lines. */
export interface LineRange {
  first: number;
  end: number;
}

const BLANK_LINE_RE = /^[ \t]*$/;

/**
 * A line that could begin or interrupt a block in SOME CommonMark context, at
 * any indent: a list item, an ATX heading, a blockquote, an HTML or component
 * tag, a fence, or a table row. A deliberate superset. A backtick run whose info
 * string holds a backtick is no fence (CommonMark, and `extractFences`), so that
 * line is paragraph text here too.
 */
const MAY_START_BLOCK_RE = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)]|#{1,6})(?=[ \t]|$)|[>|<]|`{3,}[^`]*$|~{3})/;
/** A thematic break or setext underline, spaced or not, or a table delimiter row. */
const RULE_LINE_RE = /^[ \t]*(?:[-*_=][-*_= \t]*|(?=[^|]*\|)[-:| \t]+)$/;

/** Whether `line` could begin or interrupt a block — a line no cross-line stretch holds. */
export function mayInterruptParagraph(line: string): boolean {
  return MAY_START_BLOCK_RE.test(line) || RULE_LINE_RE.test(line);
}

/** HTML block type 6 tag names common to CommonMark 0.29–0.31. */
const HTML_BLOCK_6_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|" +
  "fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|" +
  "menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/**
 * A line that CERTAINLY interrupts a paragraph, at indent ≤ 3: an ATX heading, a
 * fence, a thematic break or setext `---`, a bullet with content, an ordered item
 * numbered 1 with content, a blockquote, or an HTML block start of types 1–6.
 */
const CERTAIN_INTERRUPT_RE = new RegExp(
  "^ {0,3}(?:#{1,6}(?=[ \\t]|$)|`{3,}[^`]*$|~{3,}" +
    "|(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$" +
    "|[-+*][ \\t]+[^ \\t]|0{0,8}1[.)][ \\t]+[^ \\t]|>" +
    "|<(?:(?:script|pre|style|textarea)(?=[ \\t>]|$)|!--|\\?|![A-Za-z]|!\\[CDATA\\[" +
    `|/?(?:${HTML_BLOCK_6_NAMES})(?=[ \\t>]|/>|$)))`,
  "i",
);

/** Indented ≥ 4 columns: indented code, so never the first line of a stretch. */
const INDENTED_CODE_RE = /^(?: {0,3}\t| {4})/;
/** A first line that may open a link reference definition, which is not paragraph content. */
const LINK_REF_START_RE = /^ {0,3}\[/;
/** A backtick inside what may be an inline tag or autolink, which CommonMark reads before code spans. */
const INLINE_TAG_BACKTICK_RE = /<[A-Za-z!?/][^<>]*`/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A fence or HTML opener behind a container marker, 4+ spaces or a tab: a raw context this scan cannot place. */
const UNPLACED_OPENER_RE =
  /^(?:[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+|>[ \t]*)+|[ \t]*\t[ \t]*| {4}[ \t]*)(?:`{3,}|~{3,}|<[A-Za-z/!?])/;
/** A fence run indented 4+ spaces: it may close a fence opened inside a list item. */
const DEEP_FENCE_RUN_RE = /^ {4,}(?:`{3,}|~{3,})[ \t]*$/;
/** HTML block starts (after ≤ 3 spaces) and the marker that ends each; `null` ends at a blank line (types 6, 7). */
const HTML_BLOCK_STARTS: readonly [RegExp, RegExp | null][] = [
  [/^<(?:script|pre|style|textarea)(?=[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/],
  [/^<\/?[A-Za-z]/, null],
];

/**
 * The stretches of `lines` (a whole document body, after any frontmatter) whose
 * code spans pair across lines. One forward scan with one state: a stretch
 * starts at the first line or after a blank line and pairs across only when all
 * hold:
 *
 * - it ends at a blank line, the last line, or a line that certainly interrupts
 *   a paragraph (`CERTAIN_INTERRUPT_RE`);
 * - no other line in it may interrupt one ({@link mayInterruptParagraph});
 * - it lies outside every fence and HTML block (types 1–7) the scan tracks: a
 *   top-level fence (indent ≤ 3; the closer repeats the opener's character, at
 *   least as long) or an HTML block. After an opener the scan cannot place
 *   (`UNPLACED_OPENER_RE`), after a line that may end the list item an indented
 *   opener sits in, and after an opener inside a type 7 HTML block, which may
 *   instead be paragraph text, no later line pairs across;
 * - its first line is not indented 4+ columns;
 * - it is not a possible link reference definition (first line `[`, a `]:` in it);
 * - no backtick in it follows a backslash — this grammar reads no escapes — or
 *   lies inside what may be an inline tag or autolink (`<a title="`">`).
 *
 * A trailing `\r` is a line ending. Single-line stretches are omitted.
 */
export function crossLineStretches(input: readonly string[]): LineRange[] {
  const lines = input.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const out: LineRange[] = [];
  let fence = ""; // the open fence's run
  let htmlEnd: RegExp | null | undefined; // the open HTML block's end; `null` = a blank line
  let unplaced = false;
  let rawIndent = 0; // the open fence's or HTML block's opener indent
  let mayBeText = false; // the open HTML block may instead be paragraph text (type 7)
  let first = -1;
  let certain = false;
  const close = (end: number) => {
    if (first >= 0 && certain && end - first >= 2) {
      const text = lines.slice(first, end).join("\n");
      if (!text.includes("\\`") && !INLINE_TAG_BACKTICK_RE.test(text) &&
        !(LINK_REF_START_RE.test(lines[first]!) && text.includes("]:"))) {
        out.push({ first, end });
      }
    }
    first = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const blank = BLANK_LINE_RE.test(line);
    // An opener indented 1–3 spaces may sit in a list item. The item ends — and so
    // the raw context, which this scan would keep open — at a line indented less,
    // and a fence in it may close at a run indented 4+.
    if ((fence || htmlEnd !== undefined) && rawIndent > 0 && !blank) {
      const indent = /^ */.exec(line)![0].length;
      if (indent < rawIndent || (fence && DEEP_FENCE_RUN_RE.test(line))) unplaced = true;
    }
    if (fence) {
      const m = FENCE_CLOSE_RE.exec(line);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = "";
      continue;
    }
    if (htmlEnd !== undefined) {
      // Read as paragraph text instead, this line would open a raw context.
      if (mayBeText && (UNPLACED_OPENER_RE.test(line) || (/^ {0,3}[`~<]/.test(line) && CERTAIN_INTERRUPT_RE.test(line)))) {
        unplaced = true;
      }
      if (htmlEnd === null ? blank : htmlEnd.test(line)) htmlEnd = undefined;
      if (!blank) continue;
    }
    if (blank) {
      close(i);
      continue;
    }
    if (UNPLACED_OPENER_RE.test(line)) unplaced = true;
    rawIndent = /^ */.exec(line)![0].length;
    const f = FENCE_OPEN_RE.exec(line);
    if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      close(i);
      fence = f[1]!;
      continue;
    }
    const lt = /^ {0,3}(<.*)$/.exec(line);
    const html = lt && HTML_BLOCK_STARTS.find(([re]) => re.test(lt[1]!));
    if (html) {
      mayBeText = !CERTAIN_INTERRUPT_RE.test(line);
      if (mayBeText) certain = false;
      close(i);
      if (!html[1]?.test(line)) htmlEnd = html[1];
      continue;
    }
    if (first < 0 && !unplaced && (i === 0 || BLANK_LINE_RE.test(lines[i - 1]!))) {
      first = i;
      certain = !INDENTED_CODE_RE.test(line);
    }
    if (first >= 0 && mayInterruptParagraph(line)) {
      if (CERTAIN_INTERRUPT_RE.test(line)) close(i);
      else certain = false;
    }
  }
  close(lines.length);
  return out;
}

/**
 * A span's content per CommonMark: the text between the delimiters, each line
 * ending plus the next line's indent turned into one space FIRST, then one
 * U+0020 stripped from each end when it both begins and ends with one and is not
 * made entirely of U+0020 (a tab or NBSP is not a space here) — what lets
 * `` `` `x` `` `` read as `` `x` ``.
 */
export function codeSpanContent(text: string, range: CodeSpanRange): string {
  const inner = text.slice(range.start + range.runLen, range.end - range.runLen).replace(/\r?\n[ \t]*/g, " ");
  if (inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
    return inner.slice(1, -1);
  }
  return inner;
}
