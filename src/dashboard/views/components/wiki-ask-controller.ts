/// <reference lib="dom" />
/**
 * The /wiki reader's Ask tab: `runAskStream` and its handlers, claim retry (↻),
 * integrate into article and session persistence. Moved out of the shell
 * (`wiki-browser.ts`) verbatim, in source order (mimir plan
 * muninn-wiki-browser-split, C4).
 *
 * Importing this module runs nothing. The shell's `boot()` calls
 * {@link initAsk} beside `initEffort` and {@link registerIntegratePreviewInputs}
 * where those two listeners sat in it; every other Ask listener stays in
 * `boot()` and calls the exports. This module never imports the shell: what Ask
 * reads and calls there arrives through {@link AskTurnPort}, the `RailDeps`
 * shape. Ask owns its turn state (`askTurns`, `askShownTurn`, `integratePreview`)
 * and exports getters for the first two, so the port carries no
 * `getShownTurn()` or `repaintBody()`: those flow the other way. Leaf imports
 * (`wiki-ask-render.ts`, `wiki-ask-session.ts`, `wiki-shell-state.ts`'s
 * `setCurrentName`, the rail's `renderList`) are imported directly and are not
 * port members.
 */
import { escHtml as esc } from "./escape.ts";
import {
  wikiReadonlyWikiFlag,
  WIKI_READONLY_INPUT_PLACEHOLDER,
} from "./wiki-readonly-client.ts";
import { makeSseFrameParser, sseClient, type SseFrame, type SseHandle } from "./client-runtime.ts";
import { askAnswerBodyHtml, renderStreamingBody, enhanceConfidenceHtml } from "./wiki-ask-render.ts";
import {
  tallyClaimOutcomes,
  factcheckOutcomeSummary,
  appendSuccessStatus,
  type ClaimOutcomeCounts,
} from "./wiki-factcheck-outcomes.ts";
import {
  applyToolLogEvent,
  toolLogRowLabel,
  type ToolLogRow,
} from "./wiki-explain.ts";
import {
  chatEscBarHtml,
  composeDeclineQuestion,
  CHAT_ESC_ANSWER_MAX,
  type ChatEscState,
} from "./wiki-chat-target.ts";
import { enhanceMermaid } from "./wiki-mermaid.ts";
import { revealRightPane } from "./wiki-pane-toggle.ts";
import { enhanceCodeTabs } from "./code-tabs.ts";
import { enhanceCodeBlocks } from "./code-block-chrome.ts";
import { type DeclineReason } from "../../../wiki/ask-chat.ts";
import {
  askDeclineReason,
  askStatusText,
  serializeAskSession,
  deserializeAskSession,
  type StoredAskTurn,
} from "./wiki-ask-session.ts";
import {
  appendLedeAmendment,
  claimCountFromMap,
  claimOutcomeMapFromRows,
  claimRefFromHeadingText,
  claimRetryBatchLabel,
  claimRetryDoneCopy,
  claimRetryRunningCopy,
  claimRetryStoppedCopy,
  claimRetryUrlFor,
  isClaimOutcome,
  outcomeCountsFromMap,
  retryableClaims,
  spliceClaimBlock,
  CLAIM_RETRY_APPLY_RACE_COPY,
  CLAIM_RETRY_CANCEL_COPY,
  CLAIM_RETRY_WROTE_COPY,
  type ClaimOutcomeByIndex,
  type ClaimRetryStopReason,
  type RetryableClaim,
} from "./wiki-claim-retry.ts";
import {
  annotationIndexes,
  appendBlockedByIntegrate,
  buildIntegrateApplyBody,
  carriesFactWrapper,
  claimQuotesFromClaimsEvent,
  integrateBarState,
  integratePreviewHtml,
  integrateSuccessCopy,
  INTEGRATE_NO_ANCHORS_COPY,
  INTEGRATE_STALE_COPY,
  appendBlockedCopy,
  appendBlockedTone,
  shouldOpenDroppedList,
  INTEGRATE_STALE_COPY_EDIT,
  WIKI_LOCKED_COPY,
  isLockedResponse,
  type DroppedEditRow,
  type IntegrateProposal,
} from "./wiki-integrate.ts";
import { renderList } from "./wiki-rail-controller.ts";
import { setCurrentName } from "./wiki-shell-state.ts";

/** What Ask reads and calls on the shell, read live through a function so a
 *  value the shell reassigns is never a stale copy. */
export interface AskTurnPort {
  /** The shell's `WIKI` let (the active wiki's name), read for every Ask URL. */
  WIKI(): string;
  /** The shell's `clearShownPage()`: an Ask answer replaces the page, so
   *  `showAskAnswer` clears `currentRelPath`, `currentPageHash`, graph mode and
   *  the breadcrumb, the C3 command `renderEffort` already uses. Its
   *  `removeGraph()` aborts the graph fetch and drops its section, and its
   *  `hideBreadcrumb()` does more than its name says: `abortProvLoad()`,
   *  `unmountAnswerExport()`, `closeWalkthroughOnNavigate(null)` and
   *  `currentArticle = null` (with `clearOutgoingTitles()`) run inside it. */
  clearShownPage(): void;
  /** The article controller's `switchConnTab()`, relayed by the shell (right-rail tabs, C5): `runAskStream` shows the Ask tab. */
  switchConnTab(tab: string): void;
  /** The shell's `reloadPageInPlace()` (page loading; the walkthrough's Reload
   *  calls it too): a fact-check write re-opens the checked page. */
  reloadPageInPlace(relPath: string | undefined, name?: string): void;
}

/** Set once, by {@link initAsk}, before anything here runs. */
let deps!: AskTurnPort;

// ── Ask tab: research-style Q&A scoped to this wiki ───────────────────
// The controls (question box · status line · history list) live in the right
// column's Ask tab; the ANSWER renders as a formatted article in the main pane
// (articleWrap). The streaming buffer is rendered progressively through the same
// `formatWebHtml` markdown pipeline (throttled to one frame per rAF), so headings/
// lists/code grow formatted during the stream rather than as a wall of plain text;
// the trailing server-rendered `answer_html` (with resolved citations) then swaps
// in as the final article.
interface AskCitation {
  n: number;
  collection: string;
  docId: string;
  title: string;
  url?: string;
  badge: string;
  relevance: number;
  wikiName?: string;
  pageName?: string;
  /** The matched page's exact wiki-relative path — the collision-proof click
   *  target beside `pageName` (see `Citation.pageRelPath`). */
  pageRelPath?: string;
}
export interface AskTurn {
  question: string;
  answer: string; // final plain-text answer (history context + streaming fallback)
  citations: AskCitation[];
  cited: number[];
  html: string | null; // server-rendered answer body HTML (null until answer_html)
  askedAt: number;
  kind?: string; // "factcheck" for a fact-check turn (status line; PR B ➕ gate). Absent ⇒ Ask/Explain.
  baseHash?: string; // sha256 of the checked page at fact-check time (factcheck turns only; PR B round-trips it)
  page?: string; // the checked page's name — the ➕ append target (factcheck turns only)
  // The checked page's exact wiki-relative path — the COLLISION-PROOF half of that
  // target, sent beside the name by every action this turn can launch (➕ append,
  // ✎ integrate, ↻ claim retry, the post-write reload). It rides the TURN, not
  // `currentArticle`, because a persisted turn outlives the open article. See
  // `StoredAskTurn.pageRelPath`.
  pageRelPath?: string;
  pageType?: string; // the checked page's type — ➕ gates markdown-only (hides on "explainer")
  toolSources?: string[]; // hostnames consulted during a fact check (WebFetch targets, deduped)
  toolSourceUrls?: Record<string, string>; // host → first full URL seen (feeds the Consulting chip hrefs). Persisted intentionally; a pre-PR / malformed-dropped turn lacks it ⇒ chips fall back to https://<host>/.
  claimCount?: number; // claims verified in a fact check (from the `done` payload; drives the meta line)
  claimOutcomes?: ClaimOutcomeCounts; // per-outcome tally for the honest fact-check meta line (persisted)
  // Per-claim outcome keyed by the claim's 1-based index. PERSISTED: it is what
  // decides which claims get a ↻ retry, while the outcomes themselves arrive only
  // on the transient `claim_result` events. The tally beside it counts but can't
  // say WHICH claim timed out. After a successful retry this map is the single
  // authority — `claimOutcomes` + `claimCount` are re-derived from it.
  claimOutcomeByIndex?: ClaimOutcomeByIndex;
  // The fact-check mode + the selection/heading it ran against, so a ↻ can re-issue
  // the same scoped call (a sel-mode turn retried in article mode would verify the
  // claim against a passage nobody selected). PERSISTED.
  fcMode?: string;
  fcSel?: string;
  fcCtx?: string;
  claims?: ClaimRow[]; // per-claim checklist for a multi-claim fact check (transient; not persisted)
  toolLog?: ToolLogRow[]; // compact per-claim tool log during a fact check (transient; not persisted)
  // Which write action this turn already performed. PERSISTED, because both write
  // buttons' disabled state is derived from it at render time — a DOM-only disable
  // would come back enabled after a reload and the click would only ever 409
  // (whichever write happened staled this turn's baseHash).
  wrote?: string; // "append" | "integrate"
  // Did that write actually persist a fact-check BLOCK (the `.mdx` `<FactCheck>`
  // appendix or the `.md` `> [!factcheck]` callout)? PERSISTED for the same reason
  // as `wrote`: the ➕ bar's copy AND its tone are derived from it at render time.
  // Deliberately not inferred from `annotatable` — the apply route has an explicit
  // no-block branch that an `.mdx` page reaches whenever every mark drops and the
  // callout checkbox is off.
  wroteBlock?: boolean;
  // Integrate-relevant body length of the checked page (from the `done` payload;
  // omitted for explainers). Drives the client-side page-too-long gate so ~10% of
  // pages don't have to learn it from a server 400.
  bodyLen?: number;
  // Per-claim verbatim supporting passages from Phase-1 extraction, keyed by the
  // claim's 1-based index (a claim the extractor gave no quote for is absent).
  // PERSISTED: they arrive on the transient `claims` event, which is dropped at
  // `done`, and the integrate propose POST re-sends them from the turn.
  claimQuotes?: { index: number; quote: string }[];
  // Whether the checked page can carry inline <Fact> annotations (server-derived
  // .mdx-ness of the resolved path). Absent on an older server ⇒ not annotatable.
  annotatable?: boolean;
  // The retrieval decline that ended this turn, mapped from the `done` payload by
  // `askDeclineReason` (which checks lowConfidence FIRST — `noHits` is true on both
  // decline branches). PERSISTED: the decline hook replaces the ordinary escalate
  // bar and is re-derived on every turn switch / rehydrate, while the flags exist
  // only on the transient `done` event.
  declined?: DeclineReason;
  // Explain turns only: the page the passage was selected from (its title, else
  // its name). PERSISTED — without it an escalated Explain turn carries only the
  // `Explain: "…"` display label, which names neither the page nor the real
  // question (`composeDeclineQuestion`).
  explainPage?: string;
  // Follow-up turns only: the ALREADY-COMPOSED question that opened this chain.
  // PERSISTED for the same reason — "and what about the second one?" is
  // unanswerable on its own. Chains keep the ROOT (a follow-up of a follow-up
  // inherits its parent's origin rather than nesting).
  originQuestion?: string;
  // "Continue in chat →" state for THIS turn. Not declared on StoredAskTurn — but
  // `serializeAskSession` JSON-stringifies the live turns, so it DOES ride along
  // into localStorage and a rehydrated turn can still show a link to a thread from
  // a previous session (accepted, pre-existing; `isValidTurn` neither validates nor
  // strips it). The field's real job is intra-session: `#wikiChatEscBar` is a
  // singleton node owned by whichever turn is painted, so holding the outcome on
  // the TURN is what stops a late fetch painting turn A's result onto turn B.
  chatEsc?: ChatEscState;
}
// One row of the fact-check claim checklist — pending until its verdict block lands.
// `outcome` lands with the verdict (server `claim_result`) and drives the distinct
// checklist label. The band-colored confidence chip is rendered from the verdict
// block's own `Confidence: NN/100` line by enhanceConfidenceHtml (no separate field).
interface ClaimRow { index: number; title: string; status: string; block: string; outcome?: string; }
const askTurns: AskTurn[] = [];
let askConn: SseHandle | null = null;
let askActive: AskTurn | null = null; // the turn currently streaming, or null
let askShownTurn: AskTurn | null = null; // the turn currently painted in the pane
let askBuffer = ""; // streamed plain-text accumulator for askActive
let composeText = ""; // fact-check compose lede accumulator (Phase 3 deltas)
let askRenderRaf = 0; // pending progressive-render frame (0 = none)
const ASK_MAX_HISTORY = 4;
const ASK_ANSWER_CHARS = 700;

/** Throttle progressive markdown renders of the streaming buffer to one per
 *  animation frame (as the web chat does), coalescing bursts of deltas. The
 *  frame re-checks identity + final-HTML at FIRE time: a frame scheduled just
 *  before `answer_html` lands (or before a follow-up ask swaps `askConn`) must
 *  not repaint over the final article or clobber the newer turn's pane. */
function scheduleAskStreamRender(turn: AskTurn, conn: SseHandle): void {
  if (askRenderRaf) return;
  askRenderRaf = requestAnimationFrame(() => {
    askRenderRaf = 0;
    if (askConn !== conn) return; // superseded by a newer ask
    if (turn.html) return; // final article already swapped in
    const b = document.getElementById("askAnswerBody");
    if (b) { b.innerHTML = renderStreamingBody(askBuffer); } // confidence chip baked into renderStreamingBody
  });
}

/** Rebuild `askBuffer` for a multi-phase fact-check turn: the compose lede (empty
 *  until Phase 3) on top, then each claim's verdict block (once verified) or its
 *  pending checklist row (`n. ☐ <title>`), in claim order. Called on every
 *  `claims`/`claim_result`/compose-`delta` so the pane grows coherently with no
 *  transient bottom-then-top reorder at `done`. */
function rebuildFactcheckBuffer(turn: AskTurn): void {
  const claims = turn.claims || [];
  const rows = claims.map((c) => factcheckRowMarkdown(c));
  askBuffer = (composeText ? composeText + "\n\n" : "") + rows.join("\n\n");
}

/** One checklist row's live markdown. Pending ⇒ `n. ☐ title`. A real verdict
 *  (verified / model-chosen unverifiable) renders the model block verbatim (its
 *  emoji + reasoning + `Confidence:` line, chip-enhanced post-render). The
 *  synthetic non-verdict outcomes get a DISTINCT compact label instead of a
 *  generic ❓ block, so "ran out of time" reads differently from "the web
 *  genuinely doesn't know" (the persisted answer keeps ❓ — this is live-only). */
