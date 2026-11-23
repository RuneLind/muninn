/**
 * Discuss's locator: where in a page FILE a passage the reader selected sits,
 * as a line range, and how it was found (mimir plan muninn-wiki-discuss, P1).
 *
 * The client sends rendered text: no `**`, backticks, link syntax, list or
 * heading markers, component tags. So the match is made on the source collapsed
 * toward what the reader shows ({@link collapseForLocate}) under the shared key
 * (`locate-key.ts`), and a hit maps back to the file through two offset maps:
 * fact wrappers stripped (`stripFactWrappersWithMap`), then markup collapsed.
 *
 * Beside `locateExcerpt` (`explain-context.ts`), which stays as it is for
 * Explain and returns a window of text, never a position. Unlike it, this
 * locator never answers with the head of the page: a passage it cannot place
 * gets the heading's section (reported as such) or no range at all.
 *
 * Pure: no filesystem, no index. `src/dashboard/views/wiki-boot/wiki-discuss-parity.test.ts`
 * holds the collapse to the reader's own render.
 */

import { COMPONENT_NAMES, INLINE_COMPONENT_NAMES, SELF_CLOSING_ALLOWED } from "../format/component-spec.ts";
import { lineCodeSpanRanges } from "../format/code-spans.ts";
import { frontmatterBodyLine } from "../format/frontmatter-fence.ts";
import {
  COMPONENT_OPEN_RE,
  isTaskList,
  listItemLines,
  parseBlocks,
  readerFences,
  stripFactWrappersWithMap,
  type Block,
  type ListBlock,
} from "../format/markdown-ast.ts";
import { parseTimelineItem } from "../format/genre-lists.ts";
import { findLiveSentinelBlocks } from "./factcheck-context.ts";
import { DISCUSS_CONTEXT_KEY_CHARS } from "./discuss-bounds.ts";
import { keyChar, locateKey, matchStarts } from "./locate-key.ts";
import { wikilinkRegExp } from "../utils/wikilink-scan.ts";

/** How many key characters the edges tier compares at each end. */
export const LOCATE_EDGE_CHARS = 80;

const COMPONENTS = new Set<string>(COMPONENT_NAMES);
const INLINE_COMPONENTS = new Set<string>(INLINE_COMPONENT_NAMES);

/**
 * The attributes whose values the reader shows as text, per component, in the
 * order the render shows them (measured on `renderWikiHtml`, see the parity
 * test). A selection inside one maps to the tag's line. Every other attribute
 * the render shows (a Figure caption after its body, a Query's head, a Tab's
 * label, which is a button) is a deliberate difference the parity test lists.
 */
const SHOWN_ATTRS: Readonly<Record<string, readonly string[]>> = {
  Fold: ["title", "summary"],
  Callout: ["title"],
};

/** The same for a self-closing tag: a body-less `<FileRef path=… />` shows its path. */
const SHOWN_SELF_CLOSING_ATTRS: Readonly<Record<string, readonly string[]>> = {
  ...SHOWN_ATTRS,
  FileRef: ["path"],
};

/**
 * The lines whose block component tag the reader parses as markup, by its own
 * rule (`tryParseComponent`, `markdown-ast.ts`): the trimmed line matches
 * `COMPONENT_OPEN_RE` (double-quoted attributes only, the whole tag on one
 * line) with a known name, and it is a self-closing tag that may self-close
 * and owns its line, or an opener closed on its own line, or an opener alone
 * on its line with a matching `</Name>` line after it (same-name nesting
 * counted), which is then a tag line too. Any other tag shows as text: a bare
 * attribute (`open`), a single-quoted value, a tag over several lines, an
 * unclosed opener.
 */
