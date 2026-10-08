/**
 * The top of a report page (reader lenses PR 2): `<More>` inside `<Tldr>`,
 * `<StatusRows>`, and a `<DecisionLog>` item's first sentence. Pure and
 * browser-safe, so the four renderers, the wiki linter and the chat bundle
 * read one rule.
 *
 * - **`<More>`** (D10) is the closed «Mer om saken» part of a `<Tldr>`. Its
 *   label comes from the wiki's `language`, never from the page.
 * - **`<StatusRows>`** (D11) is a list of `**Label:** value` items. A value is
 *   split on ` · `, and a state phrase anywhere in a segment gets a colour,
 *   longest phrase first, so «ikke i prod» never reads as «i prod».
 * - **First sentence** (D6): up to the first `. ` (or `? `, `! `) outside a
 *   code span, a link, a tag and an abbreviation such as `f.eks.`, at least
 *   `FIRST_SENTENCE_MIN` visible chars long; the renderer accepts a split only
 *   where the two halves render as the whole does.
 */

import type { Block } from "./markdown-ast.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { isAbbreviation } from "./abbreviations.ts";
import { escapeRegExp } from "../utils/escape-regexp.ts";

// ── <More> ───────────────────────────────────────────────────────────────────

/** The `<More>` summary, the same for every reader of a wiki (D10). */
export const MORE_LABELS: Record<QuestionLanguage, string> = {
  en: "More about this",
  no: "Mer om saken",
};

/** A `<More>` block directly in a body: what a `<Tldr>` turns into its closed part. */
export function isMoreBlock(b: Block): b is Extract<Block, { type: "component" }> & { name: "More" } {
  return b.type === "component" && b.name === "More";
}

// ── <StatusRows> ─────────────────────────────────────────────────────────────

/** A row may hold at most this many characters (D11, mimir lint check 13). */
export const STATUS_ROW_MAX = 160;

export interface StatusRow {
  /** `Status` for `**Status:** …`; null when the item has no bold label. */
  label: string | null;
  /** The text after the label (the whole item when there is none). */
  value: string;
  /** The item as written, without its list marker. What the 160-char rule measures. */
  text: string;
}

/** `**Label:** value` or `**Label**: value`. */
const ROW_LABEL_RE = /^\*\*([^*\n]+?):\*\*(?:\s+|$)([\s\S]*)$|^\*\*([^*\n]+?)\*\*:(?:\s+|$)([\s\S]*)$/;

/** One `<StatusRows>` item. */
export function parseStatusRow(item: string): StatusRow {
  const text = item.trim();
  const m = ROW_LABEL_RE.exec(text);
  if (!m) return { label: null, value: text, text };
  const label = (m[1] ?? m[3]!).trim();
  return { label, value: (m[2] ?? m[4] ?? "").trim(), text };
}

/** Every row of a `<StatusRows>` body: the top-level items of each list
 *  directly in it, in source order. */
export function statusRows(children: Block[]): StatusRow[] {
  const out: StatusRow[] = [];
  for (const b of children) {
    if (b.type === "ul" || b.type === "ol") for (const item of b.items) out.push(parseStatusRow(item));
  }
  return out;
}

/** Every `<StatusRows>` block on the page, at any depth, in source order. */
export function statusRowBlocks(blocks: Block[]): StatusRow[][] {
  const out: StatusRow[][] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === "StatusRows") out.push(statusRows(b.children));
      walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** The segment separator in a row's value. */
export const STATUS_SEPARATOR = " · ";

/** What a ` · ` inside is no segment separator: code spans, wikilinks,
 *  links, a component's tag pair with its body, any other tag. */
const SEGMENT_PROTECTED_RES: readonly RegExp[] = [
  /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g,
  /\[\[[^\]\n]*\]\]/g,
  /!?\[[^\]\n]*\]\([^)\n]*\)/g,
  /<([A-Z][A-Za-z]*)\b[^<>\n]*>[\s\S]*?<\/\1>/g,
  /<[^<>\n]*>/g,
];

