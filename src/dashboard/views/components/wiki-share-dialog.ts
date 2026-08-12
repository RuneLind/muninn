/**
 * The share dialog's PURE half — ids, markup, labels and the two decisions worth
 * testing without a browser (what the POST body says, and when the Slack rendering
 * has outgrown a Slack message).
 *
 * Split for the reason `wiki-chat-target.ts` is: the DOM half (`share-dialog.ts`)
 * cannot be unit-tested, and everything here can. It is also import-safe — no DOM
 * access at module load — so BOTH consumers can reach it: the reader's own bundle
 * imports it directly, and the standalone `share-dialog-browser.ts` bundle (which
 * `/summaries` will load) publishes the DOM half on `globalThis`.
 *
 * **Exactly one copy per page.** A page must either import the DOM module or load
 * the standalone bundle and call the global — never both. Two copies means two
 * module states, two listener registrations and a dialog whose Generate button and
 * whose render disagree about which state they are looking at. The /wiki page
 * imports; nothing on it injects the standalone bundle.
 */

import { escHtml as esc } from "./escape.ts";
import {
  SHARE_LANGS,
  SLACK_PASTE_MAX,
  SHARE_EXTRA_MAX,
  SHARE_PROMPT_OVERRIDE_MAX,
  type ShareDonePayload,
  type ShareLang,
} from "../../../share/wire.ts";

// ── Ids and attribute hooks ──────────────────────────────────────────────────
// Each is shared by the render, the click delegation and the tests, so the three
// cannot drift (the `DISCUSS_ARTICLE_BTN_ID` precedent — a button missing from the
// click-away `inOpener` test dismisses the dialog it just opened).

export const SHARE_BTN_ID = "wikiShareBtn";
export const SHARE_DIALOG_ID = "wikiShare";
export const SHARE_SCRIM_ID = "wikiShareScrim";
export const SHARE_CLOSE_ID = "wikiShareClose";
export const SHARE_PRESET_ID = "wikiSharePreset";
export const SHARE_PROMPT_ID = "wikiSharePrompt";
/** The `<details>` the prompt textarea lives in — its open state is STATE-held
 *  (`promptOpen`), never left to the DOM: the panel re-renders whenever the
 *  "· edited" badge flips, which is mid-typing, and a DOM-only `open` collapses
 *  the textarea under the reader's hands on the first keystroke. That state is
 *  written SYNCHRONOUSLY from the activation click, not from `toggle` — see
 *  `notePromptToggle` in `share-dialog.ts` for the race that forced it. */
export const SHARE_PROMPT_PANEL_ID = "wikiSharePromptPanel";
/**
 * The prompt disclosure's `<summary>` — the SAME focus contract the chip rows
 * carry, and for the same measured reason.
 *
 * A `<summary>` is focusable, so a keyboard reader lands on it; it was the only
 * focusable control in the panel WITHOUT an id, so `captureFocus` (which tracks by
 * id) returned null for it. Any repaint that arrived while it held focus — the 1s
 * 409 countdown, a stream frame — therefore detached it unrecoverably, and
 * `rehomeFocus`'s "nothing meaningful holds focus" floor relocated the reader onto
 * the FIRST focusable node in the panel: `#wikiShareClose`. The next Enter/Space
 * dismissed the dialog.
 */
export const SHARE_PROMPT_TOGGLE_ID = "wikiSharePromptToggle";
export const SHARE_EXTRA_ID = "wikiShareExtra";
export const SHARE_GENERATE_ID = "wikiShareGen";
export const SHARE_COPY_ID = "wikiShareCopy";
export const SHARE_RESET_ID = "wikiSharePromptReset";
/** Retry on a FAILED preset fetch. Without it the dialog is a dead end: the
 *  loading branch renders the error in place of the spinner and nothing in the
 *  panel can re-run the fetch, so a blip means close-and-reopen. */
