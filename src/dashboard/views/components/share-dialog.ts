/// <reference lib="dom" />
/**
 * The share dialog's DOM half — state, render, listeners, the SSE run and the
 * clipboard write. Everything testable lives next door in `wiki-share-dialog.ts`.
 *
 * **One module state, one listener registration.** The document-level listeners
 * are wired on the FIRST open and never again (`wired`), and `openShareDialog` is
 * the module's only entry point. That is why a page must reach this module ONE
 * way — an import (what /wiki does) or the standalone `share-dialog-browser.ts`
 * bundle's global (what /summaries will do), never both: two copies would mean two
 * `state` objects, two click handlers, and a Generate button that renders from one
 * of them while writing to the other.
 *
 * **The stream is `fetch` + ReadableStream, not EventSource.** Not a preference —
 * the route answers a 409 `{state, expiresAtMs}` when a share is already running
 * on the page, and an EventSource exposes neither status nor body on a non-200
 * (so the deadline the copy needs is unreadable) and auto-reconnects on a drop,
 * straight back into the single-flight slot its own first connection is holding.
 * Framing is the shared, unit-tested `makeSseFrameParser`.
 */

import { renderSlackMrkdwn } from "../../../chat/views/components/slack-mrkdwn.ts";
import { makeSseFrameParser, type SseFrame } from "./client-runtime.ts";
import { isShareLang, type ShareDonePayload, type ShareLang } from "../../../share/wire.ts";
import {
  canGenerate,
  copyPayloadFor,
  selectedPreset,
  shareConflictCopy,
  shareCopyOf,
  shareDialogHtml,
  shareRequestBody,
  shareTargetOf,
  shouldCloseShareDialog,
  promptIsEdited,
  shareBlockingError,
  SHARE_CLOSE_ID,
  SHARE_COPY_ID,
  SHARE_DIALOG_ID,
  SHARE_EXTRA_ID,
  SHARE_GENERATE_ID,
  SHARE_LANG_ATTR,
  SHARE_PRESET_ID,
  SHARE_PRESET_RETRY_ID,
  SHARE_PROMPT_ID,
  SHARE_PROMPT_PANEL_ID,
  SHARE_RESET_ID,
  SHARE_SCRIM_ID,
  SHARE_TAB_ATTR,
  type ShareDialogState,
  type SharePresetOption,
  type ShareTab,
  type ShareTarget,
} from "./wiki-share-dialog.ts";

/** What a caller must know to share something. */
export interface OpenShareOptions {
  /** Registered wiki name; "" for the default wiki. Ignored when `target` is set. */
  wiki: string;
  /** The page NAME (`index.resolve` input) — never a relPath. On a non-wiki
   *  surface, that surface's document identity (used for the header default and
   *  {@link closeShareDialogOnNavigate}); the POST identity is `target.fields`. */
  page: string;
  /** Header title; defaults to the page name. */
  title?: string;
  /** Ids of the elements that OPEN this dialog, so their click isn't a
   *  click-away. The breadcrumb button by default. */
  openerIds?: string[];
  /**
   * Which surface to post to. Omit for /wiki (the default target reproduces PR
   * B's URLs and body exactly); `/summaries` passes `summaryShareTarget(...)`.
   */
  target?: ShareTarget;
}

let state: ShareDialogState | null = null;
let openerIds: string[] = [];
let wired = false;
let inFlight: AbortController | null = null;
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
/** Pending until the paint that first offers the preset picker — see
 *  {@link applyAutofocus}. */
let autofocusPending = false;
/** The id THIS module last auto-focused, so a paint can tell its OWN focus (the
 *  loading paint's ✕) apart from focus the reader chose. See {@link applyAutofocus}. */