function factcheckRowMarkdown(c: ClaimRow): string {
  if (c.status !== "done") return c.index + ". ☐ " + c.title;
  if (c.outcome === "timeout") return c.index + ". ⏱️ " + c.title + " — timed out";
  if (c.outcome === "skipped") return c.index + ". ⏭️ " + c.title + " — skipped (out of time)";
  if (c.outcome === "error") return c.index + ". ⚠️ " + c.title + " — verification failed";
  return c.block || c.index + ". ☐ " + c.title;
}

/** Cancel any pending progressive-render frame (on supersede / done / final swap). */
function cancelAskStreamRender(): void {
  if (askRenderRaf) {
    cancelAnimationFrame(askRenderRaf);
    askRenderRaf = 0;
  }
}

/** Compact, bounded replay of committed turns sent as context on each follow-up. */
export function askHistoryParam(): string {
  if (!askTurns.length) return "";
  const recent = askTurns.slice(-ASK_MAX_HISTORY).map((t) => ({
    q: (t.question || "").slice(0, 500),
    a: (t.answer || "").slice(0, ASK_ANSWER_CHARS),
  }));
  return JSON.stringify(recent);
}

/** Update the single status line in the Ask controls. Empty text hides it. */
function setAskStatus(text: string, state: string): void {
  const wrap = document.getElementById("wikiAskStatus");
  if (!wrap) return;
  wrap.className = "wiki-ask-status" + (state ? " " + state : "");
  wrap.style.display = text ? "flex" : "none";
  const st = wrap.querySelector(".st") as HTMLElement | null;
  if (st) st.textContent = text;
}

/** Relative "asked …" label for the answer's meta row. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

/** Render the citation list — matched pages become in-reader links (data-page,
 *  handled by the global delegated click), the rest are plain rows. */
function askSourcesHtml(citations: AskCitation[], cited: number[]): string {
  if (!citations.length) return "";
  const citedSet: Record<number, boolean> = {};
  (cited || []).forEach((n) => { citedSet[n] = true; });
  const anyCited = (cited || []).length > 0;
  const rows = citations
    .map((c) => {
      const uncited = anyCited && !citedSet[c.n] ? " uncited" : "";
      const linked = c.pageName ? " linked" : "";
      // Both keys, as on every other row emitter: `data-relpath` names ONE page
      // and `navTargetFrom` prefers it; the name stays for a citation the
      // enrichment could not give a path.
      const pageAttr =
        (c.pageName ? ' data-page="' + esc(c.pageName) + '"' : "") +
        (c.pageRelPath ? ' data-relpath="' + esc(c.pageRelPath) + '"' : "");
      const pageTag = c.pageName ? '<span class="wiki-ask-src-page">page ↗</span>' : "";
      return (
        '<div class="wiki-ask-src' + uncited + linked + '"' + pageAttr + ">" +
        '<span class="wiki-ask-src-num">' + c.n + "</span>" +
        '<span class="wiki-ask-src-badge">' + esc(c.badge || "") + "</span>" +
        '<span class="wiki-ask-src-title">' + esc(c.title || c.docId) + "</span>" +
        pageTag +
        "</div>"
      );
    })
    .join("");
  return '<div class="wiki-ask-src-head">Sources</div>' + rows;
}

/** Meta line under the answer's headline. Ask/Explain: "Asked … · wiki: X · N sources".
 *  Fact-check has no retrieval sources (`citations` is always empty), so counting
 *  them shows a misleading "0 sources" next to the "Consulting: <hosts>" chip row —
 *  instead report the claim count + the number of sites actually opened. */
function askMetaText(turn: AskTurn): string {
  const prefix = "Asked " + relTime(turn.askedAt) + (deps.WIKI() ? " · wiki: " + deps.WIKI() : "");
  if (turn.kind === "factcheck") {
    const sites = (turn.toolSources || []).length;
    const sitesLabel = sites ? " · " + sites + " site" + (sites === 1 ? "" : "s") + " consulted" : "";
    // Prefer the honest per-outcome breakdown ("5 verified · 1 unverifiable · 2
    // skipped"); fall back to the plain claim count for a pre-outcome turn.
    const summary = turn.claimOutcomes ? factcheckOutcomeSummary(turn.claimOutcomes) : "";
    if (summary) return prefix + " · " + summary + sitesLabel;
    const claims = typeof turn.claimCount === "number" ? turn.claimCount : 0;
    return prefix + " · " + claims + " claim" + (claims === 1 ? "" : "s") + sitesLabel;
  }
  const n = turn.citations.length;
  return prefix + " · " + n + " source" + (n === 1 ? "" : "s");
}

/** Follow-up bar rendered under every Ask/Explain answer (input + Ask button).
 *  Bound via document-level delegation (`showAskAnswer` replaces the whole pane
 *  per turn, destroying direct listeners). Disabled until the turn is committed
 *  (`turn.answer` is assigned only in the `done` handler) — the `done`/`answer_html`
 *  handlers re-enable it by id, since they replace only `#askAnswerBody`. */
function askFollowupHtml(turn: AskTurn): string {
  // A read-only wiki disables the bar at RENDER time, not only through the body
  // class: `disabled` is a per-render property and this bar is repainted on
  // every turn switch / SSE terminal event / splice, so a one-shot DOM sweep at
  // boot would be undone by the next paint. (The body-class guard still cancels
  // the mousedown/Enter, and the placeholder is the same shared string the
  // server renders into `#wikiAskInput`.)
  const ro = wikiReadonlyWikiFlag();
  const disabled = turn.answer && !ro ? "" : " disabled";
  const placeholder = ro ? WIKI_READONLY_INPUT_PLACEHOLDER : "Ask a follow-up…";
  return (
    '<div class="wiki-followup" id="wikiFollowupBar">' +
    '<input id="wikiFollowupInput" class="wiki-followup-input" type="text" ' +
    'placeholder="' + esc(placeholder) + '" autocomplete="off"' + disabled + " />" +
    '<button id="wikiFollowupBtn" class="wiki-followup-btn"' + disabled + ">Ask</button>" +
    "</div>"
  );
}

/** "Remember this" button rendered under the follow-up bar. Persists the shown
 *  turn's Q&A as a durable memory (POST /api/wiki/remember). Gated on the turn
 *  being committed (same `turn.answer` gate as the follow-up bar) and bound via
 *  document-level delegation. One save per render — a re-render resets it. */
function askRememberHtml(turn: AskTurn): string {
  const disabled = turn.answer ? "" : " disabled";
  return (
    '<div class="wiki-remember" id="wikiRememberBar">' +
    '<button id="wikiRememberBtn" class="wiki-remember-btn"' + disabled + ">Remember this</button>" +
    '<span class="wiki-remember-msg" id="wikiRememberMsg"></span>' +
    "</div>"
  );
}

/** "Continue in chat →" bar, a sibling of Remember. Escalates the shown turn into
 *  a real conversation thread for the wiki's owning bot (POST /api/wiki/ask/chat),
 *  seeded with the question + this answer + its sources, and opens the chat
 *  deep-link in a new tab. Its own bar (not the Remember bar, whose innerHTML is
 *  swapped wholesale on a successful save). Bound via document-level delegation.
 *
 *  The WRAPPER is always rendered (even when the inner markup is empty): the pane
 *  is painted before the answer exists, and `refreshChatEscalateBar` fills the bar
 *  in place at `done` — which needs the node to be there. `.wiki-chatesc:empty`
 *  hides the empty row. */
function askChatEscalateHtml(turn: AskTurn): string {
  return '<div class="wiki-chatesc" id="wikiChatEscBar">' + chatEscBarHtml(turn) + "</div>";
}

/** Re-render the escalate bar from the turn. TURN-GUARDED for the same reason
 *  `refreshWriteActionBars` is: the bar is a singleton node belonging to whichever
 *  turn is on screen. Nothing is lost by skipping — `showAskAnswer` renders the
 *  bar from the newly shown turn's own `chatEsc`. */
export function refreshChatEscalateBar(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const bar = document.getElementById("wikiChatEscBar");
  if (bar) bar.innerHTML = chatEscBarHtml(turn);
}

/** "➕ Add to article" button — ONLY on committed fact-check turns whose page is
 *  markdown (never an explainer, whose .html can't take a markdown callout).
 *  Persists the fact-check answer as a `> [!factcheck]` callout on the page
 *  (POST /api/wiki/factcheck/append). Bound via document-level delegation, gated
 *  on the turn being committed (same `turn.answer` gate as the follow-up bar). */
function askFactcheckAppendHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck" || turn.pageType === "explainer" || !turn.page) return "";
  return (
    '<div class="wiki-fc-append" id="wikiFactcheckAppendBar">' +
    factcheckAppendInnerHtml(turn) +
    "</div>"
  );
}

/** Inner markup of the ➕ bar, DERIVED from the turn (never mutated in place only)
 *  so a re-render — including a rehydrated turn after a reload — reproduces the
 *  post-write state. An integrate write staled this turn's `baseHash`, so the
 *  button goes disabled with the same copy a live 409 would show. */
function factcheckAppendInnerHtml(turn: AskTurn): string {
  if (turn.wrote === "append") {
    return '<span class="wiki-fc-append-done">✓ Added to article</span>';
  }
  const blocked = appendBlockedByIntegrate(turn);
  const disabled = turn.answer && !blocked ? "" : " disabled";
  // A write that COMPLETED is not an error. The tone and the words come from the
  // same turn state, so the red class and the sentence can never disagree the way
  // they did when the class was derived from `blocked` alone.
  const tone = blocked && appendBlockedTone(turn) === "error" ? " error" : "";
  return (
    '<button id="wikiFactcheckAppendBtn" class="wiki-fc-append-btn"' + disabled + ">➕ Add to article</button>" +
    '<span class="wiki-fc-append-msg' + tone + '" id="wikiFactcheckAppendMsg">' +
    (blocked ? esc(appendBlockedCopy(turn)) : "") +
    "</span>"
  );
}

/** "✎ Integrate into article" — the second write action on a fact-check turn.
 *  Unlike ➕ (which appends a callout) it EDITS THE PROSE, so it only renders when
 *  the check actually found something correctable (a ❌/⚠️ claim block, via the
 *  shared heading parser — never a substring scan) on a markdown page within the
 *  integrate body cap. The whole bar is derived from `integrateBarState`. */
function askFactcheckIntegrateHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck" || turn.pageType === "explainer" || !turn.page) return "";
  // An all-✅ / non-correctable check never becomes integrable, so drop the
  // wrapper entirely — it carries margin, and an always-empty div left a phantom
  // gap under the ➕ row. A `pending` turn KEEPS the (empty) wrapper: `done`
  // fills it in place via `refreshWriteActionBars`, which needs the node to exist.
  // `.wiki-fc-integrate:empty` hides it meanwhile.
  if (integrateBarState(turn) === "hidden") return "";
  return (
    '<div class="wiki-fc-integrate" id="wikiFactcheckIntegrateBar">' +
    factcheckIntegrateInnerHtml(turn) +
    "</div>"
  );
}

function factcheckIntegrateInnerHtml(turn: AskTurn): string {
  const state = integrateBarState(turn);
  if (state === "hidden" || state === "pending") return "";
  if (state === "done") {
    // Within the session the label carries the full outcome copy (edit count +
    // whether it was committed); a rehydrated turn only knows THAT it integrated.
    const note = integratedNotes[turn.askedAt];
    return '<span class="wiki-fc-int-done">' + esc(note || "✓ Integrated") + "</span>";
  }
  if (state === "blocked-append") {
    return (
      '<button class="wiki-fc-int-open" disabled>✎ Integrate into article</button>' +
      '<span class="wiki-fc-int-bar-msg error">' + esc(INTEGRATE_STALE_COPY_EDIT) + "</span>"
    );
  }
  if (state === "too-long") {
    return (
      '<button class="wiki-fc-int-open" disabled>✎ Integrate into article</button>' +
      '<span class="wiki-fc-int-bar-msg">This page is too long to integrate automatically ' +
      "— edit it by hand, or add the callout instead.</span>"
    );
  }
  // Nothing to correct AND no verbatim passage to mark: the only reachable outcome
  // is an empty panel, so say why instead of offering the click.
  if (state === "no-anchors") {
    return (
      '<button class="wiki-fc-int-open" disabled>✎ Integrate into article</button>' +
      '<span class="wiki-fc-int-bar-msg">' + esc(INTEGRATE_NO_ANCHORS_COPY) + "</span>"
    );
  }
  // In-flight propose is TURN state, not DOM state: a re-render (a `done`
  // refresh, an SSE drop, re-opening the turn from history) must reproduce the
  // disabled "Proposing…" button, or a second click races the first and the
  // loser's `finally` pins a stale label.
  const proposing = integrateProposing === turn;
  const msg = integrateBarMsgs[turn.askedAt];
  return (
    '<button id="wikiFactcheckIntegrateBtn" class="wiki-fc-int-open"' +
    (proposing ? " disabled" : "") + ">" +
    (proposing ? "Proposing edits… up to ~90s" : "✎ Integrate into article") + "</button>" +
    '<span class="wiki-fc-int-bar-msg' + (msg?.error ? " error" : "") +
    '" id="wikiFactcheckIntegrateMsg">' + esc(msg?.text || "") + "</span>"
  );
}

/** Full success copy per integrated turn, keyed by `askedAt` (edit count + commit
 *  outcome). Transient by design — the durable fact is the persisted `turn.wrote`;
 *  this only enriches the label within the session, and a rehydrated turn falls
 *  back to a bare "✓ Integrated". */
const integratedNotes: Record<number, string> = {};

/** Per-turn ✎ bar message (a 409, a propose failure, the too-long copy), keyed by
 *  `askedAt` like {@link integratedNotes}. Held off the DOM so a re-render — which
 *  replaces the bar's innerHTML wholesale — reproduces it instead of wiping it. */
const integrateBarMsgs: Record<number, { text: string; error: boolean }> = {};

/** The turn whose propose call is currently in flight (at most one — the bar
 *  disables while it runs). Module-level so the bar's rendered state is derived,
 *  never mutated in place. */
let integrateProposing: AskTurn | null = null;

/** Re-render BOTH write-action bars from the turn. Called at `done` (the pane was
 *  painted before the answer existed, so the gates couldn't run yet) and after any
 *  write. The rendered state is authoritative — `turn.wrote` drives it.
 *
 *  TURN-GUARDED, exactly like `renderIntegratePreview`: the two bars are SINGLETON
 *  nodes belonging to whichever turn is painted, so a late caller for another turn
 *  (a ~90s propose or an SSE handler resolving after the reader switched turns)
 *  would paint turn A's live ✎ button — or its 409 copy — into turn B's retired
 *  bar, reviving a button whose click fires a doomed one-shot against the wrong
 *  page. Nothing is lost by skipping: `showAskAnswer` re-renders both bars from
 *  the newly shown turn (`askArticleHtml` → `askFactcheck*Html`), and every piece
 *  of bar state is held off the DOM (`turn.wrote`, `integrateBarMsgs`,
 *  `integratedNotes`, `integrateProposing`) so re-opening the turn reproduces it. */