export const SHARE_PRESET_RETRY_ID = "wikiSharePresetRetry";
/** `data-` hooks for the two chip rows (language, format tab). */
export const SHARE_LANG_ATTR = "data-share-lang";
export const SHARE_TAB_ATTR = "data-share-tab";
/**
 * Both chip rows carry DETERMINISTIC ids, and that is a focus contract rather
 * than decoration: the panel's whole `innerHTML` is replaced on every change, and
 * `captureFocus`/`restoreFocus` re-find the focused element **by id**. Id-less
 * `<button>`s therefore could not be tracked across the swap — measured, a chip or
 * tab click left `document.activeElement` on `<body>`, outside a panel that claims
 * `aria-modal="true"`. The id survives the repaint because it is derived from the
 * chip's own value, not from its position.
 */
export const SHARE_LANG_ID_PREFIX = "wikiShareLang-";
export const SHARE_TAB_ID_PREFIX = "wikiShareTab-";
export function shareLangChipId(lang: string): string {
  return SHARE_LANG_ID_PREFIX + lang;
}
export function shareTabId(tab: ShareTab): string {
  return SHARE_TAB_ID_PREFIX + tab;
}

/** The three formats v1 ships. **Telegram is deliberately absent** (product
 *  decision, 2026-08-11): there is no send action yet, and a disabled placeholder
 *  tab advertises a feature the reader cannot use. */
export type ShareTab = "slack" | "email" | "markdown";
export const SHARE_TABS: readonly { id: ShareTab; label: string }[] = [
  { id: "slack", label: "Slack" },
  { id: "email", label: "Email" },
  { id: "markdown", label: "Markdown" },
];

/** One preset as `GET /api/wiki/share/presets` serves it. */
export interface SharePresetOption {
  id: string;
  label: string;
  content: string;
}

/**
 * WHERE a share posts, and which identity fields it carries.
 *
 * The dialog was built for one surface (`POST /api/wiki/share`, identified by
 * `{wiki, page}`); `/summaries` shares a capture document, identified by
 * `{source, docId}` against a different endpoint. Rather than teach the dialog
 * about two surfaces, the surface tells the dialog: a target names the two URLs
 * and the identity fields, and everything else — presets, language, the prompt
 * panel, the caps, the three tabs — is shared verbatim.
 *
 * Additive on purpose: the wiki call sites pass no target and go through
 * {@link wikiShareTarget}, which reproduces exactly the URLs and body fields
 * they used before.
 */
export interface ShareTarget {
  /** The POST endpoint the generate call streams from. */
  endpoint: string;
  /** The preset-list URL (already carrying whatever query it needs). */
  presetsUrl: string;
  /** Merged into the POST body — the surface's identity of "what to share". */
  fields: Record<string, string>;
  /** The three strings that NAME what is being shared. */
  copy: ShareSurfaceCopy;
}

/**
 * The dialog's surface-specific nouns.
 *
 * Three of its sentences say "page" and "wiki", which is true on the reader and
 * false on `/summaries`, where the thing being shared is a capture document that
 * belongs to no wiki. They ride the TARGET rather than being branched on inside
 * the renderer: the surface already tells the dialog where to post, and telling
 * it what to call the thing in the same breath keeps the dialog itself free of
 * any knowledge that there is more than one surface.
 *
 * Only the strings that name a surface are here. Everything else — the caps, the
 * empty-prompt refusal, the Slack budget warning — is the same sentence
 * everywhere and stays where it is written.
 */
export interface ShareSurfaceCopy {
  /** Shown when the resolved preset list is EMPTY. */
  noPresets: string;
  /** The 409's lead sentence; {@link shareConflictCopy} appends the deadline. */
  conflictLead: string;
  /** Escape while a run is in flight — the client-side cancel. */
  stopped: string;
}

/** The /wiki wording. Byte-identical to what PR B hard-coded, and the DEFAULT
 *  for a state carrying no target at all. */
export const WIKI_SHARE_COPY: ShareSurfaceCopy = {
  noPresets: "This wiki offers no share presets.",
  conflictLead: "A share is already running for this page.",
  stopped: "Stopped. The page stays reserved until the run on the server finishes.",
};

