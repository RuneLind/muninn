/**
 * The `/jira` composer's PURE half — ids, markup and every decision worth
 * testing without a browser.
 *
 * Split for the reason `wiki-share-dialog.ts` is: the DOM half
 * (`jira-composer.ts`) cannot be unit-tested and everything here can. It is also
 * import-safe (no DOM access at module load), so the page bundle and the tests
 * reach the same module.
 *
 * **Everything it imports must be dependency-free.** `src/jira/wire.ts` is, on
 * purpose (`templates.ts` reaches for the bot config, `retrieval.ts` for the
 * research layer, `verify-keys.ts` for huginn) — so the wire module is the ONLY
 * server-side import here, and the coverage sentences live in it rather than
 * beside `assessCoverage`.
 */

import { escHtml as esc } from "./escape.ts";
import {
  JIRA_ALL_EXCLUDED_MESSAGE,
  JIRA_DEPTHS,
  JIRA_EXTRA_MAX,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_NOTES_MAX,
  JIRA_UNREACHABLE_MESSAGE,
  isJiraDepth,
  isJiraDraftSource,
  type JiraCitation,
  type JiraCoverage,
  type JiraDepth,
  type JiraDraftSource,
  type JiraDraftStatus,
  type JiraDraftView,
  type JiraKeyVerdict,
  type JiraMarkdownFlag,
} from "../../../jira/wire.ts";

// ── Ids and attribute hooks ──────────────────────────────────────────────────
// Shared by the render, the delegated listeners and the tests, so the three
// cannot drift apart the way three string literals would.

export const JC_ROOT_ID = "jcRoot";
export const JC_LEFT_ID = "jcLeft";
export const JC_MID_ID = "jcMid";
export const JC_RIGHT_ID = "jcRight";

export const JC_NOTES_ID = "jcNotes";
export const JC_TEMPLATE_ID = "jcTemplate";
export const JC_EXTRA_ID = "jcExtra";
export const JC_SUBMIT_ID = "jcSubmit";
export const JC_REGEN_ID = "jcRegen";
export const JC_COPY_ID = "jcCopy";
export const JC_SAVE_ID = "jcSave";
export const JC_MARKDOWN_ID = "jcMarkdown";
export const JC_PREVIEW_ID = "jcPreview";
export const JC_STATUS_ID = "jcStatus";
export const JC_NOTES_COUNT_ID = "jcNotesCount";
export const JC_EXTRA_COUNT_ID = "jcExtraCount";
/** The "why the button is off" line. ALWAYS a node — `syncLeftControls` rewrites
 *  it without re-rendering the column the caret is in, and a conditionally
 *  rendered line leaves it with nothing to write into. */
export const JC_BLOCKED_ID = "jcBlocked";
/** The MIDDLE column's own "why the regenerate is off" line. The middle and left
 *  columns are separate scroll regions, so `#jcBlocked` can be off screen while
 *  the reader is looking at this button — which is how it shipped as a live
 *  button whose click did nothing and said nothing. */
export const JC_REGEN_BLOCKED_ID = "jcRegenBlocked";
/** The RIGHT column's own error line, beside the copy/save buttons. `state.error`
 *  renders only in the left column's status line, so a failed **Lagre** was
 *  invisible: the reader saw the button return to rest and believed it saved. */
export const JC_RIGHT_ERROR_ID = "jcRightError";

/** The three buttons of the unsaved-edits gate. */
export const JC_GATE_SAVE_ID = "jcGateSave";
export const JC_GATE_DISCARD_ID = "jcGateDiscard";
export const JC_GATE_CANCEL_ID = "jcGateCancel";
/** The "unsaved changes" line. ALWAYS rendered, `hidden` when clean — the draft
 *  edit deliberately does not re-render the column it is typed into, so the
 *  marker has to be a node the input handler can toggle rather than markup a
 *  render would have to produce. */
export const JC_DIRTY_ID = "jcDirty";

/** `data-jc-depth="<id>"` on the depth radios. */
export const JC_DEPTH_ATTR = "data-jc-depth";
/** `data-jc-doc="<index into state.citations>"` on a citation's retain toggle. */
export const JC_DOC_ATTR = "data-jc-doc";
/** `data-jc-open="<index into state.citations>"` on a citation's title button. */
export const JC_OPEN_ATTR = "data-jc-open";
/** `data-jc-view="markdown|preview"` on the two view-switch buttons. */
export const JC_VIEW_ATTR = "data-jc-view";

/** The default depth. `Skisse` is the plan's default: enough to estimate without
 *  locking the design. */
export const JC_DEFAULT_DEPTH: JiraDepth = "skisse";

/** How often the `?draft=` landing polls `GET /api/jira/draft/:id`.
 *
 *  Polling, NOT a stream re-attach: there is nothing to attach to (the only SSE
 *  endpoint STARTS a generation) and a re-POST of identical content would hit the
 *  single-flight 409 — which is exactly this case. */
export const JC_POLL_INTERVAL_MS = 2_500;

/**
 * When the poller gives up.
 *
 * Sized off the server's own ceiling: `Full` is budgeted 600 s and the
 * single-flight slot outlives it by `JIRA_SLOT_SLACK_MS` (180 s), so a draft that
 * is still `generating` at 13 min is a draft nothing is working on. Giving up
 * says so rather than polling a dead row forever.
 */
export const JC_POLL_MAX_MS = 13 * 60_000;

// ── The page's state ─────────────────────────────────────────────────────────

export interface JiraTemplateOption {
  id: string;
  label: string;
}

export type JiraViewMode = "markdown" | "preview";

export interface JiraComposerState {
  /** The picker's options, IN THE ORDER THE ROUTE SERVED THEM. `templates.ts`
   *  keeps the shipped set an ordered array precisely because the variant loader
   *  sorts ids with `localeCompare`, which renders `bug, spike, story, task`. */
  templates: JiraTemplateOption[];
  templatesError?: string;
  bot?: string;

  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;