/** A row's value split on ` · ` outside code spans, links and tag pairs. */
export function statusSegments(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  const masked = maskSpans(value, SEGMENT_PROTECTED_RES);
  for (let i = masked.indexOf(STATUS_SEPARATOR); i !== -1; i = masked.indexOf(STATUS_SEPARATOR, i + STATUS_SEPARATOR.length)) {
    out.push(value.slice(start, i));
    start = i + STATUS_SEPARATOR.length;
  }
  out.push(value.slice(start));
  return out;
}

export type StatusTone = "good" | "warn" | "muted" | "info";

/** State phrases per `language` and their tone. Matched longest first, as
 *  whole words, any case. «i prod» is the only good state: the work reached
 *  production; «opprettet» says a Jira task exists, no more. */
export const STATUS_STATES: Record<QuestionLanguage, readonly { phrase: string; tone: StatusTone }[]> = {
  no: [
    { phrase: "merget, ikke i prod", tone: "warn" },
    { phrase: "ikke opprettet", tone: "muted" },
    { phrase: "ikke i prod", tone: "muted" },
    { phrase: "opprettet", tone: "info" },
    { phrase: "i prod", tone: "good" },
  ],
  en: [
    { phrase: "merged, not in prod", tone: "warn" },
    { phrase: "not created", tone: "muted" },
    { phrase: "not in prod", tone: "muted" },
    { phrase: "created", tone: "info" },
    { phrase: "in prod", tone: "good" },
  ],
};

const STATE_RES: Record<QuestionLanguage, RegExp> = {
  no: stateRe("no"),
  en: stateRe("en"),
};

