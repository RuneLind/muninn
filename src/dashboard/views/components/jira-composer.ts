/// <reference lib="dom" />
/**
 * The `/jira` composer's DOM half — state, render, listeners, the SSE run, the
 * `?draft=` poll, the clipboard write and the save. Everything testable lives
 * next door in `jira-composer-pure.ts`.
 *
 * **The stream is `fetch` + ReadableStream, not EventSource.** The same reason
 * `share-dialog.ts` gives, and it binds harder here: `POST /api/jira/draft`
 * answers a 409 `{state, expiresAtMs, error}` when a draft for the same raw
 * material is already running, and an EventSource exposes neither status nor body
 * on a non-200 (so both the sentence and the deadline are unreadable) and
 * auto-reconnects on a drop — straight back into the single-flight slot its own
 * first connection is holding. Framing is the shared, unit-tested
 * `makeSseFrameParser`.
 *
 * **A `?draft=` landing POLLS, it does not re-attach.** There is nothing to
 * attach to: the only SSE endpoint STARTS a generation, and a re-POST of
 * identical content hits that same 409. `GET /api/jira/draft/:id` answers
 * `generating` until the row settles, which is what the poll reads.
 *
 * **One module state, one listener registration.** `mountJiraComposer` is the
 * only entry point and wires its delegates once.
 */

import { makeSseFrameParser, type SseFrame } from "./client-runtime.ts";
import {
  JIRA_MARKDOWN_MAX,
  JIRA_NOTES_MAX,
  isJiraDepth,
  type JiraCitation,
  type JiraDonePayload,
  type JiraDraftView,
  type JiraKeyVerdict,
  type JiraMarkdownFlag,
} from "../../../jira/wire.ts";
import {
  JC_COPY_ID,
  JC_DEPTH_ATTR,
  JC_DIRTY_ID,
  JC_DOC_ATTR,
  JC_EXTRA_ID,
  JC_LEFT_ID,
  JC_MARKDOWN_ID,
  JC_MID_ID,
  JC_NOTES_COUNT_ID,
  JC_NOTES_ID,
  JC_OPEN_ATTR,
  JC_POLL_INTERVAL_MS,
  JC_POLL_MAX_MS,
  JC_PREVIEW_ID,
  JC_REGEN_ID,
  JC_RIGHT_ID,
  JC_SAVE_ID,
  JC_STATUS_ID,
  JC_SUBMIT_ID,
  JC_VIEW_ATTR,
  canSubmit,
  initialJiraState,
  jiraCitationsHtml,
  jiraConflictCopy,
  jiraDraftBody,
  jiraDraftHtml,
  jiraLeftHtml,
  shouldStopPolling,
  statusLineHtml,
  toggleExclusion,
  type JiraComposerState,
  type JiraTemplateOption,
} from "./jira-composer-pure.ts";

const state: JiraComposerState = initialJiraState();

let inFlight: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollStartedAt = 0;
let deltaFrame = 0;

// ── Mount ────────────────────────────────────────────────────────────────────

