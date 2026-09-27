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
 * backticks opens a span that only a run of exactly N closes. `text` is one
 * line, or one stretch's lines joined by `\n` ({@link textCodeSpanRanges}); a
 * newline is ordinary content here.
 *
 * A `` `[^`]*` `` replace mis-pairs the double-backtick form the syntax exists
 * for — `` `` [[x `` `` is how a page writes a literal containing a backtick.
 * An UNMATCHED run opens no span and the scan continues past it, so a stray
 * backtick cannot swallow the rest of the text either.
 *
 * (f) Backslash escapes, opener side only (CommonMark §2.4, §6.1): outside a
 * span, a backtick after an odd number of backslashes is literal, so that ONE
 * backtick cannot open and the rest of its run opens with length N−1. Inside a
 * span a backslash is literal, so a closer ignores it.
 *
 * Linear: every run is found in one pass, and each opener's closer — the next
 * run of that length — comes from a per-length cursor that only moves forward.
 * A forward rescan per run was O(n·√n) on a paragraph of unmatched runs of
 * distinct lengths.
 */
export function lineCodeSpanRanges(text: string): CodeSpanRange[] {
  const starts: number[] = [];
  const lens: number[] = [];
  for (let i = text.indexOf("`"); i !== -1; ) {
    let end = i;
    while (end < text.length && text[end] === "`") end++;
    starts.push(i);
    lens.push(end - i);
    i = text.indexOf("`", end);
  }
  const byLen = new Map<number, { runs: number[]; next: number }>();
  for (let r = 0; r < starts.length; r++) {
    const entry = byLen.get(lens[r]!) ?? { runs: [], next: 0 };
    entry.runs.push(r);
    byLen.set(lens[r]!, entry);
  }
  // Asked with an increasing `after`, so each cursor only moves forward.
  const nextRunOfLen = (len: number, after: number): number => {
    const entry = byLen.get(len);
    if (!entry) return -1;
    while (entry.next < entry.runs.length && entry.runs[entry.next]! <= after) entry.next++;
    return entry.next < entry.runs.length ? entry.runs[entry.next]! : -1;
  };
  const ranges: CodeSpanRange[] = [];
  for (let r = 0; r < starts.length; ) {
    let start = starts[r]!;
    let len = lens[r]!;
    let k = start - 1;
    while (k >= 0 && text[k] === "\\") k--;
    if ((start - 1 - k) % 2 === 1) {
      start++; // the escaped backtick is literal
      len--;
    }
    const close = len === 0 ? -1 : nextRunOfLen(len, r);
    if (close === -1) {
      r++; // unmatched run — literal backticks, no span
      continue;
    }
    ranges.push({ start, end: starts[close]! + len, runLen: len });
    r = close + 1;
  }
  return ranges;
}

// ── Cross-line pairing ──────────────────────────────────────────────────────
// CommonMark pairs a span across the soft line breaks of ONE paragraph. This
// module pairs across only a stretch that is CERTAINLY one; every other line
// pairs on its own. The rule is (a)–(g) on `crossLineStretches`.

/** Half-open `[first, end)` line indices of a stretch that pairs across lines. */
export interface LineRange {
  first: number;
  end: number;
}

/** Blank per CommonMark: spaces and tabs only (a `\r` left by an unnormalized CRLF body is its line ending). */
const BLANK_LINE_RE = /^[ \t]*\r?$/;

/**
 * A line that could begin or interrupt a block in SOME CommonMark context, at
 * any indent: a list item (`-`, `+`, `*`, or 1–9 digits then `.`/`)`, followed
 * by a space, tab or line end), an ATX heading, a blockquote, an HTML or
 * component tag, a fence, or a table row. A deliberate SUPERSET: a stretch cut
 * at such a line pairs across only when the line CERTAINLY interrupts. A
 * backtick run whose info string holds a backtick is no fence (CommonMark, and
 * the parser's `extractFences`), so that line is paragraph text here too.
 */
const MAY_START_BLOCK_RE = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)]|#{1,6})(?=[ \t\r]|$)|[>|<]|`{3,}[^`]*$|~{3})/;
/** A thematic break or setext underline (`---`, `***`, `___`, `===`, spaced or not), or a table delimiter row. */
const RULE_LINE_RE = /^[ \t]*(?:[-*_=][-*_= \t]*|(?=[^|\r]*\|)[-:| \t]+)\r?$/;

/** Whether `line` could begin or interrupt a block — where a stretch is cut ({@link crossLineStretches}). */
export function mayInterruptParagraph(line: string): boolean {
  return MAY_START_BLOCK_RE.test(line) || RULE_LINE_RE.test(line);
}

