/// <reference lib="dom" />
/**
 * The answer card's DOM half (answer cards PR 3): hydrates every answerable
 * `<Question>` card the server rendered with its answers, the composer, Edit
 * and the log fold. The pure half is `wiki-answer-card-model.ts`.
 *
 * The controls key on the page payload's own `answers.answerable` flag and the
 * card's `data-wiki-answerable` (D14), never on `wikiToolsRegistered` or the
 * read-only selectors: a wiki outside `WIKI_ANSWER_WIKIS` sends no `answers`
 * field, and this module then neither fetches nor renders anything.
 *
 * All state lives in a per-card record, never in the DOM, and every change
 * re-renders the card from it; a stale response (the reader navigated away)
 * paints nothing because its card is no longer connected.
 */
import { questionLabels, QUESTION_LANGUAGES, type QuestionLabels, type QuestionLanguage } from "../../../format/question-labels.ts";
import { splitQuestionList } from "../../../format/question.ts";
import {
  answerItemHtml,
  ANSWER_BODY_MAX,
  cardDisplayState,
  codePointLength,
  composerCanSave,
  composerHtml,
  isVersionConflict,
  saveErrorText,
  statePillText,
  unexportedCount,
  type AnswerWire,
  type CardServerState,
} from "./wiki-answer-card-model.ts";
import { escHtml as esc } from "./escape.ts";

/** What `/api/wiki/page` says about answers on this wiki (absent ⇒ none). */
export interface PageAnswersInfo {
  answerable: boolean;
  canExport?: boolean;
  owner?: string | null;
}

interface CardUi {
  section: HTMLElement;
  questionId: string;
  server: CardServerState;
  lang: QuestionLanguage;
  L: QuestionLabels;
  choices: string[];
  /** The answer being edited, or null. */
  editing: string | null;
  choice: string | null;
  body: string;
  sending: boolean;
  message: { text: string; kind: "error" | "warn" } | null;
}

interface CardsCtx {
  wiki: string;
  relPath: string;
  answers: AnswerWire[];
  cards: CardUi[];
  fetchFn: typeof fetch;
}

const langOf = (raw: string | null): QuestionLanguage =>
  (QUESTION_LANGUAGES as readonly string[]).includes(raw ?? "") ? (raw as QuestionLanguage) : "en";

const serverStateOf = (raw: string | null): CardServerState =>
  raw === "open" || raw === "closed" || raw === "decided" ? raw : "none";

/**
 * Hydrate the answerable cards under `root`. A no-op — no fetch — when the
 * page payload carries no `answers` flag or no card is answerable.
 */
export function enhanceAnswerCards(
  root: HTMLElement,
  info: PageAnswersInfo | undefined,
  opts: { wiki: string; relPath: string; fetchFn?: typeof fetch },
): void {
  if (!info?.answerable || !opts.wiki || !opts.relPath) return;
  const sections = Array.from(
    root.querySelectorAll<HTMLElement>('section.question[data-wiki-answerable="true"][data-question-id]'),
  );
  if (sections.length === 0) return;
  const ctx: CardsCtx = {
    wiki: opts.wiki,
    relPath: opts.relPath,
    answers: [],
    cards: [],
    fetchFn: opts.fetchFn ?? fetch.bind(globalThis),
  };
  for (const section of sections) {
    const lang = langOf(section.getAttribute("data-question-lang"));
    const choicesAttr = section.getAttribute("data-question-choices");
    const ui: CardUi = {
      section,
      questionId: section.getAttribute("data-question-id") ?? "",
      server: serverStateOf(section.getAttribute("data-question-state")),
      lang,
      L: questionLabels(lang),
      choices: choicesAttr ? splitQuestionList(choicesAttr).map((c) => c.trim()).filter(Boolean) : [],
      editing: null,
      choice: null,
      body: "",
      sending: false,
      message: null,
    };
    ctx.cards.push(ui);
    wireCard(ctx, ui);
  }
  void loadAnswers(ctx);
}

async function loadAnswers(ctx: CardsCtx): Promise<void> {
  const url =
    `/api/wiki/answers?wiki=${encodeURIComponent(ctx.wiki)}` +
    `&relPath=${encodeURIComponent(ctx.relPath)}&versions=1`;
  try {
    const res = await ctx.fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { answerable?: boolean; answers?: AnswerWire[] };
    // A wiki the route says takes no answers: leave the cards read-only.
    if (data.answerable === false) return;
    ctx.answers = Array.isArray(data.answers) ? data.answers : [];
  } catch {
    // The cards stay read-only; one quiet line says why.
    for (const ui of ctx.cards) {
      if (!ui.section.isConnected) continue;
      ui.section.querySelector(".q-answers-error")?.remove();
      ui.section.insertAdjacentHTML("beforeend", `<p class="q-note q-answers-error">${esc(ui.L.composer.loadFailed)}</p>`);
    }
    return;
  }
  for (const ui of ctx.cards) renderCard(ctx, ui);
}

const answersFor = (ctx: CardsCtx, ui: CardUi) =>
  ctx.answers
    .filter((a) => a.questionId === ui.questionId)
    .sort((a, b) => a.firstCreatedAt - b.firstCreatedAt);

