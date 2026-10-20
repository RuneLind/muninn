/**
 * `<Glossary>` — the terms a «Words on the page» / «Ord på siden» block
 * defines. Pure, no server imports (`web-format.ts` ships in the chat bundle),
 * and the one reading both the reader's term marks (`glossary-view.ts`) and
 * lint check 19 (`src/wiki/lint-glossary.ts`) take, so they cannot disagree.
 *
 * Two shapes, as the wikis write them:
 *
 * - a list item led by an emphasised term: `- **Hold:** a case kept back`,
 *   `- **Hold**: …`, `- *Hold* — …` (a trailing `:` inside or after the
 *   emphasis, or a ` — `, ` – ` or ` - ` after it, is the separator; an item
 *   without one has no term);
 * - a paragraph: each sentence whose lead is an emphasised span may define
 *   it, by {@link LEAD_TABLE}. The lead is the span (`*x*`, `_x_`, `**x**`,
 *   `__x__`, `***x***`, all alike) at the sentence start, or after one word:
 *   an article (a, an, the, en, ei, et) or a pronoun-article (de, den, det;
 *   `Det *må* fornyes.`), any case; after any other word there is no lead.
 *   A separator (`:` inside or after the span, or a spaced dash after it)
 *   makes a term. Without one, what follows decides: a sentence that ends at
 *   the span defines nothing, and after a pronoun-article only a copula
 *   (is, are, was, were, er, var, blir, ble) makes a term. A span that is a
 *   function word (`A *very* long wait`, `*Ikke* …`) never is one.
 *   Sentences end where `sentenceBreaks` (report-top's DecisionLog split)
 *   finds an end, so an abbreviation (`e.g. *paused*`, `kr. **500**`,
 *   `Dr. **Who**`) starts none, and also not at a number's dot before a
 *   lower-case word past the emphasis (`1. *januar*`). The definition is the
 *   rest of the sentence plus the sentences after it that define nothing. A
 *   leading «Words on the page» / «Ord på siden» label is not a term.
 *
 * A term whose text is one code span (`` **`--arm`:** ``) is code-spelled: it
 * is listed but never marked, since prose that names it is code too.
 */

import { componentBlocks, type Block } from "./markdown-ast.ts";
import { sentenceBreaks, visibleText } from "./report-top.ts";

export interface GlossaryEntry {
  /** The term as the reader sees it. */
  term: string;
  /** What it is matched on: NFC, white space runs as one space, lower-cased
   *  (only the first letter when `exactCase`). */
  key: string;
  /** Matched letter for letter past the first: the term holds a capital
   *  past its first letter (`ATS`, `Soft AND`). */
  exactCase: boolean;
  definition: string;
  /** One code span: listed, never marked. */
  codeSpelled: boolean;
  /** Index into its block's `reads`: the item or sentence it came from. */
  at: number;
}

interface GlossaryFinding {
  level: "warning" | "info";
  message: string;
  /** Index into the block's `reads`; absent ⇒ the block's tag line. */
  at?: number;
}

export interface GlossaryBlockRead {
  entries: GlossaryEntry[];
  findings: GlossaryFinding[];
  /** Each item and sentence read, in source order, as written: what a lint
   *  line is found by. */
  reads: string[];
  /** 0-based line of the opening tag, as `parseBlocks` gives it. */
  line?: number;
}

/** A term shorter than this is never marked: `A` would mark every «a». */
const GLOSSARY_TERM_MIN = 2;