/** The /summaries wording — a capture document out of an archive, no wiki. */
export const SUMMARY_SHARE_COPY: ShareSurfaceCopy = {
  noPresets: "This archive offers no share presets.",
  conflictLead: "A share is already running for this document.",
  stopped: "Stopped. The document stays reserved until the run on the server finishes.",
};

/** The /wiki surface's target. Byte-identical to what PR B hard-coded. */
export function wikiShareTarget(wiki: string, page: string): ShareTarget {
  return {
    endpoint: "/api/wiki/share",
    presetsUrl: "/api/wiki/share/presets" + (wiki ? "?wiki=" + encodeURIComponent(wiki) : ""),
    fields: { wiki, page },
    copy: WIKI_SHARE_COPY,
  };
}

/** The /summaries surface's target. `source` + `docId`, never a collection —
 *  which collection backs a source is a server-side registration detail, and
 *  the two names diverge (`x-article` → `x-articles`). */
export function summaryShareTarget(source: string, docId: string): ShareTarget {
  return {
    endpoint: "/api/summaries/share",
    presetsUrl: "/api/summaries/share/presets",
    fields: { source, docId },
    copy: SUMMARY_SHARE_COPY,
  };
}

/**
 * The /summaries target as a browser-script EXPRESSION, with the two identity
 * values supplied as JS the page evaluates at click time.
 *
 * `/summaries` composes template-string scripts and cannot import, so it used to
 * read `.endpoint`/`.presetsUrl` off the builder and then hand-write
 * `fields: { source, docId }` in the script — i.e. the field NAMES had two
 * spellings, one of which the route tests pin and one of which nothing did. A
 * rename would have split the wire silently. Serializing the builder's own
 * output and substituting only the VALUES leaves exactly one authority for every
 * key, `copy` included.
 */
const SHARE_SCRIPT_SLOT_SOURCE = "__share_source_slot__";
const SHARE_SCRIPT_SLOT_DOC_ID = "__share_doc_id_slot__";
export function summaryShareTargetScript(sourceExpr: string, docIdExpr: string): string {
  const slots = new Map([
    [JSON.stringify(SHARE_SCRIPT_SLOT_SOURCE), sourceExpr],
    [JSON.stringify(SHARE_SCRIPT_SLOT_DOC_ID), docIdExpr],
  ]);
  // The sentinels cannot occur in a URL or a copy string, and `JSON.stringify`
  // spells them identically here and in the serialized target — but the
  // substitution is exact because it is ONE pass, not two: sequential
  // `split`/`join`s re-scan the text the previous pass inserted, so an argument
  // expression that itself contained the other slot's sentinel corrupted the
  // output. The sentinels carry no regex metacharacters (`[A-Za-z_]` plus the
  // quotes), so they go into the alternation as-is, and a replacement FUNCTION
  // is inserted verbatim (no `$&` expansion in the caller's expression).
  //
  // `<` is escaped first, and only in the serialized JSON — never in the
  // caller's expressions, where `<` would not be a comparison operator.
  // This string is interpolated into a page `<script>` block, and `<` can only
  // occur inside a JSON string literal, where `<` is the same character:
  // a future copy string containing `</script>` cannot break out of the block.
  const json = JSON.stringify(
    summaryShareTarget(SHARE_SCRIPT_SLOT_SOURCE, SHARE_SCRIPT_SLOT_DOC_ID),
  ).replace(/</g, "\\u003c");
  return json.replace(new RegExp([...slots.keys()].join("|"), "g"), (m) => slots.get(m) ?? m);
}

/** Everything the dialog renders from. Held by the DOM module, never on the DOM
 *  itself — the panel's innerHTML is replaced wholesale on every change. */
