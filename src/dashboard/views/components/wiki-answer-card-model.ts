/**
 * The answer card's pure half (answer cards PR 3): the card's five states, the
 * markup of an answer, its log fold and the composer, and the save gate. No
 * DOM, so it is unit-tested directly; `wiki-answer-cards.ts` is the DOM half.
 *
 * Every string a reader sees comes from `question-labels.ts` in the wiki's
 * language, and every answer text is escaped and rendered as plain text
 * (`white-space: pre-wrap`), never as markup.
 */
import { escHtml as esc } from "./escape.ts";
import { QUESTION_ANSWER_MAX, QUESTION_NOT_SURE } from "../../../format/question.ts";
import type { QuestionLabels, QuestionLanguage } from "../../../format/question-labels.ts";

/** An answer's body cap, in code points — the route's own. */
export const ANSWER_BODY_MAX = QUESTION_ANSWER_MAX;

/** One version as `GET /api/wiki/answers` shows it. */
export interface AnswerVersionWire {
  version: number;
  authorName: string;
  choice: string | null;
  body: string;
  createdAt: number;
  exported: boolean;
  redacted: boolean;
}

/** One answer: its latest version plus the per-answer flags. */
export interface AnswerWire extends AnswerVersionWire {
  answerId: string;
  questionId: string;
  versionCount: number;
  firstCreatedAt: number;
  mine: boolean;
  /** Null when the question names nobody (or is gone from the page). */
  asked?: boolean | null;
  /** Earlier versions, newest first; only the author and an admin get them. */
  earlier?: AnswerVersionWire[];
}

/** The server-rendered state (`data-question-state`). */
export type CardServerState = "open" | "closed" | "decided" | "none";
/** What the card shows: the plan's five states. */
export type CardDisplayState = "open" | "answered" | "copied" | "decided" | "closed";

/** Decided and Closed win; otherwise no answers is Open, any answer whose
 *  latest version is not exported is Answered, and all exported is Copied. */
export function cardDisplayState(server: CardServerState, answers: readonly AnswerWire[]): CardDisplayState {
  if (server === "decided" || server === "closed") return server;
  if (answers.length === 0) return "open";
  return answers.some((a) => !a.exported) ? "answered" : "copied";
}

/** Answers whose latest version has not been copied out — a closed card's
 *  "N new" badge. */
export function unexportedCount(answers: readonly AnswerWire[]): number {
  return answers.filter((a) => !a.exported).length;
}

/** The pill text for an open-family state; null for Decided/Closed, whose
 *  pill the server already rendered (with the `→ Dn` link). */
export function statePillText(state: CardDisplayState, L: QuestionLabels): string | null {
  if (state === "open") return L.open;
  if (state === "answered") return L.answered;
  if (state === "copied") return L.copied;
  return null;
}

/** Characters the way the route and Postgres count them: code points. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** The save gate, the route's own refusals mirrored: an answer needs a body
 *  or a choice, and a body within the cap. */