let autofocusedId = "";
/** Ticks the 409 countdown; cleared the moment the deadline passes. */
let conflictTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Where focus goes when the dialog closes — the element that had it when the
 * dialog opened, i.e. the 📤 button in every real case.
 *
 * The other half of the autofocus contract, and it was missing: `openShareDialog`
 * deliberately pulls focus INTO a panel claiming `aria-modal="true"`, and closing
 * removed that panel from under `document.activeElement`, which browsers reset to
 * `<body>`. On /wiki that is merely the top of the page; on /summaries the reader
 * is left on `<body>` BEHIND a still-open doc-panel overlay, so the next Tab walks
 * the page under the article they are reading.
 */
let returnFocusTo: HTMLElement | null = null;

function panel(): HTMLElement | null {
  return document.getElementById(SHARE_DIALOG_ID);
}

/** Open (or re-target) the dialog for one page. The module's only entry point. */
export function openShareDialog(opts: OpenShareOptions): void {
  wire();
  // Re-opening (a second 📤 click, or the same dialog re-targeted at another
  // page) abandons any run in flight. Without the abort the old fetch keeps
  // streaming into a state nothing paints, and its reader holds the connection —
  // and the page's server-side slot — for the rest of the budget.
  inFlight?.abort();
  inFlight = null;
  stopConflictTimer();
  // Where focus came FROM, stashed before autofocus takes it. Captured only when
  // it is outside the panel, so a RE-TARGET (a second open while the dialog is
  // up) cannot overwrite the real opener with one of the dialog's own controls —
  // and never `<body>`, which is the state this exists to avoid restoring to.
  const active = document.activeElement as HTMLElement | null;
  const alreadyOpen = panel();
  if (!alreadyOpen || !active || !alreadyOpen.contains(active)) {
    returnFocusTo = active && active !== document.body ? active : null;
  }
  // The panel claims `aria-modal="true"`, so leaving `document.activeElement` on
  // the 📤 button behind the scrim is a lie to a screen reader and leaves the
  // keyboard reader outside a dialog Tab is trapped inside of.
  autofocusPending = true;
  autofocusedId = "";
  openerIds = opts.openerIds ?? [];
  state = {
    wiki: opts.wiki,
    page: opts.page,
    title: opts.title || opts.page,
    presets: null,
    presetId: "",
    lang: rememberedLang(),
    prompt: "",
    extra: "",
    promptOpen: false,
    running: false,
    streamed: "",
    result: null,
    tab: "slack",
    ...(opts.target ? { target: opts.target } : {}),
  };
  render();
  void loadPresets();
}

/**
 * Close the dialog when the reader navigates to a DIFFERENT page.
 *
 * The Discuss dialog's `shouldCloseArticleChatOnNavigate` seam, same reason and
 * same call site (`renderBreadcrumb`, before `currentArticle` is re-stamped). The
 * pointer path cannot strand it — the scrim is above the page and eats a list-row
 * click as a click-away — but **`popstate` involves no click at all**, so Back
 * left the panel open over the new article, its header naming the old page and
 * its Generate about to summarize it. Measured, then pinned in
 * `e2e/wiki-share.spec.ts`.
 *
 * Comparing the page NAME (not relPath) because that is what the dialog holds and
 * posts; a same-page re-render must not close a dialog the reader has open.
 */
export function closeShareDialogOnNavigate(page: string): void {
  if (state && state.page !== page) closeShareDialog();
}