export function mountJiraComposer(): void {
  wire();
  renderAll();
  void loadTemplates();

  const draftId = new URLSearchParams(location.search).get("draft");
  if (draftId) {
    state.draftId = draftId;
    void adoptDraft(draftId, { thenPoll: true });
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Replace a column's markup, preserving the caret.
 *
 * The notes and the draft are both `<textarea>`s that live inside re-rendered
 * columns, so a naive `innerHTML =` mid-word moves the caret to the end (or drops
 * focus entirely). Same capture/restore discipline as `renderChatOptions`.
 */
function setHtml(node: HTMLElement | null, html: string): void {
  if (!node) return;
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && node.contains(active) && !!active.id;
  const id = inside ? active!.id : "";
  const sel =
    inside && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
  node.innerHTML = html;
  if (!id) return;
  const restored = document.getElementById(id);
  if (!restored) return;
  (restored as HTMLElement).focus({ preventScroll: true });
  if (sel && (restored instanceof HTMLTextAreaElement || restored instanceof HTMLInputElement)) {
    try {
      restored.setSelectionRange(sel.start ?? 0, sel.end ?? 0);
    } catch {
      /* a control with no selection API — nothing to restore */
    }
  }
}

function renderLeft(): void {
  setHtml(el(JC_LEFT_ID), jiraLeftHtml(state));
}

function renderMid(): void {
  setHtml(el(JC_MID_ID), jiraCitationsHtml(state));
}

function renderRight(): void {
  setHtml(el(JC_RIGHT_ID), jiraDraftHtml(state));
  paintPreview();
}

function renderAll(): void {
  renderLeft();
  renderMid();
  renderRight();
}

/**
 * The preview pane.
 *
 * Rendered with the SAME `formatWebHtml` the web chat and the wiki reader use —
 * published on `globalThis` by the web-format bundle the page injects — so the
 * preview cannot drift from muninn's own markdown pipeline, and `sanitizeHtml`
 * runs over the result exactly as it does there. If the bundle failed to load,
 * the fallback is escaped plain text rather than an unrendered blank pane: a
 * preview that silently shows nothing is worse than one that shows the source.
 *
 * **It is muninn's renderer, not Jira's**, and one difference is known and
 * accepted: `formatWebHtml` FLATTENS nested lists (measured — three `-` levels
 * come back as one `<ul>` with three `<li>`), while PR 0 measured Jira rendering
 * three levels with distinct glyphs. The preview is a legibility aid; what gets
 * pasted is the markdown in the textarea, byte for byte, and **Kopier markdown**
 * copies that, never this HTML.
 */
function paintPreview(): void {
  const pane = el(JC_PREVIEW_ID);
  if (!pane) return;
  const g = globalThis as {
    formatWebHtml?: (s: string) => string;
    // **The second argument is not optional in practice.** `sanitizeHtml(html)`
    // leaves `isWeb` undefined, which selects the TELEGRAM tag list — b/i/code/a
    // and nothing else — so every heading, list, table and blockquote was
    // replaced by its own text content and the preview rendered as one wall of
    // prose. Measured in the browser: `## Hei` + a list + a table came back as
    // `Hei\nab\nxy12`.
    sanitizeHtml?: (html: string, isWeb: boolean) => string;
  };
  if (typeof g.formatWebHtml !== "function") {
    pane.textContent = state.markdown;
    return;
  }
  const html = g.formatWebHtml(state.markdown);
  pane.innerHTML = typeof g.sanitizeHtml === "function" ? g.sanitizeHtml(html, true) : html;
}

/** Cheap partial repaints, used where a full column render would eat the caret. */
function syncLeftControls(): void {
  const btn = el(JC_SUBMIT_ID) as HTMLButtonElement | null;
  if (btn) btn.disabled = !canSubmit(state);
  const count = el(JC_NOTES_COUNT_ID);
  if (count) count.textContent = `${state.notes.length} / ${JIRA_NOTES_MAX}`;
  const status = el(JC_STATUS_ID);
  if (status) status.innerHTML = statusLineHtml(state);
}

function syncStatus(): void {
  const status = el(JC_STATUS_ID);
  if (status) status.innerHTML = statusLineHtml(state);
}

// ── Listeners (delegated, wired once) ────────────────────────────────────────

let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;

  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    if (target.closest(`#${JC_SUBMIT_ID}`) || target.closest(`#${JC_REGEN_ID}`)) {
      ev.preventDefault();
      void runDraft();
      return;
    }
    if (target.closest(`#${JC_COPY_ID}`)) {
      ev.preventDefault();
      void copyMarkdown();
      return;
    }
    if (target.closest(`#${JC_SAVE_ID}`)) {
      ev.preventDefault();
      void saveDraft();
      return;
    }
    const view = target.closest(`[${JC_VIEW_ATTR}]`) as HTMLElement | null;
    if (view) {
      ev.preventDefault();
      const mode = view.getAttribute(JC_VIEW_ATTR);
      state.view = mode === "preview" ? "preview" : "markdown";
      renderRight();
      return;
    }
    const open = target.closest(`[${JC_OPEN_ATTR}]`) as HTMLElement | null;
    if (open) {
      ev.preventDefault();
      const c = state.citations[Number(open.getAttribute(JC_OPEN_ATTR))];
      if (!c) return;
      const fn = (globalThis as { openDocPanel?: (co: string, id: string, url?: string) => void })
        .openDocPanel;
      // The panel is the page's own inline component; a missing global means the
      // page shipped without it, which is a build problem, not a reader problem.
      if (typeof fn === "function") fn(c.collection, c.docId, c.url);
      else console.warn("[jira] doc panel not mounted");
    }
  });

  document.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    if (target.id === "jcTemplate") {
      state.template = (target as HTMLSelectElement).value;
      return;
    }
    const depth = target.getAttribute?.(JC_DEPTH_ATTR);
    if (depth && isJiraDepth(depth)) {
      state.depth = depth;
      renderLeft();
      return;
    }
    const doc = target.getAttribute?.(JC_DOC_ATTR);
    if (doc !== null && doc !== undefined) {
      const c = state.citations[Number(doc)];
      if (!c) return;
      state.excludeDocIds = toggleExclusion(state.excludeDocIds, c.docId);
      renderMid();
    }
  });

  document.addEventListener("input", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.id === JC_NOTES_ID) {
      state.notes = (target as HTMLTextAreaElement).value;
      syncLeftControls();
      return;
    }
    if (target.id === JC_EXTRA_ID) {
      state.extra = (target as HTMLTextAreaElement).value;
      return;
    }
    if (target.id === JC_MARKDOWN_ID) {
      // The draft edit does NOT re-render: the reader is typing in this very
      // node. The unsaved marker is patched in place instead.
      state.markdown = (target as HTMLTextAreaElement).value;
      state.copied = false;
      const save = el(JC_SAVE_ID) as HTMLButtonElement | null;
      if (save) save.disabled = !state.draftId || !state.markdown || state.saving;
      const dirty = el(JC_DIRTY_ID);
      if (dirty) {
        dirty.hidden = state.savedMarkdown === undefined || state.markdown === state.savedMarkdown;
      }
    }
  });
}