  /** A generation (first draft or regenerate) is in flight. */
  running: boolean;
  /** A poll loop is in flight against a draft this page did not stream. */
  polling: boolean;
  /** The last `phase` event's label, shown while running. */
  phase?: string;
  /** The live `delta` buffer — shown in place of the draft while streaming. */
  streamed: string;

  draftId?: string;
  status?: JiraDraftStatus;
  /**
   * Where this draft came from. `notes` until a row says otherwise.
   *
   * A `thread` draft is a TURN in a chat conversation: the raw material is the
   * conversation, `notes` is only the `fra samtale: <name>` placeholder the
   * server stores because the column is NOT NULL, and every later operation
   * differs (the regenerate is another turn, the hit set is re-seeded from
   * `research_citations`). The page must therefore never render that placeholder
   * as editable raw material or as a search query.
   */
  source: JiraDraftSource;
  /** The chat thread a `thread` draft runs in. */
  threadId?: string;
  /** That thread's name, resolved server-side at READ time (a thread can be
   *  renamed, so the row deliberately stores no copy). */
  threadName?: string;
  /** The draft as it stands, INCLUDING the reader's unsaved edits. */
  markdown: string;
  /** The last text the server confirmed — what `dirty` compares against. */
  savedMarkdown?: string;

  /** The WIDE stored hit set (24-ish). Never re-sliced by depth. */
  citations: JiraCitation[];
  /** Doc ids the reader has switched OFF. */
  excludeDocIds: string[];

  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  coverage: JiraCoverage | null;
  retrievalCoverage: JiraCoverage | null;
  retrievalQuestion: string;

  view: JiraViewMode;
  /** A blocking error from the GENERATION path (a 400/409/503, a dropped stream,
   *  a failed draft). Rendered in the left column's status line. */
  error?: string;
  /** An error from the RIGHT column's own actions (copy, save). Separate from
   *  `error` because it is rendered where the button that raised it is: a failed
   *  save that only reached the left column read as no failure at all, and it
   *  then popped up in the left column on the next unrelated re-render. */
  rightError?: string;
  /**
   * The unsaved-edits gate is open.
   *
   * A regenerate over a dirty draft used to overwrite the textarea with no
   * warning. The gate is INLINE markup with three explicit buttons rather than a
   * `window.confirm`: a native dialog blocks the event loop, cannot be styled to
   * say which of the two safe paths the reader is choosing, and is invisible to
   * every browser-automation acceptance run.
   */
  dirtyGate?: boolean;
  /** Set alongside `error` on a 409 so the copy can count the slot down. */
  conflictExpiresAtMs?: number;
  copied: boolean;
  saving: boolean;
  /** Transient confirmation under the draft ("Lagret."). */
  savedNote?: string;
  /**
   * "The server holds a newer draft than your unsaved edit."
   *
   * Set by {@link mergeDraftView} instead of overwriting `markdown`: until it is
   * saved, the reader's edit exists in exactly one place — the textarea — so a
   * poll tick that adopted the server's text destroyed work with no warning and
   * no way back. Announcing it is the whole remedy; the reader decides.
   */
  serverNewerNote?: string;
}

export function initialJiraState(): JiraComposerState {
  return {
    templates: [],
    template: "",
    depth: JC_DEFAULT_DEPTH,
    notes: "",
    extra: "",
    running: false,
    polling: false,
    streamed: "",
    source: "notes",
    markdown: "",
    citations: [],
    excludeDocIds: [],
    keyVerdicts: [],
    markdownFlags: [],
    coverage: null,
    retrievalCoverage: null,
    retrievalQuestion: "",
    view: "markdown",
    copied: false,
    saving: false,
  };
}

// ── The decisions ────────────────────────────────────────────────────────────

/**
 * Flip one document's retain toggle.
 *
 * The state holds the EXCLUSION set rather than the retained one because that is
 * what the wire carries: `excludeDocIds` is what a regenerate posts and what
 * `GET /api/jira/draft/:id` answers with, so a retained-set representation would
 * have to be inverted at both ends against a citation list that is only correct
 * once it has loaded.
 */
export function toggleExclusion(excludeDocIds: string[], docId: string): string[] {
  return excludeDocIds.includes(docId)
    ? excludeDocIds.filter((d) => d !== docId)
    : [...excludeDocIds, docId];
}

/** One rendered row of the middle column. */
export interface JiraCitationRow {
  index: number;
  citation: JiraCitation;
  /** Checked ⇒ this source is used by the next generation. */
  retained: boolean;
}

export function citationRows(citations: JiraCitation[], excludeDocIds: string[]): JiraCitationRow[] {
  const excluded = new Set(excludeDocIds);
  return citations.map((citation, index) => ({
    index,
    citation,
    retained: !excluded.has(citation.docId),
  }));
}

export function retainedCount(citations: JiraCitation[], excludeDocIds: string[]): number {
  return citationRows(citations, excludeDocIds).filter((r) => r.retained).length;
}

/**
 * The POST body for the next generation.
 *
 * Two shapes, and the split is the wire's, not a preference: a FIRST draft
 * carries the raw material, a REGENERATE carries the draft id and the exclusion
 * set and **must not carry notes at all** — `parseJiraDraftBody` refuses new
 * notes on a regenerate, because the stored hit set was retrieved for the
 * original raw material. `extra` rides both, since the route reads it on both
 * paths and it is the one steer a reader can usefully change between runs.
 */
export function jiraDraftBody(state: JiraComposerState): Record<string, unknown> {
  if (isRegenerate(state)) {
    return {
      draftId: state.draftId,
      template: state.template,
      depth: state.depth,
      extra: state.extra,
      excludeDocIds: [...state.excludeDocIds],
    };
  }
  return {
    notes: state.notes,
    template: state.template,
    depth: state.depth,
    extra: state.extra,
  };
}