function refreshWriteActionBars(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const appendBar = document.getElementById("wikiFactcheckAppendBar");
  if (appendBar) appendBar.innerHTML = factcheckAppendInnerHtml(turn);
  const intBar = document.getElementById("wikiFactcheckIntegrateBar");
  if (intBar) intBar.innerHTML = factcheckIntegrateInnerHtml(turn);
  // The escalate bar is derived from the same turn and rides the same commit gate
  // (it renders nothing until `turn.answer` exists), so it refreshes here rather
  // than at five separate SSE call sites where one could quietly be missed. It is
  // rendered from `turn.chatEsc`, so this is idempotent.
  refreshChatEscalateBar(turn);
  // Same reasoning for the ↻ retry bar: it is derived from `turn.answer` +
  // `turn.claimOutcomeByIndex`, neither of which exists when the pane is painted.
  refreshClaimRetryBar(turn);
}

// ── Claim retry (↻) ───────────────────────────────────────────────────
// The client half of `GET /api/wiki/factcheck/claim`: re-verify ONE claim that
// timed out, was skipped, or errored, and splice its fresh verdict block into the
// persisted answer. A model-chosen ❓ (`unverifiable`) is deliberately NOT
// retryable — see `RETRYABLE_OUTCOMES`.
//
// TWO CONTRACTS this code lives or dies on:
//
//  - **`###` in markdown, `<h4>` in the DOM.** `formatWebHtml`'s heading renderer
//    emits `h${Math.min(level + 1, 6)}`, so the `### <emoji> Claim n/m` prompt
//    contract lands in the pane as an `<h4>`. An `h3` selector here would match
//    NOTHING and ship an invisible button, so the DOM pass queries ALL heading
//    levels and filters on the `Claim n/m` TEXT (`claimRefFromHeadingText`) —
//    a future level shift can't silently kill it either.
//  - **The affordance is re-applied at EVERY paint, never injected once.** The
//    answer body is replaced wholesale by `showAskAnswer`, by the `done` paint, by
//    the `answer_html` paint and by this feature's OWN repaint after a splice, so
//    a one-shot injection would vanish on the very next render.
//
// **Cancel is client-side only** and the UI says so: there is no abort plumbing on
// this path (`streamFactcheckSSE` treats a gone client as a launch GATE, and
// `tracedOneShot` carries no cancellation token). Cancel stops the BATCH from
// launching the next claim and detaches this client; the in-flight claim finishes
// server-side while holding the page's single-flight slot — which is exactly why a
// row ↻ clicked mid-batch 409s, and why the 409's `expiresAtMs` is rendered.

/** Per-turn, per-claim ↻ row message (live progress · a failure · a 409's
 *  deadline), keyed `askedAt` → claim index, the `integrateBarMsgs` precedent.
 *  Held OFF the DOM so the repaint after a splice — or a turn switch and back —
 *  reproduces it instead of wiping it. */
const claimRetryMsgs: Record<number, Record<number, { text: string; error: boolean }>> = {};

/** Per-turn ↻ BAR message, keyed by `askedAt` — the `integrateBarMsgs` shape one
 *  level up from the rows. It exists because the bar's two most important states
 *  outlive the run record: the cancel copy (which must not be replaced, one frame
 *  later, by an enabled button whose click can only 409) and the terminal
 *  "Re-checked N of M". Both were promised by comments and rendered by nothing. */
const claimRetryBarMsgs: Record<number, string> = {};

/** The retry currently in flight — at most ONE. The route is per-page
 *  single-flight anyway, and a batch runs SEQUENTIALLY so the tool chips and the
 *  status line stay legible (bounded by FACTCHECK_MAX_CLAIMS × 180s ≈ 24 min worst
 *  case, hence a visible running state rather than a silent spinner). */
interface ClaimRetryRun {
  turn: AskTurn;
  /** The claim currently being re-checked. */
  index: number;
  batch: boolean;
  cancelled: boolean;
  /** Claims in this run's queue (1 for a row ↻). */
  total: number;
  /** Claims that actually landed a fresh verdict — NOT "attempted". A failure, a
   *  409 or a cancel must not read as done. */
  done: number;
  cancel: () => void;
}
let claimRetryRun: ClaimRetryRun | null = null;

/**
 * Is `turn` still part of the session?
 *
 * `clearAskSession` empties `askTurns` and drops both message records, but the ↻ it
 * aborts resolves AFTERWARDS — `driveClaimRetry`'s tail and `retryAllClaims`'
 * terminal `setClaimRetryBarMsg` both run on the evicted turn and would re-create
 * its key, leaking a record nothing will ever read or drop again. Both setters are
 * gated on this, so a late write on an evicted turn PRUNES instead of resurrecting.
 */
function askTurnIsLive(turn: AskTurn): boolean {
  return askTurns.indexOf(turn) !== -1;
}

/** Set (or clear, with an empty `text`) one ↻ row's message and repaint that row. */
function setClaimRetryMsg(turn: AskTurn, index: number, text: string, error = false): void {
  const forTurn = claimRetryMsgs[turn.askedAt] || (claimRetryMsgs[turn.askedAt] = {});
  if (text && askTurnIsLive(turn)) forTurn[index] = { text, error };
  else delete forTurn[index];
  // Prune the empty per-turn bucket, the `integrateBarMsgs` lifecycle: the record
  // is keyed by `askedAt` and nothing else would ever drop it.
  if (!Object.keys(forTurn).length) delete claimRetryMsgs[turn.askedAt];
  paintClaimRetryRow(turn, index);
}

/** Set (or clear) the ↻ bar's persistent per-turn message and repaint the bar.
 *  Same evicted-turn pruning as {@link setClaimRetryMsg} — the bar record used to be
 *  the one that got resurrected, since the batch's terminal line is written after
 *  everything else has settled. */
function setClaimRetryBarMsg(turn: AskTurn, text: string): void {
  if (text && askTurnIsLive(turn)) claimRetryBarMsgs[turn.askedAt] = text;
  else delete claimRetryBarMsgs[turn.askedAt];
  refreshClaimRetryBar(turn);
}

/** Drop every ↻ message for a turn (its rows and its bar) — used when the whole
 *  session is cleared, the one lifecycle point that otherwise leaks both records. */
function clearClaimRetryMsgs(turn: AskTurn): void {
  delete claimRetryMsgs[turn.askedAt];
  delete claimRetryBarMsgs[turn.askedAt];
}

/** Inner markup of one ↻ row, DERIVED from turn + run state (never mutated in
 *  place only), so every repaint reproduces it. */
function claimRetryRowInnerHtml(turn: AskTurn, claim: RetryableClaim): string {
  const running = !!claimRetryRun && claimRetryRun.turn === turn && claimRetryRun.index === claim.index;
  const busy = !!claimRetryRun && !running;
  const msg = (claimRetryMsgs[turn.askedAt] || {})[claim.index];
  // A turn that already wrote to the page gets a DISABLED ↻ with one line of copy,
  // not nothing: check → ➕ → notice-the-❓ is a common sequence, and every other
  // derived-disable state here explains itself (the INTEGRATE_STALE_COPY precedent).
  // Silently removing the affordance reads as a bug.
  const wrote = !!turn.wrote;
  const label = running ? "↻ Re-checking… up to ~3 min" : "↻ Re-check this claim";
  const disabled = wrote || running || busy ? " disabled" : "";
  const text = wrote ? CLAIM_RETRY_WROTE_COPY : msg?.text || "";
  return (
    '<button class="wiki-fc-retry-btn" data-claim-retry-btn="' + claim.index + '"' + disabled + ">" +
    label + "</button>" +
    '<span class="wiki-fc-retry-msg' + (!wrote && msg?.error ? " error" : "") + '">' +
    esc(text) + "</span>"
  );
}

/**
 * Insert a ↻ row under every retryable claim's heading in the rendered answer.
 *
 * Idempotent by construction (it removes its own rows first), because it runs at
 * every paint site the other body enhancers run at. See the section header for the
 * h4 trap driving the all-levels query.
 *
 * TURN-GUARDED like `refreshWriteActionBars`/`refreshClaimRetryBar`: `#askAnswerBody`
 * is a singleton node owned by whichever turn is painted, and two of the four call
 * sites are late SSE handlers that can resolve after a turn switch.
 *
 * `turn.page` gates it exactly as it gates the bar — without a page there is no
 * retry URL to build, and a live-looking ↻ whose click is a silent no-op is worse
 * than no ↻ at all.
 */
function applyRetryAffordances(bodyEl: HTMLElement | null, turn: AskTurn): void {
  if (!bodyEl || turn !== askShownTurn) return;
  bodyEl.querySelectorAll(".wiki-fc-retry").forEach((n) => n.remove());
  if (turn.kind !== "factcheck" || !turn.answer || !turn.page) return;
  const claims = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes);
  if (!claims.length) return;
  const byIndex: Record<number, RetryableClaim> = {};
  claims.forEach((c) => { byIndex[c.index] = c; });
  // A rendered heading can repeat an index even after `retryableClaims` refuses to
  // OFFER duplicates (the answer's own duplicates are skipped there, but a heading
  // may also be echoed by unrelated markup). Decorate the FIRST one only —
  // `data-claim-retry` is the row's lookup key and must stay unique in the pane.
  const decorated = new Set<number>();
  // Markdown contract `###`, DOM contract `h4` — both load-bearing, so match on the
  // heading TEXT across every level rather than on a tag name.
  bodyEl.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const ref = claimRefFromHeadingText(h.textContent || "");
    if (!ref) return;
    const claim = byIndex[ref.index];
    if (!claim || decorated.has(claim.index)) return;
    decorated.add(claim.index);
    const row = document.createElement("div");
    row.className = "wiki-fc-retry";
    row.setAttribute("data-claim-retry", String(claim.index));
    row.innerHTML = claimRetryRowInnerHtml(turn, claim);
    h.insertAdjacentElement("afterend", row);
  });
}

/** Repaint ONE ↻ row in place (live progress during a 180s run — the common path
 *  is a single claim, not the batch, so the progress belongs on the row itself).
 *  Scoped to the answer body: `data-claim-retry` is unique THERE, but a bare
 *  `document.querySelector` would happily pick up a same-keyed node anywhere. */
function paintClaimRetryRow(turn: AskTurn, index: number): void {
  if (turn !== askShownTurn) return;
  const body = document.getElementById("askAnswerBody");
  const row = body?.querySelector('.wiki-fc-retry[data-claim-retry="' + index + '"]');
  if (!row) return;
  const claim = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes).find(
    (c) => c.index === index,
  );
  if (!claim) return;
  row.innerHTML = claimRetryRowInnerHtml(turn, claim);
}

/** Repaint EVERY ↻ row on the shown turn. A run start/end flips every sibling
 *  row's `busy` disable, and repainting only the running row left the others
 *  looking enabled while their clicks no-opped. */
function paintAllClaimRetryRows(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const body = document.getElementById("askAnswerBody");
  if (!body) return;
  body.querySelectorAll(".wiki-fc-retry[data-claim-retry]").forEach((row) => {
    const idx = Number(row.getAttribute("data-claim-retry"));
    if (Number.isFinite(idx)) paintClaimRetryRow(turn, idx);
  });
}

/** "Retry N unverified claims" bar — rendered only above ONE retryable claim (a
 *  lone one is served by its own row ↻). Always emitted as a wrapper so the `done`
 *  refresh can fill it in place; `.wiki-fc-retryall:empty` collapses it. */
function askClaimRetryBarHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck") return "";
  return '<div class="wiki-fc-retryall" id="wikiClaimRetryBar">' + claimRetryBarInnerHtml(turn) + "</div>";
}

function claimRetryBarInnerHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck" || !turn.answer || !turn.page) return "";
  const claims = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes);
  const run = claimRetryRun && claimRetryRun.turn === turn ? claimRetryRun : null;
  // The terminal message (a cancel, or "Re-checked N of M") lives on the TURN, not
  // on the run record — the run is nulled the moment the batch settles, and the
  // first cut therefore painted both for exactly one frame before repainting an
  // idle enabled bar whose click could only 409.
  const barMsg = claimRetryBarMsgs[turn.askedAt] || "";
  const msgHtml = barMsg ? '<span class="wiki-fc-retryall-msg">' + esc(barMsg) + "</span>" : "";
  // Nothing left to retry — but a settled batch keeps reporting itself until the
  // turn is repainted from scratch, so "Re-checked 3 of 3" doesn't vanish on the
  // last splice.
  if (!claims.length && !run) return msgHtml;
  if (turn.wrote) {
    // The persistent line comes FIRST and is not shadowed: a batch stopped BY the
    // write ("Stopped after 2 of 3 — the article was written from this answer")
    // says what happened to the run, while the wrote copy only explains the
    // disable. Rendering the second alone lost the first.
    if (claims.length < 2) return msgHtml;
    return msgHtml + '<span class="wiki-fc-retryall-msg">' + esc(CLAIM_RETRY_WROTE_COPY) + "</span>";
  }
  if (run && run.batch) {
    const status = run.cancelled
      ? CLAIM_RETRY_CANCEL_COPY
      : "Re-checking claim " + run.index + " — " + run.done + " of " + run.total + " done";
    return (
      '<button class="wiki-fc-retryall-btn" disabled>' + esc(claimRetryBatchLabel(run.total)) + "</button>" +
      (run.cancelled
        ? ""
        : '<button class="wiki-fc-retryall-cancel" id="wikiClaimRetryCancel">Cancel</button>') +
      '<span class="wiki-fc-retryall-msg">' + esc(status) + "</span>"
    );
  }
  if (claims.length < 2) return msgHtml;
  const busy = !!run;
  return (
    '<button class="wiki-fc-retryall-btn" id="wikiClaimRetryAll"' + (busy ? " disabled" : "") + ">" +
    esc(claimRetryBatchLabel(claims.length)) + "</button>" +
    (barMsg
      ? msgHtml
      : '<span class="wiki-fc-retryall-msg">one at a time · up to ~3 min each</span>')
  );
}

/** Re-render the ↻ bar from the turn. TURN-GUARDED for the same reason
 *  `refreshWriteActionBars` is — it is a singleton node owned by whichever turn is
 *  painted. */
