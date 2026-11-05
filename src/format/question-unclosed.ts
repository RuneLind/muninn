/**
 * The open `<Question>` cards whose page already holds the ruling (lint check
 * 10, and a fact the decision triage hands a model). Server code only: `new
 * RegExp` counts as side-effecting, so a regex here would stay in the browser
 * bundles of everything importing `question.ts`.
 */
import { supersededById } from "./genre-lists.ts";
import { splitFirstSentence } from "./report-top.ts";
import {
  DECISION_ID_RE,
  WORD_START,
  WS,
  itemReopened,
  phraseText,
  questionIdRe,
  type DecisionLogEntry,
  type QuestionPage,
} from "./question.ts";

/** An open card whose page already holds its ruling. */
export interface UnclosedCard {
  id: string;
  /** The decision a close should name; null when no decision's first sentence
   *  names the card as ruled, which does not mean no decision records it. */
  decision: string | null;
  /** The decision whose first sentence names the card; differs from
   *  `decision` when that one was superseded. */
  namedBy: string | null;
  /** The ruling word in the card's own item, as written; null when it has none. */
  word: string | null;
}

const WORD_END = String.raw`(?![\p{L}\p{N}_])`;
const STRUCK_SPAN_RE = /~~[\s\S]*?~~/g;
/** Stands in for a masked target: not white space, so `O3 <url> → B` does not
 *  read as the id right before the arrow. */
const FILL = "\x01";
const CLOSERS = String.raw`*~)\]»"”'’\x01`;

/** Text with what a reader never sees as prose masked: tags and comments,
 *  link destinations, bare URLs and paths. Link text stays, a wikilink's label
 *  included; a bare `[[target]]` is a target. */
function maskTargets(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g, FILL)
    .replace(/\[\[[^\]|\n]+?(?:\|([^\]\n]*?))?\]\]/g, (_m, label?: string) => label ?? FILL)
    .replace(/!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, FILL)
    .replace(/\]\((?:[^()\n]|\([^()\n]*\))*\)/g, `]${FILL}`)
    .replace(/\]\[[^[\]\n]*\]/g, `]${FILL}`)
    .replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>]*/giu, FILL)
    .replace(/[\p{L}\p{N}_.-]*\/[\p{L}\p{N}_./-]*\.\p{L}{1,5}(?![\p{L}\p{N}_])/gu, FILL);
}

/** A ruling word, unless `.` or `-` joins it to a longer token (`to-be-decided`,
 *  `decided-cards`, `decided.mdx`), as {@link questionIdRe} reads an id. */
const RULING_WORD_RE = new RegExp(
  `${WORD_START}(?<![\\p{L}\\p{N}_][.-])(answered|besvart|avgjort|decided)${WORD_END}(?![.-][\\p{L}\\p{N}_])`,
  "giu",
);
/** A word that, anywhere earlier in the clause, makes a ruling word not a ruling:
 *  it negates it, or says the ruling is still to come. */
const NOT_RULED_RE = new RegExp(
  `${WORD_START}(?:` +
    String.raw`not|ikke|ikkje|no|nobody|noone|none|nothing|ingen|ingenting|never|aldri|neither|nor|verken|hverken|without|uten|cannot|\p{L}+n['’]t` +
    "|be|been|bli|blir|blitt|should|must|can|could|skal|bør|må|kan|kunne|need|needs|trenger" +
    "|until|till|inntil|when|once|når|if|unless|hvis|dersom|before|før" +
    "|waits?|waiting|awaiting|pending|vent|venter|avventer|mangler|maybe|perhaps|kanskje" +
    String.raw`|etter\s+at|til\s+\S+\s+er|after\s+\S+\s+(?:is|are|has)` +
    `)${WORD_END}`,
  "iu",
);
const SENTENCE_BREAK_RE = new RegExp(`(?<=[.!?…][${CLOSERS}]*)\\s+`, "u");
const QUESTION_END_RE = new RegExp(`\\?[!?…]*[${CLOSERS}]*$`, "u");
/** Where a negation stops reaching. A comma inside an enumeration («until O2, O4
 *  and O6 are answered») is not a break. */
const CLAUSE_BREAK_RE = new RegExp(
  String.raw`,(?=\s)(?!\s+\S+(?:,|\s+(?:and|or|og|eller)${WORD_END}))|[;:](?=\s)|\s[—–-]\s|${WORD_START}(?:but|men)${WORD_END}`,
  "iu",
);

/** The first ruling word in an item that its sentence and clause do not take
 *  back, or null. Struck text and targets count for neither side, a sentence
 *  ending in `?` rules on nothing, and each nested paragraph reads alone. */