const LABEL_RE = /^(?:\*\*|__)\s*(?:words on the page|ord på siden)\s*[.:]?\s*(?:\*\*|__)\s*[.:]?\s*/iu;
// Group 3 is the separator; an item needs it or a term ending in `:`.
const ITEM_LEAD_RE = /^(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}])\s*(?:(:|[—–-](?=\s))\s*)?/u;
// Group 1 is the word before the span, group 2 the delimiter, group 3 the span.
const SENTENCE_LEAD_RE = /^(?:(\p{L}+)\s+)?(\*{1,3}|_{1,3})(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}*_])/u;
const SEPARATOR_AFTER_RE = /^\s*(?:(?::|[—–-](?=\s))\s*)?/u;
const CODE_ONLY_RE = /^`+[^`]+`+$/;

/** Column (a), the word before the span. */
type Lead = "none" | "article" | "pronoun" | "other";
const ARTICLES: ReadonlySet<string> = new Set(["a", "an", "the", "en", "ei", "et"]);
/** Articles that are also pronouns: `Det *må* fornyes.` */
const PRONOUN_ARTICLES: ReadonlySet<string> = new Set(["de", "den", "det"]);
/** Column (d), what follows: a copula, another word, or the sentence's end. */
type Follow = "copula" | "word" | "end";
const COPULAS: ReadonlySet<string> = new Set(["is", "are", "was", "were", "er", "var", "blir", "ble"]);
/** Closed-class words (degree, negation, frequency, quantity, modals,
 *  auxiliaries, determiners): emphasised for stress, never a term. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "not", "no", "never", "always", "only", "just", "also", "too", "very", "really", "quite",
  "rather", "so", "much", "more", "most", "less", "least", "all", "any", "some", "each", "every", "both",
  "either", "neither", "few", "many", "several", "other", "same", "own", "must", "may", "might", "can",
  "could", "should", "would", "will", "shall", "do", "does", "did", "has", "have", "had", "is", "are", "was",
  "were", "be", "been", "it", "this", "that", "these", "those", "still", "yet", "even", "already", "again",
  "often", "now", "then",
  "ikke", "aldri", "alltid", "bare", "kun", "også", "svært", "veldig", "mye", "mer", "mest", "mindre", "minst",
  "alle", "alt", "hver", "hvert", "begge", "noen", "noe", "ingen", "få", "mange", "flere", "fleste", "ene",
  "andre", "annen", "annet", "samme", "egen", "eget", "egne", "hele", "må", "kan", "skal", "bør", "vil",
  "kunne", "skulle", "burde", "ville", "måtte", "har", "hadde", "er", "var", "blir", "ble", "være", "det",
  "den", "de", "denne", "dette", "disse", "fortsatt", "ennå", "allerede", "igjen", "ofte", "nå", "da", "selv", "helt",
]);

/** The decision table: whether a lead defines its span, by column (a) and,
 *  when there is a separator (column c), `separator`, else column (d).
 *  Column (b), the delimiter, does not count; column (e), what precedes,
 *  is {@link sentencesOf}'s; a function word is never a term. */
const LEAD_TABLE: Readonly<Record<Lead, Readonly<Record<Follow | "separator", boolean>>>> = {
  none: { separator: true, copula: true, word: true, end: false },
  article: { separator: true, copula: true, word: true, end: false },
  pronoun: { separator: true, copula: true, word: false, end: false },
  other: { separator: false, copula: false, word: false, end: false },
};

function leadOf(word: string | undefined): Lead {
  if (word === undefined) return "none";
  const w = word.toLowerCase();
  return ARTICLES.has(w) ? "article" : PRONOUN_ARTICLES.has(w) ? "pronoun" : "other";
}

function followOf(rest: string): Follow {
  if (!/[\p{L}\p{N}]/u.test(rest)) return "end";
  const word = /^\p{L}+(?![\p{L}\p{N}])/u.exec(rest)?.[0];
  return word !== undefined && COPULAS.has(word.toLowerCase()) ? "copula" : "word";
}

/** A sentence's lead: the span and where its definition starts, or null. */
function sentenceLead(sentence: string): { span: string; length: number } | null {
  const m = SENTENCE_LEAD_RE.exec(sentence);
  if (!m) return null;
  const span = m[3]!;
  const after = SEPARATOR_AFTER_RE.exec(sentence.slice(m[0].length))![0];
  const rest = sentence.slice(m[0].length + after.length);
  const separator = span.trimEnd().endsWith(":") || after.trim() !== "";
  if (FUNCTION_WORDS.has(visibleText(span).replace(/\s*:$/, "").toLowerCase())) return null;
  return LEAD_TABLE[leadOf(m[1])][separator ? "separator" : followOf(rest)] ? { span, length: m[0].length + after.length } : null;
}

/** A number's dot before a lower-case word past the emphasis (`1. *januar*`):
 *  `sentenceBreaks` reads only the char after the space, here a `*`. */
const ORDINAL_BEFORE_RE = /\d\.$/;
const LOWER_AFTER_RE = /^\s*[*_~]*\p{Ll}/u;

/** A paragraph's sentences, split where `sentenceBreaks` finds an end. */
function sentencesOf(body: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const cut of sentenceBreaks(body)) {
    if (ORDINAL_BEFORE_RE.test(body.slice(0, cut)) && LOWER_AFTER_RE.test(body.slice(cut))) continue;
    out.push(body.slice(from, cut).trim());
    from = cut;
  }
  out.push(body.slice(from).trim());
  return out.filter(Boolean);
}

/** The key a term is matched and deduplicated on. */
export function glossaryKey(term: string): { key: string; exactCase: boolean } {
  const nfc = term.normalize("NFC").replace(/\s+/gu, " ");
  const [first = "", ...rest] = nfc;
  // A sentence-case capital is free: «Soft AND» matches «soft AND».
  const exactCase = /\p{Lu}/u.test(rest.join(""));
  return { key: exactCase ? first.toLowerCase() + rest.join("") : nfc.toLowerCase(), exactCase };
}

function entry(rawTerm: string, rawDefinition: string, at: number): GlossaryEntry | null {
  const inner = rawTerm.trim().replace(/\s*:$/, "").trim();
  const term = visibleText(inner).replace(/\s*:$/, "").trim();
  if (!term) return null;
  return {
    term,
    ...glossaryKey(term),
    definition: visibleText(rawDefinition),
    codeSpelled: CODE_ONLY_RE.test(inner),
    at,
  };
}

function readItem(text: string, out: GlossaryBlockRead): void {
  const at = out.reads.push(text) - 1;
  const lead = ITEM_LEAD_RE.exec(text);
  const e = lead && (lead[3] || lead[2]!.trimEnd().endsWith(":")) ? entry(lead[2]!, text.slice(lead[0].length), at) : null;
  if (e) out.entries.push(e);
  else if (visibleText(text)) out.findings.push({ level: "info", message: `has an item with no term: «${visibleText(text).slice(0, 60)}»`, at });
}

function readParagraph(text: string, out: GlossaryBlockRead): void {
  const body = text.replace(LABEL_RE, "");
  const sentences = sentencesOf(body);
  // A sentence with no lead term extends the definition above it.
  const leads = sentences.map(sentenceLead);
  for (let i = 0; i < sentences.length; i++) {
    const at = out.reads.push(sentences[i]!) - 1;
    const lead = leads[i];
    if (!lead) continue;
    let definition = sentences[i]!.slice(lead.length);
    for (let j = i + 1; j < sentences.length && !leads[j]; j++) definition += ` ${sentences[j]}`;
    const e = entry(lead.span, definition, at);
    if (e) out.entries.push(e);
  }
}

function readBlocks(blocks: readonly Block[], out: GlossaryBlockRead): void {
  for (const b of blocks) {
    if (b.type === "ul" || b.type === "ol") for (const item of b.items) readItem(item, out);
    else if (b.type === "text") {
      const paragraphs = b.lines.join("\n").split(/\n\s*\n/);
      for (const p of paragraphs) if (p.trim()) readParagraph(p.trim().replace(/\s*\n\s*/g, " "), out);
    }
  }
}

/** Each `<Glossary>` on the page, with its entries and what it could not
 *  read. A term defined twice on the page, in one block or two, is a finding
 *  where it comes the second time. */
export function readGlossaries(blocks: readonly Block[]): GlossaryBlockRead[] {
  const seen = new Set<string>();
  return componentBlocks(blocks, "Glossary").map((b) => {
    const out: GlossaryBlockRead = { entries: [], findings: [], reads: [], ...(b.line === undefined ? {} : { line: b.line }) };
    readBlocks(b.children, out);
    if (out.entries.length === 0) out.findings.unshift({ level: "warning", message: "holds no term; nothing on the page is marked" });
    for (const e of out.entries) {
      if (seen.has(e.key)) out.findings.push({ level: "warning", message: `defines «${e.term}» twice; the first definition is shown`, at: e.at });
      seen.add(e.key);
    }
    return out;
  });
}

/** The page's terms, each once (the first definition wins, across blocks). */
export function glossaryTerms(reads: readonly GlossaryBlockRead[]): GlossaryEntry[] {
  const byKey = new Map<string, GlossaryEntry>();
  for (const r of reads) for (const e of r.entries) if (!byKey.has(e.key)) byKey.set(e.key, e);
  return [...byKey.values()];
}

/** A term the marker looks for: not code-spelled, and long enough. */
export function isMarkableTerm(e: GlossaryEntry): boolean {
  return !e.codeSpelled && [...e.key].length >= GLOSSARY_TERM_MIN;
}