/** HTML block type 6 tag names common to CommonMark 0.29–0.31 (`source` and `search` differ between them). */
const HTML_BLOCK_6_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|" +
  "fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|" +
  "menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/**
 * A line that CERTAINLY interrupts a paragraph, in any container, at indent ≤ 3:
 * an ATX heading, a backtick fence whose info string holds no backtick, a `~~~`
 * fence, a thematic break (after a paragraph line, `---` is a setext underline,
 * which ends it too), a bullet with content, an ordered item numbered 1 with
 * content, a blockquote, or an HTML block start of types 1–6.
 */
const CERTAIN_INTERRUPT_RE = new RegExp(
  "^ {0,3}(?:#{1,6}(?=[ \\t]|\\r?$)|`{3,}[^`]*$|~{3,}" +
    "|(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})\\r?$" +
    "|[-+*][ \\t]+[^ \\t\\r]|0{0,8}1[.)][ \\t]+[^ \\t\\r]|>" +
    "|<(?:(?:script|pre|style|textarea)(?=[ \\t>]|\\r?$)|!--|\\?|![A-Za-z]|!\\[CDATA\\[" +
    `|/?(?:${HTML_BLOCK_6_NAMES})(?=[ \\t>]|/>|\\r?$)))`,
  "i",
);

/** Indented ≥ 4 columns: never the first line of a stretch (indented code, at any list depth). */
const INDENTED_CODE_RE = /^(?: {0,3}\t| {4})/;
/** A first line that may open a link reference definition, which is not paragraph content. */
const LINK_REF_START_RE = /^ {0,3}\[/;

/**
 * Container markers before a raw-context start, at any indent: list markers
 * (`-`, `+`, `*`, 1–9 digits then `.`/`)`, then whitespace) and `>`.
 */
const RAW_PREFIX_RE = /^(?:[ \t]*(?:(?:[-+*]|\d{1,9}[.)])(?=[ \t])|>))*[ \t]*/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/;
/** HTML block starts and the marker that ends each; `null` ends at a blank line (types 6 and 7). */
const HTML_BLOCK_STARTS: readonly [RegExp, RegExp | null][] = [
  [/^<(?:script|pre|style|textarea)(?=[ \t>]|\r?$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/],
  [/^<\/?[A-Za-z]/, null],
];

/**
 * One hypothesis about the raw context a line is in: a fence or an HTML block,
 * opened in a container whose content starts at column `col` (a list item) or
 * inside a blockquote (`quote`). `null` is "no raw context".
 */
interface RawContext {
  key: string;
  fence?: { ch: string; len: number };
  /** HTML end marker; `null` ends at a blank line. */
  end?: RegExp | null;
  col: number;
  quote: boolean;
}

/** More live hypotheses than this marks every later line raw. */
const MAX_HYPOTHESES = 64;

function indentWidth(s: string): number {
  let col = 0;
  for (const ch of s) {
    if (ch === "\t") col += 4 - (col % 4);
    else if (ch === " ") col++;
    else break;
  }
  return col;
}

/** Visual width of a container prefix: tabs to the next multiple of 4, every other character one column. */
function prefixWidth(s: string): number {
  let col = 0;
  for (const ch of s) col += ch === "\t" ? 4 - (col % 4) : 1;
  return col;
}

/**
 * The hypotheses after `line` when no raw context is open. A start certainly
 * opens only with no container marker, at indent ≤ 3, and not as a type 6/7
 * HTML block (type 7 cannot interrupt a paragraph); any other start also keeps
 * "not a start". The container column is unknown, so each possible one is a
 * hypothesis: a list item's content column is at most 3 left of the start.
 */
function startHypotheses(line: string): (RawContext | null)[] {
  const prefix = RAW_PREFIX_RE.exec(line)![0];
  const rest = line.slice(prefix.length);
  let fence: RawContext["fence"];
  let end: RegExp | null = null;
  const f = FENCE_OPEN_RE.exec(rest);
  if (f) {
    if (f[1]![0] === "`" && f[2]!.includes("`")) return [null]; // not a fence in CommonMark
    fence = { ch: f[1]![0]!, len: f[1]!.length };
  } else {
    const start = HTML_BLOCK_STARTS.find(([re]) => re.test(rest));
    if (!start) return [null];
    end = start[1];
    if (end?.test(rest)) return [null]; // ends on its own line
  }
  const width = prefixWidth(prefix);
  const container = /[^ \t]/.test(prefix);
  const quote = prefix.includes(">");
  const out: (RawContext | null)[] = [];
  if (container || width > 3 || (!fence && end === null)) out.push(null);
  const lo = container ? width : Math.max(0, width - 3);
  for (let col = lo; col <= width; col++) {
    const kind = fence ? `${fence.ch}${fence.len}` : String(HTML_BLOCK_STARTS.findIndex(([, e]) => e === end));
    out.push(fence ? { key: `${kind}|${col}|${quote}`, fence, col, quote } : { key: `${kind}|${col}|${quote}`, end, col, quote });
  }
  return out;
}

/** The hypotheses after `line` under hypothesis `h`. Every close is never earlier than CommonMark's. */
function step(h: RawContext | null, line: string, blank: boolean): (RawContext | null)[] {
  if (h === null) return blank ? [null] : startHypotheses(line);
  if (blank) return h.quote || h.end === null ? [null] : [h];
  const indent = indentWidth(line);
  // The container ended, so the context did; the line is read afresh.
  if (h.quote ? !/^[ \t]*>/.test(line) : indent < h.col) return startHypotheses(line);
  if (h.fence) {
    const m = FENCE_CLOSE_RE.exec(line);
    // A quote's closer carries `>`, which FENCE_CLOSE_RE refuses: it closes when the quote ends.
    const closes = m && m[1]![0] === h.fence.ch && m[1]!.length >= h.fence.len && indent - h.col <= 3;
    return closes ? [null] : [h];
  }
  return h.end?.test(line) ? [null] : [h];
}

/**
 * The stretches of `lines` (a whole document body, after any frontmatter) that
 * pair code spans across lines. A stretch pairs across ONLY if all hold:
 *
 * - (a) it starts at the first line or right after a blank line (a heading,
 *   rule or fence predecessor was measured to change no corpus page, so none counts);
 * - (b) it ends at a blank line, at the last line, or right before a line that
 *   certainly interrupts a paragraph (`CERTAIN_INTERRUPT_RE`); a stretch cut
 *   anywhere else (a component tag, a table row, `<kbd>`, a `2)` item) does not;
 * - (c) no line of it, and not the blank line before it, may lie inside a raw
 *   context — a fence or an HTML block of types 1–7 — under ANY reading of the
 *   containers above it (a may-analysis over hypotheses, each closing no
 *   earlier than CommonMark would);
 * - (d) no line inside it may interrupt a paragraph ({@link mayInterruptParagraph});
 * - (e) its first line is not indented ≥ 4 columns;
 * - (g) it is not a possible link reference definition (first line `[`, and a
 *   `]:` in the stretch).
 *
 * Single-line stretches are omitted: they pair the same either way. Rule (f),
 * backslash escapes, is in {@link lineCodeSpanRanges}, so per-line pairing obeys
 * it too.
 */
export function crossLineStretches(lines: readonly string[]): LineRange[] {
  const out: LineRange[] = [];
  let hyps: (RawContext | null)[] = [null];
  let saturated = false;
  let upper = true; // (a): the next line may start a stretch
  let first = -1;
  const close = (end: number, certain: boolean) => {
    if (certain && end - first >= 2) {
      const text = lines.slice(first, end).join("\n");
      if (!(LINK_REF_START_RE.test(lines[first]!) && text.includes("]:"))) out.push({ first, end });
    }
    first = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const blank = BLANK_LINE_RE.test(line);
    if (!saturated) {
      const next = new Map<string, RawContext | null>();
      for (const h of hyps) for (const o of step(h, line, blank)) next.set(o ? o.key : "", o);
      hyps = [...next.values()];
      saturated = hyps.length > MAX_HYPOTHESES;
    }
    if (blank) {
      if (first >= 0) close(i, true);
      upper = hyps.length === 1 && hyps[0] === null && !saturated;
      continue;
    }
    // No raw context is open when a stretch starts (`upper`), and only a line
    // that may interrupt can open one — which cuts the stretch here anyway.
    if (first >= 0 && mayInterruptParagraph(line)) close(i, CERTAIN_INTERRUPT_RE.test(line));
    if (first >= 0) continue;
    if (upper && !INDENTED_CODE_RE.test(line) && !mayInterruptParagraph(line)) first = i;
    upper = false;
  }
  if (first >= 0) close(lines.length, true);
  return out;
}

/**
 * Every inline code span in `lines`, as ranges over `lines.join("\n")`: each
 * `across` stretch ({@link crossLineStretches}, relative to `lines`) pairs as
 * one text, every other line on its own. The default treats `lines` as a whole
 * document body.
 */
export function textCodeSpanRanges(
  lines: readonly string[],
  across: readonly LineRange[] = crossLineStretches(lines),
): CodeSpanRange[] {
  const ranges: CodeSpanRange[] = [];
  const startsAt = new Map(across.map((r) => [r.first, r.end]));
  let offset = 0;
  for (let i = 0; i < lines.length; ) {
    const end = startsAt.get(i) ?? i + 1;
    const text = lines.slice(i, end).join("\n");
    for (const r of lineCodeSpanRanges(text)) ranges.push({ ...r, start: offset + r.start, end: offset + r.end });
    offset += text.length + 1;
    i = end;
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
export function codeSpanContent(text: string, range: CodeSpanRange): string {
  const inner = text.slice(range.start + range.runLen, range.end - range.runLen).replace(/\r?\n[ \t]*/g, " ");
  if (inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
    return inner.slice(1, -1);
  }
  return inner;
}