export interface ShareDialogState {
  /** Registered wiki name (`?wiki=`), or "" for the default wiki. Empty on any
   *  non-wiki surface — read only to build the DEFAULT target. */
  wiki: string;
  /** The page NAME — what `index.resolve(page)` takes, never a relPath. On a
   *  non-wiki surface it is that surface's document identity (the doc id), used
   *  for the header default and the navigate-away comparison. */
  page: string;
  /** Display title for the header. */
  title: string;
  /** Which surface this share posts to. Absent ⇒ the /wiki surface, i.e.
   *  {@link wikiShareTarget} over `wiki`/`page` — the PR B behaviour. */
  target?: ShareTarget;
  /** `null` while the preset fetch is in flight. */
  presets: SharePresetOption[] | null;
  presetId: string;
  lang: ShareLang;
  /** The prompt textarea's live value. */
  prompt: string;
  extra: string;
  /** Is the prompt panel expanded? Collapsed by default — the preset IS the
   *  prompt for most shares, and an open 12-row textarea reads as required work. */
  promptOpen: boolean;
  running: boolean;
  /** Markdown accumulated from `delta` events while the model writes. */
  streamed: string;
  result: ShareDonePayload | null;
  tab: ShareTab;
  /** A message from the server (`app_error`, a 4xx body) or the transport. */
  error?: string;
  /** Deadline from a 409 — a share is already running on this page. */
  conflictExpiresAtMs?: number;
  /** Set for one render after a successful clipboard write. */
  copied?: boolean;
}

/** The breadcrumb's always-visible article action, beside 💬 Discuss. */
export function shareArticleBtnHtml(): string {
  return (
    '<button class="wiki-bc-share" id="' + SHARE_BTN_ID + '" ' +
    'title="Turn this page into a post you can paste into Slack or an email">' +
    "📤 Share</button>"
  );
}

/** The selected preset, or undefined while the list is still loading. */
export function selectedPreset(state: ShareDialogState): SharePresetOption | undefined {
  return (state.presets ?? []).find((p) => p.id === state.presetId);
}

/**
 * Has the reader EDITED the prompt?
 *
 * Compared against the selected preset's own content, trimmed on both sides, so
 * whitespace the textarea adds is not an edit. This is what decides whether the
 * POST carries `promptOverride` at all — sending the unedited preset body back
 * would make every share look like a custom prompt in the logs, and would freeze
 * the wording of a preset the bot may since have overridden.
 */
export function promptIsEdited(state: ShareDialogState): boolean {
  const preset = selectedPreset(state);
  if (!preset) return false;
  return state.prompt.trim() !== preset.content.trim();
}

/** The target this state posts to — its own, or the /wiki default. */
export function shareTargetOf(state: ShareDialogState): ShareTarget {
  return state.target ?? wikiShareTarget(state.wiki, state.page);
}

/** The surface nouns this state renders with — its target's, or /wiki's. */
export function shareCopyOf(state: ShareDialogState): ShareSurfaceCopy {
  return state.target?.copy ?? WIKI_SHARE_COPY;
}

/** The POST body for the state's {@link ShareTarget}: the surface's identity
 *  fields, then the four the share layer itself owns. */
export function shareRequestBody(state: ShareDialogState): Record<string, unknown> {
  const extra = state.extra.trim();
  return {
    ...shareTargetOf(state).fields,
    preset: state.presetId,
    lang: state.lang,
    ...(promptIsEdited(state) ? { promptOverride: state.prompt } : {}),
    ...(extra ? { extra } : {}),
  };
}

/**
 * A local restatement of the server's caps, so an over-long prompt is refused
 * where the reader typed it instead of arriving as a 400 after a round-trip. The
 * SERVER owns the rule (same constants, imported — not a second number); this is
 * only about where the message appears.
 */
export function shareCapError(state: ShareDialogState): string | null {
  if (state.prompt.length > SHARE_PROMPT_OVERRIDE_MAX) {
    return `The prompt is ${state.prompt.length} characters — the limit is ${SHARE_PROMPT_OVERRIDE_MAX}.`;
  }
  if (state.extra.length > SHARE_EXTRA_MAX) {
    return `The extra instruction is ${state.extra.length} characters — the limit is ${SHARE_EXTRA_MAX}.`;
  }
  return null;
}