function rulingWord(text: string): string | null {
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    // `_` is a word character to WORD_START, so `_not_` would hide its word.
    const prose = maskTargets(phraseText(paragraph).replace(STRUCK_SPAN_RE, FILL)).replace(/_/g, "");
    for (const sentence of prose.split(SENTENCE_BREAK_RE)) {
      if (QUESTION_END_RE.test(sentence)) continue;
      for (const clause of sentence.split(CLAUSE_BREAK_RE)) {
        for (const m of clause.matchAll(RULING_WORD_RE)) {
          if (!NOT_RULED_RE.test(clause.slice(0, m.index))) return m[1]!;
        }
      }
    }
  }
  return null;
}

/** A decision's first sentence. `**` and `~~` go first, since
 *  `splitFirstSentence` refuses a break inside them. A live decision's struck
 *  text keeps its sentence ends and loses its words, so it counts for neither
 *  the id nor the sentence after it. */
function firstSentence(text: string, live: boolean): string {
  const read = live ? text.replace(STRUCK_SPAN_RE, (s) => s.slice(2, -2).replace(/[^\s.!?]/g, FILL)) : text;
  const plain = read.replace(/\*\*|~~/g, "");
  return splitFirstSentence(plain)?.first ?? plain;
}

/** Not a ruling however it goes on. */
const CONDITIONAL_OPEN_RE = new RegExp(`^[^\\p{L}\\p{N}]*(?:if|hvis|dersom)${WORD_END}`, "iu");
/** Right after `→`, `=` or `avgjort`: the sign states no ruling. */
const NOT_STATED = String.raw`(?!\s*(?:\?|(?:[Nn]ot|[Ii]kkj?e)${WORD_END}))`;
/** Between `Answer`/`Svar` and `card`/`kortet`: a choice label and a preposition. */
const ANSWER_GAP = String.raw`:?(?:${WS}[\p{L}\p{N}]{1,3}[,:]?){0,2}`;

/** Does this first sentence name `id` as ruled: right before `→`, `=` or
 *  `avgjort`, or as `card <id>`/`kortet <id>` after `Answer`/`Svar`? A question
 *  or an opening conditional rules on nothing. A sentence too short for
 *  `splitFirstSentence` to stop at reads on, so each part is judged alone. */
function sentenceRulesOn(masked: string, id: string): boolean {
  const named = questionIdRe(id).source;
  const before = new RegExp(`${named}\\*?(?:${WS})?(?:→|=|avgjort${WORD_END})${NOT_STATED}`, "u");
  const card = new RegExp(`${WORD_START}(?:Answer|Svar)${WORD_END}${ANSWER_GAP}${WS}(?:card|kortet)${WS}\\*?${named}`, "u");
  return masked
    .split(SENTENCE_BREAK_RE)
    .some((s) => !QUESTION_END_RE.test(s) && !CONDITIONAL_OPEN_RE.test(s) && (before.test(s) || card.test(s)));
}

/** The live decision a superseded one hands over to; null when the chain leaves
 *  the page's decisions. */
function liveDecision(start: DecisionLogEntry, byId: ReadonlyMap<string, DecisionLogEntry>): string | null {
  const visited = new Set<string>();
  let e: DecisionLogEntry | undefined = start;
  while (e && !visited.has(e.id)) {
    visited.add(e.id);
    if (!e.dim) return e.id;
    const next = supersededById(e.itemText);
    e = next ? byId.get(next) : undefined;
  }
  return null;
}

function decisionNumber(id: string): number {
  return Number(id.slice(1));
}

/**
 * The open cards whose page already holds the ruling, one per `<Question>` id,
 * in source order: a decision's first sentence names the id as ruled (a
 * superseded decision's sentence counts and hands over to its live successor;
 * the highest decision the chains end on wins, then the highest that names the
 * id), or the card's own item carries a ruling word
 * ({@link rulingWord}). A live decision's struck text rules on nothing, a
 * superseded one's still does, and a reopened card is left out: its ruling was
 * taken back.
 */
export function unclosedCards(page: QuestionPage): UnclosedCard[] {
  const decisions = new Map<string, DecisionLogEntry>();
  for (const e of page.entries) {
    if (DECISION_ID_RE.test(e.id) && !decisions.has(e.id)) decisions.set(e.id, e);
  }
  const out: UnclosedCard[] = [];
  const seen = new Set<string>();
  for (const { id } of page.questions) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const item = page.entries.find((e) => e.id === id);
    if (!item || page.states.get(id)?.kind !== "open" || itemReopened(item.text)) continue;
    let decision: string | null = null;
    let namedBy: string | null = null;
    for (const e of decisions.values()) {
      if (e.id === id) continue;
      const live = liveDecision(e, decisions);
      if (!live) continue;
      const later = !decision || decisionNumber(live) > decisionNumber(decision) || (live === decision && decisionNumber(e.id) > decisionNumber(namedBy!));
      if (later && sentenceRulesOn(maskTargets(phraseText(firstSentence(e.itemText, live === e.id))), id)) {
        decision = live;
        namedBy = e.id;
      }
    }
    const word = rulingWord(item.text);
    if (decision || word) out.push({ id, decision, namedBy, word });
  }
  return out;
}