function refreshClaimRetryBar(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const bar = document.getElementById("wikiClaimRetryBar");
  if (bar) bar.innerHTML = claimRetryBarInnerHtml(turn);
}

/** Repaint the answer body from `turn.answer` and re-run every enhancer the `done`
 *  path runs — including the retry affordances, which the repaint would otherwise
 *  destroy.
 *
 *  No server round-trip is needed after a splice: the fact-check route's
 *  `renderAnswerHtml` is `renderAskAnswerHtml(answer, [])`, and with an empty
 *  citation list that reduces to `formatWebHtml(answer)` — the same function
 *  `renderStreamingBody` wraps (plus the confidence enhancement the client applies
 *  on every paint anyway). */
function repaintAskAnswerBody(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const b = document.getElementById("askAnswerBody");
  if (!b) return;
  b.innerHTML = renderStreamingBody(turn.answer);
  enhanceMermaid(b);
  enhanceCodeTabs(b); enhanceCodeBlocks(b);
  applyRetryAffordances(b, turn);
}

/** Handlers for one retry stream. */
interface ClaimRetryStreamHandlers {
  tool?: (d: Record<string, unknown>) => void;
  claim_result?: (d: Record<string, unknown>) => void;
  app_error?: (message: string) => void;
  /** The route's per-page single-flight 409 `{state:"running", expiresAtMs}`. */
  conflict?: (expiresAtMs: unknown) => void;
  /** Transport-level failure (unreachable server, non-200 that isn't the 409). */
  failed?: (message: string) => void;
}

/**
 * Consume the retry SSE through **fetch + a ReadableStream**, deliberately NOT
 * `sseClient`/`EventSource`.
 *
 * Two reasons, both empirical: `EventSource` exposes neither the status nor the
 * body on a non-200, so the route's 409 `{state:"running", expiresAtMs}` — the
 * whole point of the deadline riding that body — would be unreadable; and it
 * auto-reconnects on a network drop, where the reconnect would hit the very
 * single-flight slot the first connection is holding and fail opaquely while
 * wedging the row.
 */
function openClaimRetryStream(
  url: string,
  h: ClaimRetryStreamHandlers,
): { done: Promise<void>; cancel: () => void } {
  const ctrl = new AbortController();
  const done = (async () => {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
    } catch {
      if (!ctrl.signal.aborted) h.failed?.("Could not reach the server — nothing was changed.");
      return;
    }
    if (res.status === 409) {
      let body: { expiresAtMs?: unknown } = {};
      try { body = (await res.json()) as { expiresAtMs?: unknown }; } catch { /* keep the default copy */ }
      h.conflict?.(body?.expiresAtMs);
      return;
    }
    if (!res.ok || !res.body) {
      let msg = "The re-check could not start (HTTP " + res.status + ").";
      try {
        const b = (await res.json()) as { error?: unknown };
        if (b && typeof b.error === "string") msg = b.error;
      } catch { /* non-JSON body — keep the status copy */ }
      h.failed?.(msg);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // Framing (CRLF delimiters, chunk-straddling frames, the unterminated tail a
    // server that closes right after `claim_result` leaves behind) is the shared,
    // unit-tested `makeSseFrameParser` beside `sseClient` — it is generic stream
    // plumbing and cannot be tested from inside this DOM module.
    const parser = makeSseFrameParser((frame) => dispatchClaimRetryFrame(frame, h));
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
      // Flush the decoder's own trailing state, then the buffered final frame.
      parser.push(decoder.decode());
      parser.end();
    } catch {
      if (!ctrl.signal.aborted) h.failed?.("The connection dropped — nothing was changed.");
    }
  })();
  return { done, cancel: () => ctrl.abort() };
}

/** Fan one decoded SSE frame out to the handlers.
 *
 *  The route's vocabulary is `tool` · `claim_result` · `app_error` · `done`
 *  (the per-claim terminal) · `end` (the shared scaffold's terminal) ·
 *  `heartbeat`. The last three carry nothing this client acts on — but they are
 *  named explicitly rather than silently falling through, so a future event can't
 *  be swallowed as "probably a sentinel". */
function dispatchClaimRetryFrame(frame: SseFrame, h: ClaimRetryStreamHandlers): void {
  const event = frame.event;
  if (event === "heartbeat" || event === "done" || event === "end") return;
  let d: Record<string, unknown>;
  try { d = JSON.parse(frame.data) as Record<string, unknown>; } catch { return; }
  if (event === "tool") h.tool?.(d);
  else if (event === "claim_result") h.claim_result?.(d);
  else if (event === "app_error") {
    h.app_error?.(typeof d.message === "string" ? d.message : "The re-check failed.");
  }
}

/**
 * Fold a retry's `tool` event into the turn's Consulting chips, exactly as the
 * article run's own handler does — a retried claim's sources belong on the turn
 * that will carry its verdict.
 */
function recordToolSource(turn: AskTurn, d: Record<string, unknown>): boolean {
  const detail = typeof d.detail === "string" ? d.detail : "";
  if (!detail || d.name !== "WebFetch") return false;
  if (!turn.toolSources) turn.toolSources = [];
  if (turn.toolSources.indexOf(detail) !== -1) return false;
  turn.toolSources.push(detail);
  if (typeof d.url === "string" && d.url) {
    if (!turn.toolSourceUrls) turn.toolSourceUrls = {};
    if (!turn.toolSourceUrls[detail]) turn.toolSourceUrls[detail] = d.url;
  }
  return true;
}

/**
 * Fold a successful `claim_result` into the turn: splice the block, amend the lede,
 * re-derive the counts, repaint, persist. Returns whether anything was written.
 *
 * **A SUPERSEDED retry keeps its work and skips only the paint.** The splice, the
 * outcome-map write and `persistAskSession` are all turn-scoped and perfectly safe
 * off-screen; discarding them threw away a completed 180-second verdict, left the
 * hole at ❓ and left the ↻ live to spend it all over again. Only the DOM repaint
 * (which owns singleton nodes belonging to whichever turn is painted) is guarded —
 * and when the reader switches back, the rehydrated paint shows the spliced answer.
 */
function applyClaimRetryResult(
  turn: AskTurn,
  claim: RetryableClaim,
  d: Record<string, unknown>,
): boolean {
  // Re-check the write state AT SPLICE TIME, not just at launch: a ➕/✎ that landed
  // mid-run committed the PRE-splice answer to the page, so splicing now would
  // leave the committed article and the turn silently disagreeing about what the
  // check found — and both write buttons already read as "already written".
  if (turn.wrote) {
    setClaimRetryMsg(turn, claim.index, CLAIM_RETRY_WROTE_COPY, true);
    return false;
  }
  const markdown = typeof d.markdown === "string" ? d.markdown : "";
  // A block whose heading RENUMBERED is corrected, not thrown away. The route
  // deliberately accepts one (`isClaimVerdictBlock` in `factcheck-sse.ts` calls a
  // renumbered heading a formatting wobble rather than a wrong claim, because
  // refusing it discards a completed 180s verification), so refusing it here just
  // moved that loss to the last hop; `spliceClaimBlock` rewrites the `n/m` to the
  // claim it was asked about — which is also what keeps the answer free of the
  // duplicate index that would retire the wrong ↻. A block carrying NO claim
  // heading at all is still refused there: it has no anchor to correct.
  //
  // The WIRE index is a different check and stays strict — the route echoes the
  // index it was asked for, so a disagreement is a transport-level problem, not a
  // model wobble.
  const wireIndex = typeof d.index === "number" ? d.index : undefined;
  const mismatched = wireIndex !== undefined && wireIndex !== claim.index;
  const spliced = mismatched ? null : spliceClaimBlock(turn.answer, claim.index, markdown);
  if (!spliced) {
    setClaimRetryMsg(
      turn,
      claim.index,
      "The re-checked block didn't match this claim — nothing was changed.",
      true,
    );
    return false;
  }
  // The outcome map is written FIRST and is the single authority from here on:
  // `tallyClaimOutcomes` reads `turn.claims`, which `done` cleared, and `claimCount`
  // was a server-side count of real blocks. Skipping this write is the silent
  // failure mode — the claim would keep offering ↻ forever.
  const map: ClaimOutcomeByIndex = turn.claimOutcomeByIndex || (turn.claimOutcomeByIndex = {});
  // VALIDATE the wire value against the five-outcome vocabulary. An arbitrary
  // string sails through `isValidOutcomeMap`'s `.every` on the next load and drops
  // the ENTIRE persisted map — every other claim's outcome with it.
  map[claim.index] = isClaimOutcome(d.outcome) ? d.outcome : "verified";
  turn.answer = appendLedeAmendment(spliced, claim.index);
  turn.claimOutcomes = outcomeCountsFromMap(map);
  turn.claimCount = claimCountFromMap(map);
  // The stored server-rendered HTML describes the pre-splice answer; drop it so
  // every later paint (including a history re-show) renders the new markdown.
  turn.html = null;
  // An open integrate preview was resolved against the PRE-splice answer: its
  // ranges came from that body and its Apply would post edits computed for text
  // this splice just changed. Invalidate it rather than let it write.
  invalidateIntegratePreviewAfterSplice(turn);
  // NB no `persistAskSession()` here — `driveClaimRetry` owns it and calls it on
  // EVERY path (it also has to persist the tool chips a failed retry grew), so a
  // second call was one write of the same session per success.
  // Everything above is turn-scoped. Everything below touches singleton DOM nodes.
  if (turn !== askShownTurn) return true;
  setClaimRetryMsg(turn, claim.index, "");
  repaintAskAnswerBody(turn);
  refreshAskSources(turn); // the meta line reads claimOutcomes / claimCount
  refreshWriteActionBars(turn);
  return true;
}

/** A splice changed the answer under an open integrate preview — the proposal's
 *  resolved ranges and its `answer` payload now describe a body that no longer
 *  exists, and Apply would post pre-splice edits alongside a post-splice answer.
 *  Drop it with an honest message instead. */
function invalidateIntegratePreviewAfterSplice(turn: AskTurn): void {
  if (!integratePreview || integratePreview.turn !== turn) return;
  // An apply already in flight owns its own response path and cannot be recalled —
  // it is posting the PRE-splice answer and will set `turn.wrote` when it lands, so
  // the page ends up written from a version of the answer this turn no longer
  // holds. Nothing here can prevent that ordering; what it must not do is stay
  // SILENT about it. The `turn.wrote` re-check in `applyClaimRetryResult` only
  // covers the other order (apply first, splice after).
  if (integratePreview.applying) {
    setIntegrateBarMsg(turn, CLAIM_RETRY_APPLY_RACE_COPY, true);
    setClaimRetryBarMsg(turn, CLAIM_RETRY_APPLY_RACE_COPY);
    return;
  }
  integratePreview = null;
  renderIntegratePreview();
  setIntegrateBarMsg(turn, "The answer changed — propose the edits again.", true);
}

/** Re-verify ONE claim end to end. Resolves `true` when the answer was rewritten.
 *  Every refusal that a CLICK can reach reports itself on the row — a silently
 *  dead button is the failure mode this affordance can least afford. */
async function retryOneClaim(turn: AskTurn, claim: RetryableClaim, batch: boolean): Promise<boolean> {
  if (claimRetryRun) {
    setClaimRetryMsg(turn, claim.index, "A re-check is already running on this page.", true);
    return false;
  }
  if (turn.wrote) {
    setClaimRetryMsg(turn, claim.index, CLAIM_RETRY_WROTE_COPY, true);
    return false;
  }
  if (!turn.page || !turn.answer) {
    setClaimRetryMsg(turn, claim.index, "This turn has no page to re-check against.", true);
    return false;
  }
  const run: ClaimRetryRun = {
    turn, index: claim.index, batch, cancelled: false, total: 1, done: 0, cancel: () => {},
  };
  claimRetryRun = run;
  // A row ↻ runs UNDER the bar, so the bar's persistent line — a previous batch's
  // "Stopped after 1 of 4 — …" or its "Re-checked 2 of 3" — would sit there
  // describing a run that ended, while this one is live. Clear it here rather than
  // in `driveClaimRetry`, which the batch also drives and whose own terminal line
  // `retryAllClaims` writes afterwards. `driveClaimRetry`'s finally re-derives the
  // bar from the turn at the end.
  setClaimRetryBarMsg(turn, "");
  return await driveClaimRetry(turn, claim, run, claimRetryUrlFor(turn, claim, deps.WIKI()));
}

/** The stream half of {@link retryOneClaim} / the batch, split out so the batch can
 *  own the counters on the shared run record.
 *
 *  The whole body sits in a try/FINALLY: any throw in the tail (the splice, a
 *  render, `persistAskSession`) used to leave `claimRetryRun` set forever, which
 *  disables EVERY ↻ on the page until a reload. The run record must be released on
 *  the failure path or the feature wedges itself. */
async function driveClaimRetry(
  turn: AskTurn,
  claim: RetryableClaim,
  run: ClaimRetryRun,
  url: string,
): Promise<boolean> {
  let ok = false;
  try {
    setClaimRetryMsg(turn, claim.index, "Re-checking…");
    // Every sibling row's `busy` disable flips with the run — repaint them all, or
    // a second row's ↻ looks live and no-ops on click.
    paintAllClaimRetryRows(turn);
    refreshClaimRetryBar(turn);
    const stream = openClaimRetryStream(url, {
      tool: (d) => {
        // `start` frames only, matching the article run's own gate: an `end` frame
        // carries no `detail`, so recording from it can only ever be a no-op or a
        // host recorded from a field that doesn't mean what the chip claims.
        if (d.state === "start" && recordToolSource(turn, d)) {
          // `#askToolSources` is a singleton node owned by the painted turn.
          if (turn === askShownTurn) refreshAskToolSources(turn);
        }
        if (d.state === "start") {
          const label = typeof d.label === "string" && d.label ? d.label : "Working";
          const detail = typeof d.detail === "string" ? d.detail : "";
          setClaimRetryMsg(turn, claim.index, label + (detail ? ": " + detail : "") + "…");
        } else if (d.state === "end") {
          setClaimRetryMsg(turn, claim.index, "Re-checking…");
        }
      },
      claim_result: (d) => { ok = applyClaimRetryResult(turn, claim, d); },
      // A FAILED retry leaves the persisted answer byte-untouched (the route emits no
      // claim_result) — the reason lands on the row and the ↻ stays live.
      app_error: (m) => setClaimRetryMsg(turn, claim.index, m, true),
      conflict: (expiresAtMs) =>
        setClaimRetryMsg(turn, claim.index, claimRetryRunningCopy(expiresAtMs), true),
      failed: (m) => setClaimRetryMsg(turn, claim.index, m, true),
    });
    run.cancel = stream.cancel;
    await stream.done;
    // Clear a stale live-progress line (an error/409 line is left in place).
    const msg = (claimRetryMsgs[turn.askedAt] || {})[claim.index];
    if (msg && !msg.error) setClaimRetryMsg(turn, claim.index, "");
    // Tool chips grew during the run; persist them even on a failed retry.
    persistAskSession();
    return ok;
  } finally {
    if (claimRetryRun === run) claimRetryRun = null;
    paintAllClaimRetryRows(turn);
    refreshClaimRetryBar(turn);
  }
}

