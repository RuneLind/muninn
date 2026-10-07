/**
 * The `<Question>` block and the closing rule that decides an answer card's
 * state (D6). Pure and browser-safe: the web renderer, the wiki linter and the
 * answer route (PR 2) all read a page through these functions, so a card, a
 * lint finding and a refused POST cannot disagree about a question.
 *
 * A card's state lives in the page's `<DecisionLog>`, never on the block. The
 * reader recognises ONE closing form, outside code spans:
 *
 *   `Closed <date> (Dn)` / `Lukket <date> (Dn)` — whole-word, case-sensitive,
 *     `<date>` is `YYYY-MM-DD` or `D.M`/`DD.MM` with an optional `.YYYY`, and
 *     `(Dn)` is the next token.
 *   `Reopened <date>` / `Gjenåpnet <date>` — the same date, then `.`, white
 *     space or the end.
 *
 * The LAST canonical phrase in the item wins. A close naming a decision the
 * page's `<DecisionLog>` defines is `decided`; any other id is `closed`. With
 * no canonical phrase, an item `parseLogItem` dims (struck id, struck
 * remainder, superseded) is `closed`; everything else is `open`.
 */
import type { Block, ListChild } from "./markdown-ast.ts";
import { parseLogItem } from "./genre-lists.ts";
import { lineCodeSpanRanges } from "./code-spans.ts";
import { isCalendarDay } from "./calendar-day.ts";
import { QUESTION_LABELS, type QuestionLanguage } from "./question-labels.ts";

/** The fixed extra choice every card offers beside its parsed `choices`. */
export const QUESTION_NOT_SURE = "not-sure";

/** One entry of `questions_to:` or `to=`: `Name` or `Name (IDENT)`. */
export interface QuestionTarget {
  name: string;
  ident: string | null;
}

export interface ParsedQuestion {
  /** The `id` attribute, trimmed; null when absent or blank. */
  id: string | null;
  /** `choices`, `|`-separated, trimmed, blanks and repeats dropped. */
  choices: string[];
  /** `to`, parsed; null when the block carries no `to` (the page's
   *  `questions_to:` applies). */
  to: QuestionTarget[] | null;
  /** The block body as normalized text — the input to PR 2's `question_hash`.
   *  Deterministic: the body's text runs in source order, each line trimmed
   *  with internal white space collapsed, blank lines dropped. */
  body: string;
  /** Another `<Question>` on the page carries the same id. */
  duplicate: boolean;
}

export type QuestionState = { kind: "open" } | { kind: "closed" } | { kind: "decided"; decision: string };

/** What the renderer needs from the page around a `<Question>`. */
export interface QuestionRenderOptions {
  /** The page's frontmatter `questions_to:`, parsed. */
  questionsTo: QuestionTarget[];
  language: QuestionLanguage;
  /** The wiki takes answers (`WIKI_ANSWER_WIKIS`, PR 2). False ⇒ read-only card. */
  answerable: boolean;
}

// ── Targets ─────────────────────────────────────────────────────────────────

/** `Name` or `Name (IDENT)`; a blank entry is null. */
export function parseQuestionTarget(entry: string): QuestionTarget | null {
  const s = entry.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  if (!s) return null;
  const m = /^(.*\S)\s*\(\s*([^()\s][^()]*?)\s*\)$/.exec(s);
  if (m) return { name: m[1]!.trim(), ident: m[2]! };
  return { name: s, ident: null };
}

/** The frontmatter `questions_to:` value — an inline list of strings
 *  (`parseFrontmatter` hands it over as `string[]`), or one bare string. */
export function parseQuestionsTo(raw: unknown): QuestionTarget[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return entries
    .filter((e): e is string => typeof e === "string")
    .map(parseQuestionTarget)
    .filter((t): t is QuestionTarget => t !== null);
}

/** `to="A (X1)|B"` — the same entries, `|`-separated. */
export function parseToAttr(value: string): QuestionTarget[] {
  return value
    .split("|")
    .map(parseQuestionTarget)
    .filter((t): t is QuestionTarget => t !== null);
}

/** A target as written in `questions_to:` / `to=`. */
export function formatQuestionTarget(t: QuestionTarget): string {
  return t.ident ? `${t.name} (${t.ident})` : t.name;
}