/** A phrase ends where a letter, digit or `-` does not follow: «i prod-miljøet» is no state. */
function stateRe(lang: QuestionLanguage): RegExp {
  const alts = [...STATUS_STATES[lang]].sort((a, b) => b.phrase.length - a.phrase.length).map((s) => escapeRegExp(s.phrase));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}-])`, "giu");
}

/** A word that, earlier in a segment, keeps a good state from reading good:
 *  «ikke ennå i prod», "not yet in prod". Either language's, on every page. */
const NEGATION_RE = /(?<![\p{L}\p{N}])(?:ikke|aldri|not|never|no)(?![\p{L}\p{N}])/iu;

function toneOf(lang: QuestionLanguage, phrase: string): StatusTone {
  const p = phrase.toLowerCase();
  return STATUS_STATES[lang].find((s) => s.phrase === p)?.tone ?? "info";
}

/** Elements whose text is no state: code, a link, a pill (a component's own
 *  state), a fact-check chip. Their text is a barrier between phrases. */
function isSkipTag(tag: string): boolean {
  return /^<(code|a|button)\b/i.test(tag) || /^<span\b[^>]*\bclass="[^"]*\bpill\b/i.test(tag);
}

const VOID_TAG_RE = /^<(br|img|hr|input|wbr)\b|\/>$/i;

/**
 * Wrap each state phrase in a segment's RENDERED html in
 * `<span class="sr-state sr-<tone>">`. The phrase is matched on the segment's
 * visible text with every other tag transparent, so a fact-check mark
 * (`<span class="fc-mark">`) or `<em>` inside a phrase changes nothing: the
 * phrase is coloured piecewise, one span per text run, in the tone of the
 * whole. Never matched: text inside `<code>`, `<a>`, a `.pill` or a chip
 * button. A good phrase after a negation word in the same segment
 * (`NEGATION_RE`) is muted instead.
 */
export function markStatePhrases(html: string, lang: QuestionLanguage): string {
  const parts = html.split(/(<[^>]*>)/);
  // The visible stream, and for each of its chars the part and offset it came from.
  let stream = "";
  const owner: { part: number; off: number }[] = [];
  const stack: boolean[] = [];
  let skip = 0;
  parts.forEach((part, k) => {
    if (part.startsWith("<")) {
      if (part.startsWith("</")) {
        if (stack.pop()) skip--;
      } else if (!VOID_TAG_RE.test(part)) {
        const s = isSkipTag(part);
        stack.push(s);
        if (s) {
          skip++;
          stream += "\x00";
          owner.push({ part: -1, off: 0 });
        }
      }
      return;
    }
    if (skip > 0) return;
    for (let i = 0; i < part.length; i++) {
      stream += part[i];
      owner.push({ part: k, off: i });
    }
  });

  const re = STATE_RES[lang];
  re.lastIndex = 0;
  const ranges = new Map<number, { start: number; end: number; tone: StatusTone }[]>();
  for (const m of stream.matchAll(re)) {
    let tone = toneOf(lang, m[0]);
    if (tone === "good" && NEGATION_RE.test(stream.slice(0, m.index))) tone = "muted";
    // One range per text run the phrase covers.
    for (let i = m.index; i < m.index + m[0].length; ) {
      const { part } = owner[i]!;
      let j = i;
      while (j + 1 < m.index + m[0].length && owner[j + 1]!.part === part) j++;
      const list = ranges.get(part) ?? [];
      list.push({ start: owner[i]!.off, end: owner[j]!.off + 1, tone });
      ranges.set(part, list);
      i = j + 1;
    }
  }
  if (ranges.size === 0) return html;
  return parts
    .map((part, k) => {
      const list = ranges.get(k);
      if (!list) return part;
      let out = "";
      let at = 0;
      for (const r of list) {
        out += part.slice(at, r.start) + `<span class="sr-state sr-${r.tone}">${part.slice(r.start, r.end)}</span>`;
        at = r.end;
      }
      return out + part.slice(at);
    })
    .join("");
}

// ── First sentence (D6) ──────────────────────────────────────────────────────

/** A first sentence longer than this gets a lint warning (D6). */
export const FIRST_SENTENCE_MAX = 160;

/** A first sentence shorter than this (visible chars) joins the next one
 *  (orchestrator ruling, reader lenses PR 2 fix round 1): «High.» alone tells
 *  an Overview reader nothing. */
export const FIRST_SENTENCE_MIN = 15;

const CODE_SPAN_RE = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g;
/** What a sentence end inside is not one: code spans, wikilinks, links, tags,
 *  the reader's parked wikilink sentinels, bare URLs. */
const PROTECTED_RES: readonly RegExp[] = [
  CODE_SPAN_RE,
  /\[\[[^\]\n]*\]\]/g,
  /!?\[[^\]\n]*\]\([^)\n]*\)/g,
  /<[^<>\n]*>/g,
  /\x00[^\x00]*\x00/g,
  // A URL's own trailing punctuation is the sentence's, not the URL's.
  /https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?]/g,
];

/** `text` with every match of `res` replaced by U+0001 of the same length. */
function maskSpans(text: string, res: readonly RegExp[]): string {
  let out = text;
  for (const re of res) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => "\x01".repeat(m.length));
  }
  return out;
}

/** What may follow a sentence's final mark before the white space. */
const CLOSERS = new Set(["*", "_", "~", ")", "»", '"', "”", "'", "’"]);

/** A `<Fact>` tag outside a code span. */
const FACT_TAG_RE = /<\/?Fact\b[^<>\n]*>/g;

export interface SentenceSplit {
  /** The first sentence, with its closing mark and any closer after it. */
  first: string;
  /** Everything after it, its leading white space included. */
  rest: string;
}

/**
 * Every place `text` may split after a sentence, in order: the index where
 * the rest starts. Read on the text with its `<Fact>` tags taken out, so a
 * fact-check mark moves no sentence end, and mapped back; a place inside a
 * `<Fact>` is none, so a mark is never cut. A place is a `.`, `?` or `!`, then
 * any closers (`**`, `)`, `»`, …), then white space and more text, where:
 * - the mark is not inside a code span, a link, a wikilink, a tag or a URL;
 * - a `.` is not part of `...` and does not end an abbreviation
 *   (`isAbbreviation`: `f.eks.`, `dvs.`, `e.g.`, lower-case `pr.`);
 * - a number before the `.` and a lower-case word after it is an ordinal
 *   (`1. januar`), not an end — any other lower-case word may start a
 *   sentence (`… the card. muninn runs …`);
 * - the prefix closes every `**` and `~~` it opens (a cheap pre-filter: the
 *   renderer's guard is the authority).
 */
export function sentenceBreaks(text: string): number[] {
  // The Fact tags, found where code spans cannot hide one.
  const tags: { start: number; end: number; open: boolean }[] = [];
  const codeMasked = maskSpans(text, [CODE_SPAN_RE]);
  FACT_TAG_RE.lastIndex = 0;
  for (const m of codeMasked.matchAll(FACT_TAG_RE)) {
    tags.push({ start: m.index, end: m.index + m[0].length, open: !m[0].startsWith("</") });
  }
  // `plain` is `text` without them; `at[k]` the index in `text` of plain's char k.
  let plain = "";
  const at: number[] = [];
  let from = 0;
  for (const t of [...tags, { start: text.length, end: text.length, open: false }]) {
    for (let i = from; i < t.start; i++) {
      plain += text[i];
      at.push(i);
    }
    from = t.end;
  }
  at.push(text.length);
  const insideFact = (pos: number) => {
    let depth = 0;
    for (const t of tags) if (t.end <= pos) depth += t.open ? 1 : -1;
    return depth > 0;
  };

  const masked = maskSpans(plain, PROTECTED_RES);
  const out: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if (c !== "." && c !== "?" && c !== "!") continue;
    if (c === "." && (masked[i - 1] === "." || masked[i + 1] === ".")) continue;
    let j = i + 1;
    while (j < masked.length && CLOSERS.has(masked[j]!)) j++;
    if (j >= masked.length || !/\s/.test(masked[j]!)) continue;
    const next = /\S/.exec(masked.slice(j));
    if (!next) continue;
    // A number then a lower-case word is an ordinal (`1. januar`), not an end.
    if (c === "." && /\d$/.test(plain.slice(0, i)) && /\p{Ll}/u.test(next[0])) continue;
    if (c === ".") {
      const word = /([\p{L}.]+)$/u.exec(plain.slice(0, i))?.[1];
      if (word && isAbbreviation(word)) continue;
    }
    const prefix = masked.slice(0, j);
    if ((prefix.match(/\*\*/g) ?? []).length % 2 || (prefix.match(/~~/g) ?? []).length % 2) continue;
    const cut = at[j]!;
    if (insideFact(cut)) continue;
    out.push(cut);
  }
  return out;
}

/**
 * An item's first sentence and the rest, or null when the text holds one
 * sentence (or no split point the rule accepts): the first of
 * {@link sentenceBreaks} whose first half has at least `FIRST_SENTENCE_MIN`
 * visible chars and that `accept` (the renderer's render-equality guard)
 * takes. Without `accept` the result is unguarded.
 */
export function splitFirstSentence(
  text: string,
  accept?: (first: string, rest: string) => boolean,
): SentenceSplit | null {
  for (const cut of sentenceBreaks(text)) {
    const first = text.slice(0, cut);
    const rest = text.slice(cut);
    if (visibleText(first).length < FIRST_SENTENCE_MIN) continue;
    if (accept && !accept(first, rest)) continue;
    return { first, rest };
  }
  return null;
}

/** The entities a page's prose may spell, decoded. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&amp;/g, "&");
}

/** A first sentence as a reader sees it, for the length rule: links read as
 *  their text, markup, emphasis markers and tags dropped, entities decoded, a
 *  code span's content kept as written, white space collapsed. */
export function visibleText(markdown: string): string {
  const prose = (s: string) =>
    decodeEntities(
      s
        .replace(/\[\[([^\]|\n]*\|)?([^\]\n]*)\]\]/g, "$2")
        .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
        .replace(/<[^<>\n]*>/g, "")
        .replace(/\*\*|~~|__/g, "")
        // A paired `*x*` or `_x_` is emphasis; `2*3` and `user_id` are text.
        .replace(/(?<![\p{L}\p{N}\\])([*_])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}])/gu, "$2"),
    );
  let out = "";
  let at = 0;
  for (const m of markdown.matchAll(CODE_SPAN_RE)) {
    out += prose(markdown.slice(at, m.index)) + m[0].replace(/^`+|`+$/g, "");
    at = m.index + m[0].length;
  }
  out += prose(markdown.slice(at));
  return out.replace(/\s+/g, " ").trim();
}