/** Close it, cancelling any run, and hand focus back to whatever opened it. */
export function closeShareDialog(): void {
  inFlight?.abort();
  inFlight = null;
  stopConflictTimer();
  autofocusPending = false;
  autofocusedId = "";
  state = null;
  panel()?.remove();
  document.getElementById(SHARE_SCRIM_ID)?.remove();
  // AFTER the removal, or the panel is still the focus scope. Guarded on
  // `isConnected`: a close driven by a navigation (or by /summaries retargeting
  // its doc panel) can have detached the opener, and focusing a detached node
  // silently leaves focus on `<body>` — the same place doing nothing would.
  const back = returnFocusTo;
  returnFocusTo = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

// ── 409 countdown ────────────────────────────────────────────────────────────
// The conflict copy names a deadline ("frees up in at most ~45s"), and a frozen
// number that never reaches zero is worse than none: the reader waits, re-clicks,
// and gets the same sentence. One 1s tick repaints it, and the tick that finds
// the deadline PASSED clears both the deadline and the copy, so the next click
// starts from a clean panel rather than under a stale refusal.

function stopConflictTimer(): void {
  if (conflictTimer) clearInterval(conflictTimer);
  conflictTimer = null;
}

function startConflictTimer(): void {
  stopConflictTimer();
  conflictTimer = setInterval(() => {
    if (!state?.conflictExpiresAtMs) { stopConflictTimer(); return; }
    if (Date.now() >= state.conflictExpiresAtMs) {
      stopConflictTimer();
      state.conflictExpiresAtMs = undefined;
      state.error = undefined;
    }
    render();
  }, 1000);
}

// ── Language memory ──────────────────────────────────────────────────────────
// The language a reader shares in is a property of the reader, not of the page —
// a Norwegian team picks "Norsk" on every share, and re-picking it each time is
// the kind of friction that gets a feature abandoned. localStorage, like the
// chat dialog's connector/user preferences.

const LANG_KEY = "muninn-wiki-share-lang";

function rememberedLang(): ShareLang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (isShareLang(v)) return v;
  } catch { /* private mode — fall through to the default */ }
  return "en";
}

function rememberLang(lang: ShareLang): void {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* not worth reporting */ }
}

// ── Presets ──────────────────────────────────────────────────────────────────

async function loadPresets(): Promise<void> {
  const target = state;
  if (!target) return;
  const url = shareTargetOf(target).presetsUrl;
  let presets: SharePresetOption[] = [];
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const body = (await res.json()) as { presets?: SharePresetOption[]; error?: string };
    if (!res.ok) throw new Error(body?.error || "HTTP " + res.status);
    presets = Array.isArray(body.presets) ? body.presets : [];
  } catch (err) {
    // The dialog is still open and still says what went wrong — `presets: null`
    // keeps the loading branch, which renders `error` in place of the spinner.
    if (state === target) {
      state.error = "Could not load the share presets: " + errText(err);
      render();
    }
    return;
  }
  // A dialog closed (or re-opened on another page) while the fetch was in flight
  // must not be repainted from this response.
  if (state !== target) return;
  state.presets = presets;
  state.error = undefined;
  const first = presets[0];
  if (first) {
    state.presetId = first.id;
    state.prompt = first.content;
  }
  render();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Focus + caret survive the innerHTML swap — the prompt textarea is re-rendered
 *  whenever the "edited" badge flips, which happens mid-word. */
interface FieldFocus {
  id: string;
  start: number;
  end: number;
}

function captureFocus(): FieldFocus | null {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const p = panel();
  if (!el || !el.id || !p || !p.contains(el)) return null;
  const start = typeof el.selectionStart === "number" ? el.selectionStart : 0;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
  return { id: el.id, start, end };
}