function readerTagLines(lines: readonly string[], skip: ReadonlySet<number>, code: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (let k = 0; k < lines.length; k++) {
    if (skip.has(k) || code.has(k)) continue;
    const m = COMPONENT_OPEN_RE.exec(lines[k]!.trim());
    if (!m || !COMPONENTS.has(m[1]!)) continue;
    const name = m[1]!;
    const rest = m[4]!;
    if (m[3] === "/") {
      if (SELF_CLOSING_ALLOWED.has(name as never) && rest.trim() === "") out.add(k);
      continue;
    }
    const close = `</${name}>`;
    const inline = rest.indexOf(close);
    if (inline !== -1) {
      if (rest.slice(inline + close.length).trim() === "") out.add(k);
      continue;
    }
    if (rest.trim() !== "") continue;
    let nesting = 1;
    for (let j = k + 1; j < lines.length; j++) {
      if (code.has(j)) continue;
      const t = lines[j]!.trim();
      if (t === close) {
        if (--nesting === 0) {
          out.add(k);
          out.add(j);
          break;
        }
        continue;
      }
      const o = COMPONENT_OPEN_RE.exec(t);
      if (o && o[1] === name && o[3] !== "/" && !o[4]!.includes(close)) nesting++;
    }
  }
  return out;
}

/** The collapsed text of a page and, per collapsed character, its offset in the
 *  RAW file (fact wrappers included). */
export interface LocateCollapse {
  text: string;
  map: number[];
}