/** Is this draft a turn in a chat thread rather than a paste of raw material? */
export function isThreadDraft(state: JiraComposerState): boolean {
  return state.source === "thread" && !!state.draftId;
}

/**
 * Is this POST a regenerate (an existing draft) rather than a first draft?
 *
 * **The citation count is a `notes`-path test only.** A thread draft's hit set is
 * re-seeded from `research_citations` on every run, so a conversation that has
 * not retrieved yet legitimately has ZERO stored citations — and with the count
 * as the only test, `jiraDraftBody` fell through to the FIRST-DRAFT shape and
 * posted `notes: "fra samtale: <name>"` as raw material. That is a brand-new,
 * notes-sourced draft over a nine-word placeholder: the thread is never asked,
 * the reader's draft id is orphaned, and the result looks like a real task.
 */
export function isRegenerate(state: JiraComposerState): boolean {
  if (!state.draftId) return false;
  return isThreadDraft(state) || state.citations.length > 0;
}

/** Can the **Skriv utkast** button fire? */
export function canSubmit(state: JiraComposerState): boolean {
  if (state.running || state.polling || state.saving) return false;
  if (!state.template) return false;
  // `extra` is gated on BOTH paths — the regenerate branch used to return `true`
  // before either length check ran, so an over-cap steer reached the server and
  // came back as a 400 the reader had no way to predict from the button.
  if (state.extra.length > JIRA_EXTRA_MAX) return false;
  // The NOTES cap is a first-draft cap, because `notes` is a first-draft FIELD:
  // `jiraDraftBody` omits it on a regenerate (the route refuses new notes there —
  // the stored hit set was retrieved for the original raw material). Gating the
  // regenerate on it disabled the button over a value the request cannot carry,
  // on the one path where the page itself tells the reader the notes are locked.
  if (isRegenerate(state)) return true;
  if (state.notes.length > JIRA_NOTES_MAX) return false;
  return state.notes.trim().length > 0;
}

/** Has the reader edited the draft since the last confirmed save? */
export function isDirty(state: JiraComposerState): boolean {
  return state.savedMarkdown !== undefined && state.markdown !== state.savedMarkdown;
}

/**
 * Must a regenerate ask before it overwrites the textarea?
 *
 * The draft the reader has edited exists in exactly one place — this textarea —
 * until it is saved, and a successful regenerate replaces it wholesale. Anything
 * that is not dirty has nothing to lose: the server already holds it.
 *
 * **`answered` is not a nicety.** Discarding writes nothing, so the state is
 * still dirty when the run starts — measured in the browser, **Forkast og
 * generer** closed the gate, called the run, and the run re-opened the gate. The
 * button was inert and the reader had no way forward at all.
 */
export function needsDirtyGate(
  state: JiraComposerState,
  opts: { answered?: boolean } = {},
): boolean {
  if (opts.answered) return false;
  return isDirty(state);
}

/** What answering the gate does, whichever of the three buttons was clicked. */
export function gateAnswerPatch(): Partial<JiraComposerState> {
  return { dirtyGate: false };
}

/**
 * After the gate's **Lagre og generer**: may the run start?
 *
 * Only when the PUT landed — otherwise the save the reader explicitly asked for
 * would be dropped on the floor by the very regenerate they were warned about.
 * The caller repaints on BOTH answers: `false` used to be a bare `return` that
 * left the gate panel standing over a page no longer waiting for an answer.
 */
export function saveThenRunProceeds(state: JiraComposerState): boolean {
  return !state.rightError;
}

/**
 * Is the draft textarea read-only right now?
 *
 * A `?draft=` landing on a row that is still `generating` has nothing to edit —
 * the text arrives when the row settles, and the poll tick that brings it would
 * either overwrite what was typed or (with the guard in {@link mergeDraftView})
 * strand it as a permanent unsaved edit against a draft the reader never wrote.
 */
export function markdownEditDisabled(state: JiraComposerState): boolean {
  return state.polling && state.status === "generating";
}

/** Said in the right column when the server has moved on and the edit was kept. */
export const JC_SERVER_NEWER_NOTE =
  "Serveren har en nyere versjon av utkastet. Endringen din er beholdt — lagre for å overskrive den, eller last siden på nytt for å hente serverens.";

/**
 * Fold a stored row into the page state — the POLL/adopt merge rule.
 *
 * A poll tick is a background event, so this is the same class of rule as the
 * `done`/`citations` stream handlers and carries the same two guards:
 *
 *   · **an EMPTY citation set never replaces a non-empty one** (with its
 *     exclusion set), or a degraded row deletes the very rows the reader needs
 *     in order to switch one back on;
 *   · **`markdown` is never overwritten while the draft is dirty** — that text
 *     exists in exactly one place until it is saved. `savedMarkdown` still moves
 *     to the server's text, so `dirty` keeps telling the truth about what the row
 *     holds, and {@link JC_SERVER_NEWER_NOTE} says so out loud.
 *
 * Returns a PATCH rather than mutating, so the merge is testable without a DOM.
 */