export function composerCanSave(choice: string | null, body: string): boolean {
  if (codePointLength(body) > ANSWER_BODY_MAX) return false;
  return body.trim() !== "" || choice !== null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, `2026-10-08 21:32` (en) or `08.10.2026 21:32` (no). */
export function formatAnswerTime(ms: number, lang: QuestionLanguage): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return lang === "no"
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${time}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** A stored choice as the card shows it. */
export function choiceText(choice: string, L: QuestionLabels): string {
  return choice === QUESTION_NOT_SURE ? L.notSure : choice;
}

function versionContentHtml(v: AnswerVersionWire, L: QuestionLabels): string {
  if (v.redacted) return `<div class="q-answer-body q-redacted">${esc(L.redacted)}</div>`;
  const pick = v.choice !== null ? `<span class="q-pick">${esc(choiceText(v.choice, L))}</span>` : "";
  const body = v.body.trim() !== "" ? `<div class="q-answer-body">${esc(v.body)}</div>` : "";
  return pick + body;
}

/** One answer: who, when, asked / not asked, edited N×, the choice, the body,
 *  an Edit button when the viewer may edit, and the log fold when the server
 *  sent earlier versions. */
export function answerItemHtml(
  a: AnswerWire,
  L: QuestionLabels,
  lang: QuestionLanguage,
  canEdit: boolean,
): string {
  const asked =
    a.asked === true
      ? ` <span class="q-asked q-asked-yes">${esc(L.asked)}</span>`
      : a.asked === false
        ? ` <span class="q-asked q-asked-no">${esc(L.notAsked)}</span>`
        : "";
  const edited = a.versionCount > 1 ? ` <span class="q-edited">· ${esc(L.edited(a.versionCount - 1))}</span>` : "";
  const edit = canEdit
    ? ` <button type="button" class="q-edit" data-answer-id="${esc(a.answerId)}">${esc(L.composer.edit)}</button>`
    : "";
  const earlier = a.earlier ?? [];
  const log = earlier.length
    ? `<details class="q-log"><summary>${esc(L.earlier(earlier.length))}</summary>` +
      earlier
        .map(
          (v) =>
            `<div class="q-log-item"><div class="q-by">${esc(L.version(v.version))} · ${esc(formatAnswerTime(v.createdAt, lang))}</div>${versionContentHtml(v, L)}</div>`,
        )
        .join("") +
      `</details>`
    : "";
  return (
    `<div class="q-answer" data-answer-id="${esc(a.answerId)}">` +
    `<div class="q-by"><span class="q-author">${esc(a.authorName)}</span> · <span class="q-time">${esc(formatAnswerTime(a.createdAt, lang))}</span>${asked}${edited}${edit}</div>` +
    versionContentHtml(a, L) +
    log +
    `</div>`
  );
}

export interface ComposerView {
  questionId: string;
  choices: readonly string[];
  /** The answer being edited, or null for a new one. */
  editing: string | null;
  choice: string | null;
  body: string;
  sending: boolean;
}

/** The composer: choice radios (plus Not sure yet) when the question has
 *  choices, a textarea, a counter and Save (plus Cancel when editing). */
export function composerHtml(v: ComposerView, L: QuestionLabels): string {
  const C = L.composer;
  const group = `q-choice-${v.questionId}${v.editing ? "-edit" : ""}`;
  const radios = v.choices.length
    ? `<div class="q-choices" role="radiogroup" aria-label="${esc(C.choices)}">` +
      [...v.choices.filter((c) => c !== QUESTION_NOT_SURE), QUESTION_NOT_SURE]
        .map(
          (c) =>
            `<label class="q-choice"><input type="radio" name="${esc(group)}" value="${esc(c)}"${v.choice === c ? " checked" : ""}${v.sending ? " disabled" : ""}> <span>${esc(choiceText(c, L))}</span></label>`,
        )
        .join("") +
      `</div>`
    : "";
  const len = codePointLength(v.body);
  const over = len > ANSWER_BODY_MAX;
  return (
    `<form class="q-composer${v.editing ? " q-composer-edit" : ""}"${v.editing ? ` data-answer-id="${esc(v.editing)}"` : ""}>` +
    radios +
    `<textarea class="q-text" aria-label="${esc(C.answer)}" placeholder="${esc(C.placeholder)}"${v.sending ? " readonly" : ""}>${esc(v.body)}</textarea>` +
    `<div class="q-row">` +
    `<button type="submit" class="q-save"${v.sending || !composerCanSave(v.choice, v.body) ? " disabled" : ""}>${esc(v.sending ? C.saving : v.editing ? C.saveEdit : C.save)}</button>` +
    (v.editing ? `<button type="button" class="q-cancel"${v.sending ? " disabled" : ""}>${esc(C.cancel)}</button>` : "") +
    `<span class="q-count${over ? " q-count-over" : ""}">${len} / ${ANSWER_BODY_MAX}</span>` +
    `</div></form>`
  );
}

/** The line a failed save shows: the server's own sentence when it sent one. */
export function saveErrorText(status: number, payload: unknown, L: QuestionLabels): string {
  const error =
    payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : status > 0
        ? `HTTP ${status}`
        : "";
  return error ? `${L.composer.failed}: ${error}` : L.composer.failed;
}

/** A 409 that means "someone saved a newer version first". */
export function isVersionConflict(status: number, payload: unknown): boolean {
  return status === 409 && !!payload && typeof payload === "object" && (payload as { code?: unknown }).code === "version_conflict";
}