function restoreFocus(focus: FieldFocus | null): void {
  if (!focus) return;
  const el = document.getElementById(focus.id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return;
  el.focus({ preventScroll: true });
  try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
}

function render(): void {
  if (!state) { closeShareDialog(); return; }
  let p = panel();
  const focus = captureFocus();
  if (!p) {
    const scrim = document.createElement("div");
    scrim.id = SHARE_SCRIM_ID;
    scrim.className = "wiki-share-scrim";
    document.body.appendChild(scrim);
    p = document.createElement("div");
    p.id = SHARE_DIALOG_ID;
    p.className = "wiki-share";
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-modal", "true");
    p.setAttribute("aria-label", "Share this page");
    // Focusable only programmatically — {@link rehomeFocus}'s floor.
    p.setAttribute("tabindex", "-1");
    document.body.appendChild(p);
  }
  const scrollTop = p.scrollTop;
  // The Slack tab's preview is the shared browser-side mrkdwn renderer the chat
  // page already ships — a faithful preview of the exact string being copied, at
  // no new cost and with no second implementation to drift.
  const slackHtml = state.result ? renderSlackMrkdwn(state.result.slack) : "";
  // ONE clock read per paint, threaded into the pure half (which must not reach
  // for `Date.now()` itself — the `wiki-filter.ts` rule).
  p.innerHTML = shareDialogHtml(state, slackHtml, Date.now());
  if (scrollTop) p.scrollTop = scrollTop;
  detachPreviewLinks(p);
  restoreFocus(focus);
  applyAutofocus(p, focus);
  rehomeFocus(p);
}

/**
 * Last line of defence: never leave focus stranded outside an `aria-modal` panel.
 *
 * `restoreFocus` can only re-find a control that still exists AND can still take
 * focus, and several controls here retire themselves on the very click that
 * activates them: "Reset to preset" exists only while the prompt is edited and
 * un-edits it (pinned in `e2e/wiki-share.spec.ts`), and Generate renders
 * `disabled` for the run it just started, so `focus()` on the re-found node is a
 * no-op. Autofocus has long retired by then, so focus falls to `<body>`: behind
 * the scrim, outside a panel claiming `aria-modal`, and invisible until the reader
 * presses Tab (which `trapTab` then answers by jumping to the top of the panel).
 *
 * Deliberately narrow — it fires ONLY when nothing meaningful holds focus (no
 * active element, `<body>`, or a node this paint detached). Focus the reader
 * placed anywhere real is never taken.
 */
function rehomeFocus(p: HTMLElement): void {
  const active = document.activeElement as HTMLElement | null;
  const stranded = !active || active === document.body || !active.isConnected;
  if (!stranded) return;
  // Same visibility filter as {@link trapTab}: a control inside the COLLAPSED
  // prompt `<details>` is in the DOM and matches the selector, but `focus()` on it
  // puts the caret somewhere the reader cannot see. (`offsetParent` is non-null for
  // children of the panel — the panel itself is the positioned ancestor.)
  const el = (Array.prototype.slice.call(
    p.querySelectorAll(
      "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), " +
        "input:not([disabled]), summary",
    ),
  ) as HTMLElement[]).find((c) => c.offsetParent !== null) ?? null;
  // The panel carries `tabindex="-1"` so it can hold focus itself when it offers
  // no focusable control at all (the loading paint of a dialog whose ✕ is the
  // only button is already covered; this is the empty-markup floor).
  (el ?? p).focus({ preventScroll: true });
}

/**
 * Make every link in a PREVIEW open in a new tab.
 *
 * The email preview is `formatEmailHtml`'s real output — the exact bytes the copy
 * button puts on the clipboard as `text/html` — so the fix cannot live in the
 * renderer: a `target="_blank"` baked in there would ride into the pasted email
 * body. It has to be preview-only, hence a DOM pass over the inserted markup.
 * Without it a click on a link in the preview navigates /wiki away and destroys a
 * finished, un-copied post: the dialog's state is module-held and does not
 * survive the page load.
 *
 * Applied to `.wiki-share-preview` generally, so the Slack preview's anchors are
 * covered by the same pass rather than by trusting a second renderer.
 */
function detachPreviewLinks(p: HTMLElement): void {
  p.querySelectorAll(".wiki-share-preview a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

/**
 * Move focus INTO the dialog, exactly once per open.
 *
 * The loading paint has only ✕, so focus parks there while the presets load, and
 * the paint that first offers the preset picker takes it and **retires the flag** —
 * that paint is the last one allowed to move focus, because everything after it is
 * the reader's.
 *
 * **Both halves of that are load-bearing, and the first cut got both wrong.**
 * `captureFocus` reports any id-carrying element inside the panel, so the ✕ this
 * function focused itself read as "the reader is already somewhere" and made every
 * later paint early-return: the flag never cleared, the picker never took focus,
 * and the first Tab started from the dismiss button. Meanwhile the language/tab
 * chips carry NO id, so `captureFocus` returns null on a chip click — and the
 * still-armed flag answered that click by yanking focus onto the `<select>`.
 * Hence {@link autofocusedId}: focus this module placed is not the reader having
 * chosen anything, and the flag is retired on the picker paint whether or not it
 * ends up taking focus.
 */
function applyAutofocus(p: HTMLElement, focus: FieldFocus | null): void {
  if (!autofocusPending) return;
  const readerHasFocus = !!focus && focus.id !== autofocusedId;
  // Scoped to the panel, like the fallback query two lines down: this function's
  // whole job is to place focus INSIDE `p`, and a bare document lookup would
  // happily hand it an id-alike belonging to the page behind the scrim.
  const preferred = p.querySelector("#" + SHARE_PRESET_ID) as HTMLElement | null;
  if (preferred) {
    autofocusPending = false;
    autofocusedId = "";
    // A reader who has already put the caret somewhere of their own keeps it.
    if (!readerHasFocus) preferred.focus({ preventScroll: true });
    return;
  }
  if (readerHasFocus) return;
  const el = p.querySelector("button, select, textarea, input") as HTMLElement | null;
  if (!el) return;
  el.focus({ preventScroll: true });
  autofocusedId = el.id;
}

/** Coalesce a burst of stream deltas into one paint per animation frame. */
let paintQueued = false;
function renderSoon(): void {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (state) render();
  });
}

// ── Listeners (wired once) ───────────────────────────────────────────────────

function wire(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("keydown", onKeydown);
  // `toggle` does NOT bubble, so it has to be caught in the capture phase (the
  // `/wiki/gardener` inspector precedent). It is only a BACKSTOP now — see
  // {@link notePromptToggle} for why the open state cannot be learned from this
  // event, and what does learn it.
  document.addEventListener("toggle", onToggle, true);
}

function onToggle(e: Event): void {
  if (!state) return;
  const el = e.target as HTMLDetailsElement | null;
  if (!el || el.id !== SHARE_PROMPT_PANEL_ID) return;
  state.promptOpen = el.open;
}

/**
 * Record the prompt disclosure's open state **synchronously, from the activation**.
 *
 * `toggle` is queued as a task, not fired inline, and the panel's whole innerHTML
 * is replaced on every state change — so the ordering is a live race, not a
 * theoretical one:
 *
 *   summary click → DOM `open = true`, toggle task QUEUED
 *   → any repaint (the first keystroke flips the "· edited" badge) paints
 *     `<details>` CLOSED from the still-stale `promptOpen`, detaching the node
 *   → the queued toggle then fires on a node that is no longer in the document,
 *     so it never reaches the document-level listener and the state is wrong
 *     FOREVER — the panel collapses under the reader's hands and stays collapsed.
 *
 * Measured: `e2e/wiki-share.spec.ts`'s prompt test failed ~2 of 3 full-suite runs
 * on a cold server, and an instrumented run showed the toggle listener firing
 * ZERO times for a click that had already opened the disclosure.
 *
 * So the activation itself writes the state, from the capture-phase `click` — i.e.
 * **before** the default action toggles the element, which is why the intended
 * value is the negation of what the DOM currently says.
 *
 * **The keyboard needs no second handler, and deliberately does not get one.** A
 * summary's Enter/Space activation dispatches a SIMULATED CLICK, and the element
 * is still un-toggled when that click is captured — measured in this browser on
 * both keys, and pinned by the keyboard case in `e2e/wiki-share.spec.ts`. A
 * `keydown` handler negating the same way would be redundant on that ordering and
 * actively WRONG on any engine that toggled in the keydown default action: the
 * simulated click would then read the already-new value and flip the state back.
 * `toggle` stays wired as the backstop for the paths nothing here models
 * (find-in-page auto-expansion, a programmatic `open` flip), where no repaint is
 * racing it.
 */
function notePromptToggle(el: HTMLDetailsElement): void {
  if (!state) return;
  state.promptOpen = !el.open;
}

/** The prompt `<details>` this event is activating, or null. */
function promptPanelFor(target: HTMLElement): HTMLDetailsElement | null {
  const summary = target.closest("summary");
  const details = summary?.parentElement;
  if (!details || details.id !== SHARE_PROMPT_PANEL_ID) return null;
  return details as HTMLDetailsElement;
}

function onClick(e: MouseEvent): void {
  if (!state) return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const p = panel();
  const inPanel = !!p && p.contains(target);

  if (inPanel) {
    if (target.closest("#" + SHARE_CLOSE_ID)) { closeShareDialog(); return; }
    if (target.closest("#" + SHARE_GENERATE_ID)) { void generate(); return; }
    if (target.closest("#" + SHARE_COPY_ID)) { void copyActive(); return; }
    if (target.closest("#" + SHARE_RESET_ID)) {
      const preset = selectedPreset(state);
      if (preset) { state.prompt = preset.content; state.promptOpen = true; render(); }
      return;
    }
    if (target.closest("#" + SHARE_PRESET_RETRY_ID)) {
      state.error = undefined;
      render();
      void loadPresets();
      return;
    }
    // Pointer AND keyboard activation of the prompt disclosure — see
    // {@link notePromptToggle}; Enter/Space on a summary arrives here too.
    const promptPanel = promptPanelFor(target);
    if (promptPanel) { notePromptToggle(promptPanel); return; }
    const lang = target.closest("[" + SHARE_LANG_ATTR + "]") as HTMLElement | null;
    if (lang) {
      const value = lang.getAttribute(SHARE_LANG_ATTR);
      if (isShareLang(value) && !state.running) {
        state.lang = value;
        rememberLang(value);
        render();
      }
      return;
    }
    const tab = target.closest("[" + SHARE_TAB_ATTR + "]") as HTMLElement | null;
    if (tab) {
      const value = tab.getAttribute(SHARE_TAB_ATTR) as ShareTab | null;
      if (value) { state.tab = value; state.copied = false; render(); }
      return;
    }
    return;
  }

  const inOpener = openerIds.some((id) => !!target.closest("#" + id));
  if (shouldCloseShareDialog({ inPanel, inOpener, running: state.running })) closeShareDialog();
}

/**
 * Field edits update state WITHOUT a re-render — a repaint per keystroke is how a
 * textarea loses its caret. The exception is a change that alters the markup the
 * fields sit in (the "· edited" badge and the Reset button appearing, a cap error
 * appearing or clearing, Generate flipping enabled): those are re-rendered, and
 * the caret is restored around the swap.
 */
function onInput(e: Event): void {
  if (!state) return;
  const el = e.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || (el.id !== SHARE_PROMPT_ID && el.id !== SHARE_EXTRA_ID)) return;
  const before = derivedSignature(state);
  if (el.id === SHARE_PROMPT_ID) state.prompt = el.value;
  else state.extra = el.value;
  if (derivedSignature(state) !== before) render();
}

