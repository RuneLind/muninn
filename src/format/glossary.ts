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
 * - a paragraph: a sentence led by an emphasised span defines that span. One
 *   led by an article (a, an, the, en, ei, et, den, det, de) and a span does
 *   only when a separator or a copula (is, are, er) follows the span
 *   (`A **Hold** is …`, `Et **Lån**: …`), since `Det *må* fornyes.` and
 *   `A *very* long wait follows.` go on a definition. Emphasis further in is
 *   definition text. Sentences split where `isAbbreviation` (the DecisionLog
 *   split's rule) finds no abbreviation, so `e.g. *paused*` starts none. The
 *   definition is the rest of the sentence plus the sentences after it that
 *   define nothing. A leading «Words on the page» / «Ord på siden» label is
 *   not a term.
 *
 * A term whose text is one code span (`` **`--arm`:** ``) is code-spelled: it
 * is listed but never marked, since prose that names it is code too.
 */

import { componentBlocks, type Block } from "./markdown-ast.ts";
import { visibleText } from "./report-top.ts";
import { isAbbreviation } from "./abbreviations.ts";

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
// Group 1 is an article before the span (88 real glossaries: «A», «The», «En»), group 4 the separator.
const SENTENCE_LEAD_RE = /^((?:an?|the|e[nit]|de[nt]?)\s+)?(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}*_])\s*((?::|[—–-](?=\s))\s*)?/iu;
const COPULA_RE = /^(?:is|are|er)(?![\p{L}\p{N}])/iu;
const CODE_ONLY_RE = /^`+[^`]+`+$/;
const SENTENCE_END_RE = /(?<=[.!?])\s+(?=\S)/u;
const WORD_BEFORE_DOT_RE = /([\p{L}.]+)\.$/u;

/** A paragraph's sentences: split after `.`, `!` or `?` and white space, not
 *  after an abbreviation's dot. */
function sentencesOf(body: string): string[] {
  const out: string[] = [];
  for (const piece of body.split(SENTENCE_END_RE)) {
    const prev = out.at(-1);
    const word = prev === undefined ? undefined : WORD_BEFORE_DOT_RE.exec(prev)?.[1];
    if (prev !== undefined && word && isAbbreviation(word, piece)) out[out.length - 1] = `${prev} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** A sentence's lead term, or null: an article-led span needs a separator or a copula after it. */
function sentenceLead(sentence: string): RegExpExecArray | null {
  const lead = SENTENCE_LEAD_RE.exec(sentence);
  if (lead?.[1] && !lead[4] && !COPULA_RE.test(sentence.slice(lead[0].length))) return null;
  return lead;
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
    let definition = sentences[i]!.slice(lead[0].length);
    for (let j = i + 1; j < sentences.length && !leads[j]; j++) definition += ` ${sentences[j]}`;
    const e = entry(lead[3]!, definition, at);
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
