/**
 * «🧾 Lag Jira-sak» — the web chat's entry point into the Jira composer, PURE half.
 *
 * The task is discussed in the melosys thread first; the draft is a TURN in that
 * conversation (`POST /api/jira/draft/from-thread`), and the finalized text comes
 * back as a CARD under the reply — `jira-card-pure.ts`. This module holds every
 * decision the ENTRY half makes — whether the control renders at all, what body
 * the POST carries, and what a non-200 means — so all of it is unit-testable
 * without a browser. It no longer opens anything: there is no tab, no second page
 * and no popup to be blocked, because the draft never leaves the conversation.
 *
 * **Everything it imports must be dependency-free.** It is bundled into the chat
 * page (`jira-entry-browser.ts` → `jira-entry-client.ts`), the
 * `inspector-panel-browser.ts` pattern, so an import that reaches for the DB or
 * the research layer would be pulled into the browser. `src/jira/wire.ts` is
 * dependency-free on purpose and `escape.ts` is a leaf.
 */

import { escHtml as esc } from "../../../dashboard/views/components/escape.ts";
import { JIRA_DEPTHS, JIRA_EXTRA_MAX, type JiraDepth } from "../../../jira/wire.ts";

// ── Ids and hooks ────────────────────────────────────────────────────────────
// Shared by the render, the delegated listeners and the tests, so the three
// cannot drift the way three string literals would.

/**
 * The control that sits beside the 👍/👎 on a finalized bot message.
 *
 * An ATTRIBUTE, not an id. One of these is rendered per finalized bot message,
 * so an id would be duplicated across every reply in the thread — invalid HTML,
 * and `getElementById`/`#id` then resolve to whichever one the parser saw first.
 * The delegated listener matches `closest('[data-je-btn]')` instead, which is
 * correct for N of them by construction.
 */
export const JE_BTN_ATTR = "data-je-btn";
/** The picker panel. A SINGLETON: opening one closes any other, so the id is
 *  unique in the document and the listeners can address it by id. */
export const JE_PANEL_ID = "jePanel";
export const JE_TEMPLATE_ID = "jeTemplate";
export const JE_DEPTH_ID = "jeDepth";
export const JE_EXTRA_ID = "jeExtra";
export const JE_SUBMIT_ID = "jeSubmit";
export const JE_CANCEL_ID = "jeCancel";
export const JE_MSG_ID = "jeMsg";

/** `data-je-thread="<uuid>"` — the thread the panel drafts from, stamped at the
 *  moment the control was rendered rather than read from the page's live
 *  `activeThreadId` at click time. */
export const JE_THREAD_ATTR = "data-je-thread";

/** The default template and depth the picker opens on — the same `skisse`
 *  default `/jira` uses (enough to estimate without locking the design). */
export const JE_DEFAULT_DEPTH: JiraDepth = "skisse";

/** One option of the template picker, as `GET /api/jira/templates` serves it. */
export interface JiraEntryTemplate {
  id: string;
  label: string;
}

export interface JiraEntryState {
  /** IN THE ORDER THE ROUTE SERVED THEM — `templates.ts` keeps the shipped set an
   *  ordered array precisely because sorting the ids renders `bug, spike, story,
   *  task`. */
  templates: JiraEntryTemplate[];
  templatesError?: string;
  /** The picker is still fetching its options. */
  loading: boolean;
  template: string;
  depth: JiraDepth;
  extra: string;
  /** A POST is in flight. */
  sending: boolean;
  /** The one status line under the buttons. */
  message?: string;
  messageTone?: "err" | "ok";
}

export function initialJiraEntryState(): JiraEntryState {
  return { templates: [], loading: true, template: "", depth: JE_DEFAULT_DEPTH, extra: "", sending: false };
}

// ── The decisions ────────────────────────────────────────────────────────────

/**
 * Does this bot message get a «Lag Jira-sak» control?
 *
 * TWO conditions, both load-bearing:
 *
 *   · **the bot IS the Jira bot.** `JIRA_BOT` has no fallback for a reason — a
 *     draft turn in a jarvis thread would be written over the AI/tech shelf, the
 *     wrong-corpus failure `resolveJiraBot` refuses to degrade into. The route
 *     400s such a thread; rendering the button anyway would offer a click whose
 *     only possible outcome is a refusal.
 *   · **a thread is known.** The route is keyed on `threadId` and there is
 *     nothing sensible to send without one. In practice the chat page always has
 *     one (every bot gets a `main` thread at hydration and `loadThreads`
 *     auto-selects), so this is a guard against the moment before that lands, not
 *     a common state.
 *
 * Compared case-INSENSITIVELY, the same way `resolveJiraBot` matches.
 */
