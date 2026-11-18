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
 * Pure: no filesystem, no index. `src/dashboard/views/components/wiki-discuss-parity.test.ts`
 * holds the collapse to the reader's own render.
 */

import { COMPONENT_NAMES, INLINE_COMPONENT_NAMES } from "../format/component-spec.ts";
import { lineCodeSpanRanges } from "../format/code-spans.ts";
import { frontmatterBodyLine } from "../format/frontmatter-fence.ts";
import { readerFences, stripFactWrappersWithMap } from "../format/markdown-ast.ts";
import { findLiveSentinelBlocks } from "./factcheck-context.ts";
import { keyChar, locateKey, matchStarts } from "./locate-key.ts";
import { wikiLinkText } from "./decision-text.ts";

/** How many key characters the prefix and suffix tiers compare. */
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

const TABLE_RULE_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-*:?\s*)*\|?\s*$/;
const COMPONENT_TAG_RE = /<\/?([A-Z][A-Za-z0-9]*)/y;
const WIKILINK_AT_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/y;
const MD_LINK_AT_RE = /\[([^\]\n]+)\]\(([^)\n]*)\)/y;

/**
 * The page source collapsed toward the text the reader renders, under the key.
 * It goes further than Explain's `collapseWithMap`:
 *  - frontmatter, fact-check sentinel lines and a leading H1 that repeats
 *    `stripTitle` are dropped (the reader drops them, `readerBody`);
 *  - a fence's opener and closer lines are dropped and its body kept as it
 *    stands; a `mermaid` fence's body is dropped too (the reader draws it);
 *  - a list marker (`-`, `+`, `1.`) at the start of a line is dropped, and a
 *    table's rule row and a thematic break are dropped whole; quote and
 *    heading markers and table pipes the key drops anyway;
 *  - a component tag is dropped, except the attribute values the reader shows
 *    ({@link SHOWN_ATTRS});
 *  - a `[[wikilink]]` reads as the reader shows it, `wikiLinkText`: its label,
 *    else its target; a `[label](url)` as its label; inline code as its text.
 * HTML entities and backslash escapes are NOT decoded, because the reader
 * shows them as written.
 */