export function parseChoices(value: string | undefined): string[] {
  const out: string[] = [];
  for (const c of (value ?? "").split("|")) {
    const v = c.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// ── The AST walk ────────────────────────────────────────────────────────────

type ComponentBlock = Extract<Block, { type: "component" }>;

/** Every component block on the page, depth first in source order. */
function eachComponent(blocks: Block[], visit: (b: ComponentBlock) => void): void {
  for (const b of blocks) {
    if (b.type !== "component") continue;
    visit(b);
    eachComponent(b.children, visit);
  }
}

function childText(c: ListChild, out: string[]): void {
  if (c.type === "code_block") out.push(c.code);
  else if (c.type === "paragraph") out.push(c.text);
  else listText(c.items, c.nested, out);
}

function listText(items: string[], nested: (ListChild[] | undefined)[] | undefined, out: string[]): void {
  items.forEach((item, k) => {
    out.push(item);
    for (const c of nested?.[k] ?? []) childText(c, out);
  });
}

function blocksText(blocks: Block[], out: string[]): void {
  for (const b of blocks) {
    switch (b.type) {
      case "code_block":
        out.push(b.code);
        break;
      case "hr":
        break;
      case "heading":
        out.push(b.content);
        break;
      case "blockquote":
      case "text":
        out.push(...b.lines);
        break;
      case "ul":
      case "ol":
        listText(b.items, b.nested, out);
        break;
      case "table":
        out.push(b.headers.join(" | "), ...b.rows.map((r) => r.join(" | ")));
        break;
      case "component":
        blocksText(b.children, out);
        break;
    }
  }
}

/** A block body as normalized text (see {@link ParsedQuestion.body}). */
export function questionBodyText(children: Block[]): string {
  const runs: string[] = [];
  blocksText(children, runs);
  return runs
    .join("\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}

function attrId(attrs: Record<string, string>): string | null {
  const id = (attrs.id ?? "").trim();
  return id === "" ? null : id;
}

/** Every `<Question>` on the page, in source order, with the duplicate-id
 *  signal set on every block sharing an id. */
export function parseQuestions(blocks: Block[]): ParsedQuestion[] {
  const found: ParsedQuestion[] = [];
  eachComponent(blocks, (b) => {
    if (b.name !== "Question") return;
    found.push({
      id: attrId(b.attrs),
      choices: parseChoices(b.attrs.choices),
      to: b.attrs.to === undefined ? null : parseToAttr(b.attrs.to),
      body: questionBodyText(b.children),
      duplicate: false,
    });
  });
  const seen = new Map<string, number>();
  for (const q of found) if (q.id !== null) seen.set(q.id, (seen.get(q.id) ?? 0) + 1);
  for (const q of found) if (q.id !== null && seen.get(q.id)! > 1) q.duplicate = true;
  return found;
}

/** One `<DecisionLog>` item that starts with an id. */
export interface DecisionLogEntry {
  id: string;
  /** The text after the id (`parseLogItem`'s `text`). */
  text: string;
  dim: boolean;
}

/** Every id-led item of every `<DecisionLog>` on the page, in source order —
 *  the top-level items of each list directly in a log's body, which is what
 *  the web renderer gives an anchor. */
export function decisionLogEntries(blocks: Block[]): DecisionLogEntry[] {
  const out: DecisionLogEntry[] = [];
  eachComponent(blocks, (b) => {
    if (b.name !== "DecisionLog") return;
    for (const child of b.children) {
      if (child.type !== "ul" && child.type !== "ol") continue;
      for (const item of child.items) {
        const p = parseLogItem(item);
        if (p.id) out.push({ id: p.id, text: p.text, dim: p.dim });
      }
    }
  });
  return out;
}

// ── The closing rule (D6) ───────────────────────────────────────────────────

const DATE = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}(?:\.\d{4})?)`;
const WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
const WS = String.raw`[ \t ]+`;
const CLOSE_RE = new RegExp(`${WORD_START}(Closed|Lukket)${WS}${DATE}${WS}\\((D\\d{1,4})\\)`, "gu");
const REOPEN_RE = new RegExp(`${WORD_START}(Reopened|Gjenåpnet)${WS}${DATE}(?=[.\\s]|$)`, "gu");
const KEYWORD_RE = new RegExp(`${WORD_START}(Closed|Lukket|Reopened|Gjenåpnet)(?![\\p{L}\\p{N}_])`, "gu");
const ANSWERED_RE = new RegExp(`${WORD_START}(Besvart|Answered)(?![\\p{L}\\p{N}_])`, "gu");
const DECISION_ID_RE = /^D\d{1,4}$/;

/** A date the calendar has: `YYYY-MM-DD`, or `D.M[.YYYY]` checked against a
 *  leap year when it carries no year. */
function isCloseDate(d: string): boolean {
  const dm = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(d);
  if (!dm) return isCalendarDay(d);
  return isCalendarDay(`${dm[3] ?? "2024"}-${dm[2]!.padStart(2, "0")}-${dm[1]!.padStart(2, "0")}`);
}

/** The text with every inline code span blanked to spaces, line by line, so
 *  offsets still line up and a phrase inside backticks reads as nothing. */
export function maskCodeSpans(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = line;
      for (const r of lineCodeSpanRanges(line)) {
        out = out.slice(0, r.start) + " ".repeat(r.end - r.start) + out.slice(r.end);
      }
      return out;
    })
    .join("\n");
}

interface CanonicalPhrase {
  at: number;
  kind: "close" | "reopen";
  decision?: string;
}

function canonicalPhrases(masked: string): CanonicalPhrase[] {
  const out: CanonicalPhrase[] = [];
  for (const m of masked.matchAll(CLOSE_RE)) {
    if (isCloseDate(m[2]!)) out.push({ at: m.index!, kind: "close", decision: m[3]! });
  }
  for (const m of masked.matchAll(REOPEN_RE)) {
    if (isCloseDate(m[2]!)) out.push({ at: m.index!, kind: "reopen" });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** One DecisionLog item's state. `decisions` is the set of D ids the page's
 *  `<DecisionLog>` defines. */
export function itemQuestionState(text: string, dim: boolean, decisions: ReadonlySet<string>): QuestionState {
  const phrases = canonicalPhrases(maskCodeSpans(text));
  const last = phrases[phrases.length - 1];
  if (last) {
    if (last.kind === "reopen") return { kind: "open" };
    return decisions.has(last.decision!) ? { kind: "decided", decision: last.decision! } : { kind: "closed" };
  }
  return dim ? { kind: "closed" } : { kind: "open" };
}

/** The words in an item that look like a close but are not the canonical
 *  phrase — a whole-word `Closed`/`Lukket`/`Reopened`/`Gjenåpnet` that starts
 *  no canonical phrase, and every whole-word `Besvart`/`Answered` — outside
 *  code spans, in source order. The lint check's input (D6). */
export function closeNearMisses(text: string): string[] {
  const masked = maskCodeSpans(text);
  const starts = new Set(canonicalPhrases(masked).map((p) => p.at));
  const hits: { at: number; word: string }[] = [];
  for (const m of masked.matchAll(KEYWORD_RE)) if (!starts.has(m.index!)) hits.push({ at: m.index!, word: m[1]! });
  for (const m of masked.matchAll(ANSWERED_RE)) hits.push({ at: m.index!, word: m[1]! });
  return hits.sort((a, b) => a.at - b.at).map((h) => h.word);
}

/** The D ids the page's `<DecisionLog>` blocks define. */
export function definedDecisions(entries: DecisionLogEntry[]): Set<string> {
  return new Set(entries.map((e) => e.id).filter((id) => DECISION_ID_RE.test(id)));
}

/**
 * The state of every DecisionLog id on the page — the closed-ids pre-pass the
 * renderer runs before it renders any card, since the log usually sits below
 * the `<Question>`. The FIRST item carrying an id decides it, the one that
 * keeps the bare anchor. An id with no item is absent (the card is open and
 * the linter says why).
 */
export function questionStates(blocks: Block[]): Map<string, QuestionState> {
  const entries = decisionLogEntries(blocks);
  const decisions = definedDecisions(entries);
  const out = new Map<string, QuestionState>();
  for (const e of entries) {
    if (!out.has(e.id)) out.set(e.id, itemQuestionState(e.text, e.dim, decisions));
  }
  return out;
}

/** The ids whose card is not open — closed or decided. */
export function closedQuestionIds(blocks: Block[]): Set<string> {
  const out = new Set<string>();
  for (const [id, s] of questionStates(blocks)) if (s.kind !== "open") out.add(id);
  return out;
}

/** The text-surface lead line (Telegram, Slack, email): `Question O3`, or the
 *  bare word with no id. English, since those surfaces carry no wiki. */
export function questionLeadText(attrs: Record<string, string>): string {
  const id = attrId(attrs);
  return id ? `${QUESTION_LABELS.en.question} ${id}` : QUESTION_LABELS.en.question;
}
