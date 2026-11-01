/**
 * The question grid: every question a page's `<DecisionLog>` holds, with its
 * answer or its age, open questions first. The chain view starts from decisions
 * and has no row for an open question; this view starts from the questions.
 *
 * Pure and server-free, like `decision-views.ts`: `formatWebHtml` calls it with
 * `views: true` only. A state starts from the card's own rule
 * (`parseQuestionPage`); a row says decided where the chain closes the question
 * through «Lukker Sn» or the item names the decision that superseded it, which
 * the card shows as open or closed. A row reads the log's first sentence.
 */

import type { Block } from "./markdown-ast.ts";
import { escapeHtml } from "./markdown-core.ts";
import { parseLaneSince } from "./component-spec.ts";
import { DC_VIEW_CLASS, READER_ONLY_ATTR } from "./reader-lens.ts";
import type { ChainAnalysis } from "./decision-chain.ts";
import { dcGoLink } from "./decision-views.ts";
import { parseDecisionWhen, supersededById } from "./genre-lists.ts";
import { DECISION_ID_RE, eachComponent, itemReopened, parseQuestionPage, QUESTION_ID_RE } from "./question.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { splitFirstSentence, visibleText } from "./report-top.ts";

/** The grid draws at this many questions, as the chain view does at 3 chains. */
export const QUESTION_GRID_MIN = 3;
/** Rows shown before «show more»: Grocery Bot's 21 questions would fill the
 *  screen. An open question is never behind it. */
export const QUESTION_GRID_CAP = 8;
/** A row's question or answer, in code points. */
export const QUESTION_GRID_TEXT_MAX = 220;

export interface QuestionGridRow {
  id: string;
  label: string;
  state: "open" | "decided" | "closed";
  /** Open: days since it was asked, when the page says. */
  ageDays: number | null;
  /** Open: a `<Question>` card holds it. */
  hasCard: boolean;
  decision: string | null;
  answer: string | null;
  who: string | null;
  reversed: boolean;
}

const LABELS: Record<QuestionLanguage, {
  title: string; open: string; closed: string; reversed: string; today: string; card: string;
  count: (open: number, all: number) => string; more: (n: number) => string;
}> = {
  en: {
    title: "Questions", open: "open", closed: "closed", reversed: "reversed", today: "today", card: "Answer on the card",
    count: (open, all) => (open ? `${open} open of ${all}` : `none open · ${all}`),
    more: (n) => `${n} more`,
  },
  no: {
    title: "Spørsmål", open: "åpen", closed: "lukket", reversed: "snudd", today: "i dag", card: "Svar i kortet",
    count: (open, all) => (open ? `${open} ${open === 1 ? "åpen" : "åpne"} av ${all}` : `ingen åpne · ${all}`),
    more: (n) => `${n} til`,
  },
};

/** «Asked Kari, 01.11.2026», «Spurt Kari 30.09». A date elsewhere in a question
 *  («the backups from 12.03») says nothing about when it was asked. */
const ASKED_RE = /(?<![\p{L}\p{N}_])(?:Asked|Spurt)(?![\p{L}\p{N}_])[^.?!\n]*?(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}(?:\.\d{4})?)(?!\d)/u;