export function jiraEntryVisible(opts: {
  selectedBot?: string | null;
  jiraBot?: string | null;
  threadId?: string | null;
}): boolean {
  const bot = (opts.selectedBot ?? "").trim().toLowerCase();
  const jira = (opts.jiraBot ?? "").trim().toLowerCase();
  if (!bot || !jira || bot !== jira) return false;
  return !!(opts.threadId ?? "").trim();
}

/**
 * The `POST /api/jira/draft/from-thread` body.
 *
 * `extra` is omitted when blank rather than sent as `""` — the route treats an
 * absent and an empty steer identically, and sending the key makes the request
 * log read as if the reader had typed something.
 */
export function jiraEntryDraftBody(input: {
  threadId: string;
  template: string;
  depth: JiraDepth;
  extra?: string;
}): Record<string, unknown> {
  const extra = (input.extra ?? "").trim();
  return {
    threadId: input.threadId,
    template: input.template,
    depth: input.depth,
    ...(extra ? { extra } : {}),
  };
}

/** Can the panel's **Lag utkast** button fire? */
export function jiraEntryCanSubmit(state: JiraEntryState): boolean {
  if (state.sending || state.loading) return false;
  if (!state.template) return false;
  return state.extra.length <= JIRA_EXTRA_MAX;
}

export type JiraEntryOutcome =
  | { ok: true; draftId: string }
  | { ok: false; message: string };

/**
 * What the POST answered.
 *
 * **The server's own sentence leads whenever it has one** — every refusal on this
 * route is written in bokmål and names the surface (the 409 says a turn is
 * already running in *this conversation*, the 400 names the bot the thread
 * belongs to, the 503 names which code servers are down and what to pick
 * instead). Re-writing those client-side would be a second, vaguer copy of a
 * message the route already got right.
 *
 * The per-status fallbacks below exist only for the cases where there is no body
 * to read: a transport failure (`status === 0`, this module's spelling of "the
 * fetch threw"), a non-JSON body, or a proxy answering for the route.
 */
export function jiraEntryOutcome(status: number, body: unknown): JiraEntryOutcome {
  const rec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status === 200) {
    const draftId = typeof rec.draftId === "string" ? rec.draftId.trim() : "";
    if (draftId) return { ok: true, draftId };
    return { ok: false, message: "Serveren svarte uten utkast-id — ingenting ble startet." };
  }
  const served = typeof rec.error === "string" ? rec.error.trim() : "";
  if (served) return { ok: false, message: served };
  return { ok: false, message: jiraEntryFallbackMessage(status) };
}

/** The sentence for a refusal that carried no readable body. */
export function jiraEntryFallbackMessage(status: number): string {
  if (status === 0) return "Fikk ikke kontakt med serveren — utkastet ble ikke startet.";
  if (status === 409) return "Det kjøres allerede en tur i denne samtalen — vent til den er ferdig.";
  if (status === 415) return "Forespørselen ble avvist: den må sendes som application/json.";
  if (status === 404) return "Samtalen finnes ikke lenger.";
  if (status === 503) return "Jira-komponisten er ikke tilgjengelig akkurat nå.";
  return `Utkastet kunne ikke startes (HTTP ${status}).`;
}

/**
 * `data-je-drafting="<draftId>"` on the placeholder note.
 *
 * The draft turn takes 60–600 s, and until it lands there is nothing to show but
 * the conversation's own streaming reply — so the row the control was clicked in
 * says what is happening. Keyed on the DRAFT id because the card that replaces it
 * lands under a DIFFERENT bubble (the new turn's), so "remove the note next to
 * me" is not a rule the card can follow; `attachJiraCard` clears it by id.
 */
export const JE_DRAFTING_ATTR = "data-je-drafting";

/** Said between the 200 and the card appearing. */
export const JE_DRAFTING_MESSAGE = "Utkastet skrives i samtalen …";