export function mergeDraftView(
  state: JiraComposerState,
  v: JiraDraftView,
): Partial<JiraComposerState> {
  const template = v.template || state.template;
  const incoming = Array.isArray(v.citations) ? v.citations : [];
  const keepCitations = incoming.length === 0 && state.citations.length > 0;
  const serverMarkdown = v.markdown ?? "";
  const keepEdit = isDirty(state) && serverMarkdown !== state.markdown;

  return {
    draftId: v.draftId,
    status: v.status,
    // A row that predates the column (or a degraded payload) reads as `notes` —
    // the shape every rule here already defaults to.
    source: isJiraDraftSource(v.source) ? v.source : "notes",
    threadId: typeof v.threadId === "string" && v.threadId ? v.threadId : undefined,
    threadName: typeof v.threadName === "string" && v.threadName ? v.threadName : undefined,
    template,
    // A stored template the route did not serve (a renamed or removed
    // `jiraTemplate.<id>.md`) is added as an option, so the picker shows the id
    // the POST will actually carry instead of silently displaying the first one.
    templates: withTemplateOption(state.templates, template),
    depth: isJiraDepth(v.depth) ? v.depth : state.depth,
    notes: typeof v.notes === "string" ? v.notes : state.notes,
    extra: typeof v.extra === "string" ? v.extra : state.extra,
    ...(keepEdit ? {} : { markdown: serverMarkdown }),
    savedMarkdown: v.markdown ?? undefined,
    serverNewerNote: keepEdit ? JC_SERVER_NEWER_NOTE : undefined,
    citations: keepCitations ? state.citations : incoming,
    // The toggles reflect the exclusion set the LAST generation ran under —
    // stored on the row for exactly this reason — but they travel WITH the
    // citation set, or a preserved wide set would be paired with the exclusions
    // of the empty one that was refused.
    excludeDocIds: keepCitations
      ? [...state.excludeDocIds]
      : Array.isArray(v.excludeDocIds)
        ? [...v.excludeDocIds]
        : [],
    keyVerdicts: (v.keyVerdicts ?? []) as JiraKeyVerdict[],
    markdownFlags: (v.markdownFlags ?? []) as JiraMarkdownFlag[],
    coverage: v.coverage ?? null,
    retrievalCoverage: v.retrievalCoverage ?? null,
    retrievalQuestion: v.retrievalQuestion ?? "",
    error: v.status === "failed" ? (v.error ?? "Utkastet feilet.") : undefined,
    copied: false,
  };
}

/**
 * The patch every reader-initiated action starts with.
 *
 * ONE spelling, because the clearing rule is the fix: a 409 countdown, an "ukjent
 * utkast" and a failed save all used to stay on screen until something unrelated
 * re-rendered over them — so the page asserted a stale failure about work that
 * had since succeeded. Submit, regenerate, copy, save and typing after a refusal
 * all clear both error channels.
 */
export function beginActionPatch(): Partial<JiraComposerState> {
  return {
    error: undefined,
    rightError: undefined,
    conflictExpiresAtMs: undefined,
    savedNote: undefined,
  };
}

/** What a non-2xx poll tick should do. */
export interface JiraPollTickAction {
  stop: boolean;
  error?: string;
}

/**
 * A poll tick that did not answer 200.
 *
 * Every non-200 used to be swallowed and retried until the 13-minute cap, so a
 * draft deleted upstream (or an id that never existed) was polled ~300 times
 * before the page said anything. A 4xx is an answer — the row is not there and
 * will not appear — while a 5xx or a transport failure is the server having a
 * moment, which the row outlives. `status === 0` is this module's spelling of
 * "the fetch threw".
 */
export function pollTickAction(status: number): JiraPollTickAction {
  if (status === 404) return { stop: true, error: "ukjent utkast" };
  if (status >= 400 && status < 500) {
    return { stop: true, error: `Utkastet kunne ikke hentes (HTTP ${status}).` };
  }
  return { stop: false };
}

/**
 * What to say when the stream drops.
 *
 * With a draft id the row is the record and the page fetches it. WITHOUT one, no
 * `draft` frame ever arrived — nothing was created, there is nothing to fetch,
 * and the old copy ("henter utkastet fra serveren") described work that does not
 * exist while the reader waited for a draft that was never going to appear.
 */
export function streamDropMessage(hasDraftId: boolean): string {
  return hasDraftId
    ? "Forbindelsen falt — henter utkastet fra serveren."
    : "Forbindelsen falt før utkastet ble startet — ingenting ble generert. Send inn på nytt.";
}

/**
 * Make sure the picker can show a template id the route did not serve.
 *
 * A stored draft carries the template it was generated with, and a bot's
 * `jiraTemplate.<id>.md` can be renamed or removed between the draft and the
 * reload. Restoring the id into `state.template` without an option for it left
 * the `<select>` showing the FIRST option while the POST carried the stored one —
 * a control that says something different from what it does.
 */
export function withTemplateOption(
  templates: JiraTemplateOption[],
  id: string,
): JiraTemplateOption[] {
  if (!id || templates.some((t) => t.id === id)) return templates;
  return [...templates, { id, label: id }];
}

/**
 * Defence in depth on every `href` this page renders from data.
 *
 * The urls come from huginn documents and from `verify-keys`, neither of which
 * is reader-controlled, and `toJiraCitations` already drops `file://` — so this
 * is a second gate, not the first. It is here because the cost is one line and
 * the failure mode (a `javascript:` url in a link the reader is invited to click)
 * is not one the escaping catches.
 */
export function safeExternalHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}

/** One character counter. Red past the cap — the button is off for that reason. */
export function charCountHtml(length: number, max: number): string {
  return `<span class="${length > max ? "jc-over" : ""}">${length} / ${max}</span>`;
}

/** Why the button is off, when it is off for a reason the reader can fix. */
export function submitBlockedReason(state: JiraComposerState): string | undefined {
  if (state.extra.length > JIRA_EXTRA_MAX) {
    return `Ekstra instruks er ${state.extra.length} tegn — grensen er ${JIRA_EXTRA_MAX}.`;
  }
  // Mirrors `canSubmit`: on a regenerate the notes are locked and unsent, so the
  // cap cannot be the reason for anything.
  if (isRegenerate(state)) return undefined;
  if (state.notes.length > JIRA_NOTES_MAX) {
    return `Råmaterialet er ${state.notes.length} tegn — grensen er ${JIRA_NOTES_MAX}.`;
  }
  if (!state.notes.trim()) return "Lim inn råmateriale først.";
  return undefined;
}

export type JiraNoticeTone = "warn" | "bad";

export interface JiraCoverageNotice {
  tone: JiraNoticeTone;
  text: string;
}

