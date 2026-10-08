/// <reference lib="dom" />
/**
 * The answer card's DOM half (answer cards PR 3): hydrates every answerable
 * `<Question>` card the server rendered with its answers, the composer, Edit
 * and the log fold. The pure half is `wiki-answer-card-model.ts`.
 *
 * The controls key on the page payload's own `answers.answerable` flag and the
 * card's `data-wiki-answerable` (D14), never on `wikiToolsRegistered` or the
 * read-only selectors: a wiki outside `WIKI_ANSWER_WIKIS`, or a viewer whose
 * zone does not admit the answer routes, gets no `answers` field, and this
 * module then neither fetches nor renders anything.
 *
 * State lives in a per-card record, never in the DOM. Four rules keep a card
 * honest while answers load and save around it:
 * - only the NEWEST answers request paints (`loadSeq`), so two reloads that
 *   return in reverse order cannot leave the older list on screen;
 * - a reload repaints only the cards whose data changed; a repaint puts
 *   focus, caret and selection back on the control it replaced, nested ones
 *   (the edit form inside the answers) included, puts it on the card when
 *   that control is gone or disabled, leaves focus anywhere else alone, and
 *   keeps every open log fold;
 * - an edit is based on the version the reader clicked Edit on, captured then
 *   — never on whatever a later reload put in the list, which would turn a
 *   stale edit into a silent overwrite instead of a 409;
 * - a card is repainted the moment its POST settles, whatever the reload does.
 *
 * An admin (the page's `canExport`) gets a Redact control on each answer, with
 * an inline two-step confirm held on the card record (PR 5).
 */
import {
  DEFAULT_QUESTION_LANGUAGE,
  parseQuestionLanguage,
  questionLabels,
  type QuestionLabels,
  type QuestionLanguage,
} from "../../../format/question-labels.ts";
import { codePointLength, parseChoices, QUESTION_ANSWER_MAX } from "../../../format/question.ts";
import {
  answerItemHtml,
  cardDisplayState,
  composerCanSave,
  composerHtml,
  draftChoiceFor,
  isVersionConflict,
  mergeSavedAnswer,
  overCapText,
  redactErrorText,
  saveErrorText,
  savedAnswerOf,
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
}

/** What a caller (PR 4's export button) holds on to after hydrating. */
export interface AnswerCardsHandle {
  /** Every answer on the page, as the last load or save left it. */
  answers(): readonly AnswerWire[];
  /** Answers the export has not copied yet, redacted ones excluded. */
  unexportedCount(): number;
  /** A load has succeeded at least once (the first one notifies `onChange`). */
  loaded(): boolean;
  /** Load the answers again and repaint the cards whose data changed. */
  refresh(): Promise<void>;
  /** Called after every change to `answers()`. Returns the unsubscribe. */
  onChange(cb: () => void): () => void;
}

/** The answer an edit is made from, captured when Edit is clicked. */
interface EditBase {
  answerId: string;
  version: number;
}

interface CardUi {
  section: HTMLElement;
  questionId: string;
  server: CardServerState;
  lang: QuestionLanguage;
  L: QuestionLabels;
  choices: string[];
  editing: EditBase | null;
  choice: string | null;
  body: string;
  sending: boolean;
  message: { text: string; kind: "error" | "warn"; retry?: boolean } | null;
  /** A 409 asked for the newer version: move `editing` onto it on the next load. */
  rebaseOnLoad: boolean;
  /** Answer ids whose log fold the reader has open. */
  openLogs: Set<string>;
  /** The viewer may redact (an admin: the page's `canExport`). */
  canRedact: boolean;
  /** The answer whose Redact confirm is open, and whether its request is out. */
  redact: { answerId: string; working: boolean } | null;
  /** What the last paint rendered from, so an unchanged card is left alone. */
  paintedKey: string | null;
}

interface CardsCtx {
  wiki: string;
  relPath: string;
  answers: AnswerWire[];
  /** A load has succeeded at least once. */
  loaded: boolean;
  cards: CardUi[];
  fetchFn: typeof fetch;
  /** The newest answers request issued; only its response paints. */
  loadSeq: number;
  listeners: Set<() => void>;
}

type LoadResult = "ok" | "failed" | "off" | "stale";

