/**
 * The open `<Question>` cards whose page seems to hold the ruling (lint check
 * 10, and a hint the decision triage hands a model). Server code only: `new
 * RegExp` counts as side-effecting, so a regex here would stay in the browser
 * bundles of everything importing `question.ts`.
 */
import { stripFactWrappers } from "./markdown-ast.ts";
import { supersededById } from "./genre-lists.ts";
import { splitFirstSentence } from "./report-top.ts";
import {
  DECISION_ID_RE,
  itemReopened,
  maskCodeSpans,
  questionIdRe,
  type DecisionLogEntry,
  type QuestionPage,
} from "./question.ts";

/** An open card whose page seems to hold its ruling. When unsure this flags: a
 *  false flag is dismissed, a false silence hides a settled card. */
export interface UnclosedCard {
  id: string;
  /** The decision a close should name; null when no decision's first sentence
   *  names the card as ruled, which does not mean no decision records it. */
  decision: string | null;
  /** The decision whose first sentence names the card; differs from
   *  `decision` when that one was superseded. */
  namedBy: string | null;
  /** The ruling word in the card's own item, as written, or null. A hint, not a
   *  ruling: it may sit in a condition («Depends on O2 being answered»). */
  word: string | null;
}

const WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_END = String.raw`(?![\p{L}\p{N}_])`;
const LINE_SPACE = String.raw`[ \t\u00a0]`;
/** At most one line break. A masked code span is at least three, so never fits. */
const SPACE = `${LINE_SPACE}*\\n?${LINE_SPACE}*`;
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
const RULING_WORD_RE = new RegExp(`${WORD_START}(?<![\\p{L}\\p{N}_][.-])(answered|besvart|avgjort|decided)${WORD_END}(?![.-][\\p{L}\\p{N}_])`, "giu");
/** At the end of a token: it ends no clause. */
const IN_CLAUSE = `(?<![,;:.!?…—–-][${CLOSERS}]*)`;
const MARKER_END = `${WORD_END}(?!-[\\p{L}\\p{N}_])\\S*${IN_CLAUSE}`;
/** Up to a ruling word: a negating or pending word at most three words back, or
 *  `be`/`bli` right before it («It must be A as decided» rules), on one line and
 *  in one clause. */
const NOT_RULED_BEFORE_RE = new RegExp(
  `${WORD_START}(?<![\\p{L}\\p{N}_]-)(?:(?:${String.raw`not|ikke|ikkje|never|aldri|\p{L}+n['’]t|nobody|ingen|until|når`})${MARKER_END}(?:${LINE_SPACE}+\\S+${IN_CLAUSE}){0,2}` +
    `|(?:be|bli)${MARKER_END})${LINE_SPACE}+[^\\p{L}\\p{N}\\s]*$`,
  "iu",
);
/** What follows a word in a question about it: the text ends in `?` with no clause
 *  break, bracket, line break or sentence end on the way («Decided A, ok?» rules). */
const QUESTION_AFTER_RE = new RegExp(`^(?:(?![.!…][${CLOSERS}]*\\s)[^,;:([\\n])*\\?[.!…\\s${CLOSERS}]*$`, "u");

/** The first ruling word in an item that the words before it and the question
 *  around it do not take back, or null. Struck text and targets count for
 *  neither side. */
function rulingWord(text: string): string | null {
  // `_` is a word character to WORD_START, so `_not_` would hide its word.
  const prose = maskTargets(maskCodeSpans(text).replace(STRUCK_SPAN_RE, FILL)).replace(/_/g, "");
  for (const m of prose.matchAll(RULING_WORD_RE)) {
    if (!NOT_RULED_BEFORE_RE.test(prose.slice(0, m.index)) && !QUESTION_AFTER_RE.test(prose.slice(m.index + m[0].length))) return m[1]!;
  }
  return null;
}

/** `text` (NFC, so offsets line up with the mask's) with each match of `re`
 *  outside a code span replaced by `by`. */
function replaceOutsideCode(text: string, re: RegExp, by: string): string {
  let out = "";
  let at = 0;
  for (const m of maskCodeSpans(text).matchAll(re)) {
    out += text.slice(at, m.index) + by;
    at = m.index + m[0].length;
  }
  return out + text.slice(at);
}

/** A decision's first sentence. `<Fact>`, `**` and `~~` go first, since
 *  `splitFirstSentence` refuses a break inside them. A live decision's struck
 *  span goes whole; a superseded one's still counts. A negation in a code span
 *  loses its marks, since the mask would hide it. */
function firstSentence(text: string, live: boolean): string {
  const unwrapped = stripFactWrappers(text).normalize("NFC").replace(/`(not|ikke|ikkje)`/gi, "$1");
  const read = replaceOutsideCode(live ? replaceOutsideCode(unwrapped, STRUCK_SPAN_RE, " ") : unwrapped, /\*\*|~~/g, "");
  return splitFirstSentence(read)?.first ?? read;
}

/** Right after `→`, `=`, `avgjort`, `Answer` or `Svar`: no ruling is stated. */
const NOT_STATED = String.raw`(?!\s*(?:\?|[*_]*(?:[Nn][Oo][Tt]|[Ii][Kk][Kk][Jj]?[Ee])[*_]*${WORD_END}(?!-)))`;

/** Does this first sentence name `id` as ruled: right before `→`, `=` or
 *  `avgjort`, or as `card <id>`/`kortet <id>` after `Answer`/`Svar` with at most
 *  three tokens between? A question about it rules on nothing. */
function sentenceRulesOn(masked: string, id: string): boolean {
  const named = questionIdRe(id).source;
  const before = new RegExp(`${named}\\*?${SPACE}(?:→|=|avgjort${WORD_END})${NOT_STATED}`, "u");
  const card = new RegExp(`${WORD_START}(?:Answer|Svar)${NOT_STATED}:?(?:\\s+\\S+){0,3}?\\s+(?:card|kortet)${SPACE}\\*?${named}`, "u");
  return [before, card].some((re) => {
    const m = re.exec(masked);
    return m !== null && !QUESTION_AFTER_RE.test(masked.slice(m.index + m[0].length));
  });
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
 * The open cards whose page seems to hold the ruling, one per `<Question>` id,
 * in source order: a decision's first sentence names the id as ruled (a
 * superseded decision's sentence counts and hands over to its live successor;
 * the highest decision the chains end on wins, then the highest that names the
 * id), or the card's own item carries a ruling word ({@link rulingWord}). A
 * live decision's struck text rules on nothing, a superseded one's still does,
 * and a reopened card is left out: its ruling was taken back.
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
      if (later && sentenceRulesOn(maskTargets(maskCodeSpans(firstSentence(e.itemText, live === e.id))), id)) {
        decision = live;
        namedBy = e.id;
      }
    }
    const word = rulingWord(item.text);
    if (decision || word) out.push({ id, decision, namedBy, word });
  }
  return out;
}