// ── The templates picker ─────────────────────────────────────────────────────

async function loadTemplates(): Promise<void> {
  try {
    const res = await fetch("/api/jira/templates");
    const body = (await res.json()) as {
      bot?: string;
      templates?: JiraTemplateOption[];
      error?: string;
    };
    if (!res.ok) {
      state.templatesError = body.error || `Kunne ikke hente maler (HTTP ${res.status}).`;
    } else {
      // Rendered in the ORDER SERVED — `templates.ts` keeps the shipped set an
      // ordered array precisely because sorting the ids renders them as
      // `bug, spike, story, task`.
      state.templates = Array.isArray(body.templates) ? body.templates : [];
      if (body.bot) state.bot = body.bot;
      if (!state.template && state.templates[0]) state.template = state.templates[0].id;
    }
  } catch (err) {
    state.templatesError = `Kunne ikke hente maler: ${errText(err)}`;
  }
  renderLeft();
}

// ── A generation ─────────────────────────────────────────────────────────────

async function runDraft(): Promise<void> {
  if (!canSubmit(state)) return;
  const ctrl = new AbortController();
  inFlight?.abort();
  inFlight = ctrl;
  stopPolling();

  state.running = true;
  state.streamed = "";
  state.phase = undefined;
  state.error = undefined;
  state.conflictExpiresAtMs = undefined;
  state.savedNote = undefined;
  state.copied = false;
  renderAll();

  const settle = (patch: Partial<JiraComposerState>): void => {
    if (inFlight !== ctrl) return;
    Object.assign(state, patch, { running: false });
    inFlight = null;
    renderAll();
  };

  let res: Response;
  try {
    res = await fetch("/api/jira/draft", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(jiraDraftBody(state)),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (!ctrl.signal.aborted) settle({ error: `Fikk ikke kontakt med serveren: ${errText(err)}` });
    return;
  }

  if (res.status === 409) {
    // The whole reason this is a fetch and not an EventSource: the deadline is
    // in the body of a non-200.
    let body: { expiresAtMs?: unknown; error?: unknown } = {};
    try {
      body = (await res.json()) as { expiresAtMs?: unknown; error?: unknown };
    } catch {
      /* keep the defaults */
    }
    if (ctrl.signal.aborted) return;
    const at = typeof body.expiresAtMs === "number" ? body.expiresAtMs : Date.now();
    settle({
      conflictExpiresAtMs: at,
      error: jiraConflictCopy(typeof body.error === "string" ? body.error : undefined, at, Date.now()),
    });
    return;
  }

  if (!res.ok || !res.body) {
    let msg = `Utkastet kunne ikke startes (HTTP ${res.status}).`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (b && typeof b.error === "string") msg = b.error;
    } catch {
      /* non-JSON body — keep the status copy */
    }
    if (ctrl.signal.aborted) return;
    settle({ error: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done: JiraDonePayload | null = null;
  let appError: string | undefined;
  const parser = makeSseFrameParser((frame) => {
    const out = dispatchJiraFrame(frame, ctrl);
    if (out.done) done = out.done;
    if (out.error) appError = out.error;
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
    if (!ctrl.signal.aborted) {
      // The row is the record — the server finishes the draft even with no
      // client attached — so a dropped stream is a reason to POLL, not to lose
      // the work.
      settle({ error: "Forbindelsen falt — henter utkastet fra serveren." });
      if (state.draftId) void adoptDraft(state.draftId, { thenPoll: true });
    }
    return;
  }
  if (ctrl.signal.aborted) return;

  if (done) {
    const d: JiraDonePayload = done;
    settle({
      draftId: d.draftId,
      status: "ready",
      markdown: d.markdown,
      savedMarkdown: d.markdown,
      // **The done payload's `citations` are the RETAINED set**, post-exclusion
      // and renumbered — what the draft was written from, not what retrieval
      // stored. The middle column must keep showing the WIDE set, or the rows
      // the reader just switched off would disappear and there would be nothing
      // left to switch back on. The wide set comes from the `citations` event
      // (first draft) or from the row the page loaded (regenerate); the fallback
      // below only covers a stream that somehow carried neither.
      citations: state.citations.length ? state.citations : d.citations,
      keyVerdicts: d.keyVerdicts,
      markdownFlags: d.markdownFlags,
      coverage: d.coverage,
      retrievalCoverage: d.retrievalCoverage,
      retrievalQuestion: d.retrievalQuestion,
      streamed: "",
      error: undefined,
    });
    stampDraftInUrl(d.draftId);
    return;
  }
  settle({ error: appError ?? "Utkastet kom aldri — ingenting ble generert." });
}

/**
 * Decode one frame.
 *
 * The route's vocabulary is `draft` · `phase` · `citations` · `delta` · `done` ·
 * `app_error` · `end` · `heartbeat`. The last two are named explicitly rather
 * than falling through, so a future event cannot be swallowed as "probably a
 * sentinel".
 */
function dispatchJiraFrame(
  frame: SseFrame,
  ctrl: AbortController,
): { done?: JiraDonePayload; error?: string } {
  if (inFlight !== ctrl) return {};
  let data: Record<string, unknown> = {};
  try {
    data = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {};
  } catch {
    return {};
  }

  switch (frame.event) {
    case "draft": {
      // Emitted FIRST, before any expensive work, so an abort a second later
      // still knows which row to poll.
      if (typeof data.draftId === "string") {
        state.draftId = data.draftId;
        stampDraftInUrl(data.draftId);
      }
      return {};
    }
    case "phase": {
      state.phase = typeof data.phase === "string" ? data.phase : undefined;
      if (typeof data.question === "string") {
        state.retrievalQuestion = data.question;
        renderMid();
      }
      syncStatus();
      return {};
    }
    case "citations": {
      // The WIDE stored set, before this run's depth slice — the toggle column
      // renders exactly this, unchanged when the depth dial moves.
      if (Array.isArray(data.citations)) state.citations = data.citations as JiraCitation[];
      if (typeof data.coverage === "string") state.coverage = data.coverage as JiraDonePayload["coverage"];
      renderMid();
      return {};
    }
    case "delta": {
      if (typeof data.text === "string") state.streamed += data.text;
      scheduleDeltaPaint();
      return {};
    }
    case "done":
      return { done: data as unknown as JiraDonePayload };
    case "app_error":
      return { error: typeof data.message === "string" ? data.message : "Utkastet feilet." };
    case "end":
    case "heartbeat":
      return {};
    default:
      return {};
  }
}

/** Coalesce delta paints to one per frame — a Full draft emits thousands. */
function scheduleDeltaPaint(): void {
  if (deltaFrame) return;
  deltaFrame = requestAnimationFrame(() => {
    deltaFrame = 0;
    renderRight();
  });
}

// ── `?draft=<id>` — read, then poll ──────────────────────────────────────────

/** Fold a stored draft into the state. Never throws. */
async function adoptDraft(id: string, opts: { thenPoll?: boolean } = {}): Promise<void> {
  try {
    const res = await fetch(`/api/jira/draft/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
    });
    const body = (await res.json()) as JiraDraftView & { error?: string };
    if (!res.ok) {
      state.polling = false;
      state.error = body?.error || `Fant ikke utkastet (HTTP ${res.status}).`;
      renderAll();
      return;
    }
    applyDraftView(body);
    if (opts.thenPoll && !shouldStopPolling(body.status)) startPolling(id);
    else state.polling = false;
    renderAll();
  } catch (err) {
    state.polling = false;
    state.error = `Kunne ikke hente utkastet: ${errText(err)}`;
    renderAll();
  }
}

function applyDraftView(v: JiraDraftView): void {
  state.draftId = v.draftId;
  state.status = v.status;
  state.template = v.template || state.template;
  if (isJiraDepth(v.depth)) state.depth = v.depth;
  state.notes = typeof v.notes === "string" ? v.notes : state.notes;
  state.extra = typeof v.extra === "string" ? v.extra : state.extra;
  state.markdown = v.markdown ?? "";
  state.savedMarkdown = v.markdown ?? undefined;
  state.citations = Array.isArray(v.citations) ? v.citations : [];
  // The toggles reflect the exclusion set the LAST generation ran under — stored
  // on the row for exactly this reason, so a reload cannot show 24 live rows
  // beside markdown that cites 23.
  state.excludeDocIds = Array.isArray(v.excludeDocIds) ? [...v.excludeDocIds] : [];
  state.keyVerdicts = (v.keyVerdicts ?? []) as JiraKeyVerdict[];
  state.markdownFlags = (v.markdownFlags ?? []) as JiraMarkdownFlag[];
  state.coverage = v.coverage ?? null;
  state.retrievalCoverage = v.retrievalCoverage ?? null;
  state.retrievalQuestion = v.retrievalQuestion ?? "";
  state.error = v.status === "failed" ? (v.error ?? "Utkastet feilet.") : undefined;
  state.copied = false;
}

function startPolling(id: string): void {
  stopPolling();
  state.polling = true;
  pollStartedAt = Date.now();
  const tick = async (): Promise<void> => {
    pollTimer = null;
    if (!state.polling) return;
    if (Date.now() - pollStartedAt > JC_POLL_MAX_MS) {
      state.polling = false;
      state.error =
        "Utkastet er fortsatt merket «skrives» etter 13 minutter — lengre enn serverens egen frist. Prøv å skrive det på nytt.";
      renderAll();
      return;
    }
    try {
      const res = await fetch(`/api/jira/draft/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as JiraDraftView;
        applyDraftView(body);
        if (shouldStopPolling(body.status)) {
          state.polling = false;
          renderAll();
          return;
        }
        renderAll();
      }
    } catch {
      // A failed tick is not a failed draft — keep polling; the row is the record.
    }
    if (state.polling) pollTimer = setTimeout(() => void tick(), JC_POLL_INTERVAL_MS);
  };
  pollTimer = setTimeout(() => void tick(), JC_POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  state.polling = false;
}

/** Keep `?draft=` on the URL so a reload lands on the same draft. */
function stampDraftInUrl(id: string): void {
  const url = new URL(location.href);
  if (url.searchParams.get("draft") === id) return;
  url.searchParams.set("draft", id);
  history.replaceState(null, "", url.toString());
}

// ── Copy + save ──────────────────────────────────────────────────────────────

async function copyMarkdown(): Promise<void> {
  if (!state.markdown) return;
  try {
    await navigator.clipboard.writeText(state.markdown);
    state.copied = true;
    state.error = undefined;
  } catch {
    // A denied clipboard permission is the common case on a non-focused tab;
    // saying so beats a button that silently does nothing.
    state.error = "Utklippstavlen ble avvist av nettleseren — marker teksten og kopier manuelt.";
  }
  renderRight();
}

async function saveDraft(): Promise<void> {
  if (!state.draftId || !state.markdown || state.saving) return;
  if (state.markdown.length > JIRA_MARKDOWN_MAX) {
    state.error = `Utkastet er ${state.markdown.length} tegn — grensen er ${JIRA_MARKDOWN_MAX}.`;
    renderRight();
    return;
  }
  state.saving = true;
  state.savedNote = undefined;
  state.error = undefined;
  renderRight();

  try {
    const res = await fetch(`/api/jira/draft/${encodeURIComponent(state.draftId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: state.markdown }),
    });
    const body = (await res.json()) as {
      error?: string;
      keyVerdicts?: JiraKeyVerdict[];
      markdownFlags?: JiraMarkdownFlag[];
    };
    if (!res.ok) {
      state.error = body?.error || `Lagring feilet (HTTP ${res.status}).`;
    } else {
      // BOTH post-passes are re-run server-side against the edited text and come
      // back with the 200 — so the chips and the flag list describe the text that
      // is now stored, not the text the model wrote.
      state.savedMarkdown = state.markdown;
      state.keyVerdicts = body.keyVerdicts ?? state.keyVerdicts;
      state.markdownFlags = body.markdownFlags ?? state.markdownFlags;
      state.savedNote = "Lagret.";
    }
  } catch (err) {
    state.error = `Lagring feilet: ${errText(err)}`;
  }
  state.saving = false;
  renderRight();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