function renderCard(ctx: CardsCtx, ui: CardUi): void {
  const { section, L } = ui;
  if (!section.isConnected) return;
  const answers = answersFor(ctx, ui);
  const state = cardDisplayState(ui.server, answers);
  section.setAttribute("data-answer-state", state);
  section.classList.toggle("q-answered", state === "answered");
  section.classList.toggle("q-copied", state === "copied");
  const pill = statePillText(state, L);
  const pillEl = section.querySelector<HTMLElement>(":scope > .q-head > .q-state");
  if (pill !== null && pillEl) pillEl.textContent = pill;

  // Idempotent: drop what an earlier render injected.
  section.querySelectorAll(":scope > .q-answers, :scope > .q-composer, :scope > .q-msg, :scope > .q-answers-error, :scope > .q-head > .q-new").forEach((el) => el.remove());

  const open = ui.server === "open";
  // A closed card keeps its answers on screen; the ones not yet copied are
  // what the export still has to find.
  const fresh = unexportedCount(answers);
  if (!open && fresh > 0) {
    section.querySelector(":scope > .q-head")?.insertAdjacentHTML("beforeend", `<span class="q-new">${esc(L.newBadge(fresh))}</span>`);
  }
  const items = answers
    .map((a) =>
      open && ui.editing === a.answerId
        ? composerHtml(composerView(ui), L)
        : answerItemHtml(a, L, ui.lang, open && a.mine && !a.redacted && ui.editing === null),
    )
    .join("");
  let html = items ? `<div class="q-answers">${items}</div>` : "";
  // The viewer composes a new answer until they have one; after that they edit it.
  if (open && ui.editing === null && !answers.some((a) => a.mine)) html += composerHtml(composerView(ui), L);
  if (ui.message) {
    html += `<p class="q-msg q-msg-${ui.message.kind}" role="${ui.message.kind === "error" ? "alert" : "status"}">${esc(ui.message.text)}</p>`;
  }
  section.insertAdjacentHTML("beforeend", html);
  // `.value`, not the escaped text node: a textarea's markup drops a leading newline.
  const text = section.querySelector<HTMLTextAreaElement>("textarea.q-text");
  if (text) text.value = ui.body;
}

const composerView = (ui: CardUi) => ({
  questionId: ui.questionId,
  choices: ui.choices,
  editing: ui.editing,
  choice: ui.choice,
  body: ui.body,
  sending: ui.sending,
});

/** Refresh the counter and the Save button in place, so typing keeps focus. */
function syncComposer(ui: CardUi): void {
  const form = ui.section.querySelector<HTMLFormElement>("form.q-composer");
  if (!form) return;
  const len = codePointLength(ui.body);
  const count = form.querySelector<HTMLElement>(".q-count");
  if (count) {
    count.textContent = `${len} / ${ANSWER_BODY_MAX}`;
    count.classList.toggle("q-count-over", len > ANSWER_BODY_MAX);
  }
  const save = form.querySelector<HTMLButtonElement>("button.q-save");
  if (save) save.disabled = ui.sending || !composerCanSave(ui.choice, ui.body);
}

function wireCard(ctx: CardsCtx, ui: CardUi): void {
  const { section } = ui;
  section.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement && t.classList.contains("q-text")) {
      ui.body = t.value;
      syncComposer(ui);
    }
  });
  section.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.type === "radio" && t.closest("form.q-composer")) {
      ui.choice = t.value;
      syncComposer(ui);
    }
  });
  section.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t || !section.contains(t)) return;
    if (t.classList.contains("q-edit") && !ui.sending) {
      const a = ctx.answers.find((x) => x.answerId === t.getAttribute("data-answer-id"));
      if (!a) return;
      ui.editing = a.answerId;
      ui.choice = a.choice;
      ui.body = a.body;
      ui.message = null;
      renderCard(ctx, ui);
      section.querySelector<HTMLTextAreaElement>("textarea.q-text")?.focus();
    } else if (t.classList.contains("q-cancel") && !ui.sending) {
      resetDraft(ui);
      renderCard(ctx, ui);
    }
  });
  section.addEventListener("submit", (e) => {
    const form = e.target as HTMLElement;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains("q-composer")) return;
    e.preventDefault();
    void save(ctx, ui);
  });
}

function resetDraft(ui: CardUi): void {
  ui.editing = null;
  ui.choice = null;
  ui.body = "";
}

async function save(ctx: CardsCtx, ui: CardUi): Promise<void> {
  // One request in flight per card: a double-click on a NEW answer would
  // otherwise store two answers.
  if (ui.sending || !composerCanSave(ui.choice, ui.body)) return;
  const editing = ui.editing ? ctx.answers.find((a) => a.answerId === ui.editing) : undefined;
  if (ui.editing && !editing) return;
  ui.sending = true;
  ui.message = null;
  renderCard(ctx, ui);
  const payload: Record<string, unknown> = {
    wiki: ctx.wiki,
    relPath: ctx.relPath,
    questionId: ui.questionId,
    choice: ui.choice,
    body: ui.body,
  };
  // The base is the version the card shows: a newer one saved elsewhere is a
  // 409, never a silent overwrite.
  if (editing) Object.assign(payload, { answerId: editing.answerId, baseVersion: editing.version });
  let status = 0;
  let data: unknown = null;
  try {
    const res = await ctx.fetchFn("/api/wiki/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  ui.sending = false;
  if (status >= 200 && status < 300) {
    resetDraft(ui);
    await loadAnswers(ctx);
  } else if (isVersionConflict(status, data)) {
    resetDraft(ui);
    ui.message = { text: ui.L.composer.conflict, kind: "warn" };
    await loadAnswers(ctx);
  } else {
    ui.message = { text: saveErrorText(status, data, ui.L), kind: "error" };
    renderCard(ctx, ui);
  }
}