/** True while the ↻ bar this batch is driving is still in the document. Navigating
 *  away does NOT clear `askShownTurn` (see `currentViewState`), so without a DOM
 *  liveness test a batch kept launching claims — up to ~24 minutes of model spend —
 *  with the Cancel button long since destroyed. */
function claimRetryPaneAlive(): boolean {
  const bar = document.getElementById("wikiClaimRetryBar");
  const body = document.getElementById("askAnswerBody");
  return !!(bar?.isConnected && body?.isConnected);
}

/** Retry every unverified claim on the shown turn, SEQUENTIALLY (concurrency 1):
 *  the route is per-page single-flight, and parallel runs would interleave tool
 *  chips and status text into noise. */
export async function retryAllClaims(turn: AskTurn): Promise<void> {
  // Every refusal a click can reach says so on the bar — the button is rendered
  // disabled in each of these states, but a delegated handler must not depend on
  // that and go quiet.
  if (claimRetryRun) {
    setClaimRetryBarMsg(turn, "A re-check is already running on this page.");
    return;
  }
  if (turn.wrote) {
    setClaimRetryBarMsg(turn, CLAIM_RETRY_WROTE_COPY);
    return;
  }
  if (!turn.page) {
    setClaimRetryBarMsg(turn, "This turn has no page to re-check against.");
    return;
  }
  const queue = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes);
  if (queue.length < 2) {
    setClaimRetryBarMsg(turn, "Nothing left to re-check in a batch.");
    return;
  }
  const run: ClaimRetryRun = {
    turn,
    index: queue[0]!.index,
    batch: true,
    cancelled: false,
    total: queue.length,
    done: 0,
    cancel: () => {},
  };
  claimRetryRun = run;
  setClaimRetryBarMsg(turn, ""); // a prior batch's terminal line must not linger
  refreshClaimRetryBar(turn);
  // WHY the loop ended, so the terminal line can say so. A batch stopped by a turn
  // switch / a navigation / a mid-run write is NOT a completed batch, and reporting
  // "Re-checked 1 of 4" for one told the reader the other three were unfixable.
  let stopped: ClaimRetryStopReason | null = null;
  for (const claim of queue) {
    if (run.cancelled) break;
    // The reader switched turns — stop rather than rewriting an off-screen answer.
    if (turn !== askShownTurn) { stopped = "switched"; break; }
    // …or navigated away entirely, which leaves `askShownTurn` set but destroys
    // the pane (and with it Cancel).
    if (!claimRetryPaneAlive()) { stopped = "navigated"; break; }
    // A ➕/✎ that landed between claims commits the answer as it stands; keep
    // going would splice into a turn the page has already been written from.
    if (turn.wrote) { stopped = "wrote"; break; }
    run.index = claim.index;
    refreshClaimRetryBar(turn);
    // Each claim owns the run record for the duration of its own stream.
    claimRetryRun = run;
    const wrote = await driveClaimRetry(turn, claim, run, claimRetryUrlFor(turn, claim, deps.WIKI()));
    // Count SUCCESSES, not attempts — a 409, a failure or a cancel is not "done" —
    // and increment BEFORE the repaint so the running label isn't one behind.
    if (wrote) run.done++;
    claimRetryRun = run;
    refreshClaimRetryBar(turn);
  }
  if (claimRetryRun === run) claimRetryRun = null;
  // The terminal state has to outlive the run record, or it paints for one frame
  // and is replaced by an idle bar (which, after a cancel, offers a button whose
  // click can only 409).
  setClaimRetryBarMsg(
    turn,
    run.cancelled
      ? CLAIM_RETRY_CANCEL_COPY
      : stopped
        ? claimRetryStoppedCopy(stopped, run.done, run.total)
        : claimRetryDoneCopy(run.done, run.total),
  );
  paintAllClaimRetryRows(turn);
}

/** Cancel the batch — CLIENT-SIDE ONLY. Stops the next launch and detaches this
 *  client; the claim already running finishes server-side holding the page's slot. */
export function cancelClaimRetryBatch(): void {
  if (!claimRetryRun || !claimRetryRun.batch) return;
  claimRetryRun.cancelled = true;
  claimRetryRun.cancel();
  refreshClaimRetryBar(claimRetryRun.turn);
}

/** Abort whatever retry is in flight and forget the run — the session it was going
 *  to splice into is about to stop existing. Without this a landing `claim_result`
 *  spliced into an emptied session and re-persisted a `[]`-plus-ghost. */
function abortClaimRetryRun(): void {
  const run = claimRetryRun;
  if (!run) return;
  run.cancelled = true;
  run.cancel();
  claimRetryRun = null;
}

/** Click entry point for one row's ↻. */
export function submitClaimRetry(index: number): void {
  const turn = askShownTurn;
  if (!turn || turn.kind !== "factcheck") return;
  const claim = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes).find(
    (c) => c.index === index,
  );
  if (!claim) return;
  void retryOneClaim(turn, claim, false);
}

/** Only http(s) URLs are safe to put in a chip href (the URL is model output). A
 *  non-http(s) or missing value degrades to `https://<host>/` — the host itself
 *  comes from `new URL(...).hostname` server-side, so it's a real hostname. */
function factcheckSrcHref(host: string, url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : "https://" + host + "/";
}

/** Inner markup of the "Consulting" chip row — a label + one linked chip per
 *  consulted hostname (opens the source in a new tab). Empty string when there are
 *  none (the container then hides). The href is the first full URL seen for that
 *  host (`toolSourceUrls`), falling back to `https://<host>/` for a rehydrated turn
 *  that only persisted the hostnames. */
function toolSourceChips(turn: AskTurn): string {
  const hosts = turn.toolSources || [];
  if (!hosts.length) return "";
  const urls = turn.toolSourceUrls || {};
  return (
    '<span class="wiki-fc-src-label">Consulting</span>' +
    hosts
      .map(
        (h) =>
          '<a class="wiki-fc-src-chip" href="' + esc(factcheckSrcHref(h, urls[h])) +
          '" target="_blank" rel="noopener">' + esc(h) + "</a>",
      )
      .join("")
  );
}

/** The "Consulting: host · host" chip row for a fact-check turn. Always emitted
 *  (hidden while empty) so `refreshAskToolSources` can populate it live during the
 *  stream. Renders nothing on non-fact-check turns. */
function askToolSourcesHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck") return "";
  const has = (turn.toolSources || []).length > 0;
  return (
    '<div class="wiki-fc-sources" id="askToolSources"' +
    (has ? "" : ' style="display:none"') + ">" + toolSourceChips(turn) + "</div>"
  );
}

/** Inner rows of the compact per-claim tool log — one line per verify step,
 *  `Claim n · <label>[: <detail>]`, dimmed once done. Empty string when there
 *  are no rows (the container then hides). */
function toolLogRows(turn: AskTurn): string {
  const rows = turn.toolLog || [];
  if (!rows.length) return "";
  return rows
    .map((r) =>
      '<div class="wiki-fc-tool' + (r.done ? " done" : "") + '">' +
      '<span class="wiki-fc-tool-claim">Claim ' + r.claimIndex + "</span>" +
      '<span class="wiki-fc-tool-label">' + esc(toolLogRowLabel(r)) + "</span>" +
      '<span class="wiki-fc-tool-state">' + (r.done ? "✓" : "…") + "</span>" +
      "</div>",
    )
    .join("");
}

/** The compact per-claim tool log for a fact-check turn — a scrolling list of
 *  live verify steps under the Consulting chips. Always emitted (hidden while
 *  empty) so `refreshAskToolLog` can populate it live. Ephemeral: `turn.toolLog`
 *  is cleared at `done`, so a committed/rehydrated turn never re-renders it. */
function askToolLogHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck") return "";
  const has = (turn.toolLog || []).length > 0;
  return (
    '<div class="wiki-fc-toollog" id="askToolLog" data-log' +
    (has ? "" : ' style="display:none"') + ">" + toolLogRows(turn) + "</div>"
  );
}

/** Re-render the on-screen tool log in place as verify steps arrive, then
 *  auto-scroll to the newest row (same as /agents' mini-log). The article body
 *  still streams separately, so only this container is repainted. */
function refreshAskToolLog(turn: AskTurn): void {
  const el = document.getElementById("askToolLog");
  if (!el) return;
  el.innerHTML = toolLogRows(turn);
  el.style.display = (turn.toolLog || []).length ? "flex" : "none";
  el.scrollTop = el.scrollHeight;
}

/** Update the on-screen "Consulting" chip row in place as WebFetch hosts arrive
 *  (the article body still streams, so re-render just this container). */
function refreshAskToolSources(turn: AskTurn): void {
  const el = document.getElementById("askToolSources");
  if (!el) return;
  el.innerHTML = toolSourceChips(turn);
  el.style.display = (turn.toolSources || []).length ? "flex" : "none";
}

/** Full article-pane HTML for one Ask turn: question headline, meta row, the
 *  fact-check "Consulting" chip row (fact-check turns only), answer body (rendered
 *  final article once available, else the progressively-formatted streaming
 *  buffer), then Sources, then the follow-up bar, then Remember, then — for
 *  fact-check turns on markdown pages — the ➕ Add-to-article button. */
function askArticleHtml(turn: AskTurn, buffer: string): string {
  const body = askAnswerBodyHtml(turn.html, buffer, turn.answer);
  return (
    '<div class="wiki-article-head"><h1>' + esc(turn.question) + "</h1>" +
    '<div class="wiki-meta-row"><span class="wiki-dates" id="askAnswerMeta">' +
    esc(askMetaText(turn)) + "</span></div></div>" +
    askToolLogHtml(turn) +
    askToolSourcesHtml(turn) +
    '<div class="wiki-article wiki-ask-article" id="askAnswerBody">' + body + "</div>" +
    '<div class="wiki-ask-sources" id="askAnswerSources">' +
    askSourcesHtml(turn.citations, turn.cited) + "</div>" +
    askFollowupHtml(turn) +
    askRememberHtml(turn) +
    askChatEscalateHtml(turn) +
    askClaimRetryBarHtml(turn) +
    askFactcheckAppendHtml(turn) +
    askFactcheckIntegrateHtml(turn) +
    // Transient per-turn preview host — the proposal is never persisted, so a
    // rehydrated turn simply re-proposes on click (its inputs, the persisted
    // answer + baseHash, are all the propose route needs).
    '<div class="wiki-fc-int-host" id="wikiFcIntHost"></div>'
  );
}

/** Enable/disable the follow-up + Remember controls by id (they may not exist yet
 *  at boot, and the article pane is re-rendered per turn — always look up
 *  fresh). The Remember button rides the same commit gate as the follow-up bar.
 *
 *  The two WRITE buttons are deliberately NOT here. Their state is derived from
 *  `turn.wrote` + the in-flight propose flag (`refreshWriteActionBars`), and a
 *  blanket `setFollowupDisabled(false)` from an SSE drop or the `end` fallback
 *  would force-enable a button the derivation had correctly retired — reviving a
 *  ✎ button mid-propose so a second click races the first. Every site that used
 *  to rely on this re-derives instead. */
function setFollowupDisabled(disabled: boolean): void {
  const input = document.getElementById("wikiFollowupInput") as HTMLInputElement | null;
  const btn = document.getElementById("wikiFollowupBtn") as HTMLButtonElement | null;
  if (input) input.disabled = disabled;
  if (btn) btn.disabled = disabled;
  const remember = document.getElementById("wikiRememberBtn") as HTMLButtonElement | null;
  if (remember) remember.disabled = disabled;
  // "Continue in chat →" is deliberately NOT here, for the same reason the two
  // write buttons aren't: every terminal path (app_error / end / onerror) called
  // `setFollowupDisabled(false)`, which force-enabled the button on turns that
  // never committed — and clicking it was then a silent no-op. Its state is
  // derived from the turn (`refreshChatEscalateBar`).
}

/** Paint an Ask turn into the main article pane (replaces the page/start view). */
export function showAskAnswer(turn: AskTurn, buffer: string): void {
  setCurrentName(null);
  // An answer replaces the article pane: graph mode ends with it, so a citation
  // clicked below opens its page for reading.
  deps.clearShownPage(); // an Ask answer replaces the page — no breadcrumb
  askShownTurn = turn; // the turn the in-pane Remember button acts on
  document.getElementById("articleWrap")!.innerHTML = askArticleHtml(turn, buffer);
  // The preview is TURN-KEYED, not "whatever was last proposed": nulling it here
  // stranded a ~90s propose whose user had switched turns (and, worse, an earlier
  // build painted the panel under an unrelated turn, whose Apply then wrote turn
  // A's page). It survives the swap; `renderIntegratePreview` paints it only when
  // its own turn is the one on screen, so re-opening that turn from history brings
  // the pending/ready preview back.
  renderIntegratePreview();
  // Rehydrated turns (history re-show) inject stored answer HTML that may carry
  // mermaid fences; the streaming paths hook separately. No-op when absent.
  const askBody = document.getElementById("askAnswerBody");
  if (askBody) {
    // Confidence chips are already baked into the body HTML by askAnswerBodyHtml.
    enhanceMermaid(askBody);
    enhanceCodeTabs(askBody); enhanceCodeBlocks(askBody);
    // The ↻ rows are re-applied at EVERY paint site (never injected once): this is
    // the turn-switch / history-click repaint.
    applyRetryAffordances(askBody, turn);
  }
  document.getElementById("articleWrap")!.scrollTop = 0;
  document.getElementById("connBody")!.innerHTML =
    '<div class="wiki-conn-empty">Showing an Ask answer — sources are listed under it.</div>';
  renderList();
}

/** Refresh the meta count + sources block of the on-screen answer in place
 *  (used when the `sources`/`done` events land while the body still streams). */
function refreshAskSources(turn: AskTurn): void {
  const meta = document.getElementById("askAnswerMeta");
  if (meta) meta.textContent = askMetaText(turn);
  const s = document.getElementById("askAnswerSources");
  if (s) s.innerHTML = askSourcesHtml(turn.citations, turn.cited);
}

/** History list in the Ask controls — one clickable line per committed turn,
 *  newest first. Clicking re-renders that turn's stored answer in the main pane. */
