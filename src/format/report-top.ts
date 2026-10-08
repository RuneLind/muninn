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
 *   code span, a link, a tag and an abbreviation such as `f.eks.`.
 */

import type { Block } from "./markdown-ast.ts";
import type { QuestionLanguage } from "./question-labels.ts";

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

/** A row's value split on ` · ` outside code spans. */
export function statusSegments(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  const masked = maskSpans(value, [CODE_SPAN_RE]);
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATE_RES: Record<QuestionLanguage, RegExp> = {
  no: stateRe("no"),
  en: stateRe("en"),
};

function stateRe(lang: QuestionLanguage): RegExp {
  const alts = [...STATUS_STATES[lang]].sort((a, b) => b.phrase.length - a.phrase.length).map((s) => escapeRe(s.phrase));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

function toneOf(lang: QuestionLanguage, phrase: string): StatusTone {
  const p = phrase.toLowerCase();
  return STATUS_STATES[lang].find((s) => s.phrase === p)?.tone ?? "info";
}

/**
 * Wrap each state phrase in a segment's RENDERED html in
 * `<span class="sr-state sr-<tone>">`: text outside tags only, and never
 * inside `<code>`, `<a>` or an element the renderer already emitted for a
 * component. A phrase split by markup (`merget, <em>ikke</em> i prod`) is not
 * matched.
 */
export function markStatePhrases(html: string, lang: QuestionLanguage): string {
  const re = STATE_RES[lang];
  let skip = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        const m = /^<(\/?)(code|a)\b/i.exec(part);
        if (m) skip += m[1] ? -1 : 1;
        return part;
      }
      if (skip > 0 || part === "") return part;
      re.lastIndex = 0;
      return part.replace(re, (phrase) => `<span class="sr-state sr-${toneOf(lang, phrase)}">${phrase}</span>`);
    })
    .join("");
}

// ── First sentence (D6) ──────────────────────────────────────────────────────

/** A first sentence longer than this gets a lint warning (D6). */
export const FIRST_SENTENCE_MAX = 160;

/** Abbreviations whose dot ends no sentence, lower-cased, without the final dot. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "f.eks", "bl.a", "dvs", "osv", "mht", "ca", "jf", "jfr", "nr", "pr", "kl", "evt", "ev", "inkl", "ekskl",
  "iht", "mtp", "pga", "vha", "ift", "ang", "e.g", "i.e", "etc", "vs", "cf", "approx", "incl", "excl", "fig", "ref",
]);

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

/** Inline markup the prefix must close before a split: bold, strike,
 *  single-star emphasis and `<Fact>` marks. */
function balanced(prefix: string, masked: string): boolean {
  const plain = masked;
  const bold = (plain.match(/\*\*/g) ?? []).length;
  const strike = (plain.match(/~~/g) ?? []).length;
  const star = (plain.replace(/\*\*/g, "").match(/\*/g) ?? []).length;
  if (bold % 2 || strike % 2 || star % 2) return false;
  const opens = (prefix.match(/<Fact\b[^>]*[^/]>/g) ?? []).length;
  const closes = (prefix.match(/<\/Fact>/g) ?? []).length;
  return opens === closes;
}

export interface SentenceSplit {
  /** The first sentence, with its closing mark and any closer after it. */
  first: string;
  /** Everything after it, its leading white space included. */
  rest: string;
}

/**
 * An item's first sentence and the rest, or null when the text holds one
 * sentence (or no split point the rule accepts). A split point is a `.`, `?`
 * or `!`, then any closers (`**`, `)`, `»`, …), then white space and more
 * text, where:
 * - the mark is not inside a code span, a link, a wikilink, a tag or a URL;
 * - a `.` is not part of `...` and does not end an abbreviation such as
 *   `f.eks.` or `dvs.`;
 * - a number before the `.` and a lower-case word after it is an ordinal
 *   (`1. januar`), not an end — any other lower-case word may start a
 *   sentence (`… the card. muninn runs …`);
 * - the prefix closes every `**`, `~~`, `*` and `<Fact>` it opens, so the two
 *   halves render as the whole would.
 */
export function splitFirstSentence(text: string): SentenceSplit | null {
  const masked = maskSpans(text, PROTECTED_RES);
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
    if (c === "." && /\d$/.test(text.slice(0, i)) && /\p{Ll}/u.test(next[0])) continue;
    if (c === ".") {
      const word = /([\p{L}.]+)$/u.exec(text.slice(0, i))?.[1]?.toLowerCase();
      if (word && ABBREVIATIONS.has(word)) continue;
    }
    if (!balanced(text.slice(0, j), masked.slice(0, j))) continue;
    return { first: text.slice(0, j), rest: text.slice(j) };
  }
  return null;
}

/** A first sentence as a reader sees it, for the length rule: links read as
 *  their text, markup and tags dropped, a code span's content kept as
 *  written, white space collapsed. */
export function visibleText(markdown: string): string {
  const prose = (s: string) =>
    s
      .replace(/\[\[([^\]|\n]*\|)?([^\]\n]*)\]\]/g, "$2")
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
      .replace(/<[^<>\n]*>/g, "")
      .replace(/\*\*|~~/g, "");
  let out = "";
  let at = 0;
  for (const m of markdown.matchAll(CODE_SPAN_RE)) {
    out += prose(markdown.slice(at, m.index)) + m[0].replace(/^`+|`+$/g, "");
    at = m.index + m[0].length;
  }
  out += prose(markdown.slice(at));
  return out.replace(/\s+/g, " ").trim();
}

/** The first sentence of an item, as the reader shows it in Overview: the
 *  split's first half, else the whole item. */
export function firstSentence(text: string): string {
  return splitFirstSentence(text)?.first ?? text;
}