/** Marks a card section this module wired, so a second call never wires it twice. */
export const ANSWER_CARD_WIRED_ATTR = "data-answer-cards";
const handles = new WeakMap<Element, AnswerCardsHandle>();

const serverStateOf = (raw: string | null): CardServerState =>
  raw === "open" || raw === "closed" || raw === "decided" ? raw : "none";

/**
 * Hydrate the answerable cards under `root` and return a handle on them. Null —
 * and no fetch — when the page payload carries no `answers` flag or no card is
 * answerable. Idempotent: cards already wired are skipped, and a call that
 * finds only those returns their existing handle.
 */
export function enhanceAnswerCards(
  root: HTMLElement,
  info: PageAnswersInfo | undefined,
  opts: { wiki: string; relPath: string; fetchFn?: typeof fetch },
): AnswerCardsHandle | null {
  if (!info?.answerable || !opts.wiki || !opts.relPath) return null;
  const sections = Array.from(
    root.querySelectorAll<HTMLElement>('section.question[data-wiki-answerable="true"][data-question-id]'),
  );
  if (sections.length === 0) return null;
  const fresh = sections.filter((s) => !s.hasAttribute(ANSWER_CARD_WIRED_ATTR));
  if (fresh.length === 0) return handles.get(sections[0]!) ?? null;

  const ctx: CardsCtx = {
    wiki: opts.wiki,
    relPath: opts.relPath,
    answers: [],
    loaded: false,
    cards: [],
    fetchFn: opts.fetchFn ?? fetch.bind(globalThis),
    loadSeq: 0,
    listeners: new Set(),
  };
  const handle: AnswerCardsHandle = {
    answers: () => ctx.answers,
    unexportedCount: () => unexportedCount(ctx.answers),
    loaded: () => ctx.loaded,
    refresh: async () => {
      const r = await loadAnswers(ctx);
      if (r === "failed" && !ctx.loaded) showLoadError(ctx);
    },
    onChange: (cb) => {
      ctx.listeners.add(cb);
      return () => ctx.listeners.delete(cb);
    },
  };
  for (const section of fresh) {
    section.setAttribute(ANSWER_CARD_WIRED_ATTR, "wired");
    // Focusable from code only: where focus goes when the control it was on
    // is gone after a repaint.
    if (!section.hasAttribute("tabindex")) section.setAttribute("tabindex", "-1");
    const lang = parseQuestionLanguage(section.getAttribute("data-question-lang") ?? DEFAULT_QUESTION_LANGUAGE).language;
    const ui: CardUi = {
      section,
      questionId: section.getAttribute("data-question-id") ?? "",
      server: serverStateOf(section.getAttribute("data-question-state")),
      lang,
      L: questionLabels(lang),
      choices: parseChoices(section.getAttribute("data-question-choices") ?? undefined),
      editing: null,
      choice: null,
      body: "",
      sending: false,
      message: null,
      rebaseOnLoad: false,
      openLogs: new Set(),
      canRedact: info.canExport === true,
      redact: null,
      paintedKey: null,
    };
    ctx.cards.push(ui);
    handles.set(section, handle);
    wireCard(ctx, ui);
  }
  void handle.refresh();
  return handle;
}