/**
 * Which coverage sentence the middle column shows — the PAIR, never the derived
 * verdict alone.
 *
 * `jiraCoverageMessage` on the server takes only the derived verdict, and a
 * derived `no_hits` has two causes that must not be told the same way:
 *
 *   · retrieval itself found nothing (`retrievalCoverage` is `no_hits`, or null
 *     on a row whose retrieval never landed) ⇒ the corpus-had-nothing copy;
 *   · retrieval found hits and the reader switched them all off
 *     (`retrievalCoverage` is `answer`/`low_confidence`) ⇒ say THAT, because
 *     telling someone who just unticked 24 rows that jira-issues covered nothing
 *     is a false statement about the corpus.
 *
 * `answer` shows nothing at all: a grounded draft needs no banner.
 *
 * `unreachable` is a FOURTH line and is checked before everything else: it is the
 * one state where nothing can be said about the corpus at all, and it is the one
 * state that is worth retrying unchanged. `effectiveCoverage` already passes it
 * through the derived verdict, so both halves of the pair carry it.
 */
export function jiraCoverageNotice(
  retrievalCoverage: JiraCoverage | null | undefined,
  coverage: JiraCoverage | null | undefined,
): JiraCoverageNotice | null {
  if (!coverage || coverage === "answer") return null;
  if (coverage === "unreachable" || retrievalCoverage === "unreachable") {
    return { tone: "bad", text: JIRA_UNREACHABLE_MESSAGE };
  }
  if (coverage === "low_confidence") return { tone: "warn", text: JIRA_LOW_CONFIDENCE_MESSAGE };
  // coverage === "no_hits"
  if (retrievalCoverage && retrievalCoverage !== "no_hits") {
    return { tone: "bad", text: JIRA_ALL_EXCLUDED_MESSAGE };
  }
  return { tone: "bad", text: JIRA_NO_HITS_MESSAGE };
}

export interface JiraKeyChip {
  key: string;
  cls: string;
  /** Rendered beside the key; empty for the ordinary verified case. */
  note: string;
  /** `title=` — the long form of the same verdict. */
  hint: string;
}

/**
 * How one Jira key renders.
 *
 * THREE states, deliberately, and the amber one carries the sentence the plan
 * wrote for it: a key present only in the notes is the reader's own claim, not
 * something retrieval confirmed. `resolved` is a SEPARATE axis — "does the issue
 * exist" — and `undefined` means the lookup was unavailable, which must never
 * read as a fabrication verdict.
 */
export function keyVerdictChip(v: JiraKeyVerdict): JiraKeyChip {
  if (v.state === "verified") {
    return { key: v.key, cls: "jc-key jc-key-ok", note: "", hint: "Hentet i retrieval — saken finnes." };
  }
  if (v.state === "notes") {
    const exists =
      v.resolved === true
        ? " Nøkkelen finnes i jira-issues, men retrieval hentet den ikke."
        : v.resolved === false
          ? " Nøkkelen finnes ikke i jira-issues — sannsynligvis en skrivefeil i notatene."
          : " Oppslaget mot jira-issues var utilgjengelig.";
    return {
      key: v.key,
      cls: "jc-key jc-key-notes",
      note: "fra notatene — ikke bekreftet",
      hint: `Bare i råmaterialet ditt, ikke i det som ble hentet.${exists}`,
    };
  }
  return {
    key: v.key,
    cls: "jc-key jc-key-unknown",
    note: "ukjent",
    hint: "Hverken hentet i retrieval eller nevnt i notatene — kontroller den før du oppretter saken.",
  };
}

export interface JiraKeyCounts {
  verified: number;
  notes: number;
  unknown: number;
}

export function keyVerdictCounts(verdicts: JiraKeyVerdict[]): JiraKeyCounts {
  return {
    verified: verdicts.filter((v) => v.state === "verified").length,
    notes: verdicts.filter((v) => v.state === "notes").length,
    unknown: verdicts.filter((v) => v.state === "unknown").length,
  };
}

/**
 * Stop polling?
 *
 * `ready` and `failed` are the two terminal statuses; `generating` (and an absent
 * status, which is what a degraded payload looks like) keeps the loop running.
 * Written as an explicit terminal list rather than `!== "generating"` so a status
 * the server adds later cannot silently stop the poller.
 */
export function shouldStopPolling(status: JiraDraftStatus | string | undefined): boolean {
  return status === "ready" || status === "failed";
}

/**
 * The 409 copy.
 *
 * The server's own `error` sentence leads — it names the surface ("Det skrives
 * allerede et utkast for dette råmaterialet") — and the countdown is appended,
 * because the whole reason this page streams with `fetch` rather than an
 * EventSource is that `expiresAtMs` rides the body of a NON-200, which an
 * EventSource never surfaces.
 */
export function jiraConflictCopy(
  serverError: string | undefined,
  expiresAtMs: number,
  now: number,
): string {
  const lead = serverError?.trim() || "Det skrives allerede et likt utkast.";
  const secs = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  if (secs <= 0) return `${lead} Slotten skulle vært ledig nå — prøv igjen.`;
  return `${lead} Plassen frigis om ~${secs} s.`;
}

/** One line of the markdown-flag warn list. Flagged, never silently rewritten. */
export function markdownFlagLine(flag: JiraMarkdownFlag): string {
  const what: Record<string, string> = {
    html: "rå HTML",
    "wiki-markup": "wiki-markup",
    "task-list": "avkryssingsliste (- [ ])",
    "emoji-shortcode": "emoji-kode (:navn:)",
  };
  return `Linje ${flag.line}: ${what[flag.kind] ?? flag.kind} — «${flag.sample}». Jira konverterer ikke dette ved innliming.`;
}

// ── Markup ───────────────────────────────────────────────────────────────────

/**
 * LEFT: the action row, then the raw material and the two dials.
 *
 * **The buttons are at the TOP and stay there.** They used to sit under the
 * textarea, the picker, the depth radios and the extra steer — measured at
 * 1440×950 with a 1.4 KB note pasted, **Skriv utkast** and the status line it
 * writes into were both below the fold, so the reader clicked, saw nothing move,
 * and scrolled to find out whether anything had happened.
 */