export function collapseForLocate(raw: string, opts: { stripTitle?: string } = {}): LocateCollapse {
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
  for (const s of findLiveSentinelBlocks(text)) {
    skip.add(s.startLine);
    skip.add(s.endLine);
  }
  /** 0 = prose, 1 = code kept verbatim. */
  const code = new Set<number>();
  for (const f of readerFences(text)) {
    skip.add(f.opener);
    skip.add(f.closer);
    for (let k = f.opener + 1; k < f.closer; k++) {
      if (f.lang.toLowerCase() === "mermaid") skip.add(k);
      else code.add(k);
    }
  }
  if (opts.stripTitle) {
    const want = opts.stripTitle.trim().toLowerCase();
    for (let k = bodyFrom; k < lines.length; k++) {
      if (skip.has(k)) continue;
      if (lines[k]!.trim() === "") continue;
      const m = /^\s*#\s+(.+)$/.exec(lines[k]!);
      if (m && m[1]!.trim().toLowerCase() === want) skip.add(k);
      break;
    }
  }

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
    if (TABLE_RULE_RE.test(line) && /-/.test(line)) {
      li++;
      continue;
    }
    // Line-start markers. The key drops `>`, `#`, `-`, `+` and `*`, so only a
    // numbered marker needs taking off, and only outside a quote: the reader
    // parses no list inside a blockquote and shows its `1.` as text.
    const quoted = /^[ \t]*>/.test(line);
    let i = /^[ \t]*(?:>[ \t]?)*/.exec(line)![0].length;
    if (!quoted) {
      for (;;) {
        const lm = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/.exec(line.slice(i));
        if (!lm) break;
        i += lm[0].length;
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
    let next = li + 1;
    while (i < line.length) {
      const span = spans.find((s) => s.start === i);
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
          const shown = wikiLinkText(w[1]!, w[2]);
          const labelUsed = w[2] !== undefined && w[2].trim() !== "";
          const from = base + i + 2 + (labelUsed ? w[1]!.length + 1 : 0);
          const src = labelUsed ? w[2]! : w[1]!;
          // `wikiLinkText` trims; the key drops the white space it trims.
          if (locateKey(shown) === locateKey(src)) emitRange(from, from + src.length);
          else for (const c of shown) emit(c, from);
          i += w[0].length;
          continue;
        }
        MD_LINK_AT_RE.lastIndex = i;
        const l = MD_LINK_AT_RE.exec(line);
        if (l) {
          emitRange(base + i + 1, base + i + 1 + l[1]!.length);
          i += l[0].length;
          continue;
        }
      }
      if (ch === "<") {
        COMPONENT_TAG_RE.lastIndex = i;
        const t = COMPONENT_TAG_RE.exec(line);
        const closing = line[i + 1] === "/";
        const name = t?.[1] ?? "";
        const end = t && COMPONENTS.has(name) ? tagEnd(text, base + i) : -1;
        // A block component's tag is markup when its line holds nothing else, or
        // its opener and closer share the line (`<Meter …>label</Meter>`); any
        // other block tag the reader shows as text. An inline one is markup anywhere.
        const restOfLine = end === -1 ? "" : text.slice(end, base + line.length);
        const isTag =
          end !== -1 &&
          (INLINE_COMPONENTS.has(name) ||
            (closing && (openedHere.has(name) || (i === contentStart && restOfLine.trim() === ""))) ||
            (!closing && i === contentStart && (restOfLine.trim() === "" || end > base + line.length || restOfLine.trimEnd().endsWith(`</${name}>`))));
        if (isTag) {
          {
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
            // A tag may run over several lines: carry on after it.
            if (end > base + line.length) {
              while (next < lines.length && lineStart[next]! + lines[next]!.length < end) next++;
              const rest = end - lineStart[next]!;
              const tail = lines[next]!.slice(rest);
              // Scan the tail of the line the tag ends on as prose.
              const tailBase = end;
              for (let k = 0; k < tail.length; k++) emit(tail[k]!, tailBase + k);
              next++;
              i = line.length;
              break;
            }
            i = end - base;
            continue;
          }
        }
      }
      emit(ch, base + i);
      i++;
    }
    li = next;
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

/** The page's markdown headings outside fences and frontmatter, with their
 *  sections' line ranges. */
export function pageHeadings(raw: string): PageHeading[] {
  const lines = raw.split("\n");
  const bodyFrom = frontmatterBodyLine(raw);
  const fenced = new Set<number>();
  for (const f of readerFences(raw)) for (let k = f.opener; k <= f.closer; k++) fenced.add(k);
  const found: { level: number; text: string; line: number }[] = [];
  for (let k = bodyFrom; k < lines.length; k++) {
    if (fenced.has(k)) continue;
    const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[k]!);
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
  /** How many matches of the selection start before it in the article. */
  occurrence?: number;
  /** How many matches the article holds in all. */
  total?: number;
  /** The nearest heading above the selection, as the reader shows it. */
  heading?: string;
  /** The page title, when the reader drops a leading H1 that repeats it. */
  stripTitle?: string;
}

/**
 * How the passage was found:
 *  - `one`: the selection matched one place;
 *  - `occurrence`: it matched several, and the client's occurrence number chose one;
 *  - `section`: no single place, so the section of the heading the client sent
 *    (`ambiguous` when there were several matches the count could not choose among);
 *  - `none`: no match and no heading section. The range is then empty.
 */
export type LocateFound = "one" | "occurrence" | "section" | "none";

export interface LocateResult {
  found: LocateFound;
  /** The tier that matched: the whole selection, or its first {@link LOCATE_EDGE_CHARS}. */
  tier: "whole" | "prefix" | null;
  /** How many places the matching tier found. */
  matches: number;
  /** 1-based, inclusive. `toLine` is null when only the start was found. */
  fromLine: number | null;
  toLine: number | null;
  /** Several matches the count could not choose among. */
  ambiguous: boolean;
  /** Start lines of every match, when there were several. */
  candidates: number[];
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

/**
 * Locate a reader selection in the raw page file. Tiers, in order:
 *  1. the whole selection: one match is taken; several are chosen among by the
 *     client's occurrence number when its total agrees with this count;
 *  2. the selection's first {@link LOCATE_EDGE_CHARS} key characters, when the
 *     whole did not match: one match is taken, and the range runs to where the
 *     selection's last {@link LOCATE_EDGE_CHARS} end after it, or has a start
 *     only when they are not found;
 *  3. the section of the heading the client sent;
 *  4. nothing. Never the head of the page.
 */
export function locatePassage(raw: string, req: LocateRequest): LocateResult {
  const collapsed = collapseForLocate(raw, { stripTitle: req.stripTitle });
  const line = lineIndex(raw);
  const needle = locateKey(req.selection);
  const startLine = (s: number) => line(collapsed.map[s]!);
  const endLine = (s: number, len: number) => line(collapsed.map[s + len - 1]!);
  const result = (r: Partial<LocateResult> & Pick<LocateResult, "found">): LocateResult => ({
    tier: null,
    matches: 0,
    fromLine: null,
    toLine: null,
    ambiguous: false,
    candidates: [],
    ...r,
  });

  let candidates: number[] = [];
  let tier: LocateResult["tier"] = null;
  if (needle) {
    const whole = matchStarts(collapsed.text, needle);
    if (whole.length === 1) {
      return result({ found: "one", tier: "whole", matches: 1, fromLine: startLine(whole[0]!), toLine: endLine(whole[0]!, needle.length) });
    }
    if (whole.length > 1) {
      const { occurrence, total } = req;
      if (total === whole.length && occurrence !== undefined && Number.isInteger(occurrence) && occurrence >= 0 && occurrence < whole.length) {
        const s = whole[occurrence]!;
        return result({ found: "occurrence", tier: "whole", matches: whole.length, fromLine: startLine(s), toLine: endLine(s, needle.length) });
      }
      candidates = whole;
      tier = "whole";
    } else if (needle.length > LOCATE_EDGE_CHARS) {
      const prefix = needle.slice(0, LOCATE_EDGE_CHARS);
      const hits = matchStarts(collapsed.text, prefix);
      if (hits.length === 1) {
        const s = hits[0]!;
        const suffix = needle.slice(-LOCATE_EDGE_CHARS);
        const at = collapsed.text.indexOf(suffix, s);
        const ok = at !== -1 && at + suffix.length <= s + needle.length * 2 + 200;
        return result({ found: "one", tier: "prefix", matches: 1, fromLine: startLine(s), toLine: ok ? endLine(at, suffix.length) : null });
      }
      if (hits.length > 1) {
        candidates = hits;
        tier = "prefix";
      }
    }
  }

  const candidateLines = [...new Set(candidates.map(startLine))];
  const headings = pageHeadings(raw);
  const want = req.heading ? locateKey(req.heading) : "";
  const named = want ? headings.filter((h) => locateKey(h.text) === want) : [];
  // Among same-named headings, the one whose section holds a match.
  const section = named.find((h) => candidateLines.some((l) => h.fromLine <= l && l <= h.toLine)) ?? named[0];
  if (section) {
    return result({
      found: "section",
      tier,
      matches: candidates.length,
      fromLine: section.fromLine,
      toLine: section.toLine,
      ambiguous: candidates.length > 1,
      candidates: candidateLines,
    });
  }
  return result({ found: "none", tier, matches: candidates.length, ambiguous: candidates.length > 1, candidates: candidateLines });
}