/** The bits of the markup that are DERIVED from the text fields. */
function derivedSignature(s: ShareDialogState): string {
  return `${promptIsEdited(s)}|${shareBlockingError(s) ?? ""}|${canGenerate(s)}`;
}

function onChange(e: Event): void {
  if (!state) return;
  const el = e.target as HTMLSelectElement | null;
  if (!el || el.id !== SHARE_PRESET_ID) return;
  state.presetId = el.value;
  const preset = selectedPreset(state);
  // Switching preset replaces the prompt: the panel shows the instruction that
  // will run, and keeping an edit of the PREVIOUS preset under a new preset's
  // name is the same silent-wrong-instruction failure the route's unknown-id 400
  // exists to prevent.
  if (preset) state.prompt = preset.content;
  render();
}

/**
 * Keep Tab inside the dialog.
 *
 * The panel declares `role="dialog"` + `aria-modal="true"` and the scrim blocks
 * only POINTER events — without this, Tab walks out into the wiki's list rows and
 * links behind a dimmed page that still answers Enter, and a screen reader is told
 * the dialog is modal and then reads the page behind it. The chat dialog's
 * `trapChatOptTab`, same shape.
 */
function trapTab(e: KeyboardEvent): void {
  const p = panel();
  if (!p) return;
  const focusable = Array.prototype.slice
    .call(
      p.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary',
      ),
    )
    .filter(
      (el: HTMLElement) => el.offsetParent !== null || el === document.activeElement,
    ) as HTMLElement[];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  // Focus that has already escaped (or never entered) comes back to the top on
  // the next Tab rather than continuing through the page behind.
  //
  // **`active === p` counts as escaped, and that is the load-bearing clause.** The
  // panel carries `tabindex="-1"` (for `rehomeFocus`), so ANY click on non-focusable
  // dialog chrome — the heading, the preview text, a drag-select — focuses the panel
  // itself. It is inside itself, so `p.contains(active)` is true, and it is absent
  // from `focusable`, so neither the first nor the last branch below matches: both
  // fall through, and native Shift+Tab walks to the previous tabbable BEHIND the
  // scrim (measured: the wiki rail's "Ask" button, where Enter activates it and the
  // bubbling click reads as a click-away, dismissing the dialog and destroying an
  // un-copied post).
  if (!active || active === p || !p.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (!state) return;
  if (e.key === "Tab") { trapTab(e); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    // **This dialog OWNS Escape while it is open**, and says so to every other
    // document-level listener rather than relying on being wired last.
    // `/summaries` opens this over a doc panel whose own Escape closes the
    // article, and that panel's listener is registered at page load while this
    // module's is wired lazily on the first open — so today the panel's runs
    // FIRST and is held off only by its own `#wikiShare` guard. That ordering is
    // an accident of when each listener happened to be added; this makes the
    // contract enforceable from the dialog's side too, so a future host that
    // wires its listener after us cannot eat the same keypress.
    e.stopImmediatePropagation();
    // A run in flight is cancelled first (client-side: the server keeps the slot
    // until its own budget expires, which the 409 copy reports), and the dialog
    // stays open so the reader can see that it stopped.
    if (state.running && inFlight) {
      inFlight.abort();
      inFlight = null;
      state.running = false;
      state.error = shareCopyOf(state).stopped;
      render();
      return;
    }
    closeShareDialog();
  }
}