function renderAskHistory(): void {
  const el = document.getElementById("wikiAskHistory");
  if (!el) return;
  if (!askTurns.length) { el.innerHTML = ""; return; }
  let html =
    '<div class="wiki-ask-hist-head">This session' +
    '<span class="wiki-ask-hist-clear" id="wikiAskHistClear" title="Clear this session">clear</span>' +
    "</div>";
  for (let i = askTurns.length - 1; i >= 0; i--) {
    html +=
      '<div class="wiki-ask-hist-item" data-ask-idx="' + i + '">' +
      esc(askTurns[i]!.question) + "</div>";
  }
  el.innerHTML = html;
}

/** Shared stream runner for the Ask box AND the Explain pill: supersede any
 *  in-flight ask, paint `turn` into the main pane, and drive the SSE stream to
 *  completion. The `delta`/`done` handlers read the module-level `askBuffer`, so
 *  the reset here is load-bearing — omitting it bleeds a stale buffer across
 *  turns. Both entry points converge here so the committed turn lands in
 *  `askTurns` (session history + follow-up context) with zero extra code. */
export function runAskStream(url: string, turn: AskTurn): void {
  // Supersede any in-flight ask: close its stream so late events are ignored, and
  // drop any pending progressive-render frame so it can't repaint the new pane.
  if (askConn) { askConn.close(); askConn = null; }
  cancelAskStreamRender();
  // Reveal the Ask tab in the rail so the compose + session history are visible
  // while the answer streams into the main pane. Covers the Ask box, the in-pane
  // follow-up bar, and Explain (all converge here). No focus steal — the follow-up
  // input in the article pane keeps the caret. The pane itself must be on screen
  // for the reveal to mean anything: un-collapse it and leave focus mode first.
  revealRightPane();
  deps.switchConnTab("ask");
  askActive = turn;
  askBuffer = "";
  composeText = "";
  showAskAnswer(turn, "");
  // Fact-check starts with claim extraction (Haiku), then per-claim web verification.
  setAskStatus(turn.kind === "factcheck" ? "Extracting claims…" : "Searching…", "");
  const btn = document.getElementById("wikiAskBtn") as HTMLButtonElement;
  btn.disabled = true;
  setFollowupDisabled(true);

  const conn = sseClient(url, {
    phase: (e: MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data);
      setAskStatus(d.phase === "synthesizing" ? "Synthesizing…" : "Searching…", "");
    },
    sources: (e: MessageEvent) => {
      // Guard against a superseded connection whose late events would clobber the
      // active turn (a follow-up ask swaps askConn before the old stream drains).
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      turn.citations = d.citations || [];
      refreshAskSources(turn);
    },
    delta: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      // On a fact-check turn WITH a claim checklist, deltas are the Phase-3 compose
      // lede — accumulate them separately and rebuild the buffer so they render
      // ABOVE the blocks (append-only `askBuffer +=` would put them at the bottom).
      if (turn.kind === "factcheck" && turn.claims && turn.claims.length) {
        composeText += d.text || "";
        rebuildFactcheckBuffer(turn);
      } else {
        askBuffer += d.text || "";
      }
      if (!turn.html) scheduleAskStreamRender(turn, conn);
    },
    // Phase 1 — the extracted claim list. Seed the checklist + rebuild the buffer.
    // Once total > 1 the claim counter OWNS the status line (per-tool events stop
    // overwriting it; with concurrency 2 the host flips would thrash).
    claims: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      const list = Array.isArray(d.claims) ? d.claims : [];
      turn.claims = list.map((c: { index: number; title: string }) => ({
        index: c.index, title: c.title, status: "pending", block: "",
      }));
      // The checklist itself is transient (cleared at `done`), so the quotes are
      // lifted onto the turn HERE — this event is the only place they exist. The
      // lift is the pure, unit-tested `claimQuotesFromClaimsEvent`; claims the
      // extractor gave no usable quote for are simply absent from the list.
      const quotes = claimQuotesFromClaimsEvent(list);
      turn.claimQuotes = quotes.length ? quotes : undefined;
      composeText = "";
      rebuildFactcheckBuffer(turn);
      if (!turn.html) scheduleAskStreamRender(turn, conn);
      if (turn.claims && turn.claims.length > 1) {
        setAskStatus("Verifying claim 0/" + turn.claims.length + "…", "");
      }
    },
    // Phase 2 — a claim's verdict block landed. Mark it done, store the block,
    // rebuild the buffer (blocks-or-checklist-rows in claim order), re-render.
    claim_result: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      if (!turn.claims) return;
      const row = turn.claims.find((c) => c.index === d.index);
      if (row) {
        row.status = "done";
        row.block = typeof d.markdown === "string" ? d.markdown : "";
        row.outcome = typeof d.outcome === "string" ? d.outcome : undefined;
      }
      rebuildFactcheckBuffer(turn);
      if (!turn.html) scheduleAskStreamRender(turn, conn);
      if (turn.claims.length > 1) {
        const done = turn.claims.filter((c) => c.status === "done").length;
        setAskStatus("Verifying claim " + done + "/" + turn.claims.length + "…", "");
      }
    },
    // Live tool progress — fact-check only (Ask/Explain never emit `tool`). Drives
    // the "Searching the web / Reading <host>" status line and accumulates the
    // "Consulting" hostname chips (WebFetch targets, deduped) on the turn.
    tool: (e: MessageEvent) => {
      if (askConn !== conn) return;
      if (turn.kind !== "factcheck") return;
      const d = JSON.parse((e as MessageEvent).data);
      // Compact per-claim tool log — folds every start/end (paired by name +
      // claimIndex, so concurrent claims resolve to their own rows) into a
      // scrolling list under the Consulting chips. Rendered on ALL fact-check
      // turns (it lives in the article pane, not the rail, so it doesn't compete
      // with the status line the way the per-tool narration below would). Cleared
      // at `done` — never persisted.
      if (!turn.toolLog) turn.toolLog = [];
      applyToolLogEvent(turn.toolLog, {
        state: d.state === "end" ? "end" : "start",
        name: typeof d.name === "string" ? d.name : "",
        claimIndex: typeof d.claimIndex === "number" ? d.claimIndex : 0,
        label: typeof d.label === "string" ? d.label : undefined,
        detail: typeof d.detail === "string" ? d.detail : undefined,
      });
      refreshAskToolLog(turn);
      // With a multi-claim checklist the claim counter owns the status line — don't
      // let per-tool flips thrash it. A single-claim (sel) run keeps tool narration.
      const multiClaim = !!(turn.claims && turn.claims.length > 1);
      if (d.state === "start") {
        const detail = typeof d.detail === "string" ? d.detail : "";
        if (!multiClaim) {
          const label = typeof d.label === "string" && d.label ? d.label : "Working";
          setAskStatus(label + (detail ? ": " + detail : "") + "…", "");
        }
        // WebFetch carries a hostname detail — record deduped consulted sources,
        // keeping the FIRST full URL seen per host for the chip href. Shared with
        // the ↻ retry's own handler set so the two can't drift on the chip contract.
        if (recordToolSource(turn, d)) refreshAskToolSources(turn);
      } else if (d.state === "end") {
        if (!multiClaim) setAskStatus("Checking the web…", "");
      }
    },
    done: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      turn.answer = d.answer || askBuffer || "";
      turn.cited = d.cited || [];
      askBuffer = turn.answer;
      // Keep the streamed (now fully-formatted) answer visible until (and unless)
      // `answer_html` arrives; render the final buffer directly and drop any
      // pending frame so it can't repaint stale text afterward. Refresh sources +
      // the meta count with the final `cited` set.
      cancelAskStreamRender();
      const b = document.getElementById("askAnswerBody");
      if (b && !turn.html) { b.innerHTML = renderStreamingBody(turn.answer); enhanceMermaid(b); enhanceCodeTabs(b); enhanceCodeBlocks(b); } // chip baked into renderStreamingBody
      refreshAskSources(turn);
      let statusText: string;
      // NB the ↻ rows are applied further down, AFTER `claimOutcomeByIndex` is
      // written — they are derived from it, so a pass here would find nothing.
      if (turn.kind === "factcheck") {
        // Fact-check has no retrieval sources — report the claim count instead.
        turn.baseHash = typeof d.baseHash === "string" ? d.baseHash : undefined;
        // Integrate-relevant body length of the checked page — omitted entirely
        // for explainers (they can never be integrated), so an absent value is
        // meaningful and must stay undefined rather than defaulting to 0.
        turn.bodyLen = typeof d.bodyLen === "number" ? d.bodyLen : undefined;
        // .mdx-ness of the checked page, decided server-side from the resolved
        // path. Absent (older server) stays undefined — never defaulted to false,
        // so "unknown" and "definitely not annotatable" remain distinguishable.
        turn.annotatable = typeof d.annotatable === "boolean" ? d.annotatable : undefined;
        // Tally the per-outcome breakdown from the checklist BEFORE it's cleared
        // below — it's persisted (drives the honest meta line on rehydrated turns).
        turn.claimOutcomes = tallyClaimOutcomes(turn.claims);
        // …and keep the PER-CLAIM outcomes too, for the same reason and one more:
        // the tally counts, but only this map says WHICH claim timed out, which is
        // what decides where a ↻ retry affordance goes. Same last chance to read it
        // — the checklist is dropped a few lines below.
        turn.claimOutcomeByIndex = claimOutcomeMapFromRows(turn.claims);
        const n = typeof d.claimCount === "number" ? d.claimCount : 0;
        turn.claimCount = n; // drives the meta line's "N claims · M sites consulted"
        refreshAskSources(turn); // repaint the meta line now that claimCount is set
        statusText = n > 0
          ? "Checked " + n + " claim" + (n === 1 ? "" : "s") + " against the web"
          : "Fact check complete";
      } else {
        // The decline lands on the TURN, not just on this status string: the
        // escalate bar is re-derived from turn state on every switch/rehydrate,
        // and `done` fires exactly once. `askDeclineReason` owns the
        // lowConfidence-before-noHits order both branches below depend on.
        turn.declined = askDeclineReason(d);
        statusText = askStatusText(turn.declined, turn.citations.length);
      }
      setAskStatus(statusText, "done");
      // Drop the transient claim checklist before persisting — it's fully folded
      // into `turn.answer` by now (the final render above uses `turn.answer`, not
      // the checklist), and no post-done path reads it. Leaving it on the turn would
      // round-trip the whole verdict-block markdown into localStorage, duplicating
      // `turn.answer`.
      turn.claims = undefined;
      // The tool log is ephemeral streaming chrome (the trace is the durable
      // record) — drop it so it neither survives into the committed turn nor gets
      // persisted to localStorage. The final render above uses `turn.answer`, and
      // no post-done path reads it.
      turn.toolLog = undefined;
      // Clearing the data alone leaves the already-rendered #askToolLog node
      // on screen (with any unpaired "…" row) — hide it too.
      refreshAskToolLog(turn);
      askTurns.push(turn);
      renderAskHistory();
      persistAskSession();
      btn.disabled = false;
      setFollowupDisabled(false); // committed — the follow-up bar is now usable
      // The pane was painted before the answer existed, so neither write-action
      // gate could run (both read the committed answer). Re-derive them now.
      refreshWriteActionBars(turn);
      // The `done` paint above ran before the outcome map existed; apply the ↻ rows
      // now that both the answer and the map are on the turn.
      applyRetryAffordances(document.getElementById("askAnswerBody"), turn);
      // Do NOT close here — the server emits a trailing `answer_html` after `done`.
      // We close on `answer_html` (or the `end` fallback if it never comes).
    },
    answer_html: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      turn.html = d.html || null;
      if (typeof d.cited !== "undefined") turn.cited = d.cited || [];
      // Swap the streamed markdown for the final rendered article — but only if
      // this turn's answer is still the one on screen (the user may have navigated
      // away, in which case it's reachable via the history list). Drop any pending
      // progressive-render frame so it can't repaint over the final article.
      cancelAskStreamRender();
      const b = document.getElementById("askAnswerBody");
      if (b && turn.html) { b.innerHTML = enhanceConfidenceHtml(turn.html); enhanceMermaid(b); enhanceCodeTabs(b); enhanceCodeBlocks(b); applyRetryAffordances(b, turn); }
      refreshAskSources(turn);
      persistAskSession(); // re-store so the rehydrated turn carries the final HTML
      setFollowupDisabled(false); // belt: `done` enabled it, but never re-render since
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
      askActive = null;
      conn.close();
      askConn = null;
    },
    app_error: (e: MessageEvent) => {
      if (askConn !== conn) return;
      let msg = "Something went wrong.";
      try { msg = JSON.parse((e as MessageEvent).data).message || msg; } catch {}
      setAskStatus(msg, "error");
      askActive = null;
      btn.disabled = false;
      setFollowupDisabled(false);
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
      // Terminal for this turn — close so a drop before `end` can't reconnect + re-run.
      conn.close();
      askConn = null;
    },
    end: () => {
      // Fallback close if `answer_html` never arrived (older server / render error):
      // the streamed plain text stands.
      if (askConn !== conn) return;
      askConn.close();
      askConn = null;
      askActive = null;
      btn.disabled = false;
      setFollowupDisabled(false);
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
    },
    onerror: () => {
      if (askConn !== conn) return;
      conn.close();
      askConn = null;
      askActive = null;
      btn.disabled = false;
      setFollowupDisabled(false);
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
      const wrap = document.getElementById("wikiAskStatus");
      if (wrap && !wrap.classList.contains("done") && !wrap.classList.contains("error")) {
        setAskStatus("Connection lost", "error");
      }
    },
  });
  askConn = conn;
}

/** Build the `/api/wiki/ask` URL for a plain question (the Ask box + follow-up
 *  bar share this — same `q`/`wiki`/`history` params). */
function buildAskUrl(q: string): string {
  let url = "/api/wiki/ask?q=" + encodeURIComponent(q);
  if (deps.WIKI()) url += "&wiki=" + encodeURIComponent(deps.WIKI());
  const hist = askHistoryParam();
  if (hist) url += "&history=" + encodeURIComponent(hist);
  return url;
}

/** Start an Ask turn from a plain question string (shared by the Ask box and the
 *  in-pane follow-up bar). `originQuestion` is set only by the follow-up bar —
 *  see `submitFollowup`. */
function askPlainQuestion(q: string, originQuestion?: string): void {
  const turn: AskTurn = {
    question: q, answer: "", citations: [], cited: [], html: null, askedAt: Date.now(),
    originQuestion: originQuestion || undefined,
  };
  runAskStream(buildAskUrl(q), turn);
}

export function askQuestion(): void {
  const input = document.getElementById("wikiAskInput") as HTMLTextAreaElement;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const hint = document.getElementById("wikiAskHint");
  if (hint) hint.style.display = "none";
  askPlainQuestion(q);
}