function notify(ctx: CardsCtx): void {
  for (const cb of ctx.listeners) {
    try {
      cb();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

async function loadAnswers(ctx: CardsCtx): Promise<LoadResult> {
  const seq = ++ctx.loadSeq;
  const url =
    `/api/wiki/answers?wiki=${encodeURIComponent(ctx.wiki)}` +
    `&relPath=${encodeURIComponent(ctx.relPath)}&versions=1`;
  let data: { answerable?: boolean; answers?: AnswerWire[] };
  try {
    const res = await ctx.fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as typeof data;
  } catch {
    return seq === ctx.loadSeq ? "failed" : "stale";
  }
  // A newer request was issued while this one was out: its answer is the
  // newer list, so this one paints nothing.
  if (seq !== ctx.loadSeq) return "stale";
  // A wiki the route says takes no answers: leave the cards as they are.
  if (data.answerable === false) return "off";
  ctx.answers = Array.isArray(data.answers) ? data.answers : [];
  ctx.loaded = true;
  for (const ui of ctx.cards) {
    if (ui.message?.retry) ui.message = null;
    if (ui.rebaseOnLoad) rebaseEdit(ctx, ui);
    paint(ctx, ui);
  }
  notify(ctx);
  return "ok";
}

/** After a 409: base the reader's edit on the newer version now on screen. */
function rebaseEdit(ctx: CardsCtx, ui: CardUi): void {
  ui.rebaseOnLoad = false;
  const base = ui.editing;
  const latest = base ? ctx.answers.find((a) => a.answerId === base.answerId) : undefined;
  if (base && latest && latest.version > base.version) ui.editing = { answerId: base.answerId, version: latest.version };
  ui.message = { text: ui.L.composer.conflict, kind: "warn" };
}

/** The first load failed: the cards stay read-only, and one quiet line says why. */
function showLoadError(ctx: CardsCtx): void {
  for (const ui of ctx.cards) {
    if (!ui.section.isConnected) continue;
    ui.section.querySelector(":scope > .q-answers-error")?.remove();
    ui.section.insertAdjacentHTML("beforeend", `<p class="q-note q-answers-error">${esc(ui.L.composer.loadFailed)}</p>`);
  }
}

const answersFor = (ctx: CardsCtx, ui: CardUi) =>
  ctx.answers
    .filter((a) => a.questionId === ui.questionId)
    .sort((a, b) => a.firstCreatedAt - b.firstCreatedAt);

/** Where focus is in a card, as a key a repaint can find again. */
function focusKeyOf(section: HTMLElement, el: Element): string | null {
  if (el instanceof HTMLTextAreaElement && el.classList.contains("q-text")) return "text";
  if (el instanceof HTMLInputElement && el.type === "radio") return `radio:${el.value}`;
  if (el instanceof HTMLButtonElement) {
    if (el.classList.contains("q-edit")) return `edit:${el.getAttribute("data-answer-id") ?? ""}`;
    for (const cls of ["q-redact", "q-redact-yes", "q-redact-no"]) {
      if (el.classList.contains(cls)) return `${cls}:${el.getAttribute("data-answer-id") ?? ""}`;
    }
    for (const cls of ["q-save", "q-cancel", "q-retry", "q-clear-choice"]) if (el.classList.contains(cls)) return cls;
  }
  if (el.tagName === "SUMMARY") {
    const log = el.closest("details.q-log");
    if (log) return `log:${log.getAttribute("data-answer-id") ?? ""}`;
  }
  return null;
}

interface FocusMark {
  key: string;
  start: number | null;
  end: number | null;
}

/** The parts of a card `renderCard` removes and rebuilds. An edit form sits
 *  INSIDE `.q-answers`, so a part can be nested in another. */
const REPAINTED_PARTS = ".q-answers, .q-composer, .q-msg, .q-answers-error";

/** Focus inside a part the repaint replaces, at any depth, or null: focus on
 *  the question text, the id or decision link, or the card itself survives the
 *  repaint untouched. */
function captureFocus(section: HTMLElement): FocusMark | null {
  const el = document.activeElement;
  if (!el || !section.contains(el)) return null;
  if (!el.closest(REPAINTED_PARTS)) return null;
  const key = focusKeyOf(section, el) ?? "section";
  const text = el instanceof HTMLTextAreaElement ? el : null;
  return { key, start: text ? text.selectionStart : null, end: text ? text.selectionEnd : null };
}

function restoreFocus(section: HTMLElement, mark: FocusMark | null): void {
  if (!mark) return;
  if (mark.key !== "section") {
    const target = Array.from(
      section.querySelectorAll<HTMLElement>("textarea.q-text, input[type=radio], button, details.q-log > summary"),
    ).find((el) => focusKeyOf(section, el) === mark.key);
    if (target && !(target as HTMLButtonElement | HTMLInputElement).disabled && !target.hidden) {
      target.focus({ preventScroll: true });
      if (target instanceof HTMLTextAreaElement && mark.start !== null) {
        target.setSelectionRange(mark.start, mark.end ?? mark.start);
      }
      return;
    }
  }
  // The control focus was on is gone, or disabled while a save is out: the
  // card holds it.
  section.focus({ preventScroll: true });
}

/** Repaint a card from its state. Unless `force`, a card whose answers and
 *  draft state are what it last painted from is left alone. */
function paint(ctx: CardsCtx, ui: CardUi, force = false): void {
  if (!ui.section.isConnected) return;
  const answers = answersFor(ctx, ui);
  // A confirm whose answer is redacted or gone has nothing left to redact.
  const target = ui.redact;
  if (target && !target.working && !answers.some((a) => a.answerId === target.answerId && !a.redacted)) ui.redact = null;
  const key = JSON.stringify([answers, ui.editing, ui.sending, ui.message, ui.server, ui.redact]);
  if (!force && key === ui.paintedKey) return;
  const mark = captureFocus(ui.section);
  renderCard(ui, answers);
  ui.paintedKey = key;
  restoreFocus(ui.section, mark);
}

function renderCard(ui: CardUi, answers: AnswerWire[]): void {
  const { section, L } = ui;
  const state = cardDisplayState(ui.server, answers);
  section.setAttribute("data-answer-state", state);
  section.classList.toggle("q-answered", state === "answered");
  section.classList.toggle("q-copied", state === "copied");
  const pill = statePillText(state, L);
  const pillEl = section.querySelector<HTMLElement>(":scope > .q-head > .q-state");
  if (pill !== null && pillEl) pillEl.textContent = pill;

  // Idempotent: drop what an earlier render injected.
  section
    .querySelectorAll(":scope > .q-answers, :scope > .q-composer, :scope > .q-msg, :scope > .q-answers-error, :scope > .q-head > .q-new")
    .forEach((el) => el.remove());

  const open = ui.server === "open";
  // A closed card keeps its answers on screen; the ones not yet copied are
  // what the export still has to find.
  const fresh = unexportedCount(answers);
  if (!open && fresh > 0) {
    section.querySelector(":scope > .q-head")?.insertAdjacentHTML("beforeend", `<span class="q-new">${esc(L.newBadge(fresh))}</span>`);
  }
  const editingId = open ? (ui.editing?.answerId ?? null) : null;
  const items = answers
    .map(
      (a) =>
        answerItemHtml(a, L, ui.lang, open && a.mine && !a.redacted && ui.editing === null, ui.openLogs.has(a.answerId), {
          // Not beside its own open editor: one control per answer at a time.
          can: ui.canRedact && ui.editing?.answerId !== a.answerId,
          confirming: ui.redact?.answerId === a.answerId,
          working: ui.redact?.answerId === a.answerId && ui.redact.working,
        }) +
        // The editor sits under the answer it edits, so a 409 shows the newer
        // version above the reader's own text.
        (a.answerId === editingId ? composerHtml(composerView(ui), L) : ""),
    )
    .join("");
  let html = items ? `<div class="q-answers">${items}</div>` : "";
  // The viewer composes a new answer until they have one; after that they edit it.
  if (open && ui.editing === null && !answers.some((a) => a.mine)) html += composerHtml(composerView(ui), L);
  if (ui.message) {
    const retry = ui.message.retry ? ` <button type="button" class="q-retry">${esc(L.composer.retry)}</button>` : "";
    html += `<p class="q-msg q-msg-${ui.message.kind}" role="${ui.message.kind === "error" ? "alert" : "status"}">${esc(ui.message.text)}${retry}</p>`;
  }
  section.insertAdjacentHTML("beforeend", html);
  // `.value`, not the escaped text node: a textarea's markup drops a leading newline.
  const text = section.querySelector<HTMLTextAreaElement>("textarea.q-text");
  if (text) text.value = ui.body;
}

const composerView = (ui: CardUi) => ({
  questionId: ui.questionId,
  choices: ui.choices,
  editing: ui.editing?.answerId ?? null,
  choice: ui.choice,
  body: ui.body,
  sending: ui.sending,
});

/** Refresh the counter, the over-cap line, Clear choice and Save in place,
 *  so typing keeps focus. */
function syncComposer(ui: CardUi): void {
  const form = ui.section.querySelector<HTMLFormElement>("form.q-composer");
  if (!form) return;
  const len = codePointLength(ui.body);
  const count = form.querySelector<HTMLElement>(".q-count");
  if (count) {
    count.textContent = `${len} / ${QUESTION_ANSWER_MAX}`;
    count.classList.toggle("q-count-over", len > QUESTION_ANSWER_MAX);
  }
  const over = form.querySelector<HTMLElement>(".q-over");
  if (over) {
    const text = overCapText(ui.body, ui.L);
    over.textContent = text;
    over.hidden = text === "";
  }
  const clear = form.querySelector<HTMLButtonElement>("button.q-clear-choice");
  if (clear) clear.hidden = ui.choice === null;
  const save = form.querySelector<HTMLButtonElement>("button.q-save");
  if (save) save.disabled = ui.sending || !composerCanSave(ui.choice, ui.body);
}

/** Focus the `cls` button of one answer, else the card. */
function focusButton(ui: CardUi, cls: string, answerId: string): void {
  const btn = Array.from(ui.section.querySelectorAll<HTMLButtonElement>(`button.${cls}`)).find(
    (b) => b.getAttribute("data-answer-id") === answerId,
  );
  (btn ?? ui.section).focus({ preventScroll: true });
}

/** The answer as a redact leaves it, every version emptied. */
function redactedCopy(a: AnswerWire): AnswerWire {
  return {
    ...a,
    body: "",
    choice: null,
    redacted: true,
    ...(a.earlier ? { earlier: a.earlier.map((v) => ({ ...v, body: "", choice: null, redacted: true })) } : {}),
  };
}

/** An admin's confirmed Redact: one POST, then the answers again. The card is
 *  repainted the moment the POST settles, as a save's is. */
async function redact(ctx: CardsCtx, ui: CardUi, answerId: string): Promise<void> {
  ui.redact = { answerId, working: true };
  paint(ctx, ui, true);
  let status = 0;
  let data: unknown = null;
  try {
    const res = await ctx.fetchFn("/api/wiki/answers/redact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answerId }),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  ui.redact = null;
  const moveFocus = focusIsHereOrNowhere(ui);
  if (status >= 200 && status < 300) {
    ctx.answers = ctx.answers.map((a) => (a.answerId === answerId ? redactedCopy(a) : a));
    notify(ctx);
    paint(ctx, ui, true);
    // Its Redact… is gone: the card holds focus, the repaint rule.
    if (moveFocus) ui.section.focus({ preventScroll: true });
    const r = await loadAnswers(ctx);
    if (r === "failed" || r === "off") {
      ui.message = { text: ui.L.redact.reloadFailed, kind: "warn", retry: true };
      paint(ctx, ui, true);
    }
    return;
  }
  ui.message = { text: redactErrorText(status, data, ui.L), kind: "error" };
  paint(ctx, ui, true);
  if (moveFocus) focusButton(ui, "q-redact", answerId);
}

function focusEdit(ui: CardUi, answerId: string | null): void {
  const edit = answerId
    ? Array.from(ui.section.querySelectorAll<HTMLButtonElement>("button.q-edit")).find(
        (b) => b.getAttribute("data-answer-id") === answerId,
      )
    : undefined;
  (edit ?? ui.section).focus({ preventScroll: true });
}

/** Focus is in this card, or nowhere: moving it will not take it from
 *  somewhere the reader went meanwhile. */
function focusIsHereOrNowhere(ui: CardUi): boolean {
  const el = document.activeElement;
  return !el || el === document.body || ui.section.contains(el);
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
  // `toggle` does not bubble: listen in the capture phase.
  section.addEventListener(
    "toggle",
    (e) => {
      const t = e.target as HTMLElement;
      if (!(t instanceof HTMLDetailsElement) || !t.classList.contains("q-log")) return;
      const id = t.getAttribute("data-answer-id") ?? "";
      if (t.open) ui.openLogs.add(id);
      else ui.openLogs.delete(id);
    },
    true,
  );
  section.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t || !section.contains(t)) return;
    if (t.classList.contains("q-edit") && !ui.sending) {
      const a = ctx.answers.find((x) => x.answerId === t.getAttribute("data-answer-id"));
      if (!a) return;
      // The base is the version on screen NOW: a newer one saved elsewhere
      // before this edit is saved is a 409, never a silent overwrite.
      ui.editing = { answerId: a.answerId, version: a.version };
      ui.choice = draftChoiceFor(a.choice, ui.choices);
      ui.body = a.body;
      ui.message = null;
      // An open Redact confirm closes: the answer it named is being edited.
      if (!ui.redact?.working) ui.redact = null;
      paint(ctx, ui, true);
      section.querySelector<HTMLTextAreaElement>("textarea.q-text")?.focus();
    } else if (t.classList.contains("q-cancel") && !ui.sending) {
      const id = ui.editing?.answerId ?? null;
      resetDraft(ui);
      ui.message = null;
      paint(ctx, ui, true);
      focusEdit(ui, id);
    } else if (t.classList.contains("q-clear-choice") && !ui.sending) {
      ui.choice = null;
      section.querySelectorAll<HTMLInputElement>("form.q-composer input[type=radio]").forEach((r) => (r.checked = false));
      syncComposer(ui);
      section.querySelector<HTMLInputElement>("form.q-composer input[type=radio]")?.focus();
    } else if (t.classList.contains("q-redact") && ui.canRedact && !ui.redact?.working) {
      const id = t.getAttribute("data-answer-id") ?? "";
      ui.redact = { answerId: id, working: false };
      ui.message = null;
      paint(ctx, ui, true);
      focusButton(ui, "q-redact-no", id);
    } else if (t.classList.contains("q-redact-no") && !ui.redact?.working) {
      const id = ui.redact?.answerId ?? "";
      ui.redact = null;
      paint(ctx, ui, true);
      focusButton(ui, "q-redact", id);
    } else if (t.classList.contains("q-redact-yes") && ui.redact && !ui.redact.working) {
      void redact(ctx, ui, ui.redact.answerId);
    } else if (t.classList.contains("q-retry")) {
      // aria-disabled, not `disabled`: the browser drops focus from a button
      // it disables, so the reload's repaint would find focus on <body>.
      if (t.getAttribute("aria-disabled") === "true") return;
      t.setAttribute("aria-disabled", "true");
      void loadAnswers(ctx).then((r) => {
        if (r !== "ok" && t.isConnected) t.removeAttribute("aria-disabled");
      });
    }
  });
  // Escape inside the Redact confirm is its Cancel. Stopped here, so the
  // reader's own Escape (leaving focus mode) does not run as well.
  section.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !ui.redact || ui.redact.working) return;
    if (!(e.target instanceof Element) || !e.target.closest(".q-redact-confirm")) return;
    e.preventDefault();
    e.stopPropagation();
    const id = ui.redact.answerId;
    ui.redact = null;
    paint(ctx, ui, true);
    focusButton(ui, "q-redact", id);
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
  ui.rebaseOnLoad = false;
}

async function save(ctx: CardsCtx, ui: CardUi): Promise<void> {
  // One request in flight per card: a double submit on a NEW answer would
  // otherwise store two answers.
  if (ui.sending || !composerCanSave(ui.choice, ui.body)) return;
  const base = ui.editing;
  ui.sending = true;
  ui.message = null;
  paint(ctx, ui, true);
  const payload: Record<string, unknown> = {
    wiki: ctx.wiki,
    relPath: ctx.relPath,
    questionId: ui.questionId,
    choice: ui.choice,
    body: ui.body,
  };
  if (base) Object.assign(payload, { answerId: base.answerId, baseVersion: base.version });
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
  // Whatever happens next, the card stops saying "Saving …" now.
  ui.sending = false;
  const { L } = ui;
  if (status >= 200 && status < 300) {
    const saved = savedAnswerOf(data);
    if (saved) {
      ctx.answers = mergeSavedAnswer(ctx.answers, saved);
      notify(ctx);
    }
    resetDraft(ui);
    const moveFocus = focusIsHereOrNowhere(ui);
    paint(ctx, ui, true);
    if (moveFocus) focusEdit(ui, saved?.answerId ?? base?.answerId ?? null);
    const r = await loadAnswers(ctx);
    if (r === "failed" || r === "off") {
      ui.message = { text: L.composer.savedReloadFailed, kind: "warn", retry: true };
      paint(ctx, ui, true);
    }
  } else if (isVersionConflict(status, data)) {
    // Keep the reader's text; show the newer answer above it on the next load
    // and base the editor on it, so saving again is a deliberate choice.
    ui.rebaseOnLoad = true;
    ui.message = { text: L.composer.conflict, kind: "warn" };
    paint(ctx, ui, true);
    const r = await loadAnswers(ctx);
    if (r === "failed" || r === "off") {
      ui.message = { text: `${L.composer.conflict} ${L.composer.loadFailed}`, kind: "warn", retry: true };
      paint(ctx, ui, true);
    }
  } else {
    ui.message = { text: saveErrorText(status, data, L), kind: "error" };
    paint(ctx, ui, true);
  }
}