/**
 * The placeholder note for a draft that STARTED.
 *
 * There is no tab and no second page any more: the draft is a turn in this
 * conversation and its finalized text arrives as a card under the reply. The
 * archive link rides along regardless, because a 200 means the turn is RUNNING —
 * a row exists, a message is coming and the thread's flight slot is held — and
 * the reader must never be left without a pointer to work that is happening.
 */
export function jiraEntryDraftingHtml(draftId: string): string {
  return (
    `<span class="je-msg je-msg-ok" ${JE_DRAFTING_ATTR}="${esc(draftId)}">${esc(JE_DRAFTING_MESSAGE)}</span>`
  );
}

/**
 * Why **Avbryt** is dead while a POST is on the wire.
 *
 * There is nothing to cancel: the route is fire-and-forget, so by the time the
 * reader can click, a turn is either about to run or already running in their
 * conversation. Closing the panel only threw away the ANSWER — the draft id —
 * while the row, the visible chat turn and the thread's single-flight slot all
 * stayed, and the next click came back as a 409 about work never shown.
 */
export const JE_CANCEL_BUSY_TITLE = "Utkastet skrives — vent";

// ── Markup ───────────────────────────────────────────────────────────────────

/** The control itself. Rendered beside the 👍/👎 on a finalized bot message. */
export function jiraEntryButtonHtml(threadId: string): string {
  return (
    `<button type="button" class="msg-jira-btn" ${JE_BTN_ATTR} ${JE_THREAD_ATTR}="${esc(threadId)}"` +
    ` title="Lag et Jira-utkast av denne samtalen">🧾 Lag Jira-sak</button>`
  );
}

/**
 * The picker.
 *
 * Deliberately three controls and no more: the template, the depth, and one line
 * of steer. Everything else the composer offers (the raw material, the source
 * toggles, the draft itself) belongs on `/jira`, which this opens.
 */
export function jiraEntryPanelHtml(state: JiraEntryState): string {
  const templates = state.templates.length
    ? state.templates
        .map(
          (t) =>
            `<option value="${esc(t.id)}"${t.id === state.template ? " selected" : ""}>${esc(t.label)}</option>`,
        )
        .join("")
    : `<option value="">${state.loading ? "(henter maler…)" : "(ingen maler)"}</option>`;

  const depths = JIRA_DEPTHS.map(
    (d) =>
      `<option value="${esc(d.id)}"${d.id === state.depth ? " selected" : ""} title="${esc(d.hint)}">${esc(d.label)}</option>`,
  ).join("");

  // The message line is ALWAYS a node: a refusal is written into it without a
  // re-render (the reader may be mid-word in the steer field), and a
  // conditionally rendered line leaves that write with nothing to land in.
  const msg =
    `<span class="je-msg${state.messageTone === "err" ? " je-msg-err" : state.messageTone === "ok" ? " je-msg-ok" : ""}"` +
    `${state.message ? "" : " hidden"}>${esc(state.message ?? "")}</span>`;

  return `<div class="je-panel" id="${JE_PANEL_ID}">
    <div class="je-row">
      <label class="je-lab" for="${JE_TEMPLATE_ID}">Mal</label>
      <select id="${JE_TEMPLATE_ID}" class="je-select"${state.loading ? " disabled" : ""}>${templates}</select>
      <label class="je-lab" for="${JE_DEPTH_ID}">Dybde</label>
      <select id="${JE_DEPTH_ID}" class="je-select">${depths}</select>
    </div>
    <input id="${JE_EXTRA_ID}" class="je-extra" type="text" spellcheck="false"
      placeholder="Ekstra instruks (valgfritt) — f.eks. «fokuser på migreringsrisikoen»" value="${esc(state.extra)}">
    <div class="je-row je-foot">
      <button type="button" id="${JE_SUBMIT_ID}" class="je-primary"${jiraEntryCanSubmit(state) ? "" : " disabled"}>${
        state.sending ? "Starter…" : "Lag utkast"
      }</button>
      <button type="button" id="${JE_CANCEL_ID}" class="je-secondary"${
        state.sending ? ` disabled title="${esc(JE_CANCEL_BUSY_TITLE)}"` : ""
      }>Avbryt</button>
      <span class="je-note">Utkastet skrives som en tur i denne samtalen, og vises som et kort under svaret.</span>
    </div>
    <div id="${JE_MSG_ID}" class="je-msgwrap">${msg}</div>
    ${state.templatesError ? `<span class="je-msg je-msg-err">${esc(state.templatesError)}</span>` : ""}
  </div>`;
}