/** Submit the in-pane follow-up bar under an answer. Reads + clears the input,
 *  then runs the same Ask stream — the turn lands in `askTurns` via the shared
 *  `done` handler, carrying the prior turns as `history`.
 *
 *  The originating question is stamped onto the turn because `history` is a
 *  STREAM param: nothing else survives to the point where a declined follow-up
 *  escalates into chat, and "and what about the second one?" is unanswerable on
 *  its own. Chains keep the ROOT (the parent's own origin wins over the parent's
 *  question), and an Explain-rooted chain stores the composed page+passage form
 *  rather than the bare `Explain: "…"` label. */
export function submitFollowup(): void {
  const input = document.getElementById("wikiFollowupInput") as HTMLInputElement | null;
  if (!input || input.disabled) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const parent = askShownTurn;
  const origin = parent
    ? parent.originQuestion ||
      composeDeclineQuestion({ question: parent.question, explainPage: parent.explainPage })
    : undefined;
  askPlainQuestion(q, origin);
}

/** Persist the shown answer as a durable memory (POST /api/wiki/remember).
 *  Pending → success swaps the bar to a non-interactive "✓ Remembered: …" line;
 *  a failure re-enables the button and shows an inline error. Acts on
 *  `askShownTurn` (set by `showAskAnswer`), sending its plain-markdown answer. */
export async function submitRemember(): Promise<void> {
  const btn = document.getElementById("wikiRememberBtn") as HTMLButtonElement | null;
  const msg = document.getElementById("wikiRememberMsg");
  const turn = askShownTurn;
  if (!btn || btn.disabled || !turn || !turn.answer) return;
  btn.disabled = true;
  const prevLabel = btn.textContent || "Remember this";
  btn.textContent = "Saving…";
  if (msg) { msg.textContent = ""; msg.className = "wiki-remember-msg"; }
  try {
    const res = await fetch("/api/wiki/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: deps.WIKI() || undefined,
        question: turn.question,
        answer: turn.answer,
      }),
    });
    const data = await res.json().catch(() => ({} as { saved?: boolean; summary?: string; error?: string }));
    if (!res.ok || !data.saved) {
      throw new Error(data.error || ("HTTP " + res.status));
    }
    const bar = document.getElementById("wikiRememberBar");
    if (bar) {
      bar.innerHTML =
        '<span class="wiki-remember-done">✓ Remembered: ' + esc(data.summary || "") + "</span>";
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevLabel;
    if (msg) {
      msg.textContent =
        "Couldn't remember that — " + (err instanceof Error ? err.message : String(err));
      msg.className = "wiki-remember-msg error";
    }
  }
}

/** Every field either escalation path reads off `POST /api/wiki/ask/chat`. */
interface AskChatResponse {
  chatUrl?: string;
  error?: string;
  threadId?: string;
  threadExists?: boolean;
  /** Article mode: the derived name collided with a thread that is NOT this
   *  article's (its description carries no matching article tag). Distinct from
   *  `threadExists` precisely because "Send there →" must not be offered. */
  nameTaken?: boolean;
  alreadyQueued?: boolean;
  existingThreadId?: string;
  /** Reuse path only: whether a posted `connectorId` was actually applied. An
   *  established thread keeps its own model, and the pick is dropped. */
  connectorApplied?: boolean;
}

/** The one POST both escalation entry points make. Shared so the body encoding
 *  and the response shape have a single spelling; the 409 handling and all
 *  presentation stay with each caller, which is where they genuinely differ.
 *
 *  NB `connectorId` is passed through VERBATIM, including `""`: its mere presence
 *  is what tells the route this request expressed a connector decision (and so
 *  earns the chatUrl's `&src=wiki` stamp-suppression flag). The one-click path
 *  omits the key entirely — it offers no choice, and must keep the chat sidebar's
 *  ordinary stamping. */
export async function postAskChat(
  payload: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; data: AskChatResponse }> {
  const res = await fetch("/api/wiki/ask/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as AskChatResponse;
  return { status: res.status, ok: res.ok, data };
}

/** Escalate the shown Ask turn into a real chat thread (POST /api/wiki/ask/chat)
 *  and open the returned deep-link in a new tab, where the seeded message
 *  auto-sends.
 *
 *  A 409 means a thread for this question already exists. It is NOT auto-retried
 *  with `forceNew`: that minted a new thread — and a new auto-sent model turn —
 *  on every re-click. The bar offers the existing thread, with "Start new thread"
 *  as an explicit second choice.
 *
 *  All outcome state lands on the TURN (`turn.chatEsc`), never on the DOM node, so
 *  a turn switch mid-flight can neither paint this result onto another turn's bar
 *  nor swallow the error into a detached node. */
export async function submitChatEscalate(forceNew: boolean): Promise<void> {
  const turn = askShownTurn;
  if (!turn || !turn.answer || turn.kind === "factcheck") return;
  if (turn.chatEsc?.status === "pending") return;
  // Pre-open the tab SYNCHRONOUSLY, still inside the click's user gesture: Safari
  // blocks a `window.open` issued after an await unconditionally, so opening after
  // the fetch silently did nothing while the bar claimed "✓ Opened in chat →".
  // Blocked anyway (win === null) ⇒ fall back to rendering an honest link.
  const win = window.open("", "_blank");
  turn.chatEsc = { status: "pending" };
  refreshChatEscalateBar(turn);
  try {
    // No `connectorId` key at all: this path decides nothing about the model, so
    // the thread it opens keeps the chat sidebar's ordinary connector stamping.
    const { status, ok, data } = await postAskChat({
      wiki: deps.WIKI() || undefined,
      question: turn.question,
      answer: turn.answer.slice(0, CHAT_ESC_ANSWER_MAX),
      citations: turn.citations.map((ci) => ({ title: ci.title, pageName: ci.pageName })),
      forceNew: forceNew || undefined,
    });
    if (status === 409 && !forceNew) {
      if (win) win.close();
      // The link comes from the route (which builds it with the same helper its
      // 200s use), never re-derived here.
      turn.chatEsc = { status: "exists", chatUrl: data.chatUrl };
      return;
    }
    if (!ok || !data.chatUrl) throw new Error(data.error || "HTTP " + status);
    if (win) win.location.href = data.chatUrl;
    turn.chatEsc = { status: "done", chatUrl: data.chatUrl, opened: !!win };
  } catch (err) {
    if (win) win.close();
    turn.chatEsc = {
      status: "error",
      message: "Couldn't open a chat — " + (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    refreshChatEscalateBar(turn);
  }
}

/**
 * Re-open the page a fact-check turn was checked on, after a write to it.
 *
 * By relPath when the turn carries one — a name reload after a write lands on
 * whichever same-stem page registered first, i.e. shows the reader an UNCHANGED
 * page and makes a successful write look like it did nothing. Falls back to the
 * name for a turn persisted before `pageRelPath` existed.
 *
 * `push=false` in both spellings: the reader is already on this page, and a write
 * must not add a history entry.
 */
function reloadCheckedPage(turn: AskTurn): void {
  deps.reloadPageInPlace(turn.pageRelPath, turn.page);
}

/** Persist the shown fact-check answer onto the page as a `> [!factcheck]` callout
 *  (POST /api/wiki/factcheck/append). Sends the turn's stored `page` + `baseHash`
 *  + answer. Success ⇒ swap the button to a non-interactive "✓ Added to article"
 *  and reload the page in the reader so the new callout is visible. A 409 (page
 *  changed since the check) shows a clear re-run message. Acts on `askShownTurn`. */
export async function submitFactcheckAppend(): Promise<void> {
  const btn = document.getElementById("wikiFactcheckAppendBtn") as HTMLButtonElement | null;
  const msg = document.getElementById("wikiFactcheckAppendMsg");
  const turn = askShownTurn;
  if (!btn || btn.disabled || !turn || !turn.answer || !turn.page) return;
  const showErr = (text: string): void => {
    if (msg) { msg.textContent = text; msg.className = "wiki-fc-append-msg error"; }
  };
  if (!turn.baseHash) {
    showErr("No page snapshot from this check — re-run the fact check, then add it.");
    return;
  }
  btn.disabled = true;
  const prevLabel = btn.textContent || "➕ Add to article";
  btn.textContent = "Adding…";
  if (msg) { msg.textContent = ""; msg.className = "wiki-fc-append-msg"; }
  try {
    const res = await fetch("/api/wiki/factcheck/append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: deps.WIKI() || undefined,
        page: turn.page,
        // The collision-proof half of the target. Without it the callout was
        // written into whichever same-stem page registered first — measured on
        // mimir, a check on `projects/yggdrasil/architecture.md` landed in
        // `projects/claude-hivemind/architecture.md`.
        ...(turn.pageRelPath ? { relPath: turn.pageRelPath } : {}),
        answer: turn.answer,
        baseHash: turn.baseHash,
      }),
    });
    const data = await res.json().catch(
      () =>
        ({}) as {
          written?: boolean;
          error?: string;
          stale?: boolean;
          /** Set when the write removed `<Fact>` marks left by an earlier check —
           *  the only notice the reader gets that the page lost its underlines. */
          supersededNote?: string;
        },
    );
    if (res.status === 409 || data.stale) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      // A held wiki write lock is the same status with the opposite recovery:
      // nothing moved, so the fact check still stands and the reader retries.
      showErr(isLockedResponse(data) ? WIKI_LOCKED_COPY : INTEGRATE_STALE_COPY);
      return;
    }
    if (!res.ok || !data.written) {
      throw new Error(data.error || "HTTP " + res.status);
    }
    // Record the write on the TURN and persist immediately: the session is only
    // stored on explicit calls, so without this the derived disable would die on
    // the next reload and the button would come back live against a stale
    // baseHash. The innerHTML swap below is just immediate feedback — the render
    // path (`factcheckAppendInnerHtml`) is what's authoritative on a re-render.
    turn.wrote = "append";
    persistAskSession();
    // Both bars are re-DERIVED from the turn (an append also stales this turn's
    // baseHash, retiring the ✎ action), never poked one node at a time.
    refreshWriteActionBars(turn);
    // …and the outcome goes on the rail's Ask status line, the only surface that
    // survives the `loadPage` below (which replaces #articleWrap, bars included).
    // It carries the route's `supersededNote` when there is one: the reload that
    // follows shows a page whose marks are simply gone, and a fixed "✓ Added to
    // article" leaves that looking like a rendering fault rather than this click.
    setAskStatus(appendSuccessStatus(data.supersededNote), "done");
    // Reload the page content so the freshly-written callout is visible — by
    // relPath where the turn has one, so the reader lands on the page that was
    // just WRITTEN rather than on the stem's first registration.
    reloadCheckedPage(turn);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevLabel;
    showErr("Couldn't add that — " + (err instanceof Error ? err.message : String(err)));
  }
}

// ── Integrate into article (fact-check v4) ────────────────────────────
// The second write action on a fact-check turn: propose a structured edit list
// (one 25–90s fenced one-shot server-side), preview it as a per-edit diff with
// checkboxes, then apply the accepted subset in one CAS-guarded write.
//
// The proposal is per-turn TRANSIENT and never persisted — a rehydrated turn just
// re-proposes on click, since the inputs (the persisted answer + baseHash) are all
// the propose route takes.
interface IntegratePreviewState {
  /** The turn this proposal belongs to. `renderIntegratePreview` paints ONLY when
   *  this is the turn currently on screen — a ~90s propose that resolves after the
   *  user switched turns must not paint a live Apply under an unrelated turn (its
   *  Apply would write THIS turn's page while another is displayed). */
  turn: AskTurn;
  proposal: IntegrateProposal;
  /** Parallel to `proposal.edits` — all ON by default. */
  selected: boolean[];
  callout: boolean;
  /** An apply is in flight. Lives HERE, not on the DOM: the panel re-renders
   *  wholesale on every checkbox toggle, so a DOM-held disable produced a fresh
   *  enabled Apply mid-flight and detached the nodes the error path wrote into. */
  applying: boolean;
  /** Panel message (an error, or an `applied: 0` outcome) + its severity. */
  message?: string;
  messageError?: boolean;
  /** Apply is disabled for THIS selection (an `applied: 0` would reproduce
   *  forever). Any checkbox toggle clears it. */
  applyBlocked?: boolean;
  /** The apply route's own per-edit rejections, rendered with their honest reasons. */
  applyDropped?: DroppedEditRow[];
  /** `<details>` open state of the propose-time dropped list, so a re-render
   *  doesn't snap it shut under the reader. */
  droppedOpen: boolean;
  /** Same, for the APPLY-time dropped list. Kept as its OWN field because both
   *  lists render with the `.wiki-fc-int-dropped` class — one shared flag meant
   *  opening either one flipped the other on the next re-render. `undefined` ⇒
   *  the renderer's default (open). */
  applyDroppedOpen?: boolean;
  /** Index of the checkbox to refocus after a re-render (-1 = none). */
  focusEditIdx: number;
}
let integratePreview: IntegratePreviewState | null = null;

/** Show a message on the ✎ bar (not the preview panel). Stored per turn and
 *  RE-RENDERED, never poked into a node the next refresh would replace. */
function setIntegrateBarMsg(turn: AskTurn, text: string, isError: boolean): void {
  if (text) integrateBarMsgs[turn.askedAt] = { text, error: isError };
  else delete integrateBarMsgs[turn.askedAt];
  refreshWriteActionBars(turn);
}

/** Repaint the preview panel from `integratePreview` — every visual bit (checkbox
 *  states, the Apply count/budget/in-flight state, the messages, the dropped
 *  disclosure) derives from it. Renders NOTHING when the stored preview belongs to
 *  a turn other than the one on screen. */
function renderIntegratePreview(): void {
  const host = document.getElementById("wikiFcIntHost");
  if (!host) return;
  const state = integratePreview;
  if (!state || state.turn !== askShownTurn) { host.innerHTML = ""; return; }
  host.innerHTML = integratePreviewHtml(state.proposal, state.selected, state.callout, {
    applying: state.applying,
    message: state.message,
    messageError: state.messageError,
    applyBlocked: state.applyBlocked,
    applyDropped: state.applyDropped,
    droppedOpen: state.droppedOpen,
    applyDroppedOpen: state.applyDroppedOpen,
    calloutDisabled: !state.turn.answer,
  });
  // A full re-render on every toggle is the simple, state-honest choice — but it
  // must not cost the reader their caret. Restore focus to the checkbox they just
  // flipped (the details open state is carried on the state above).
  if (state.focusEditIdx >= 0) {
    const cb = host.querySelector(
      '.wiki-fc-int-cb[data-edit-idx="' + state.focusEditIdx + '"]',
    ) as HTMLElement | null;
    cb?.focus();
    state.focusEditIdx = -1;
  }
}