export function jiraLeftHtml(state: JiraComposerState): string {
  const templates = state.templates.length
    ? state.templates
        .map(
          (t) =>
            `<option value="${esc(t.id)}"${t.id === state.template ? " selected" : ""}>${esc(t.label)}</option>`,
        )
        .join("")
    : `<option value="">(ingen maler)</option>`;

  const depths = JIRA_DEPTHS.map(
    (d) => `<label class="jc-depth${d.id === state.depth ? " jc-depth-on" : ""}">
      <input type="radio" name="jcDepth" ${JC_DEPTH_ATTR}="${esc(d.id)}" value="${esc(d.id)}"${d.id === state.depth ? " checked" : ""}>
      <span class="jc-depth-name">${esc(d.label)}</span>
      <span class="jc-depth-hint">${esc(d.hint)}</span>
    </label>`,
  ).join("");

  const regen = isRegenerate(state);
  const blocked = submitBlockedReason(state);
  const fromThread = isThreadDraft(state);

  // **A thread draft has no raw material to show.** `state.notes` is the
  // `fra samtale: <name>` placeholder the server stores because the column is NOT
  // NULL — rendering it in the textarea offered nine words of server bookkeeping
  // as if it were the reader's own pasted note, editable and about to be sent.
  const rawMaterial = fromThread
    ? jiraThreadSourceHtml(state)
    : `
    <h2 class="jc-h">Råmateriale</h2>
    <p class="jc-sub">Møtenotat, Slack-tråd, «det vi ble enige om i går». Hentes over
      <code>jira-issues</code>, <code>melosys-confluence-v3</code> og <code>nav-wiki</code>${
        state.bot ? ` på <code>${esc(state.bot)}</code>` : ""
      }.</p>
    <textarea id="${JC_NOTES_ID}" class="jc-notes" rows="16" spellcheck="false"
      placeholder="Lim inn notatene her…">${esc(state.notes)}</textarea>
    <div class="jc-charcount" id="${JC_NOTES_COUNT_ID}">${charCountHtml(state.notes.length, JIRA_NOTES_MAX)}</div>`;

  return `
    ${fromThread ? jiraThreadBannerHtml(state) : ""}
    <div class="jc-actions">
      <button id="${JC_SUBMIT_ID}" class="jc-primary" type="button"${canSubmit(state) ? "" : " disabled"}>
        ${state.running ? "Skriver…" : regen ? "Generer på nytt" : "Skriv utkast"}
      </button>
      <div class="jc-status" id="${JC_STATUS_ID}">${statusLineHtml(state)}</div>
      <p class="jc-note" id="${JC_BLOCKED_ID}"${blocked ? "" : " hidden"}>${blocked ? esc(blocked) : ""}</p>
    </div>
${rawMaterial}

    <label class="jc-lab" for="${JC_TEMPLATE_ID}">Mal</label>
    <select id="${JC_TEMPLATE_ID}" class="jc-select">${templates}</select>
    ${state.templatesError ? `<p class="jc-err">${esc(state.templatesError)}</p>` : ""}

    <div class="jc-lab">Teknisk dybde</div>
    <div class="jc-depths">${depths}</div>

    <label class="jc-lab" for="${JC_EXTRA_ID}">Ekstra instruks <span class="jc-opt">(valgfritt)</span></label>
    <textarea id="${JC_EXTRA_ID}" class="jc-extra" rows="2" spellcheck="false"
      placeholder="f.eks. «fokuser på migreringsrisikoen»">${esc(state.extra)}</textarea>
    <div class="jc-charcount" id="${JC_EXTRA_COUNT_ID}">${charCountHtml(state.extra.length, JIRA_EXTRA_MAX)}</div>
    ${
      fromThread
        ? `<p class="jc-note">Mal, dybde og ekstra instruks gjelder fra og med neste generering — de sendes med
             som en ny tur i samtalen.</p>`
        : regen
          ? `<p class="jc-note">Råmaterialet er låst til dette utkastet — treffene ble hentet for akkurat denne teksten.
             Endre notatene ved å starte et nytt utkast (åpne <code>/jira</code> uten <code>?draft=</code>).</p>`
          : ""
    }`;
}

/**
 * The chat deep link for a thread — `handleDeepLink`'s own shape.
 *
 * `user` is deliberately omitted: this page never knows which user owns the
 * thread, and the chat page resolves one anyway (URL preference → the bot's
 * `bot_default_user` → the sole user). `bot` and `thread` are all the deep link
 * actually needs — `selectBot(bot, thread)` auto-selects it.
 *
 * `undefined` when the bot has not resolved yet (the templates fetch is what
 * carries it) or there is no thread: a link that cannot be built is not rendered,
 * rather than rendered pointing at `/chat?bot=&thread=`.
 */
export function jiraChatUrl(bot: string | undefined, threadId: string | undefined): string | undefined {
  if (!bot || !threadId) return undefined;
  return `/chat?bot=${encodeURIComponent(bot)}&thread=${encodeURIComponent(threadId)}`;
}

/** The name to call the conversation. Falls back to the thread id — a deleted
 *  thread row leaves `threadName` null, and "samtalen «»" says nothing. */
export function threadDraftLabel(state: JiraComposerState): string {
  return state.threadName || state.threadId || "samtalen";
}

/**
 * The banner that tells the reader where this draft came from.
 *
 * It leads the LEFT column, above the action row, because everything below it
 * behaves differently: the raw material is a conversation, the hit set is what
 * that conversation found, and «Generer på nytt» writes another turn into it.
 */