/** Attribute values with their offsets inside a tag. */
function tagAttrs(tag: string, base: number): Map<string, { value: string; at: number }> {
  const out = new Map<string, { value: string; at: number }>();
  for (const m of tag.matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = m[2] ?? m[3] ?? "";
    const quote = m[0].search(/["']/);
    out.set(m[1]!, { value, at: base + m.index! + quote + 1 });
  }
  return out;
}

/** End offset (exclusive) of a component tag opening at `i`, honouring quoted
 *  attribute values, which may hold `>`; -1 when it never closes. */
function tagEnd(text: string, i: number): number {
  let quote = "";
  for (let k = i + 1; k < text.length; k++) {
    const ch = text[k]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return k + 1;
    else if (ch === "<") return -1;
  }
  return -1;
}

/** A block component whose body the reader does not show, opened alone at a line's start. */
const HIDDEN_BODY_OPEN_RE = /^\s*<(Diagram|Embed)\b/;

/**
 * The lines of a block whose body the reader never shows as text, tags
 * included: it draws a Diagram from its `src` and frames an Embed, so the
 * body's words (and any heading in it) are not on screen. Shared by the
 * collapse and {@link pageHeadings}, so the two cannot disagree.
 */
function hiddenBodyLines(
  text: string,
  lines: readonly string[],
  lineStart: readonly number[],
  bodyFrom: number,
  skip: ReadonlySet<number>,
  code: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>();
  for (let k = bodyFrom; k < lines.length; k++) {
    if (skip.has(k) || code.has(k)) continue;
    const m = HIDDEN_BODY_OPEN_RE.exec(lines[k]!);
    if (!m) continue;
    const end = tagEnd(text, lineStart[k]! + m[0].length - m[1]!.length - 1);
    if (end === -1 || /\/\s*>$/.test(text.slice(lineStart[k]!, end))) continue;
    let close = k;
    while (close < lines.length && !lines[close]!.includes(`</${m[1]}>`)) close++;
    if (close === lines.length) continue;
    for (let j = k; j <= close; j++) out.add(j);
    k = close;
  }
  return out;
}

/**
 * The lines where the reader's own parser (`parseBlocks`, run on the body as
 * `readerBody` hands it over: no frontmatter, no sentinel lines) starts a list
 * item, so the collapse drops exactly the markers the reader drops (`1)` is
 * text, so is an indented `3.` under prose, and only one marker per line):
 *  - `marker`: an item's first line;
 *  - `task`: an item whose `[x]`/`[ ]` the reader draws as ✓/✗: in a
 *    Checklist's list, a RunChecklist's step lists, the task list of a Lane
 *    directly in a NextMoves, and the lists nested under their rows;
 *  - `dated`: a Timeline's top-level item, whose separator after the date
 *    the reader does not show.
 * Line numbers are those of `lines` (0-based): the fact-stripped text's ({@link readerLines}).
 */
function readerListLines(lines: readonly string[], keep: readonly number[]) {
  const marker = new Set<number>();
  const task = new Set<number>();
  const dated = new Set<number>();
  const firstLines = (list: ListBlock) => (listItemLines(list) ?? []).flatMap((ls) => (ls.length ? [keep[ls[0]!]!] : []));
  const visitList = (list: ListBlock, checklist: boolean): void => {
    for (const k of firstLines(list)) {
      marker.add(k);
      if (checklist) task.add(k);
    }
    for (const kids of list.nested ?? []) for (const c of kids ?? []) if (c.type === "ul" || c.type === "ol") visitList(c, checklist);
  };
  const visit = (blocks: readonly Block[], parent: string | null): void => {
    for (const b of blocks) {
      if (b.type === "ul" || b.type === "ol") visitList(b, false);
      else if (b.type === "component") {
        const lists = b.children.filter((c): c is ListBlock => c.type === "ul" || c.type === "ol");
        const checklist =
          b.name === "Checklist"
            ? lists.filter((c) => c.type === "ul").slice(0, 1)
            : b.name === "RunChecklist"
              ? lists
              : b.name === "Lane" && parent === "NextMoves"
                ? lists.filter(isTaskList)
                : [];
        for (const c of b.children) {
          if (c.type !== "ul" && c.type !== "ol") visit([c], b.name);
          else {
            visitList(c, checklist.includes(c));
            if (b.name === "Timeline") for (const k of firstLines(c)) dated.add(k);
          }
        }
      }
    }
  };
  visit(parseBlocks(keep.map((k) => lines[k]!).join("\n")), null);
  return { marker, task, dated };
}

/** The page's lines as the collapse reads them: fact wrappers stripped,
 *  frontmatter, sentinel and fence marker lines in `skip`, fence bodies in
 *  `code`, hidden bodies in `hidden`. The strip removes a line that holds only
 *  a `<Fact …>` or `</Fact>` tag, so every line number here is the STRIPPED
 *  text's: a caller reaches the file through `rawOf` (offsets), never by
 *  using a line number as the file's. */
function readerLines(raw: string) {
  const { text, map: rawOf } = stripFactWrappersWithMap(raw.replace(/\0/g, " "));
  const lines = text.split("\n");
  const lineStart: number[] = [];
  {
    let at = 0;
    for (const l of lines) {
      lineStart.push(at);
      at += l.length + 1;
    }
  }
  const bodyFrom = frontmatterBodyLine(text);
  const skip = new Set<number>();
  for (let k = 0; k < bodyFrom; k++) skip.add(k);
  const sentinels = new Set<number>();
  for (const s of findLiveSentinelBlocks(text)) {
    sentinels.add(s.startLine);
    sentinels.add(s.endLine);
  }
  for (const k of sentinels) skip.add(k);
  const code = new Set<number>();
  for (const f of readerFences(text)) {
    skip.add(f.opener);
    skip.add(f.closer);
    for (let k = f.opener + 1; k < f.closer; k++) {
      if (f.lang.toLowerCase() === "mermaid") skip.add(k);
      else code.add(k);
    }
  }
  const hidden = hiddenBodyLines(text, lines, lineStart, bodyFrom, skip, code);
  return { text, rawOf, lines, lineStart, bodyFrom, skip, code, hidden, sentinels };
}

/**
 * A table's delimiter row: what `/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-*:?\s*)*\|?\s*$/`
 * matched, cell by cell (fix round 2 of A4: that regex backtracks
 * exponentially, about 1 s for `-`, then `|:` × 26, then `x`).
 */
export function isTableRule(line: string): boolean {
  const cells = line.split("|");
  const first = cells.length > 1 && cells[0]!.trim() === "" ? 1 : 0;
  return cells.every((c, k) => k < first || (k === first ? /^:?-+:?$/ : /^:?-*:?$/).test(c.trim()));
}

const COMPONENT_TAG_RE = /<\/?([A-Z][A-Za-z0-9]*)/y;
const WIKILINK_AT_RE = wikilinkRegExp("label", "y");

/** The first `ch` at or after a position in one line, remembered, so increasing positions read each character once. */
function nextIndexOf(line: string, ch: string): (pos: number) => number {
  let from = 0;
  let at = -2;
  return (pos) => {
    if (at === -2 || pos < from || (at >= 0 && pos > at)) {
      from = pos;
      at = line.indexOf(ch, pos);
    }
    return at;
  };
}

/**
 * `/\[([^\]\n]+)\]\(([^)\n]*)\)/y` at `i` of a line holding no `\n`, without
 * the regex's rescan to the end of the line from every `[` that does not close
 * (fix round 2 of A4: 380 ms for 16k `[a ` at ae0772b1). The label ends at
 * the first `]` after the `[`, the URL at the first `)` after the `(`.
 */
function mdLinkAt(
  line: string,
  i: number,
  nextClose: (pos: number) => number,
  nextParen: (pos: number) => number,
): { label: string; length: number } | null {
  const j = nextClose(i + 1);
  if (j <= i + 1 || line[j + 1] !== "(") return null;
  const k = nextParen(j + 2);
  return k < 0 ? null : { label: line.slice(i + 1, j), length: k + 1 - i };
}

/**
 * The page source collapsed toward the text the reader renders, under the key.
 * It goes further than Explain's `collapseWithMap`:
 *  - frontmatter, fact-check sentinel lines and a leading H1 that repeats
 *    `stripTitle` are dropped (the reader drops them, `readerBody`);
 *  - a fence's opener and closer lines are dropped and its body kept as it
 *    stands; a `mermaid` fence's body is dropped too (the reader draws it);
 *  - a list marker (`-`, `+`, `*`, `1.`) is dropped on the lines where the
 *    reader's parser starts an item ({@link readerListLines}), with a
 *    checklist row's `[x]`/`[ ]` and a Timeline date's `—`/`–` separator;
 *    a table's rule row and a thematic break are dropped whole; quote and
 *    heading markers and table pipes the key drops anyway;
 *  - a component tag the reader parses ({@link readerTagLines}) is dropped, except the attribute values the reader shows
 *    ({@link SHOWN_ATTRS}); a `<Diagram>` or `<Embed>` body is dropped whole
 *    (the reader draws or frames it, and shows none of its words);
 *  - a `[[wikilink]]` reads as the reader shows it, `wikiLinkText`: its label,
 *    else its target; a `[label](url)` as its label; inline code as its text.
 * HTML entities and backslash escapes are NOT decoded, because the reader
 * shows them as written.
 */
export function collapseForLocate(raw: string, opts: { stripTitle?: string } = {}): LocateCollapse {
  const { text, rawOf, lines, lineStart, bodyFrom, skip, code, hidden, sentinels } = readerLines(raw);
  const keep: number[] = [];
  for (let k = bodyFrom; k < lines.length; k++) if (!sentinels.has(k)) keep.push(k);
  const items = readerListLines(lines, keep);
  for (const k of hidden) skip.add(k);
  if (opts.stripTitle) {
    const want = opts.stripTitle.trim().toLowerCase();
    for (let k = bodyFrom; k < lines.length; k++) {
      if (skip.has(k)) continue;
      if (lines[k]!.trim() === "") continue;
      const m = /^\s*#\s+(.+?)\s*$/.exec(lines[k]!);
      if (m && m[1]!.trim().toLowerCase() === want) skip.add(k);
      break;
    }
  }

  const tagLines = readerTagLines(lines, skip, code);
  const out: string[] = [];
  const map: number[] = [];
  const emit = (ch: string, at: number) => {
    const k = keyChar(ch);
    for (let u = 0; u < k.length; u++) {
      out.push(k[u]!);
      map.push(rawOf[at]!);
    }
  };
  const emitRange = (from: number, to: number) => {
    for (let i = from; i < to; i++) emit(text[i]!, i);
  };

  let li = 0;
  while (li < lines.length) {
    const line = lines[li]!;
    const base = lineStart[li]!;
    if (skip.has(li)) {
      li++;
      continue;
    }
    if (code.has(li)) {
      emitRange(base, base + line.length);
      li++;
      continue;
    }
    if (isTableRule(line) && /-/.test(line)) {
      li++;
      continue;
    }
    // Line-start markers. The key drops `>`, `#`, `-`, `+` and `*`, so only a
    // numbered marker needs taking off, on an item line of the reader's parser.
    const quoted = /^[ \t]*>/.test(line);
    let i = /^[ \t]*(?:>[ \t]?)*/.exec(line)![0].length;
    /** Offsets in `text` the reader does not show: a Timeline separator's dashes. */
    let dropDash: { from: number; to: number } | null = null;
    if (!quoted && items.marker.has(li)) {
      const lm = /^[ \t]*(?:[-+*]|\d{1,9}\.)[ \t]+/.exec(line);
      if (lm) {
        i = lm[0].length;
        if (items.task.has(li)) {
          const tm = /^\[[ xX]\][ \t]*/.exec(line.slice(i));
          if (tm) i += tm[0].length;
        }
        if (items.dated.has(li)) {
          const item = line.slice(i);
          const t = parseTimelineItem(item);
          if (t.date !== null) dropDash = { from: base + i, to: base + i + item.length - t.text.length };
        }
      }
    }
    // An Obsidian callout's `[!type]` becomes the callout's frame, not text.
    if (quoted) {
      const cm = /^\[![\w-]+\][+-]?/.exec(line.slice(i));
      if (cm) i += cm[0].length;
    }
    i += /^[ \t]*/.exec(line.slice(i))![0].length;
    const contentStart = i;
    /** Block components opened on this line, whose closer on it is a tag too. */
    const openedHere = new Set<string>();
    const spans = lineCodeSpanRanges(line);
    // Spans are in order and `i` only grows: the next span not yet behind `i`.
    let nextSpan = 0;
    const nextClose = nextIndexOf(line, "]");
    const nextParen = nextIndexOf(line, ")");
    while (i < line.length) {
      while (nextSpan < spans.length && spans[nextSpan]!.start < i) nextSpan++;
      const span = spans[nextSpan]?.start === i ? spans[nextSpan] : undefined;
      if (span) {
        emitRange(base + span.start + span.runLen, base + span.end - span.runLen);
        i = span.end;
        continue;
      }
      const ch = line[i]!;
      if (ch === "[") {
        WIKILINK_AT_RE.lastIndex = i;
        const w = WIKILINK_AT_RE.exec(line);
        if (w) {
          // The reader shows `wikiLinkText`: the label, else the target, trimmed.
          // The key drops the white space it trims, so the raw span maps 1:1.
          const labelUsed = w[2] !== undefined && w[2].trim() !== "";
          const from = base + i + 2 + (labelUsed ? w[1]!.length + 1 : 0);
          const src = labelUsed ? w[2]! : w[1]!;
          emitRange(from, from + src.length);
          i += w[0].length;
          continue;
        }
        const l = mdLinkAt(line, i, nextClose, nextParen);
        if (l) {
          emitRange(base + i + 1, base + i + 1 + l.label.length);
          i += l.length;
          continue;
        }
      }
      if (ch === "<") {
        COMPONENT_TAG_RE.lastIndex = i;
        const t = COMPONENT_TAG_RE.exec(line);
        const closing = line[i + 1] === "/";
        const name = t?.[1] ?? "";
        const end = t && COMPONENTS.has(name) ? tagEnd(text, base + i) : -1;
        // A block component's tag is markup only where the reader parses it
        // ({@link readerTagLines}), and a closer on its opener's line
        // (`<Meter …>label</Meter>`); any other block tag the reader shows as
        // text. An inline one is markup anywhere.
        const isTag =
          end !== -1 &&
          end <= base + line.length &&
          (INLINE_COMPONENTS.has(name) || (closing && openedHere.has(name)) || (i === contentStart && tagLines.has(li)));
        if (isTag) {
          const tag = text.slice(base + i, end);
          if (!closing) {
            openedHere.add(name);
            const attrs = tagAttrs(tag, base + i);
            const shown = /\/\s*>$/.test(tag) ? SHOWN_SELF_CLOSING_ATTRS[name] : SHOWN_ATTRS[name];
            for (const name of shown ?? []) {
              const a = attrs.get(name);
              if (a) emitRange(a.at, a.at + a.value.length);
            }
          }
          i = end - base;
          continue;
        }
      }
      if (!(dropDash && base + i >= dropDash.from && base + i < dropDash.to && (ch === "—" || ch === "–"))) emit(ch, base + i);
      i++;
    }
    li++;
  }
  return { text: out.join(""), map };
}

/** One heading of the page, 1-based lines; `toLine` is the last line of its
 *  section (up to the next heading of the same or a higher level). */
export interface PageHeading {
  level: number;
  text: string;
  fromLine: number;
  toLine: number;
}

/** An ATX heading line: a closing run of `#` counts only after white space
 *  (`## C#` is «C#»), and a CRLF line's `\r` is white space. */
const HEADING_LINE_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t\r]*$/;

/** The page's markdown headings outside fences, frontmatter and the bodies the
 *  reader hides ({@link hiddenBodyLines}), with their sections' line ranges. */
export function pageHeadings(raw: string): PageHeading[] {
  const lines = raw.split("\n");
  const bodyFrom = frontmatterBodyLine(raw);
  const fenced = new Set<number>();
  for (const f of readerFences(raw)) for (let k = f.opener; k <= f.closer; k++) fenced.add(k);
  // `readerLines` numbers the fact-stripped text, which lacks each line that
  // held only a `<Fact>` tag: translate through its offset map to the file's.
  const r = readerLines(raw);
  const rawLine = lineIndex(raw);
  const hidden = new Set<number>();
  for (const k of r.hidden) hidden.add(rawLine(r.rawOf[r.lineStart[k]!] ?? raw.length) - 1);
  const found: { level: number; text: string; line: number }[] = [];
  for (let k = bodyFrom; k < lines.length; k++) {
    if (fenced.has(k) || hidden.has(k)) continue;
    const m = HEADING_LINE_RE.exec(lines[k]!);
    if (m) found.push({ level: m[1]!.length, text: m[2]!.trim(), line: k });
  }
  let last = lines.length - 1;
  while (last > 0 && lines[last]!.trim() === "") last--;
  return found.map((h, j) => {
    let end = last;
    for (let n = j + 1; n < found.length; n++) {
      if (found[n]!.level <= h.level) {
        end = found[n]!.line - 1;
        break;
      }
    }
    while (end > h.line && lines[end]!.trim() === "") end--;
    return { level: h.level, text: h.text, fromLine: h.line + 1, toLine: end + 1 };
  });
}

/** The innermost heading section holding 1-based `line`, or null above the
 *  first heading. */
export function sectionHolding(headings: readonly PageHeading[], line: number): PageHeading | null {
  let best: PageHeading | null = null;
  for (const h of headings) if (h.fromLine <= line && line <= h.toLine) best = h;
  return best;
}

export interface LocateRequest {
  /** The selection as the reader read it (rendered text). */
  selection: string;
  /** The article's text just before the selection, as the client read it
   *  (reader additions left out): its last key characters are compared. */
  before?: string;
  /** The same just after the selection: its first key characters. */
  after?: string;
  /** `before` stops at the article's start (it is short because nothing precedes). */
  atStart?: boolean;
  /** `after` stops at the article's end. */
  atEnd?: boolean;
  /** The client saw the selection start or end in text the reader added
   *  (`added`), or span lanes the reader reordered (`reordered`): it cannot be
   *  placed exactly, so it goes to the heading's section. */
  edge?: "added" | "reordered";
  /** The nearest heading above the selection, as the reader shows it. */
  heading?: string;
  /** The page title, when the reader drops a leading H1 that repeats it. */
  stripTitle?: string;
}

/**
 * How the passage was found:
 *  - `exact`: one match whose neighbours in the source agree with the
 *    client's context ({@link contextAccepts});
 *  - `section`: no such single match, so the section of the heading the
 *    client sent, when only one heading has that text and it holds a match
 *    (if there are any), with `reason` saying why;
 *  - `none`: neither a single match nor a heading section. No range then.
 */
export type LocateFound = "exact" | "section" | "none";

/** Why a passage was not placed exactly. */
export type LocateMiss =
  /** The source does not hold the selection (nor its first and last {@link LOCATE_EDGE_CHARS}). */
  | "no-match"
  /** Matches exist, but none has neighbours that agree with the client's context. */
  | "no-agreement"
  /** More than one match agrees. */
  | "ambiguous"
  /** The client saw the selection start or end in reader-added text. */
  | "added"
  /** The selection spans lanes the reader reordered. */
  | "reordered";

export interface LocateResult {
  found: LocateFound;
  /** Set when `found` is not `exact`. */
  reason: LocateMiss | null;
  /** The tier that matched: the whole selection, or its first and last {@link LOCATE_EDGE_CHARS}. */
  tier: "whole" | "edges" | null;
  /** How many places the matching tier found. */
  matches: number;
  /** 1-based, inclusive: the passage's own lines when `exact`, the section's
   *  when `section`, null when `none`. */
  fromLine: number | null;
  toLine: number | null;
  /** Raw-file offsets of an `exact` passage, end exclusive; null otherwise. */
  rawFrom: number | null;
  rawTo: number | null;
  /** Several matches the context could not choose among (or did not test). */
  ambiguous: boolean;
  /** Start lines of every match, when it was not placed exactly. */
  candidates: number[];
  /** The heading section a `section` result names. */
  section: { heading: string; fromLine: number; toLine: number } | null;
}

function lineIndex(raw: string): (offset: number) => number {
  const starts = [0];
  for (let i = raw.indexOf("\n"); i !== -1; i = raw.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The key characters on each side the agreement rule compares. */
export const CONTEXT_NEAR_CHARS = 48;
/** A side of context agrees in full from this many key characters on. */
export const CONTEXT_FULL_MIN = 12;
/** A side that disagrees only past this many key characters is not
 *  contradicted: the reader shows something the source does not (or the
 *  reverse) further out. Nearer than this, it is. */
export const CONTEXT_PARTIAL_MIN = 8;
/** Matches scored at most; past it the selection goes to the section. */
const MAX_SCORED = 400;

/**
 * One side of a match, compared outward from the match. It disagrees at the
 * first position where a character differs, where the source runs out before
 * the client's text, or where the client reaches the page's edge and the
 * source goes on. Then:
 *  - `full`: no disagreement, and the client sent at least
 *    {@link CONTEXT_FULL_MIN} key characters, or both reach the page's edge;
 *  - `agrees`: no disagreement, 1 to {@link CONTEXT_FULL_MIN} − 1 characters;
 *  - `open`: the client sent nothing and is not at the page's edge;
 *  - `partial`: the first disagreement is at {@link CONTEXT_PARTIAL_MIN} or later;
 *  - `contradicted`: it is nearer.
 * A match is accepted only when both of its sides are `full`
 * ({@link contextAccepts}); every other state refuses it.
 */
export type SideState = "full" | "agrees" | "open" | "partial" | "contradicted";

/** Compare the client's side with the source's, outward from the match: the
 *  left side from its end, the right side from its start. `clientAtEdge`: the
 *  client's text stops at the article's edge; `sourceAtEdge`: the source's
 *  window reaches the collapsed page's edge. The test file pins the states by example. */
export function sideState(client: string, source: string, side: "left" | "right", clientAtEdge: boolean, sourceAtEdge: boolean): SideState {
  const L = client.length;
  const S = source.length;
  const n = Math.min(L, S);
  let a = 0;
  if (side === "left") while (a < n && client[L - 1 - a] === source[S - 1 - a]) a++;
  else while (a < n && client[a] === source[a]) a++;
  let d: number | null = null;
  if (a < n) d = a;
  else if (S < L) d = S;
  else if (clientAtEdge && !(S === L && sourceAtEdge)) d = L;
  if (d === null) return clientAtEdge || L >= CONTEXT_FULL_MIN ? "full" : L > 0 ? "agrees" : "open";
  return d >= CONTEXT_PARTIAL_MIN ? "partial" : "contradicted";
}

/** The agreement rule: a match is accepted only when both sides agree in full.
 *  One side in full and the other only partly took a wrong copy when the
 *  reader showed a label beside the true one (a Fold's «Details», a callout's
 *  «Note») that the collapse does not hold. */
export function contextAccepts(left: SideState, right: SideState): boolean {
  return left === "full" && right === "full";
}

/**
 * Locate a reader selection in the raw page file. A match is taken only when
 * its neighbours in the collapsed source agree with the context the client
 * read around the selection ({@link contextAccepts}), whether the source holds
 * one match or several. Tiers, in order:
 *  1. the whole selection;
 *  2. when the whole is not found and is longer than {@link LOCATE_EDGE_CHARS}:
 *     its first {@link LOCATE_EDGE_CHARS} key characters with its last ones
 *     after them (a start without an end counts as a miss);
 *  3. the section of the heading the client sent, with why;
 *  4. nothing. Never the head of the page.
 */
export function locatePassage(raw: string, req: LocateRequest): LocateResult {
  const collapsed = collapseForLocate(raw, { stripTitle: req.stripTitle });
  const text = collapsed.text;
  const line = lineIndex(raw);
  const needle = locateKey(req.selection);
  const N = CONTEXT_NEAR_CHARS;
  const F = DISCUSS_CONTEXT_KEY_CHARS;
  const beforeKey = locateKey(req.before ?? "");
  const afterKey = locateKey(req.after ?? "");
  const beforeFar = beforeKey.slice(-F);
  const afterFar = afterKey.slice(0, F);
  const before = beforeFar.slice(-N);
  const after = afterFar.slice(0, N);

  /** Candidate spans in the collapsed text, `[s, e)`. */
  let spans: { s: number; e: number }[] = [];
  let tier: LocateResult["tier"] = null;
  if (needle) {
    const whole = matchStarts(text, needle);
    if (whole.length) {
      tier = "whole";
      spans = whole.map((s) => ({ s, e: s + needle.length }));
    } else if (needle.length > LOCATE_EDGE_CHARS) {
      const prefix = needle.slice(0, LOCATE_EDGE_CHARS);
      const suffix = needle.slice(-LOCATE_EDGE_CHARS);
      for (const s of matchStarts(text, prefix)) {
        // The end may sit further than the needle's length (text the source
        // holds and the reader does not show), never before the prefix starts.
        const limit = s + needle.length * 2 + 200;
        for (let at = text.indexOf(suffix, s); at !== -1 && at + suffix.length <= limit; at = text.indexOf(suffix, at + 1)) {
          spans.push({ s, e: at + suffix.length });
        }
      }
      if (spans.length) tier = "edges";
    }
  }

  const base = {
    tier,
    matches: spans.length,
    rawFrom: null,
    rawTo: null,
    ambiguous: false,
    candidates: [] as number[],
    section: null,
  };

  let reason: LocateMiss;
  let accepted: { s: number; e: number }[] = [];
  if (req.edge === "added" || req.edge === "reordered") reason = req.edge;
  else if (!spans.length) reason = "no-match";
  else if (spans.length > MAX_SCORED) reason = "ambiguous";
  else {
    // The client's edge holds for a window only when its whole text fits in it.
    const left = (client: string, s: number, w: number) =>
      sideState(client, text.slice(Math.max(0, s - w), s), "left", req.atStart === true && beforeKey.length <= w, s <= w);
    const right = (client: string, e: number, w: number) =>
      sideState(client, text.slice(e, e + w), "right", req.atEnd === true && afterKey.length <= w, e + w >= text.length);
    accepted = spans.filter(({ s, e }) => contextAccepts(left(before, s, N), right(after, e, N)));
    // Copies whose near context is the same: the one whose far context agrees
    // in full on both sides, when it is the only one.
    if (accepted.length > 1) {
      const far = accepted.filter(({ s, e }) => left(beforeFar, s, F) === "full" && right(afterFar, e, F) === "full");
      if (far.length === 1) accepted = far;
    }
    reason = accepted.length === 0 ? "no-agreement" : "ambiguous";
  }
  if (accepted.length === 1) {
    const { s, e } = accepted[0]!;
    const rawFrom = collapsed.map[s]!;
    const rawTo = collapsed.map[e - 1]! + 1;
    return { ...base, found: "exact", reason: null, fromLine: line(rawFrom), toLine: line(rawTo - 1), rawFrom, rawTo };
  }

  const candidateLines = [...new Set(spans.map((sp) => line(collapsed.map[sp.s]!)))];
  const headings = pageHeadings(raw);
  const want = req.heading ? locateKey(req.heading) : "";
  const named = want ? headings.filter((h) => locateKey(h.text) === want) : [];
  // A section only when it is known to be the passage's: one heading of that
  // text, holding a match when there are any. A repeated text names none.
  const only = named.length === 1 ? named[0]! : null;
  const section = only && (!candidateLines.length || candidateLines.some((l) => only.fromLine <= l && l <= only.toLine)) ? only : null;
  const miss = { ...base, reason, ambiguous: spans.length > 1, candidates: candidateLines };
  if (section) {
    return {
      ...miss,
      found: "section",
      fromLine: section.fromLine,
      toLine: section.toLine,
      section: { heading: section.text, fromLine: section.fromLine, toLine: section.toLine },
    };
  }
  return { ...miss, found: "none", fromLine: null, toLine: null };
}
