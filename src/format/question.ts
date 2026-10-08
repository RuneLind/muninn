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
 * The white space between two tokens may hold one line break (a hard-wrapped
 * item), never a blank line and never a code span. The item is read in NFC,
 * with its nested sub-bullets as part of it.
 *
 * The LAST canonical phrase in the item wins. A close naming a decision the
 * page's `<DecisionLog>` defines is `decided`; any other id is `closed`. With
 * no canonical phrase, an item `parseLogItem` dims (struck id, struck
 * remainder, superseded) is `closed`; everything else is `open`.
 */
import type { Block, ListBlock, ListChild } from "./markdown-ast.ts";
import { parseLogItem } from "./genre-lists.ts";
import { maskLineCodeSpans } from "./code-spans.ts";
import { isCalendarDay } from "./calendar-day.ts";
import { QUESTION_LABELS, type QuestionLanguage } from "./question-labels.ts";

/** The fixed extra choice every card offers beside its parsed `choices`. */
export const QUESTION_NOT_SURE = "not-sure";

/** An answer's body cap, in code points — what Postgres `char_length` counts
 *  and the table's CHECK holds. The route refuses past it and the card's
 *  composer counts against it. */
export const QUESTION_ANSWER_MAX = 8000;

/** Characters the way the route and Postgres count them: code points. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** One entry of `questions_to:` or `to=`: `Name` or `Name (IDENT)`. */
export interface QuestionTarget {
  name: string;
  ident: string | null;
}