/**
 * Is the EFFECTIVE instruction empty?
 *
 * Blanking the textarea makes `promptIsEdited` true and sends `promptOverride:
 * ""`. The route used to read that as "no override" (`promptOverride.trim() ||
 * preset.content`) and run the PRESET — the model answering an instruction the
 * screen was no longer showing. The server 400s it now; this is the same rule
 * where the reader typed it, so Generate is simply not pressable.
 *
 * Null while no preset has resolved: that case has its own copy, and stacking
 * "the prompt is empty" on top of "this wiki offers no share presets" says
 * nothing extra.
 */
export function sharePromptError(state: ShareDialogState): string | null {
  if (!selectedPreset(state)) return null;
  if (promptIsEdited(state) && state.prompt.trim() === "") {
    return "The prompt is empty — type an instruction, or reset it to the preset.";
  }
  return null;
}

/** Every reason Generate (and the result pane's Regenerate) is unpressable, in
 *  the order they are reported. */
export function shareBlockingError(state: ShareDialogState): string | null {
  return shareCapError(state) ?? sharePromptError(state);
}

/** Can Generate be pressed? */
export function canGenerate(state: ShareDialogState): boolean {
  return !state.running && !!selectedPreset(state) && shareBlockingError(state) === null;
}

/**
 * The Slack length-budget warning.
 *
 * Measured against the SERVER-rendered mrkdwn — the exact string the copy button
 * puts on the clipboard, not the markdown it came from (they differ: headings
 * become bold lines, links become `<url|label>`, so the markdown length is not the
 * paste length). Over {@link SLACK_PASTE_MAX} Slack turns the paste into a file
 * snippet, which collapses in the channel and is read by nobody — so this is a
 * delivery failure, and the copy is about what to DO, not a scolding.
 *
 * Returns null when the post fits, so the caller renders nothing at all.
 */
export function slackLengthWarning(slack: string): string | null {
  if (slack.length <= SLACK_PASTE_MAX) return null;
  return (
    `This is ${slack.length} characters. Slack turns a paste over ~${SLACK_PASTE_MAX} into a ` +
    "collapsed file snippet — shorten it (or add “keep it under 1200 characters” to the prompt) " +
    "before sending."
  );
}

/** What the copy button writes for a tab. The email tab carries BOTH flavours so
 *  a rich-text target gets the styled body and a plain one still gets the text. */
export function copyPayloadFor(
  tab: ShareTab,
  result: ShareDonePayload,
): { text: string; html?: string } {
  if (tab === "slack") return { text: result.slack };
  if (tab === "email") return { text: result.markdown, html: result.mailHtml };
  return { text: result.markdown };
}

/**
 * "another share is running on this thing" copy, with the deadline the 409
 * carried.
 *
 * `lead` is the surface's own sentence ({@link ShareSurfaceCopy.conflictLead});
 * it defaults to /wiki's so the existing callers and their pinned strings are
 * untouched. Only the noun differs — the deadline clause is the same everywhere,
 * and it is the half that actually carries information.
 */
export function shareConflictCopy(
  expiresAtMs: number,
  now: number,
  lead: string = WIKI_SHARE_COPY.conflictLead,
): string {
  const secs = Math.max(0, Math.round((expiresAtMs - now) / 1000));
  const when = secs > 90 ? `~${Math.ceil(secs / 60)} min` : `~${secs}s`;
  return `${lead} It frees up in at most ${when}.`;
}

// ── Markup ───────────────────────────────────────────────────────────────────

/** `idFor` is the exported id BUILDER, not a prefix to re-concatenate: the tab row
 *  already renders through `shareTabId`, and a chip row spelling the same id a
 *  second way is a rename away from a focus contract that silently stops holding
 *  (the tests would keep passing — they call the builder). */
function chipRow(
  attr: string,
  idFor: (id: string) => string,
  items: readonly { id: string; label: string }[],
  active: string,
  disabled: boolean,
): string {
  return items
    .map(
      (i) =>
        `<button class="wiki-share-chip${i.id === active ? " is-active" : ""}" ` +
        `id="${esc(idFor(i.id))}" ` +
        `${attr}="${esc(i.id)}"${disabled ? " disabled" : ""}>${esc(i.label)}</button>`,
    )
    .join("");
}