export function jiraThreadBannerHtml(state: JiraComposerState): string {
  const href = jiraChatUrl(state.bot, state.threadId);
  const link = href
    ? ` <a class="jc-threadlink" href="${esc(href)}" target="_blank" rel="noopener">Juster i samtalen →</a>`
    : "";
  return `<div class="jc-banner jc-banner-thread">Utkast fra samtalen «${esc(
    threadDraftLabel(state),
  )}» — kildene er det samtalen fant.${link}</div>`;
}

/** What stands where the raw-material textarea stands on a notes draft. */
export function jiraThreadSourceHtml(state: JiraComposerState): string {
  const href = jiraChatUrl(state.bot, state.threadId);
  const name = esc(threadDraftLabel(state));
  return `
    <h2 class="jc-h">Kilde</h2>
    <p class="jc-threadname">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${name}</a>` : name}</p>
    <p class="jc-sub">Råmaterialet er selve samtalen — den har allerede hentet, diskutert og rettet.
      Legg til det som mangler i chatten, og generer på nytt herfra.</p>`;
}

/**
 * The middle column's provenance line.
 *
 * On a notes draft it says what was SEARCHED (a condensed question). A thread
 * draft condenses nothing — `retrieval_question` holds the same
 * `fra samtale: <name>` placeholder as `notes`, and printing that after
 * «Søkte etter:» claimed a search that never ran.
 */
export function jiraSearchedLineHtml(state: JiraComposerState): string {
  if (isThreadDraft(state)) {
    return `<p class="jc-searched">Kilder fra samtalen «${esc(threadDraftLabel(state))}».</p>`;
  }
  return state.retrievalQuestion
    ? `<p class="jc-searched">Søkte etter: ${esc(state.retrievalQuestion)}</p>`
    : "";
}

/** The one line that says what the page is doing right now. */
export function statusLineHtml(state: JiraComposerState): string {
  const parts: string[] = [];
  if (state.running) parts.push(`<span class="jc-run">${esc(phaseLabel(state.phase))}</span>`);
  else if (state.polling) parts.push(`<span class="jc-run">Venter på utkastet…</span>`);
  if (state.error) parts.push(`<span class="jc-err">${esc(state.error)}</span>`);
  return parts.join(" ");
}

/** Server phase names → what the reader is actually waiting for. */
export function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case "condensing":
      return "Koker notatene ned til ett søk…";
    case "retrieving":
      return "Søker i de tre samlingene…";
    case "regenerating":
      return "Skriver på nytt fra de valgte kildene…";
    case "writing":
      return "Skriver saken…";
    default:
      return "Jobber…";
  }
}

/** MIDDLE: the retrieved hits, always the stored wide set. */
export function jiraCitationsHtml(state: JiraComposerState): string {
  const rows = citationRows(state.citations, state.excludeDocIds);
  const kept = rows.filter((r) => r.retained).length;
  const notice = jiraCoverageNotice(state.retrievalCoverage, state.coverage);

  const head = `<h2 class="jc-h">Hentede kilder ${
    state.citations.length ? `<span class="jc-count">${kept} av ${state.citations.length} på</span>` : ""
  }</h2>`;

  const question = jiraSearchedLineHtml(state);

  const noticeHtml = notice
    ? `<div class="jc-banner jc-banner-${notice.tone}">${esc(notice.text)}</div>`
    : "";

  if (rows.length === 0) {
    return `${head}${question}${noticeHtml}
      <p class="jc-empty">${
        state.running || state.polling
          ? "Henter…"
          : isThreadDraft(state)
            ? "Samtalen hentet ingen kilder — utkastet er skrevet fra det som ble sagt i chatten."
            : "Ingen kilder ennå. Skriv et utkast, så vises hele det lagrede trefflista her."
      }</p>`;
  }

  // A toggle clicked mid-run was silently discarded — the run that is streaming
  // was launched with the exclusion set as it stood, and the `done` frame
  // re-renders the column from that. Disabled says so.
  const busy = state.running || state.polling;

  const list = rows
    .map((r) => {
      const c = r.citation;
      const rel = Number.isFinite(c.relevance) ? c.relevance.toFixed(2) : "";
      const href = safeExternalHref(c.url);
      const link = href
        ? ` <a class="jc-cite-src" href="${esc(href)}" target="_blank" rel="noopener">↗</a>`
        : "";
      return `<div class="jc-cite${r.retained ? "" : " jc-cite-off"}">
        <label class="jc-cite-toggle" title="Av ⇒ kilden utelates fra neste generering">
          <input type="checkbox" ${JC_DOC_ATTR}="${r.index}"${r.retained ? " checked" : ""}${busy ? " disabled" : ""}>
        </label>
        <div class="jc-cite-body">
          <div class="jc-cite-head">
            <span class="jc-badge">${esc(c.badge)}</span>
            <button type="button" class="jc-cite-title" ${JC_OPEN_ATTR}="${r.index}"
              title="Åpne dokumentet">${esc(c.key ? `${c.key} — ${c.title}` : c.title)}</button>${link}
            <span class="jc-rel" title="Relevans">${esc(rel)}</span>
          </div>
          ${c.snippet ? `<p class="jc-snip">${esc(c.snippet)}</p>` : ""}
        </div>
      </div>`;
    })
    .join("");

  // **The same gate as the left column's button**, `canSubmit` — which already
  // covers running/polling/saving (a PUT in flight is about to answer with
  // verdicts and flags for text a regenerate would have replaced). Gating this
  // one on busy ALONE left it live whenever `canSubmit` was false for any other
  // reason — an over-cap `extra`, no resolved template — and the click was a
  // silent no-op: `runDraft` returns immediately and nothing repaints.
  const canRun = canSubmit(state);
  const regenBlocked = submitBlockedReason(state);
  const regenBtn = `<button id="${JC_REGEN_ID}" class="jc-secondary" type="button"${
    canRun ? "" : " disabled"
  }>Generer på nytt</button>`;

  return `${head}${question}${noticeHtml}
    <div class="jc-citelist">${list}</div>
    <div class="jc-citefoot">${regenBtn}
      <span class="jc-note">Slå av kilder du ikke vil ha med, og generer på nytt — ingen nye søk kjøres.</span>
    </div>
    <p class="jc-note jc-err" id="${JC_REGEN_BLOCKED_ID}"${regenBlocked ? "" : " hidden"}>${
      regenBlocked ? esc(regenBlocked) : ""
    }</p>`;
}

/** RIGHT: the draft itself. */
export function jiraDraftHtml(state: JiraComposerState): string {
  const counts = keyVerdictCounts(state.keyVerdicts);
  const idLine = state.draftId
    ? `<span class="jc-draftid" title="Utkastets id">${esc(state.draftId)}</span>`
    : `<span class="jc-draftid jc-dim">ingen utkast ennå</span>`;
  const statusChip = state.status
    ? `<span class="jc-chip jc-chip-${esc(state.status)}">${esc(draftStatusLabel(state.status))}</span>`
    : "";
  const keyLine = state.keyVerdicts.length
    ? `<span class="jc-keycount">${counts.verified} bekreftet · ${counts.notes} fra notatene · ${counts.unknown} ukjent</span>`
    : "";

  const flags = state.markdownFlags.length
    ? `<div class="jc-banner jc-banner-warn"><strong>Markdown Jira ikke konverterer:</strong>
        <ul>${state.markdownFlags.map((f) => `<li>${esc(markdownFlagLine(f))}</li>`).join("")}</ul></div>`
    : "";

  const chips = state.keyVerdicts.length
    ? `<div class="jc-keys">${state.keyVerdicts
        .map((v) => {
          const chip = keyVerdictChip(v);
          const inner = chip.note ? `${esc(chip.key)} <em>${esc(chip.note)}</em>` : esc(chip.key);
          const href = safeExternalHref(v.url);
          return href
            ? `<a class="${chip.cls}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(chip.hint)}">${inner}</a>`
            : `<span class="${chip.cls}" title="${esc(chip.hint)}">${inner}</span>`;
        })
        .join("")}</div>`
    : "";

  // While a run streams, the live text REPLACES the body — but `state.markdown`
  // is deliberately left alone underneath it, so a failed regenerate leaves the
  // previous draft intact rather than wiping a task the reader never copied.
  const body = state.running && state.streamed
    ? `<pre class="jc-stream">${esc(state.streamed)}</pre>`
    : state.view === "preview"
      ? `<div class="jc-preview markdown-body" id="${JC_PREVIEW_ID}"></div>`
      : `<textarea id="${JC_MARKDOWN_ID}" class="jc-md" spellcheck="false"${
          markdownEditDisabled(state) ? " disabled" : ""
        }
           placeholder="Utkastet vises her.">${esc(state.markdown)}</textarea>`;

  const dirty = isDirty(state);

  // The gate, INLINE and with both safe paths spelled out — see `dirtyGate`. It
  // is rendered above the draft body so it cannot be scrolled past, and the
  // regenerate it stands in front of does not start until one of these is clicked.
  const gate = state.dirtyGate
    ? `<div class="jc-gate">
        <p class="jc-gate-lead">Du har ulagrede endringer.</p>
        <p class="jc-note">En ny generering erstatter teksten under. Lagre den først, eller forkast den.</p>
        <div class="jc-gate-buttons">
          <button type="button" id="${JC_GATE_SAVE_ID}" class="jc-secondary">Lagre og generer</button>
          <button type="button" id="${JC_GATE_DISCARD_ID}" class="jc-secondary">Forkast og generer</button>
          <button type="button" id="${JC_GATE_CANCEL_ID}" class="jc-secondary">Avbryt</button>
        </div>
      </div>`
    : "";

  return `
    <div class="jc-drafthead">
      <h2 class="jc-h">Utkast</h2>
      ${statusChip}${idLine}${keyLine}
    </div>
    ${flags}
    <div class="jc-switch">
      <button type="button" ${JC_VIEW_ATTR}="markdown" class="jc-tab${state.view === "markdown" ? " jc-tab-on" : ""}"
        aria-pressed="${state.view === "markdown"}">Markdown</button>
      <button type="button" ${JC_VIEW_ATTR}="preview" class="jc-tab${state.view === "preview" ? " jc-tab-on" : ""}"
        aria-pressed="${state.view === "preview"}">Forhåndsvisning</button>
      <span class="jc-spacer"></span>
      <button type="button" id="${JC_COPY_ID}" class="jc-secondary"${state.markdown ? "" : " disabled"}>${
        state.copied ? "✓ Kopiert" : "Kopier markdown"
      }</button>
      <button type="button" id="${JC_SAVE_ID}" class="jc-secondary"${
        // **Off while a generation runs.** With it live, a PUT of the OLD text
        // could land after the new draft settled — and the 200 carries verdicts
        // and flags describing the previous text, which then sat under the new
        // one as if they described it.
        state.draftId && state.markdown && !state.saving && !state.running && !state.polling
          ? ""
          : " disabled"
      }>${state.saving ? "Lagrer…" : "Lagre utkast"}</button>
    </div>
    <p class="jc-note jc-dirty" id="${JC_DIRTY_ID}"${dirty ? "" : " hidden"}>Ulagrede endringer.</p>
    ${state.serverNewerNote ? `<p class="jc-note jc-server-newer">${esc(state.serverNewerNote)}</p>` : ""}
    <p class="jc-err" id="${JC_RIGHT_ERROR_ID}"${state.rightError ? "" : " hidden"}>${
      state.rightError ? esc(state.rightError) : ""
    }</p>
    ${state.savedNote ? `<p class="jc-note jc-saved">${esc(state.savedNote)}</p>` : ""}
    ${gate}
    ${body}
    ${chips}`;
}

export function draftStatusLabel(status: JiraDraftStatus): string {
  switch (status) {
    case "generating":
      return "skrives";
    case "ready":
      return "klar";
    default:
      return "feilet";
  }
}
