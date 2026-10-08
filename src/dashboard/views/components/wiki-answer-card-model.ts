/**
 * The answer card's pure half (answer cards PR 3): the card's five states, the
 * markup of an answer, its log fold and the composer, the save gate, and the
 * draft rules a save and a reload need. No DOM, so it is unit-tested directly;
 * `wiki-answer-cards.ts` is the DOM half.
 *
 * Every string a reader sees comes from `question-labels.ts` in the wiki's
 * language, and every answer text is escaped and rendered as plain text
 * (`white-space: pre-wrap`), never as markup.
 */
import { escHtml as esc } from "./escape.ts";
import {
  codePointLength,
  QUESTION_ANSWER_MAX,
  QUESTION_NOT_SURE,
  type QuestionState,
} from "../../../format/question.ts";
import type { QuestionLabels, QuestionLanguage } from "../../../format/question-labels.ts";

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

/** What a successful `POST /api/wiki/answers` returns. */
export interface SavedAnswerWire extends AnswerVersionWire {
  answerId: string;
  questionId: string;
  mine: boolean;
}

/** The server-rendered state (`data-question-state`). */
export type CardServerState = QuestionState["kind"] | "none";
/** What the card shows: the plan's five states. */
export type CardDisplayState = "open" | "answered" | "copied" | "decided" | "closed";

/** An answer the export still has to find: its latest version is neither
 *  copied out nor redacted (a redacted answer has nothing to copy). */
const isUnexported = (a: AnswerWire) => !a.exported && !a.redacted;

/** Decided and Closed win. Otherwise a card with no live (unredacted) answer
 *  is Open, one with an unexported answer is Answered, and the rest Copied. */
export function cardDisplayState(server: CardServerState, answers: readonly AnswerWire[]): CardDisplayState {
  if (server === "decided" || server === "closed") return server;
  const live = answers.filter((a) => !a.redacted);
  if (live.length === 0) return "open";
  return live.some(isUnexported) ? "answered" : "copied";
}

/** Answers the export has not copied yet — a closed card's "N new" badge and
 *  PR 4's "Copy new answers (N)". Redacted answers never count. */
export function unexportedCount(answers: readonly AnswerWire[]): number {
  return answers.filter(isUnexported).length;
}

/** The pill text for an open-family state; null for Decided/Closed, whose
 *  pill the server already rendered (with the `→ Dn` link). */
export function statePillText(state: CardDisplayState, L: QuestionLabels): string | null {
  if (state === "open") return L.open;
  if (state === "answered") return L.answered;
  if (state === "copied") return L.copied;
  return null;
}

/** The save gate, the route's own refusals mirrored: an answer needs a body
 *  or a choice, and a body within the cap. */
export function composerCanSave(choice: string | null, body: string): boolean {
  if (codePointLength(body) > QUESTION_ANSWER_MAX) return false;
  return body.trim() !== "" || choice !== null;
}

/** The stored choice an edit starts from: kept only when the card still offers
 *  it (a page that renamed or dropped a choice would 400 it). */
export function draftChoiceFor(stored: string | null, choices: readonly string[]): string | null {
  if (stored === null || choices.length === 0) return null;
  return stored === QUESTION_NOT_SURE || choices.includes(stored) ? stored : null;
}

/**
 * The answer list with a just-saved version folded in, so the card shows the
 * save before (or without) a reload. A new answer gets a provisional entry;
 * an edit replaces its answer's latest version and moves the old one into the
 * log. `asked` is the server's to compute, so a new entry carries none.
 */