/** The result pane for the active tab, plus the Slack budget warning. */
export function shareResultHtml(state: ShareDialogState, slackHtml: string): string {
  const r = state.result;
  if (!r) return "";
  const tabs =
    '<div class="wiki-share-tabs" role="tablist">' +
    SHARE_TABS.map(
      (t) =>
        `<button class="wiki-share-tab${t.id === state.tab ? " is-active" : ""}" ` +
        `id="${esc(shareTabId(t.id))}" ` +
        `${SHARE_TAB_ATTR}="${t.id}" role="tab" aria-selected="${t.id === state.tab}">` +
        `${esc(t.label)}</button>`,
    ).join("") +
    "</div>";

  let body: string;
  if (state.tab === "slack") {
    const warn = slackLengthWarning(r.slack);
    body =
      (warn ? '<div class="wiki-share-warn">⚠️ ' + esc(warn) + "</div>" : "") +
      '<div class="wiki-share-preview wiki-share-slack">' + slackHtml + "</div>";
  } else if (state.tab === "email") {
    body = '<div class="wiki-share-preview wiki-share-mail">' + r.mailHtml + "</div>";
  } else {
    body = '<pre class="wiki-share-preview wiki-share-md">' + esc(r.markdown) + "</pre>";
  }

  const copyLabel = state.copied ? "✓ Copied" : "Copy " + activeTabLabel(state.tab);
  return (
    tabs +
    body +
    '<div class="wiki-share-foot">' +
    `<button class="wiki-share-primary" id="${SHARE_COPY_ID}">${esc(copyLabel)}</button>` +
    // The SAME derivation as the main Generate, not just `running`. `generate()`
    // early-returns on `!canGenerate(state)`, so an over-cap prompt or a blanked
    // one made this button a live-looking silent no-op.
    `<button class="wiki-share-ghost" id="${SHARE_GENERATE_ID}"${canGenerate(state) ? "" : " disabled"}>` +
    "Regenerate</button>" +
    "</div>"
  );
}

function activeTabLabel(tab: ShareTab): string {
  return SHARE_TABS.find((t) => t.id === tab)?.label ?? tab;
}

/**
 * The whole dialog. Rendered from state on every change — nothing is DOM-held.
 *
 * `now` is a PARAMETER, never a `Date.now()` read in here: this is the pure half,
 * and the 409 countdown was the one value that reached for the clock mid-render
 * (the `wiki-filter.ts` rule — the DOM half captures one instant per paint).
 */