export interface ParsedQuestion {
  /** The `id` attribute, trimmed; null when absent or blank. */
  id: string | null;
  /** `choices`, `|`-separated ({@link splitQuestionList}), trimmed, blanks
   *  and repeats dropped. */
  choices: string[];
  /** `to`, parsed; null when the block carries no `to`, or one that names
   *  nobody (`to=""`, `to="|"`) — the page's `questions_to:` applies. */
  to: QuestionTarget[] | null;
  /** The block body as normalized text ({@link questionBodyText}). */
  body: string;
  /** PR 2's `question_hash` input: the body plus the parsed choices, so a
   *  change to either is a different question. */
  hashInput: string;
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
  /** `WIKI_ANSWER_OWNER`, on an answerable wiki only: who a question is for
   *  when neither `to=` nor `questions_to:` names anyone (D9). */
  owner?: string | null;
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

/**
 * A `|`-separated `to=`/`choices=` value split into its entries. A `|` inside
 * a `[[…]]` wikilink is the link's alias, not a separator, so
 * `[[Page|Alias]] (X1)|B` is two entries. A `[[` with no `]]` after it opens
 * nothing. The card's `data-question-to`/`data-question-choices` re-join
 * entries with `|`, so a reader of those attributes splits with this too.
 */
export function splitQuestionList(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("[[", i)) {
      const close = value.indexOf("]]", i + 2);
      if (close !== -1) {
        i = close + 2;
        continue;
      }
    }
    if (value[i] === "|") {
      out.push(value.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(value.slice(start));
  return out;
}

/** `to="A (X1)|B"` — the same entries, `|`-separated ({@link splitQuestionList}). */
export function parseToAttr(value: string): QuestionTarget[] {
  return splitQuestionList(value)
    .map(parseQuestionTarget)
    .filter((t): t is QuestionTarget => t !== null);
}

/** A target as written in `questions_to:` / `to=`. */
export function formatQuestionTarget(t: QuestionTarget): string {
  return t.ident ? `${t.name} (${t.ident})` : t.name;
}

/** Where a question's targets came from: `to=`, the page's `questions_to:`,
 *  the configured owner, or nobody. */
export type QuestionTargetSource = "block" | "page" | "owner" | "none";

/**
 * Who a question is for: its `to=` when it names someone, else the page's
 * `questions_to:`, else the owner (D9). The card's `q-for` line and the answer
 * route's `asked` flag both read this, so they name the same people.
 */
export function resolveQuestionTargets(
  blockTo: QuestionTarget[] | null,
  questionsTo: QuestionTarget[],
  owner: string | null | undefined,
): { to: QuestionTarget[]; source: QuestionTargetSource } {
  if (blockTo && blockTo.length) return { to: blockTo, source: "block" };
  if (questionsTo.length) return { to: questionsTo, source: "page" };
  // The owner takes the target format: `Rune Lind (X111111)` is a name and an
  // ident, so the owner's answers match on the ident like any other target's.
  const ownerTarget = owner ? parseQuestionTarget(owner) : null;
  if (ownerTarget) return { to: [ownerTarget], source: "owner" };
  return { to: [], source: "none" };
}

/** Format characters (zero-width space, soft hyphen, BOM …) dropped, then
 *  NFC — in that order, or a format character between a letter and its
 *  combining mark blocks the composition — white space collapsed, lower-cased:
 *  a name pasted from a document still matches. */
const foldName = (s: string) =>
  s.replace(/\p{Cf}/gu, "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** `WIKI_ANSWER_GROUPS`: group name (lower-case) → member NAV idents (upper-case). */
export type AnswerGroups = ReadonlyMap<string, ReadonlySet<string>>;

const NO_GROUPS: AnswerGroups = new Map();

/** The configured group a target names, if any: an entry with no `(IDENT)`
 *  whose folded name is a group name. With no groups, every name is a person. */
function targetGroup(t: QuestionTarget, groups: AnswerGroups): ReadonlySet<string> | undefined {
  return t.ident ? undefined : groups.get(foldName(t.name));
}

/** The groups holding this NAV ident, sorted. Never the ident itself. */
export function authorGroupsOf(navIdent: string | null, groups: AnswerGroups): string[] {
  const ident = navIdent?.trim().toUpperCase();
  if (!ident) return [];
  return [...groups].filter(([, members]) => members.has(ident)).map(([name]) => name).sort();
}

/**
 * Did the page ask this author (D2, the O2 v1 rule)? A target matches on the
 * NAV ident when both the target and the author carry one, else on the
 * case-folded display name. A target naming a configured group (`fag`) matches
 * only an author whose NAV ident is in it. Null when the question names
 * nobody: "not asked" would claim someone else was.
 */
export function isAskedAuthor(
  author: { name: string; navIdent: string | null },
  targets: QuestionTarget[],
  groups: AnswerGroups = NO_GROUPS,
): boolean | null {
  if (targets.length === 0) return null;
  const ident = author.navIdent?.trim().toUpperCase() || null;
  return targets.some((t) => {
    const group = targetGroup(t, groups);
    if (group) return ident !== null && group.has(ident);
    return t.ident && ident ? t.ident.trim().toUpperCase() === ident : foldName(t.name) === foldName(author.name);
  });
}

/** The three attributes of a `<Question>` tag, read the one way the parser,
 *  the card and the answer route all read them. */
export function parseQuestionAttrs(attrs: Record<string, string>): Pick<ParsedQuestion, "id" | "choices" | "to"> {
  const to = attrs.to === undefined ? [] : parseToAttr(attrs.to);
  return { id: attrId(attrs), choices: parseChoices(attrs.choices), to: to.length > 0 ? to : null };
}

export function parseChoices(value: string | undefined): string[] {
  const out: string[] = [];
  for (const c of splitQuestionList(value ?? "")) {
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

/** Inline text with its white space collapsed: a soft-wrapped line and its
 *  reflow read the same. */
const inlineRun = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A text block's paragraphs, each joined across its soft wraps. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  for (const line of [...lines, ""]) {
    if (line.trim() !== "") {
      run.push(line);
    } else if (run.length > 0) {
      out.push(inlineRun(run.join(" ")));
      run = [];
    }
  }
  return out;
}

const fenceText = (lang: string, code: string): string => "```" + lang + "\n" + code + "\n```";

function listSegments(list: ListBlock, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  list.items.forEach((item, k) => {
    const marker = list.type === "ol" ? `${list.start + k}.` : "-";
    out.push(`${pad}${marker} ${inlineRun(item)}`);
    for (const c of list.nested?.[k] ?? []) {
      if (c.type === "code_block") out.push(fenceText(c.lang, c.code));
      else if (c.type === "paragraph") out.push(`${pad}  ${inlineRun(c.text)}`);
      else listSegments(c, depth + 1, out);
    }
  });
}

function bodySegments(blocks: Block[], out: string[]): void {
  for (const b of blocks) {
    switch (b.type) {
      case "code_block":
        out.push(fenceText(b.lang, b.code));
        break;
      case "hr":
        out.push("---");
        break;
      case "heading":
        out.push(`${"#".repeat(b.level)} ${inlineRun(b.content)}`);
        break;
      case "blockquote":
        for (const p of paragraphs(b.lines)) out.push(`> ${p}`);
        break;
      case "text":
        out.push(...paragraphs(b.lines));
        break;
      case "ul":
      case "ol":
        listSegments(b, 0, out);
        break;
      case "table":
        out.push(...[b.headers, ...b.rows].map((r) => `| ${r.map(inlineRun).join(" | ")} |`));
        break;
      case "component":
        bodySegments(b.children, out);
        break;
    }
  }
}

/**
 * A block body as normalized text, the hashed half of {@link ParsedQuestion}.
 * Reflow-insensitive: a paragraph or list item joins across its soft wraps and
 * its white space collapses. Everything else is kept: code-block content and
 * indentation verbatim, a heading's level, a list's markers and nesting, and
 * the boundary between two paragraphs.
 */
export function questionBodyText(children: Block[]): string {
  const segments: string[] = [];
  bodySegments(children, segments);
  return segments.join("\n");
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
    const attrs = parseQuestionAttrs(b.attrs);
    const body = questionBodyText(b.children);
    found.push({ ...attrs, body, hashInput: `${body}\n\nchoices: ${attrs.choices.join("|")}`, duplicate: false });
  });
  const seen = new Map<string, number>();
  for (const q of found) if (q.id !== null) seen.set(q.id, (seen.get(q.id) ?? 0) + 1);
  for (const q of found) if (q.id !== null && seen.get(q.id)! > 1) q.duplicate = true;
  return found;
}

/** One `<DecisionLog>` item that starts with an id. */
export interface DecisionLogEntry {
  id: string;
  /** The item's own text after the id (`parseLogItem`'s `text`). */
  itemText: string;
  /** What the closing rule reads: {@link itemText}, then the text of the
   *  sub-bullets and paragraphs nested under the item, each after a blank
   *  line so no phrase spans two of them. Nested code is left out. */
  text: string;
  dim: boolean;
}

/** The prose nested under one list item, in source order, code left out. */
function nestedProse(children: ListChild[] | undefined, out: string[]): void {
  for (const c of children ?? []) {
    if (c.type === "paragraph") {
      out.push(c.text);
    } else if (c.type !== "code_block") {
      c.items.forEach((item, k) => {
        out.push(item);
        nestedProse(c.nested?.[k], out);
      });
    }
  }
}

/** Every id-led item of every `<DecisionLog>` on the page, in source order —
 *  the top-level items of each list directly in a log's body, which is what
 *  the web renderer gives an anchor. A nested sub-item is part of the item
 *  above it, never an entry of its own: it gets no anchor, so a D id defined
 *  only there is not a decision the page defines (its `→ Dn` link would land
 *  nowhere). */
export function decisionLogEntries(blocks: Block[]): DecisionLogEntry[] {
  const out: DecisionLogEntry[] = [];
  eachComponent(blocks, (b) => {
    if (b.name !== "DecisionLog") return;
    for (const child of b.children) {
      if (child.type !== "ul" && child.type !== "ol") continue;
      child.items.forEach((item, k) => {
        const p = parseLogItem(item);
        if (!p.id) return;
        const nested: string[] = [];
        nestedProse(child.nested?.[k], nested);
        out.push({ id: p.id, itemText: p.text, text: [p.text, ...nested].join("\n\n"), dim: p.dim });
      });
    }
  });
  return out;
}

// ── The closing rule (D6) ───────────────────────────────────────────────────

const DATE = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}(?:\.\d{4})?)`;
const WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
/** White space between two tokens: a run on one line, or one line break with
 *  indentation either side. A masked code span is at least three line breaks
 *  ({@link maskCodeSpans}), so it never fits. */
const WS = String.raw`(?:[ \t\u00a0]+|[ \t\u00a0]*\n[ \t\u00a0]*)`;
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

/** The item text in NFC with every inline code span blanked to line breaks
 *  (`maskLineCodeSpans`), line by line: offsets still line up, a phrase inside
 *  backticks reads as nothing, and a span between two tokens is never white
 *  space — a span is at least three characters, and {@link WS} admits one
 *  line break. */
export function maskCodeSpans(text: string): string {
  return text.normalize("NFC").split("\n").map(maskLineCodeSpans).join("\n");
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

/** The last canonical phrase in the item reopens it: the item is open because
 *  it was reopened, not because it was never closed. */
export function itemReopened(text: string): boolean {
  const phrases = canonicalPhrases(maskCodeSpans(text));
  return phrases[phrases.length - 1]?.kind === "reopen";
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

/** Everything a `<Question>` reader needs from one page, from one walk. */
export interface QuestionPage {
  /** Every `<Question>`, in source order ({@link parseQuestions}). */
  questions: ParsedQuestion[];
  /** Every id-led DecisionLog item, in source order, repeats included. */
  entries: DecisionLogEntry[];
  /** The D ids the page's `<DecisionLog>` blocks define. */
  decisions: Set<string>;
  /** The state of every DecisionLog id on the page. The FIRST item carrying
   *  an id decides it, the one that keeps the bare anchor; an id with no item
   *  is absent (the card is open and the linter says why). */
  states: Map<string, QuestionState>;
}

/**
 * The one page parse the renderer's pre-pass, the linter and the answer route
 * (PR 2) share. The renderer runs it before any card renders, since the log
 * usually sits below the `<Question>`.
 */
export function parseQuestionPage(blocks: Block[]): QuestionPage {
  const entries = decisionLogEntries(blocks);
  const decisions = definedDecisions(entries);
  const states = new Map<string, QuestionState>();
  for (const e of entries) {
    if (!states.has(e.id)) states.set(e.id, itemQuestionState(e.text, e.dim, decisions));
  }
  return { questions: parseQuestions(blocks), entries, decisions, states };
}

/** The state of every DecisionLog id on the page ({@link QuestionPage.states}). */
export function questionStates(blocks: Block[]): Map<string, QuestionState> {
  return parseQuestionPage(blocks).states;
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
