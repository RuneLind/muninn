/**
 * Discuss's context pack (mimir plan muninn-wiki-discuss): what a question
 * about a page carries, built on the server from a page reference and a
 * selection, never from text the client claims about the file.
 *
 * Pure: the route resolves the page (`resolvePageRef`), reads its raw text and
 * computes the card command, then calls {@link buildContextPack}. P1's prompt
 * (`discuss-prompt.ts`) reads only the path, the line range, the passage and
 * the card command; the section text and the heading list are here for the
 * wiki agent (P2b), which builds on the same pack. The card itself and the
 * repos in reach are P2b's.
 */

import { COMPONENT_NAMES } from "../format/component-spec.ts";
import { frontmatterBodyLine } from "../format/frontmatter-fence.ts";
import { readerFences } from "../format/markdown-ast.ts";
import { locatePassage, pageHeadings, sectionHolding, type LocateResult, type PageHeading } from "./discuss-locate.ts";

/** The section text's bound, in characters. */
export const PACK_SECTION_MAX = 12_000;
/** The passage's bound, as Explain's selection cap. */
export const PACK_PASSAGE_MAX = 1500;
/** The heading hint's bound. */
export const PACK_HEADING_MAX = 200;

/** Block components whose tag lines the mask blanks; `Fact` wrappers stay. */
const MASKED_COMPONENTS = new Set<string>(COMPONENT_NAMES.filter((n) => n !== "Fact"));

/**
 * The pack's mask: frontmatter lines and the tag lines of block components
 * become empty lines, one for one, so line k of the result is line k of the
 * file. Code blocks and fact wrappers stay as they stand. A tag line is a line
 * that holds nothing but component tags (an opener may run over several lines
 * until its `>`); a tag inside a fence is code and stays.
 */
export function packMask(raw: string): string[] {
  const lines = raw.split("\n");
  const out = [...lines];
  const bodyFrom = frontmatterBodyLine(raw);
  for (let k = 0; k < bodyFrom; k++) out[k] = "";
  const fenced = new Set<number>();
  for (const f of readerFences(raw)) for (let k = f.opener; k <= f.closer; k++) fenced.add(k);
  const tagStart = /^\s*<\/?([A-Z][A-Za-z0-9]*)\b/;
  for (let k = bodyFrom; k < lines.length; k++) {
    if (fenced.has(k)) continue;
    const m = tagStart.exec(lines[k]!);
    if (!m || !MASKED_COMPONENTS.has(m[1]!)) continue;
    // Gather the tag's lines up to the line where it closes.
    let end = k;
    let joined = lines[k]!;
    while (!/>\s*$/.test(joined) && end + 1 < lines.length && end - k < 20) {
      end++;
      joined += "\n" + lines[end]!;
    }
    if (!/^\s*(?:<\/?[A-Z][A-Za-z0-9]*\b(?:"[^"]*"|'[^']*'|[^'">])*>\s*)+$/.test(joined)) continue;
    for (let j = k; j <= end; j++) out[j] = "";
    k = end;
  }
  return out;
}

export interface PackSection {
  /** The heading the section starts at; null for the text above the first heading. */
  heading: string | null;
  /** 1-based, inclusive. */
  fromLine: number;
  toLine: number;
  /** The masked lines `fromLine..toLine`, cut at {@link PACK_SECTION_MAX}. */
  text: string;
  /** The text was cut; the cut is marked at its end. */
  cut: boolean;
}

export interface ContextPack {
  wiki: string;
  relPath: string;
  title: string;
  /** The page's absolute path on the machine serving the reader. */
  path: string;
  /** The selection, trimmed and bounded; null for a question about the whole page. */
  passage: string | null;
  /** Where the passage sits; null for the whole page. */
  location: LocateResult | null;
  /** The headings holding the passage's first line, outermost first. */
  headingTrail: string[];
  section: PackSection;
  headings: PageHeading[];
  /** The plan-card command, for a page with `plan_status` in a plan-card root. */
  cardCommand: string | null;
}

export interface PackInput {
  wiki: string;
  relPath: string;
  title: string;
  absPath: string;
  raw: string;
  selection?: string;
  occurrence?: number;
  total?: number;
  heading?: string;
  cardCommand?: string | null;
}

function boundedSection(masked: string[], heading: string | null, fromLine: number, toLine: number): PackSection {
  const text = masked.slice(fromLine - 1, toLine).join("\n");
  if (text.length <= PACK_SECTION_MAX) return { heading, fromLine, toLine, text, cut: false };
  return {
    heading,
    fromLine,
    toLine,
    text: `${text.slice(0, PACK_SECTION_MAX)}\n[… cut at ${PACK_SECTION_MAX.toLocaleString("en-US")} characters; the section runs to line ${toLine} …]`,
    cut: true,
  };
}

/** The pack for a question about `raw`: about the passage `selection` when given,
 *  about the whole page when not. */
export function buildContextPack(input: PackInput): ContextPack {
  const { raw } = input;
  const headings = pageHeadings(raw);
  const masked = packMask(raw);
  const lastLine = Math.max(1, raw.split("\n").length);
  const passage = input.selection?.trim().slice(0, PACK_PASSAGE_MAX) || null;
  const base = {
    wiki: input.wiki,
    relPath: input.relPath,
    title: input.title,
    path: input.absPath,
    headings,
    cardCommand: input.cardCommand ?? null,
  };
  const top = Math.min(frontmatterBodyLine(raw) + 1, lastLine);
  if (!passage) {
    return { ...base, passage: null, location: null, headingTrail: [], section: boundedSection(masked, null, top, lastLine) };
  }
  const location = locatePassage(raw, {
    selection: passage,
    occurrence: input.occurrence,
    total: input.total,
    heading: input.heading?.slice(0, PACK_HEADING_MAX),
    stripTitle: input.title,
  });
  const anchor = location.fromLine;
  const holding = anchor === null ? null : sectionHolding(headings, anchor);
  const headingTrail = anchor === null
    ? []
    : headings.filter((h) => h.fromLine <= anchor && anchor <= h.toLine).sort((a, b) => a.level - b.level).map((h) => h.text);
  let section: PackSection;
  if (holding) section = boundedSection(masked, holding.text, holding.fromLine, holding.toLine);
  else {
    // Above the first heading (or not placed): the page from the top to it.
    const end = headings[0] ? Math.max(top, headings[0].fromLine - 1) : lastLine;
    section = boundedSection(masked, null, top, end);
  }
  return { ...base, passage, location, headingTrail, section };
}