export function shareDialogHtml(state: ShareDialogState, slackHtml: string, now: number): string {
  const head =
    '<div class="wiki-share-head"><span>📤 Share “' + esc(state.title) + "”</span>" +
    `<button class="wiki-share-x" id="${SHARE_CLOSE_ID}" aria-label="Close">✕</button></div>`;

  if (state.presets === null) {
    // A failed fetch offers a way out other than close-and-reopen.
    const retry = state.error
      ? ` <button class="wiki-share-ghost" id="${SHARE_PRESET_RETRY_ID}">Retry</button>`
      : "";
    return head + '<div class="wiki-share-note">' +
      (state.error ? esc(state.error) : "Loading presets…") + retry + "</div>";
  }

  const preset = selectedPreset(state);
  const presetRow =
    '<label class="wiki-share-row"><span>Preset</span>' +
    `<select id="${SHARE_PRESET_ID}"${state.running ? " disabled" : ""}>` +
    state.presets
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${p.id === state.presetId ? " selected" : ""}>` +
          `${esc(p.label)}</option>`,
      )
      .join("") +
    "</select></label>";

  const langRow =
    '<div class="wiki-share-row"><span>Language</span><div class="wiki-share-chips">' +
    chipRow(SHARE_LANG_ATTR, shareLangChipId, SHARE_LANGS, state.lang, state.running) +
    "</div></div>";

  // The prompt is VISIBLE and editable, but collapsed by default: the preset is
  // the prompt for most shares, and an open 12-row textarea reads as required
  // work. The summary line says whether it has been edited, so a reader can never
  // generate from an edit they forgot behind a fold.
  const edited = promptIsEdited(state);
  const promptPanel =
    `<details class="wiki-share-prompt" id="${SHARE_PROMPT_PANEL_ID}"` +
    (state.promptOpen ? " open" : "") + ">" +
    `<summary id="${SHARE_PROMPT_TOGGLE_ID}">Prompt` +
    (edited ? ' <span class="wiki-share-edited">· edited</span>' : "") +
    "</summary>" +
    `<textarea id="${SHARE_PROMPT_ID}" rows="10" spellcheck="false"` +
    (state.running ? " disabled" : "") + ">" + esc(state.prompt) + "</textarea>" +
    (edited
      ? `<button class="wiki-share-ghost wiki-share-reset" id="${SHARE_RESET_ID}">` +
        "Reset to preset</button>"
      : "") +
    "</details>";

  const extraRow =
    '<label class="wiki-share-row wiki-share-row-col"><span>Anything to steer it? (optional)</span>' +
    `<input id="${SHARE_EXTRA_ID}" type="text" value="${esc(state.extra)}" ` +
    'placeholder="e.g. lead with the security angle"' + (state.running ? " disabled" : "") +
    "></label>";

  const status =
    shareBlockingError(state) ??
    state.error ??
    (state.conflictExpiresAtMs
      ? shareConflictCopy(state.conflictExpiresAtMs, now, shareCopyOf(state).conflictLead)
      : preset
        ? ""
        : shareCopyOf(state).noPresets);
  const statusHtml = status ? '<div class="wiki-share-status">' + esc(status) + "</div>" : "";

  // While the model writes, the raw markdown IS the preview — the tabs need the
  // server's three renderings, which only exist at `done`.
  const live = state.running || state.streamed
    ? '<pre class="wiki-share-preview wiki-share-md wiki-share-live">' +
      esc(state.streamed) + (state.running ? "▍" : "") + "</pre>"
    : "";

  const generate =
    '<div class="wiki-share-foot">' +
    `<button class="wiki-share-primary" id="${SHARE_GENERATE_ID}"` +
    (canGenerate(state) ? "" : " disabled") + ">" +
    (state.running ? "Generating…" : state.streamed ? "Regenerate" : "Generate") +
    "</button></div>";

  // **`running` outranks `result`.** A REGENERATE keeps the previous post in
  // state until a new `done` lands (clearing it up front meant an app_error, a
  // 409, a dropped connection or an Escape destroyed a finished post the reader
  // had not copied yet), so the result pane must give way to the live stream
  // while the new run is in flight — and come back, intact, beside the error
  // line if that run fails.
  const body = state.running
    ? live + generate
    : state.result
      ? shareResultHtml(state, slackHtml)
      : live + generate;

  return head + presetRow + langRow + promptPanel + extraRow + statusHtml + body;
}

/**
 * The dialog's CSS.
 *
 * Exported (rather than pasted into `wiki-page.ts`, as the chat dialog's is)
 * because `/summaries` mounts the same dialog in PR C, and a second hand-copied
 * stylesheet is how the two surfaces drift. Every colour names a token the HOST
 * page actually defines — the chat dialog shipped fully transparent on
 * `var(--bg-elevated)`, a token that exists only in the chat page's own styles,
 * and the e2e asserts the computed background for exactly that reason.
 */
export function shareDialogStyles(): string {
  return `
    .wiki-share-scrim { position: fixed; inset: 0; z-index: 59; background: rgba(5,5,10,0.55); }
    .wiki-share {
      position: fixed; z-index: 60; display: flex; flex-direction: column; gap: 10px;
      left: 50%; top: 7vh; transform: translateX(-50%);
      width: min(620px, calc(100vw - 32px));
      padding: 14px; border-radius: 12px; border: 1px solid var(--border-secondary);
      background: var(--bg-surface); box-shadow: 0 18px 48px rgba(0,0,0,0.5);
      font-size: 12.5px; color: var(--text-primary);
      max-height: 86vh; overflow-y: auto; scrollbar-width: thin;
    }
    .wiki-share-head {
      display: flex; align-items: center; justify-content: space-between;
      font-weight: 600; font-size: 14px; gap: 8px;
    }
    .wiki-share-x {
      background: none; border: none; color: var(--text-secondary); cursor: pointer;
      font-size: 14px; padding: 2px 6px;
    }
    .wiki-share-row { display: flex; align-items: center; gap: 10px; }
    .wiki-share-row > span { color: var(--text-secondary); min-width: 108px; }
    .wiki-share-row-col { flex-direction: column; align-items: stretch; gap: 4px; }
    .wiki-share-row select, .wiki-share-row input {
      flex: 1; padding: 6px 8px; border-radius: 8px; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-primary);
    }
    .wiki-share-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .wiki-share-chip, .wiki-share-tab {
      padding: 4px 10px; border-radius: 999px; cursor: pointer; font-size: 12px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-secondary);
    }
    .wiki-share-chip.is-active, .wiki-share-tab.is-active {
      background: var(--accent); border-color: var(--accent); color: #fff;
    }
    .wiki-share-chip[disabled], .wiki-share-tab[disabled] { opacity: 0.5; cursor: default; }
    .wiki-share-prompt > summary {
      cursor: pointer; color: var(--text-secondary); padding: 2px 0;
    }
    .wiki-share-edited { color: var(--accent); }
    .wiki-share-prompt textarea {
      width: 100%; margin-top: 6px; resize: vertical; padding: 8px 10px; font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      border-radius: 8px; border: 1px solid var(--border-secondary);
      background: var(--bg-inset); color: var(--text-primary);
    }
    .wiki-share-tabs { display: flex; gap: 6px; margin-top: 4px; }
    .wiki-share-preview {
      border: 1px solid var(--border-secondary); border-radius: 8px; padding: 10px;
      background: var(--bg-inset); max-height: 42vh; overflow: auto;
      white-space: pre-wrap; word-break: break-word; line-height: 1.5;
    }
    /* The email tab renders the real inline-styled body: it must NOT inherit the
       page's dark surface, or the light-palette mail HTML is unreadable. */
    .wiki-share-mail { background: #fff; color: #1f2328; white-space: normal; }
    .wiki-share-md { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .wiki-share-live { opacity: 0.85; }
    .wiki-share-warn {
      border: 1px solid var(--warning, #d29922); border-radius: 8px; padding: 8px 10px;
      color: var(--text-primary); background: rgba(210, 153, 34, 0.12); margin-bottom: 6px;
    }
    .wiki-share-status { color: var(--text-secondary); }
    .wiki-share-note { color: var(--text-secondary); padding: 8px 0; }
    .wiki-share-foot { display: flex; gap: 8px; align-items: center; }
    .wiki-share-primary {
      padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12.5px;
      border: 1px solid var(--accent); background: var(--accent); color: #fff;
    }
    .wiki-share-ghost {
      padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-secondary);
    }
    .wiki-share-primary[disabled], .wiki-share-ghost[disabled] { opacity: 0.5; cursor: default; }
    .wiki-share-reset { margin-top: 6px; }
  `;
}

/** Context for the click-away decision. */
export interface ShareClickContext {
  /** Is the click inside the dialog panel? */
  inPanel: boolean;
  /** Is it on the button that opens it (or another registered opener)? */
  inOpener: boolean;
  /** Is a generation in flight? */
  running: boolean;
}

/**
 * Should an outside click dismiss the dialog?
 *
 * Never while a generation is running: the reader has spent the call, the result
 * lands in this panel and nowhere else, and a stray click on the scrim would throw
 * it away mid-stream. × and Escape remain the deliberate exits (Escape cancels
 * the run first). The opener test is what stops the opening click from reading as
 * a click-away and closing the dialog it just opened.
 */
export function shouldCloseShareDialog(ctx: ShareClickContext): boolean {
  if (ctx.inPanel || ctx.inOpener) return false;
  return !ctx.running;
}