/** Fresh preview state for a landed proposal. */
function newPreviewState(
  turn: AskTurn,
  proposal: IntegrateProposal,
  selected: boolean[],
  callout: boolean,
): IntegratePreviewState {
  return {
    turn,
    proposal,
    selected,
    callout,
    applying: false,
    // A run whose drops OUTNUMBER its edits gets its reason list opened: the
    // headline "1 proposed edit" is exactly the case where the reasons are the
    // information (`shouldOpenDroppedList`).
    droppedOpen: shouldOpenDroppedList(proposal),
    focusEditIdx: -1,
  };
}

/**
 * Ask the server to propose edits for the shown fact-check turn. One synchronous
 * model call server-side, so the button carries an explicit "up to ~90s" label
 * rather than a spinner with no expectation set.
 */
export async function submitFactcheckIntegrate(): Promise<void> {
  const btn = document.getElementById("wikiFactcheckIntegrateBtn") as HTMLButtonElement | null;
  const turn = askShownTurn;
  if (!btn || btn.disabled || !turn || !turn.answer || !turn.page) return;
  if (integrateProposing) return; // one propose at a time (the bar renders disabled)
  if (!turn.baseHash) {
    setIntegrateBarMsg(turn, "No page snapshot from this check — re-run the fact check, then integrate.", true);
    return;
  }
  // In-flight state is derived, not poked: `integrateProposing` drives the bar's
  // disabled "Proposing…" label through `factcheckIntegrateInnerHtml`, so any
  // re-render (an SSE `end`, re-opening the turn) reproduces it.
  integrateProposing = turn;
  delete integrateBarMsgs[turn.askedAt];
  refreshWriteActionBars(turn);
  integratePreview = null;
  renderIntegratePreview();
  // The proposal's ranges are resolved against THIS answer. A ↻ retry splicing a
  // fresh verdict block mid-propose (the propose takes ~90s; a retry takes ~180s,
  // so the overlap is routine) would leave every offset describing a body that no
  // longer exists — and Apply posts the answer too, so it would ship pre-splice
  // edits beside a post-splice answer.
  const proposedAgainst = turn.answer;
  try {
    const res = await fetch("/api/wiki/factcheck/integrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: deps.WIKI() || undefined,
        page: turn.page,
        ...(turn.pageRelPath ? { relPath: turn.pageRelPath } : {}),
        answer: turn.answer,
        baseHash: turn.baseHash,
        // Claim quotes ride along for instrumentation (PR 2) — the server
        // re-validates them against the answer it parses itself and silently
        // degrades to "no quotes" on any disagreement.
        ...(turn.claimQuotes && turn.claimQuotes.length ? { quotes: turn.claimQuotes } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as IntegrateProposal & {
      error?: string;
      stale?: boolean;
    };
    if (res.status === 409 || data.stale) {
      setIntegrateBarMsg(turn, INTEGRATE_STALE_COPY_EDIT, true);
      return;
    }
    // A page over the cap is a legitimate outcome, not a failure — the client
    // usually catches it from `turn.bodyLen`, but a pre-`bodyLen` turn learns it
    // here. Say the same thing either way.
    if (res.status === 400 && (data.error || "").indexOf("too long") !== -1) {
      setIntegrateBarMsg(
        turn,
        "This page is too long to integrate automatically — edit it by hand, or add the callout instead.",
        true,
      );
      return;
    }
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    if (turn.answer !== proposedAgainst) {
      setIntegrateBarMsg(turn, "The answer changed — propose the edits again.", true);
      return;
    }
    const edits = Array.isArray(data.edits) ? data.edits : [];
    // ALWAYS store, THEN attempt the render. A propose that resolved while the
    // reader was on another turn (or another page) is not lost — the state is
    // turn-keyed, and re-opening the turn from history paints it.
    integratePreview = newPreviewState(
      turn,
      { ...data, edits, dropped: Array.isArray(data.dropped) ? data.dropped : [] },
      edits.map(() => true),
      // Default ON only when the page already carries a fact-check block AND the
      // turn actually has an answer to build one from (no answer ⇒ the checkbox
      // renders disabled).
      data.hasSentinelBlock === true && !!turn.answer,
    );
    renderIntegratePreview();
  } catch (err) {
    setIntegrateBarMsg(
      turn,
      "Couldn't propose edits — " + (err instanceof Error ? err.message : String(err)),
      true,
    );
  } finally {
    // Re-DERIVE the bar rather than force-enabling it: the write may have retired
    // the button in the meantime, and a restored label would out-live the state.
    integrateProposing = null;
    refreshWriteActionBars(turn);
  }
}

/** Apply the selected edits. The accepted subset goes back VERBATIM with the same
 *  `baseHash`, so the server's CAS still guards the write. */
export async function acceptFactcheckIntegrate(): Promise<void> {
  const state = integratePreview;
  // Every gate is state-side: an in-flight apply, a turn that is no longer the
  // one on screen, or a selection already known to resolve to nothing.
  if (!state || state.applying || state.applyBlocked) return;
  if (state.turn !== askShownTurn) return;
  const { turn } = state;
  if (!turn.page || !turn.baseHash) return;
  const calloutRequested = state.callout && !!turn.answer;
  const calloutReplaced = state.proposal.hasSentinelBlock === true;
  const body = buildIntegrateApplyBody({
    wiki: deps.WIKI() || undefined,
    page: turn.page,
    ...(turn.pageRelPath ? { relPath: turn.pageRelPath } : {}),
    baseHash: turn.baseHash,
    edits: state.proposal.edits,
    selected: state.selected,
    appendCallout: state.callout,
    answer: turn.answer,
  });
  if (!body) return;
  // Show a message by mutating STATE and re-rendering — never by writing into a
  // node captured before the render, which a mid-flight toggle would have detached.
  const showErr = (text: string): void => {
    state.message = text;
    state.messageError = true;
    renderIntegratePreview();
  };
  state.applying = true;
  state.message = undefined;
  state.messageError = false;
  state.applyDropped = undefined;
  state.applyDroppedOpen = undefined; // a fresh apply's reasons open by default again
  renderIntegratePreview();
  try {
    const res = await fetch("/api/wiki/factcheck/integrate/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      applied?: number;
      calloutAdded?: boolean;
      dropped?: DroppedEditRow[];
      committed?: boolean;
      reason?: string;
      error?: string;
      stale?: boolean;
    };
    if (res.status === 409 || data.stale) {
      state.applying = false;
      showErr(isLockedResponse(data) ? WIKI_LOCKED_COPY : INTEGRATE_STALE_COPY_EDIT);
      return;
    }
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    const applied = typeof data.applied === "number" ? data.applied : 0;
    const copy = integrateSuccessCopy({
      applied,
      committed: data.committed,
      reason: data.reason,
      calloutAdded: data.calloutAdded,
      calloutRequested,
      calloutReplaced,
      // An annotated write persists the `<FactCheck>` APPENDIX, not the `.md`
      // summary callout — name the thing that actually landed on the page.
      annotated: carriesFactWrapper(body.edits),
    });
    if (applied === 0) {
      // Nothing was written. Re-offering the SAME selection would reproduce this
      // forever, so Apply stays disabled until a checkbox changes — and the
      // server's honest per-edit reasons are shown instead of being discarded.
      state.applying = false;
      state.applyBlocked = true;
      state.applyDropped = Array.isArray(data.dropped) ? data.dropped : [];
      showErr(copy);
      return;
    }
    // Record the write on the TURN and persist IMMEDIATELY — the session only
    // persists on explicit calls, and this flag is what makes both write buttons
    // come back correctly disabled after a reload.
    turn.wrote = "integrate";
    // What the write actually PERSISTED, not what the page's extension allows. The
    // route sets `calloutAdded` on the one branch that splices a fact-check block,
    // and the ➕ bar's copy + tone are derived from this on every later render
    // (a reload included — the whole turn is serialized).
    turn.wroteBlock = data.calloutAdded === true;
    integratedNotes[turn.askedAt] = copy;
    delete integrateBarMsgs[turn.askedAt];
    persistAskSession();
    integratePreview = null;
    renderIntegratePreview();
    refreshWriteActionBars(turn);
    // The outcome copy ALSO goes on the rail's Ask status line, which is the only
    // place it can actually be read: `loadPage` below replaces #articleWrap
    // wholesale — bars and all — so a message left only on the bar is destroyed
    // within a frame, whichever order the two calls are made in (loadPage is
    // fire-and-forget; there is no post-render hook to re-attach to). The bar copy
    // stays for the re-opened turn; the status line is what the user sees NOW.
    setAskStatus(copy, "done");
    // Reload the page in the reader so the corrected prose is visible — by
    // relPath where the turn has one (see `reloadCheckedPage`).
    reloadCheckedPage(turn);
  } catch (err) {
    state.applying = false;
    showErr("Couldn't apply — " + (err instanceof Error ? err.message : String(err)));
  }
}

/** Dismiss the preview panel without writing anything. Refuses while an apply is
 *  in flight (the button renders disabled then too) — dropping the state mid-write
 *  would strand the response with nowhere honest to report itself. */
export function cancelFactcheckIntegrate(): void {
  if (integratePreview?.applying) return;
  integratePreview = null;
  renderIntegratePreview();
}

// ── Ask session persistence (localStorage) ────────────────────────────
// Persist the last N committed Ask/Explain turns so a page reload rehydrates the
// "This session" list. Keyed per wiki (the bare /wiki reader may have no WIKI —
// fall back to a shared default key). localStorage works here (the reader is a
// normal page); the no-storage constraint only applies inside explainer iframes.
const ASK_SESSION_CAP = 10;
const ASK_SESSION_CAP_FALLBACK = 5; // quota retry
function askSessionKey(): string {
  return "wikiAskSession:" + (deps.WIKI() || "__default__");
}
/** Store the current session; a quota error retries once at a smaller cap, then
 *  gives up silently (persistence is best-effort). */
function persistAskSession(): void {
  const key = askSessionKey();
  try {
    localStorage.setItem(key, serializeAskSession(askTurns as StoredAskTurn[], ASK_SESSION_CAP));
  } catch {
    try {
      localStorage.setItem(
        key,
        serializeAskSession(askTurns as StoredAskTurn[], ASK_SESSION_CAP_FALLBACK),
      );
    } catch {
      /* out of quota even at 5 — drop persistence silently */
    }
  }
}
/** Rehydrate the stored session into `askTurns` + the history list at boot. Does
 *  NOT auto-show an answer — the list is enough; clicking a turn re-shows it. */
export function rehydrateAskSession(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(askSessionKey());
  } catch {
    return; // storage unavailable — nothing to rehydrate
  }
  const stored = deserializeAskSession(raw);
  if (!stored.length) return;
  for (const t of stored) askTurns.push(t as unknown as AskTurn);
  renderAskHistory();
}
/** Clear the session (history + storage), from the "clear" affordance. */
export function clearAskSession(): void {
  // Disown any in-flight ↻ first: its `claim_result` would otherwise land on a turn
  // that is no longer in `askTurns`, splice it, and `persistAskSession` an empty
  // array while the orphan turn kept a live run record pointing at it.
  abortClaimRetryRun();
  for (const t of askTurns) clearClaimRetryMsgs(t as AskTurn);
  askTurns.length = 0;
  renderAskHistory();
  try {
    localStorage.removeItem(askSessionKey());
  } catch {
    /* ignore */
  }
}

/** Wire the port. The shell's `boot()` calls it beside `initEffort`, after
 *  `WIKI` is read and before {@link rehydrateAskSession}. */
export function initAsk(d: AskTurnPort): void {
  deps = d;
}

/** The turn painted in the article pane, or null (the shell's click delegate
 *  and the chat-options port read it). */
export function getAskShownTurn(): AskTurn | null {
  return askShownTurn;
}

/** The session's committed turns, oldest first. The array itself, not a copy. */
export function getAskTurns(): AskTurn[] {
  return askTurns;
}

/** The integrate preview's `change` and capture-phase `toggle` delegates.
 *  The shell's `boot()` calls this at the position the listeners held there:
 *  after `initChatOptions`, before the follow-up `keydown`. */
export function registerIntegratePreviewInputs(): void {
  // Preview-panel checkboxes — same document-level delegation (the panel is
  // re-rendered wholesale on every toggle, so direct listeners wouldn't survive).
  // State lives on `integratePreview`, never on the DOM.
  document.addEventListener("change", (e) => {
    const state = integratePreview;
    if (!state) return;
    // An apply is in flight: the inputs render disabled, but a programmatic or
    // racing change must not re-render the panel out from under it either.
    if (state.applying) return;
    const t = e.target as HTMLElement;
    if (t.id === "wikiFcIntCallout") {
      state.callout = (t as HTMLInputElement).checked;
      renderIntegratePreview();
      return;
    }
    if (t.classList && t.classList.contains("wiki-fc-int-cb")) {
      // The annotation GROUP checkbox owns every wrapper-only index at once — the
      // marks are one editorial act, and a half-marked page would leave chips and
      // appendix disagreeing about what was checked.
      if (t.getAttribute("data-edit-group") === "annotations") {
        const on = (t as HTMLInputElement).checked;
        for (const i of annotationIndexes(state.proposal.edits || [])) state.selected[i] = on;
        state.applyBlocked = false;
        state.applyDropped = undefined;
        state.applyDroppedOpen = undefined;
        renderIntegratePreview();
        return;
      }
      const idx = parseInt(t.getAttribute("data-edit-idx") || "-1", 10);
      if (idx >= 0) {
        state.selected[idx] = (t as HTMLInputElement).checked;
        // The selection changed, so the "this exact selection resolved to nothing"
        // block no longer applies — Apply becomes live again.
        state.applyBlocked = false;
        state.applyDropped = undefined;
        state.applyDroppedOpen = undefined;
        state.focusEditIdx = idx; // restored after the full re-render
        renderIntegratePreview();
      }
    }
  });
  // The dropped-list disclosure is state, not DOM: without this a checkbox toggle's
  // re-render snapped an opened "N not applied" list shut again.
  //
  // There are TWO such lists (propose-time drops, and the apply route's own
  // rejections) and they share the `.wiki-fc-int-dropped` class, so the `apply-drops`
  // modifier is what tells them apart — into two separate state fields. A single
  // shared field made each list's toggle clobber the other's open state.
  document.addEventListener(
    "toggle",
    (e) => {
      const state = integratePreview;
      if (!state) return;
      const t = e.target as HTMLElement;
      if (t instanceof HTMLDetailsElement && t.classList.contains("wiki-fc-int-dropped")) {
        if (t.classList.contains("apply-drops")) state.applyDroppedOpen = t.open;
        else state.droppedOpen = t.open;
      }
    },
    true, // `toggle` does not bubble — capture it
  );
}