// ── Generate ─────────────────────────────────────────────────────────────────

async function generate(): Promise<void> {
  if (!state || !canGenerate(state)) return;
  const target = state;
  const ctrl = new AbortController();
  inFlight?.abort();
  inFlight = ctrl;
  stopConflictTimer();
  target.running = true;
  target.streamed = "";
  // `result` is DELIBERATELY left alone. A Regenerate that fails — app_error,
  // 409, dropped connection, Escape — used to leave the reader with nothing,
  // having destroyed a finished post they had not copied yet. It is replaced
  // only when a new `done` actually lands; `shareDialogHtml` shows the live
  // stream over it while the run is in flight.
  target.error = undefined;
  target.conflictExpiresAtMs = undefined;
  target.copied = false;
  render();

  const settle = (patch: Partial<ShareDialogState>): void => {
    if (state !== target) return;
    Object.assign(target, patch, { running: false });
    if (inFlight === ctrl) inFlight = null;
    if (target.conflictExpiresAtMs) startConflictTimer();
    render();
  };

  let res: Response;
  try {
    res = await fetch(shareTargetOf(target).endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(shareRequestBody(target)),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (!ctrl.signal.aborted) settle({ error: "Could not reach the server: " + errText(err) });
    return;
  }

  // Every terminal path is abort-guarded, including these two. `settle` only
  // checks that the STATE object is still the same one — which it is after an
  // Escape-then-second-Generate — so an unguarded late settle from run A would
  // flip `running: false` and paint its error over live run B.
  if (res.status === 409) {
    // The whole reason this is a fetch and not an EventSource: the deadline is in
    // the body of a non-200, which an EventSource never surfaces.
    let body: { expiresAtMs?: unknown } = {};
    try { body = (await res.json()) as { expiresAtMs?: unknown }; } catch { /* keep the default */ }
    if (ctrl.signal.aborted) return;
    const at = typeof body.expiresAtMs === "number" ? body.expiresAtMs : Date.now();
    // The surface's own noun — the route's `error` string is deliberately not
    // used: this copy carries the live countdown the 1s timer repaints.
    settle({
      conflictExpiresAtMs: at,
      error: shareConflictCopy(at, Date.now(), shareCopyOf(target).conflictLead),
    });
    return;
  }
  if (!res.ok || !res.body) {
    let msg = "The share could not start (HTTP " + res.status + ").";
    try {
      const b = (await res.json()) as { error?: unknown };
      if (b && typeof b.error === "string") msg = b.error;
    } catch { /* non-JSON body — keep the status copy */ }
    if (ctrl.signal.aborted) return;
    settle({ error: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done: ShareDonePayload | null = null;
  let appError: string | undefined;
  const parser = makeSseFrameParser((frame) => {
    const parsed = dispatchShareFrame(frame, target);
    if (parsed.done) done = parsed.done;
    if (parsed.error) appError = parsed.error;
  });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch {
    if (!ctrl.signal.aborted) settle({ error: "The connection dropped before the post arrived." });
    return;
  }
  if (ctrl.signal.aborted) return;
  // `tab` is NOT reset. A reader regenerating from the Email tab is regenerating
  // the email; snapping back to Slack loses the tab they were working in — and on
  // the first run the tab is "slack" already, so resetting it bought nothing.
  if (done) settle({ result: done, error: undefined });
  else settle({ error: appError ?? "The post never arrived — nothing was generated." });
}

/**
 * Decode one frame. `delta` repaints live (that is the point of the stream);
 * `done`/`app_error` are returned to the caller, which owns the terminal state so
 * an aborted run can't paint over a newer one.
 *
 * The route's vocabulary is `delta` · `done` · `app_error` · `end` · `heartbeat`.
 * The last two are named explicitly rather than falling through, so a future event
 * can't be swallowed as "probably a sentinel".
 */
function dispatchShareFrame(
  frame: SseFrame,
  target: ShareDialogState,
): { done?: ShareDonePayload; error?: string } {
  if (frame.event === "heartbeat" || frame.event === "end") return {};
  let d: Record<string, unknown>;
  try { d = JSON.parse(frame.data) as Record<string, unknown>; } catch { return {}; }
  if (frame.event === "delta") {
    if (state === target && typeof d.text === "string") {
      target.streamed += d.text;
      // Throttled to ONE paint per animation frame: a full innerHTML swap per
      // token is the same burst the reader's Ask pane throttles, and here each
      // swap also re-runs the focus/caret restore.
      renderSoon();
    }
    return {};
  }
  if (frame.event === "app_error") {
    return { error: typeof d.message === "string" ? d.message : "The share failed." };
  }
  if (frame.event === "done") {
    const { markdown, slack, mailHtml } = d as Partial<ShareDonePayload>;
    if (typeof markdown === "string" && typeof slack === "string" && typeof mailHtml === "string") {
      return { done: { markdown, slack, mailHtml } };
    }
    return { error: "The server sent a post in a shape this page can't render." };
  }
  return {};
}

// ── Clipboard ────────────────────────────────────────────────────────────────

async function copyActive(): Promise<void> {
  if (!state?.result) return;
  const payload = copyPayloadFor(state.tab, state.result);
  try {
    // Rich text for the EMAIL tab only: pasting the inline-styled body into a mail
    // client is the whole point of that renderer, and a `text/plain` sibling keeps
    // a plain target (a terminal, a code editor) from getting nothing at all.
    const w = window as unknown as { ClipboardItem?: typeof ClipboardItem };
    if (payload.html && w.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new w.ClipboardItem({
          "text/html": new Blob([payload.html], { type: "text/html" }),
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(payload.text);
    }
  } catch (err) {
    state.error = "Could not copy: " + errText(err);
    render();
    return;
  }
  state.copied = true;
  state.error = undefined;
  render();
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    if (state?.copied) { state.copied = false; render(); }
  }, 2500);
}