function isoOf(written: string, today: string): string | null {
  if (/^\d{4}-/.test(written)) return written;
  const [d, m, y] = written.split(".");
  const iso = `${y ?? today.slice(0, 4)}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function daysBetween(from: string, today: string): number | null {
  const days = Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000);
  return days >= 0 ? days : null;
}

/** The `since=` of the waiting lane that names each id. */
function laneSinceByQuestion(blocks: Block[]): Map<string, string> {
  const out = new Map<string, string>();
  eachComponent(blocks, (b) => {
    if (b.name !== "Lane" || b.attrs.kind !== "waiting") return;
    const since = parseLaneSince(b.attrs.since);
    if (!since) return;
    for (const child of b.children) {
      if (child.type !== "ul" && child.type !== "ol") continue;
      for (const item of child.items) {
        const id = /^\*\*([SO]\d{1,4})\*\*/.exec(item.trim())?.[1];
        if (id && !out.has(id)) out.set(id, since);
      }
    }
  });
  return out;
}

const plainText = (markdown: string): string => visibleText(markdown).replace(/\s+/g, " ").trim();

function clip(s: string): string {
  const cps = [...s];
  return cps.length > QUESTION_GRID_TEXT_MAX ? cps.slice(0, QUESTION_GRID_TEXT_MAX - 1).join("").trimEnd() + "…" : s;
}

const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}(?:\.\d{4})?)`;
/** A question item's bookkeeping, always dated: a close, reopen or answer
 *  stamp and an asked phrase. A word in prose («The Closed state») is none. */
const BOOKKEEPING_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:(?:Closed|Lukket|Reopened|Gjenåpnet|Answered|Besvart)\s+${DATE}(?:\s*\(D\d{1,4}\))?|(?:Asked|Spurt)(?![\p{L}\p{N}_])[^.?!\n]*?${DATE}(?!\d))[.:,]?`,
  "gu",
);

/** The item's first sentence as the log shows it, read from the markdown, up to
 *  any bookkeeping. */
function firstOf(markdown: string): string {
  const cut = markdown.search(BOOKKEEPING_RE);
  const head = (cut > 0 ? markdown.slice(0, cut) : markdown).trimEnd();
  return splitFirstSentence(head)?.first ?? head;
}

/** What a closed item says after its first sentence, bookkeeping and a date
 *  tail left out; null when nothing is left. */
function ownAnswer(itemText: string, first: string): string | null {
  const rest = itemText.slice(first.length).replace(BOOKKEEPING_RE, " ").trim();
  const when = parseDecisionWhen(rest);
  const text = plainText(firstOf(when ? rest.slice(0, when.start) : rest));
  return text ? clip(text) : null;
}

/** A decision item's first sentence, its date tail left out. */
function decisionAnswer(itemText: string): string | null {
  const when = parseDecisionWhen(itemText);
  const text = plainText(firstOf(when ? itemText.slice(0, when.start) : itemText));
  return text ? clip(text) : null;
}

/** The grid's rows, open first, each group in id order. `today` is the render
 *  day; absent, no row has an age. */
export function questionGridRows(blocks: Block[], analysis: ChainAnalysis, today?: string): QuestionGridRow[] {
  const page = parseQuestionPage(blocks);
  const cards = new Set(page.questions.map((q) => q.id).filter((id): id is string => !!id));
  const byId = new Map(page.entries.map((e) => [e.id, e] as const).reverse());
  const chainOf = new Map(analysis.chains.flatMap((c) => c.questions.map((q) => [q.id, c] as const)));
  const since = laneSinceByQuestion(blocks);
  const rows: QuestionGridRow[] = [];
  for (const [id, e] of byId) {
    if (!QUESTION_ID_RE.test(id) && !cards.has(id)) continue;
    const state = page.states.get(id);
    // «Lukker Sn» on a decision closes Sn in the chain, unless Sn was reopened since.
    const chain = chainOf.get(id) ?? null;
    const decided = state?.kind === "decided" || (state?.kind === "open" && chain !== null && !itemReopened(e.text));
    // «superseded by Dn» closes a question without a close phrase, so no chain holds it.
    const supersededBy = !decided && state?.kind === "closed" ? supersededById(e.itemText) : null;
    const supersededEntry = supersededBy && DECISION_ID_RE.test(supersededBy) ? byId.get(supersededBy) : undefined;
    const first = firstOf(e.itemText);
    const asked = ASKED_RE.exec(e.text)?.[1];
    const from = since.get(id) ?? (asked && today ? isoOf(asked, today) : null);
    const decisionEntry = decided && chain ? byId.get(chain.decision) : supersededEntry;
    rows.push({
      id,
      label: clip(plainText(first)),
      state: decided || supersededEntry ? "decided" : state?.kind === "closed" ? "closed" : "open",
      ageDays: !decided && state?.kind === "open" && from && today ? daysBetween(from, today) : null,
      hasCard: cards.has(id),
      decision: decided && chain ? chain.decision : supersededEntry ? supersededBy : null,
      // A reversed decision's label is its struck sentence.
      answer: decided && chain?.reversed
        ? chain.label
        : decisionEntry
          ? decisionAnswer(decisionEntry.itemText)
          : state?.kind === "closed"
            ? ownAnswer(e.itemText, first)
            : null,
      who: decisionEntry ? (parseDecisionWhen(decisionEntry.itemText)?.who ?? null) : null,
      reversed: decided && chain?.reversed != null,
    });
  }
  const num = (r: QuestionGridRow) => Number(r.id.replace(/\D/g, ""));
  return rows.sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open") || num(a) - num(b));
}

/** The anchor a `<Question>` card takes on the page render. */
export const questionCardAnchor = (id: string): string => `qcard-${id.toLowerCase()}`;

function rowHtml(r: QuestionGridRow, language: QuestionLanguage): string {
  const L = LABELS[language];
  const open = r.state === "open";
  const age = r.ageDays === null ? "" : ` · ${r.ageDays === 0 ? L.today : `${r.ageDays} d`}`;
  const chip = open
    ? `<span class="qg-chip qg-chip-open">${escapeHtml(L.open + age)}</span>`
    : r.decision
      ? `<span class="qg-chip qg-chip-done${r.reversed ? " qg-chip-reversed" : ""}">${dcGoLink(r.decision, escapeHtml(r.decision))}</span>`
      : `<span class="qg-chip qg-chip-done">${escapeHtml(L.closed)}</span>`;
  const body = open
    ? r.hasCard
      ? `<a class="qg-card" href="#${questionCardAnchor(r.id)}">${escapeHtml(L.card)}</a>`
      : ""
    : `${r.reversed ? `<em class="qg-reversed">${escapeHtml(L.reversed)}</em> ` : ""}${escapeHtml(r.answer ?? "")}${r.who ? ` <span class="qg-who">· ${escapeHtml(r.who)}</span>` : ""}`;
  return (
    `<div class="qg-row ${open ? "qg-open" : "qg-done"}" role="listitem">` +
    `<span class="qg-id">${dcGoLink(r.id, escapeHtml(r.id))}</span>` +
    `<span class="qg-q">${escapeHtml(r.label)}</span>` +
    `<span class="qg-a">${chip}${body}</span></div>`
  );
}

/** Where the grid goes: right after the first top-level `<StatusRows>`, the
 *  place a picture takes (plan D15), else with the other views. */
export function questionGridSlot(blocks: Block[], viewSlotAt: number): number {
  const i = blocks.findIndex((b) => b.type === "component" && b.name === "StatusRows");
  return i >= 0 ? i + 1 : viewSlotAt;
}

/** The grid, or "" under {@link QUESTION_GRID_MIN} rows. */
export function questionGridHtml(rows: QuestionGridRow[], language: QuestionLanguage): string {
  if (rows.length < QUESTION_GRID_MIN) return "";
  const L = LABELS[language];
  const openCount = rows.filter((r) => r.state === "open").length;
  const shown = Math.max(QUESTION_GRID_CAP, openCount);
  const head = rows.slice(0, shown).map((r) => rowHtml(r, language)).join("");
  const rest = rows.slice(shown);
  const more = rest.length
    ? `<details class="qg-more"><summary>${escapeHtml(L.more(rest.length))}</summary>${rest.map((r) => rowHtml(r, language)).join("")}</details>`
    : "";
  return (
    `<section class="${DC_VIEW_CLASS} qg" ${READER_ONLY_ATTR} aria-label="${escapeHtml(L.title)}">` +
    `<div class="dc-title">${escapeHtml(L.title)} <span class="qg-count">${escapeHtml(L.count(openCount, rows.length))}</span></div>` +
    `<div class="qg-rows" role="list">${head}${more}</div></section>`
  );
}