export function mergeSavedAnswer(answers: readonly AnswerWire[], saved: SavedAnswerWire): AnswerWire[] {
  const version: AnswerVersionWire = {
    version: saved.version,
    authorName: saved.authorName,
    choice: saved.choice,
    body: saved.body,
    createdAt: saved.createdAt,
    exported: saved.exported,
    redacted: saved.redacted,
  };
  const i = answers.findIndex((a) => a.answerId === saved.answerId);
  if (i === -1) {
    return [
      ...answers,
      { ...version, answerId: saved.answerId, questionId: saved.questionId, versionCount: saved.version, firstCreatedAt: saved.createdAt, mine: saved.mine, asked: null },
    ];
  }
  const prev = answers[i]!;
  if (prev.version >= saved.version) return [...answers];
  const { answerId, questionId, firstCreatedAt, mine, asked, earlier, ...prevVersion } = prev;
  const next: AnswerWire = {
    ...version,
    answerId,
    questionId,
    firstCreatedAt,
    mine,
    asked,
    versionCount: Math.max(prev.versionCount + 1, saved.version),
    earlier: [
      {
        version: prevVersion.version,
        authorName: prevVersion.authorName,
        choice: prevVersion.choice,
        body: prevVersion.body,
        createdAt: prevVersion.createdAt,
        exported: prevVersion.exported,
        redacted: prevVersion.redacted,
      },
      ...(earlier ?? []),
    ],
  };
  return answers.map((a, k) => (k === i ? next : a));
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

/** A `·`-led part of a `q-by` line. The separator rides inside the part, with
 *  `white-space: nowrap`, so a wrap never leaves a `·` alone on a line. */
const byPart = (cls: string, text: string) => `<span class="${cls}">· ${esc(text)}</span>`;

/** An admin's Redact control on one answer (PR 5): the button, or the inline
 *  two-step confirm once it was pressed. No browser dialog. */
export interface RedactView {
  /** The viewer is an admin (the page's `canExport`). */
  can: boolean;
  /** This answer's confirm is open. */
  confirming: boolean;
  /** The redact request for this answer is out. */
  working: boolean;
}

/** The Redact button (on the `q-by` line) or the open confirm (its own line
 *  under it); empty for a viewer who may not redact or a redacted answer. */
function redactParts(a: AnswerWire, L: QuestionLabels, r: RedactView | undefined): { inline: string; block: string } {
  if (!r?.can || a.redacted) return { inline: "", block: "" };
  const id = esc(a.answerId);
  const R = L.redact;
  if (!r.confirming && !r.working) {
    return { inline: ` <button type="button" class="q-redact" data-answer-id="${id}">${esc(R.open)}</button>`, block: "" };
  }
  const off = r.working ? " disabled" : "";
  return {
    inline: "",
    block:
      `<div class="q-redact-confirm" role="group" aria-label="${esc(R.confirm)}">` +
      `<span class="q-redact-prompt">${esc(R.prompt)}</span> ` +
      `<button type="button" class="q-redact-yes" data-answer-id="${id}"${off}>${esc(r.working ? R.working : R.confirm)}</button> ` +
      `<button type="button" class="q-redact-no" data-answer-id="${id}"${off}>${esc(R.cancel)}</button>` +
      `</div>`,
  };
}

/** One answer: who, when, asked / not asked, edited N×, the choice, the body,
 *  an Edit button when the viewer may edit, an admin's Redact (`redact`), and
 *  the log fold when the server sent earlier versions (`logOpen`: the reader
 *  left it open). */
export function answerItemHtml(
  a: AnswerWire,
  L: QuestionLabels,
  lang: QuestionLanguage,
  canEdit: boolean,
  logOpen = false,
  redact?: RedactView,
): string {
  const asked =
    a.asked === true
      ? ` <span class="q-asked q-asked-yes">${esc(L.asked)}</span>`
      : a.asked === false
        ? ` <span class="q-asked q-asked-no">${esc(L.notAsked)}</span>`
        : "";
  const edited = a.versionCount > 1 ? ` ${byPart("q-edited", L.edited(a.versionCount - 1))}` : "";
  const edit = canEdit
    ? ` <button type="button" class="q-edit" data-answer-id="${esc(a.answerId)}">${esc(L.composer.edit)}</button>`
    : "";
  const { inline: redactInline, block: redactBlock } = redactParts(a, L, redact);
  const earlier = a.earlier ?? [];
  const log = earlier.length
    ? `<details class="q-log" data-answer-id="${esc(a.answerId)}"${logOpen ? " open" : ""}><summary>${esc(L.earlier(earlier.length))}</summary>` +
      earlier
        .map(
          (v) =>
            `<div class="q-log-item"><div class="q-by"><span class="q-ver">${esc(L.version(v.version))}</span> ${byPart("q-time", formatAnswerTime(v.createdAt, lang))}</div>${versionContentHtml(v, L)}</div>`,
        )
        .join("") +
      `</details>`
    : "";
  return (
    `<div class="q-answer" data-answer-id="${esc(a.answerId)}">` +
    `<div class="q-by"><span class="q-author">${esc(a.authorName)}</span> ${byPart("q-time", formatAnswerTime(a.createdAt, lang))}${asked}${edited}${edit}${redactInline}</div>` +
    redactBlock +
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

/** The over-cap line's text, or "" within the cap. */
export function overCapText(body: string, L: QuestionLabels): string {
  const over = codePointLength(body) - QUESTION_ANSWER_MAX;
  return over > 0 ? L.composer.overCap(over) : "";
}

/** The composer: choice radios (plus Not sure yet, and Clear choice once one
 *  is picked) when the question has choices, a textarea, a counter, Save
 *  (plus Cancel when editing), and the reason Save is disabled when the body
 *  is over the cap. */
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
      `<button type="button" class="q-clear-choice"${v.choice === null ? " hidden" : ""}${v.sending ? " disabled" : ""}>${esc(C.clearChoice)}</button>` +
      `</div>`
    : "";
  const len = codePointLength(v.body);
  const over = overCapText(v.body, L);
  return (
    `<form class="q-composer${v.editing ? " q-composer-edit" : ""}"${v.editing ? ` data-answer-id="${esc(v.editing)}"` : ""}>` +
    radios +
    `<textarea class="q-text" aria-label="${esc(C.answer)}" placeholder="${esc(C.placeholder)}"${v.sending ? " readonly" : ""}>${esc(v.body)}</textarea>` +
    `<div class="q-row">` +
    `<button type="submit" class="q-save"${v.sending || !composerCanSave(v.choice, v.body) ? " disabled" : ""}>${esc(v.sending ? C.saving : v.editing ? C.saveEdit : C.save)}</button>` +
    (v.editing ? `<button type="button" class="q-cancel"${v.sending ? " disabled" : ""}>${esc(C.cancel)}</button>` : "") +
    `<span class="q-count${over ? " q-count-over" : ""}">${len} / ${QUESTION_ANSWER_MAX}</span>` +
    `</div>` +
    `<p class="q-over" role="status"${over ? "" : " hidden"}>${esc(over)}</p>` +
    `</form>`
  );
}

/** The scanner's own reasons from a 422 `scanner_refused`, or null. */
export function scannerReasonsOf(status: number, payload: unknown): string[] | null {
  if (status !== 422 || !payload || typeof payload !== "object") return null;
  const p = payload as { code?: unknown; reasons?: unknown };
  if (p.code !== "scanner_refused" || !Array.isArray(p.reasons)) return null;
  return p.reasons.filter((r): r is string => typeof r === "string");
}

/** The line a failed save shows: the scanner's reasons on a refusal, a fixed
 *  line when no scanner could run, else the server's own sentence. */
export function saveErrorText(status: number, payload: unknown, L: QuestionLabels): string {
  const reasons = scannerReasonsOf(status, payload);
  if (reasons) return reasons.length ? `${L.composer.scannerRefused} ${reasons.join("; ")}` : L.composer.scannerRefused;
  if (payload && typeof payload === "object" && (payload as { code?: unknown }).code === "scanner_unavailable") {
    return L.composer.scannerUnavailable;
  }
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

/** A successful POST's body, when it has the saved answer's shape. */
export function savedAnswerOf(payload: unknown): SavedAnswerWire | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return typeof p.answerId === "string" &&
    typeof p.questionId === "string" &&
    typeof p.version === "number" &&
    typeof p.body === "string" &&
    typeof p.createdAt === "number"
    ? (payload as SavedAnswerWire)
    : null;
}
