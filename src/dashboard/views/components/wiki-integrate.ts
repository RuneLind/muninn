/**
 * Pure (DOM-free, server-import-free) helpers for the fact-check **Integrate into
 * article** flow — the counterpart to `src/wiki/integrate-edits.ts`.
 *
 * The one thing that must be shared verbatim between the server (which builds the
 * integrate prompt from the PERSISTED answer markdown) and the bundled client
 * (which previews the proposed edits per claim) is the answer-block parser. It
 * lives here — the `synthesisTopicKey` precedent in `wiki-atlas-semantic.ts` —
 * so there is ONE implementation and no hand-mirror to drift.
 *
 * Kept free of every server-only import (no node builtins, no `src/wiki/*`), so
 * `src/wiki/integrate-edits.ts` imports THIS module and never the reverse.
 *
 * PR 2 (UI) grew this module past the parser: the reader's Integrate button gate,
 * the diff-preview HTML builders and the apply-body construction all live here for
 * the same reason — they must be unit-testable, and `wiki-browser.ts` runs DOM code
 * at module load so it can't be imported in tests. `src/gardener/diff.ts` (the
 * dependency-free LCS line diff behind the gardener's update preview) is the only
 * import, and it is likewise DOM-free + node-free.
 */

import { lineDiff, type DiffLine } from "../../../gardener/diff.ts";
import { escHtml as esc } from "./escape.ts";

/**
 * The four verdict markers, matching `VERDICT_RE` in `factcheck-sse.ts`. The VS16
 * (U+FE0F) is OPTIONAL on ALL FOUR — the persisted answer is the raw model blocks
 * with no normalization pass, and models emit both the bare ⚠ (U+26A0) and the
 * VS16-suffixed ❌️/✅️/❓️ that most emoji keyboards produce. A single missed
 * variant makes the whole claim invisible to the integrate flow, which is why the
 * separator is likewise tolerant (em dash / en dash / hyphen / colon), `Claim` is
 * matched case-insensitively, and the title is optional.
 *
 * The `###` anchor is deliberately NOT loosened: the heading level is a fixed
 * prompt contract (`factcheckVerifySystemPrompt`), and accepting `##`/`####` would
 * start matching prose that merely mentions a claim.
 */
const CLAIM_HEADING_RE =
  /^###\s*(✅️?|⚠️?|❌️?|❓️?)\s*Claim\s+(\d+)\s*\/\s*(\d+)\s*(?:[—–:-]\s*(.*))?$/iu;

/** One claim anchor derived SERVER-SIDE from the persisted fact-check answer. */
export interface FactcheckClaimAnchor {
  /** `n` from the `Claim n/m` heading (1-based, as the model wrote it). */
  index: number;
  /** Verdict emoji, normalized to the VS16 form for ⚠️. */
  verdict: string;
  /** Short claim title from the heading (empty when the heading carried none). */
  title: string;
  /** The whole block — heading line through the text before the next `###`. */
  block: string;
}

/** Normalize verdict spelling to ONE form downstream can compare against: strip
 *  every optional VS16, then re-add it on ⚠ (whose canonical form here IS ⚠️,
 *  matching `INTEGRATE_VERDICTS`). */
function normalizeVerdict(v: string): string {
  const bare = v.replace(/\uFE0F/g, "");
  return bare === "⚠" ? "⚠️" : bare;
}

/**
 * Split a persisted fact-check answer into its per-claim verdict blocks. The
 * `### <emoji> Claim n/m — <title>` heading is a fixed prompt contract
 * (`factcheckVerifySystemPrompt` in `src/wiki/factcheck-context.ts`), so this is
 * a heading scan, not a heuristic. Text before the first heading (the compose
 * lede) is ignored. Never throws; a malformed answer yields `[]`.
 */
export function parseFactcheckClaims(answer: string): FactcheckClaimAnchor[] {
  if (!answer || typeof answer !== "string") return [];
  const lines = answer.split("\n");
  const anchors: FactcheckClaimAnchor[] = [];
  let current: FactcheckClaimAnchor | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) anchors.push({ ...current, block: buffer.join("\n").trim() });
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    const m = line.trim().match(CLAIM_HEADING_RE);
    if (m) {
      flush();
      current = {
        index: Number(m[2]),
        verdict: normalizeVerdict(m[1]!),
        title: (m[4] ?? "").trim(),
        block: "",
      };
      buffer = [line];
      continue;
    }
    // A non-claim `###` heading closes the current block without opening one.
    if (current && /^###\s/.test(line.trim())) {
      flush();
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return anchors;
}

/**
 * Per-quote character cap. Phase-1 extraction already asks for ≤300 chars; 400
 * leaves slack for a model that overshoots slightly without letting a client turn
 * the quote list into an unbounded input on a bounded route.
 */
export const CLAIM_QUOTE_MAX = 400;

/** Total character cap across the whole posted quote list. `FACTCHECK_MAX_CLAIMS`
 *  (8) × {@link CLAIM_QUOTE_MAX} plus slack — a bound, not a budget. */
export const CLAIM_QUOTES_TOTAL_MAX = 4_000;

/** One claim's verbatim supporting passage, keyed by the claim's 1-based index
 *  (the SAME `n` the `### … Claim n/m` heading carries). Alignment is ALWAYS by
 *  this explicit index, never by list position. */
export interface ClaimQuote {
  index: number;
  quote: string;
}

/** Outcome of {@link validateClaimQuotes}: the surviving quotes plus an honest
 *  `note` whenever anything was dropped (reported on the propose response — a
 *  silent drop is the #397 class of bug). */
export interface ClaimQuoteValidation {
  quotes: ClaimQuote[];
  note?: string;
}

/**
 * Validate a CLIENT-POSTED claim-quote list against the claim anchors the server
 * itself parses out of the posted `answer` ({@link parseFactcheckClaims}) — the
 * same "parse it ourselves, don't trust a client split" discipline the propose
 * route already applies to the claim list.
 *
 * The failure mode this guards is specific and bad: a quote wrongly paired with
 * claim k+1's verdict would wrap the passage in the WRONG verdict colour. So a
 * structural disagreement drops the WHOLE list rather than guessing an alignment:
 * a non-array payload, any malformed item, an index that names no claim block in
 * the answer, a duplicate index, more quotes than the answer has claims, or a
 * total size over {@link CLAIM_QUOTES_TOTAL_MAX}.
 *
 * NB the count rule is `≤`, not `===`: `Claim.quote` is OPTIONAL at extraction
 * ("Omit it if the claim is implicit" — `buildClaimExtractionPrompt`), so a
 * legitimate run routinely carries fewer quotes than claims. The safety property
 * is preserved by the index-membership + no-duplicates rules, which is where
 * alignment actually lives.
 *
 * A single over-cap or blank quote is dropped ON ITS OWN (index-keyed, so
 * dropping one cannot shift another). Never throws; degrading to "no quotes"
 * always leaves the caller with a working propose.
 */
export function validateClaimQuotes(raw: unknown, answer: string): ClaimQuoteValidation {
  if (typeof raw === "undefined" || raw === null) return { quotes: [] };
  if (!Array.isArray(raw)) return { quotes: [], note: "claim quotes ignored — not a list" };

  const anchors = parseFactcheckClaims(answer);
  const known = new Set(anchors.map((a) => a.index));
  if (raw.length > anchors.length) {
    return { quotes: [], note: "claim quotes ignored — more quotes than claims in the answer" };
  }

  const seen = new Set<number>();
  const kept: ClaimQuote[] = [];
  let overCap = 0;
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { quotes: [], note: "claim quotes ignored — malformed entry" };
    }
    const o = item as Record<string, unknown>;
    const index = typeof o.index === "number" && Number.isInteger(o.index) ? o.index : null;
    if (index === null || !known.has(index)) {
      return { quotes: [], note: "claim quotes ignored — an index matches no claim in the answer" };
    }
    if (seen.has(index)) {
      return { quotes: [], note: "claim quotes ignored — duplicate claim index" };
    }
    seen.add(index);
    const quote = typeof o.quote === "string" ? o.quote.trim() : "";
    // A blank or over-long quote is dropped alone — the remaining quotes stay
    // correctly aligned because alignment is by `index`, not position.
    if (!quote || quote.length > CLAIM_QUOTE_MAX) {
      overCap++;
      continue;
    }
    total += quote.length;
    kept.push({ index, quote });
  }
  if (total > CLAIM_QUOTES_TOTAL_MAX) {
    return { quotes: [], note: "claim quotes ignored — total size over the limit" };
  }
  return overCap > 0
    ? { quotes: kept, note: `${overCap} claim quote${overCap === 1 ? "" : "s"} dropped (blank or over ${CLAIM_QUOTE_MAX} chars)` }
    : { quotes: kept };
}

/** Verdicts the integrate flow acts on (v1): contradicted + partly supported.
 *  ✅ and ❓ blocks are never turned into edits. */
export const INTEGRATE_VERDICTS = ["❌", "⚠️"] as const;

/** The correctable subset of {@link parseFactcheckClaims} — ❌ and ⚠️ only. */
export function correctableClaims(answer: string): FactcheckClaimAnchor[] {
  const wanted = new Set<string>(INTEGRATE_VERDICTS);
  return parseFactcheckClaims(answer).filter((c) => wanted.has(c.verdict));
}

/**
 * Body-length ceiling for the whole integrate flow. Declared HERE (not in
 * `src/wiki/integrate-edits.ts`, which re-exports it) because the bundled client
 * needs it for the render gate and must not import the server module — importing
 * `integrate-edits.ts` would drag `explain-context.ts` → `research/answer.ts` and
 * the whole server graph into the browser bundle.
 *
 * ~10% of a mature wiki's pages exceed it; the client renders the honest
 * "page too long" state itself rather than spending a round-trip on a 400.
 */
export const INTEGRATE_BODY_MAX = 24_000;

// ── Client-side wire shapes ──────────────────────────────────────────────────
// Deliberately loose mirrors of the propose route's 200 payload: the client is
// the untrusted side of nothing here (the server re-resolves and re-bounds every
// edit at apply), so these types exist for readability, not enforcement.

/** One proposed edit as the propose route returns it (range-resolved). */
export interface ProposedEdit {
  claimIndex: number;
  verdict: string;
  old: string;
  new: string;
  reason: string;
  start?: number;
  end?: number;
  /** `"collapsed"` marks a tier-2 whitespace-rescued anchor — surfaced as a chip
   *  so the reviewer knows the raw span differs from the model's quote. */
  tier?: string;
  /** The RAW slice the server will actually replace. The preview MUST diff this,
   *  not `old` — on a tier-2 rescue they differ. */
  resolvedText?: string;
  beforeCtx?: string;
  afterCtx?: string;
}

/** One rejection from the propose route (model-malformed / capped / unplaceable). */
export interface DroppedEditRow {
  edit?: { claimIndex?: number; verdict?: string; old?: string; new?: string; reason?: string };
  reason?: string;
}

/** The propose route's echoed budget (`proposedChangedChars` only on the full path). */
export interface IntegrateBudget {
  bodyLen: number;
  maxEdits: number;
  maxEditChars: number;
  maxChangedChars: number;
  proposedChangedChars?: number;
}

/** The propose route's 200 payload. */
export interface IntegrateProposal {
  edits: ProposedEdit[];
  dropped: DroppedEditRow[];
  note?: string;
  budget?: IntegrateBudget;
  /** Additive (PR 2): the page already carries a `<!-- factcheck:start -->` block,
   *  so the "also refresh the summary callout" checkbox defaults ON. */
  hasSentinelBlock?: boolean;
}

// ── Render gate ──────────────────────────────────────────────────────────────

/** What the "✎ Integrate into article" bar should render for a turn. */
export type IntegrateBarState =
  /** Not an integrate-capable turn at all (not a fact check, an explainer, no page,
   *  or no ❌/⚠️ claim to correct) — the bar renders nothing. */
  | "hidden"
  /** A fact check still streaming — the bar is empty until `done` refreshes it. */
  | "pending"
  /** Ready to propose. */
  | "ready"
  /** The page is over {@link INTEGRATE_BODY_MAX} — say so instead of offering a
   *  button whose only outcome is a 400. */
  | "too-long"
  /** This turn already integrated — nothing more to write from it. */
  | "done"
  /** This turn already appended a callout, which staled its `baseHash`. */
  | "blocked-append";

/** The subset of an `AskTurn` the two write-action gates read. */
export interface IntegrateGateTurn {
  kind?: string;
  page?: string;
  pageType?: string;
  answer?: string;
  bodyLen?: number;
  wrote?: string;
}

/** True when the persisted answer carries at least one ❌/⚠️ claim block. Uses the
 *  shared heading parser, NOT a substring scan — a ⚠️ in the compose lede or in a
 *  claim's reasoning must not make an all-✅ check look correctable. */
export function hasCorrectableClaims(answer: string | undefined): boolean {
  return correctableClaims(answer ?? "").length > 0;
}

/**
 * Decide what the Integrate bar renders for a turn. Pure, so the gate is
 * unit-tested rather than eyeballed in the browser.
 *
 * An ABSENT `bodyLen` (a turn from before the field shipped) deliberately renders
 * the button and lets the server's 400 drive the too-long panel — better than
 * hiding a working action on every rehydrated turn.
 */
export function integrateBarState(turn: IntegrateGateTurn): IntegrateBarState {
  if (turn.kind !== "factcheck" || turn.pageType === "explainer" || !turn.page) return "hidden";
  if (!turn.answer) return "pending";
  if (turn.wrote === "integrate") return "done";
  if (turn.wrote === "append") return "blocked-append";
  if (!hasCorrectableClaims(turn.answer)) return "hidden";
  if (typeof turn.bodyLen === "number" && turn.bodyLen > INTEGRATE_BODY_MAX) return "too-long";
  return "ready";
}

/** Whether the ➕ Add-to-article button is still offerable. An integrate write
 *  staled this turn's `baseHash`, so re-appending would only ever 409. */
export function appendBlockedByIntegrate(turn: IntegrateGateTurn): boolean {
  return turn.wrote === "integrate";
}

/** The 409-shaped copy the ➕ **append** action shows once the other write has
 *  landed. Deliberately identical to `submitFactcheckAppend`'s live-409 message. */
export const INTEGRATE_STALE_COPY =
  "The page changed since the check — re-run the fact check, then add it.";

/** The same 409 shape on the ✎ **integrate** bar. Separate string because "then
 *  add it" names the ➕ action — on the editing bar the only sensible next step is
 *  to integrate again. */
export const INTEGRATE_STALE_COPY_EDIT =
  "The page changed since the check — re-run the fact check, then integrate again.";

// ── Diff preview ─────────────────────────────────────────────────────────────

/** Chars ONE edit changes, measured the way the server measures a resolved
 *  outcome (`outcomeChangedChars`): the larger of the raw span replaced and the
 *  text inserted. Client-side this is UX only — the server re-measures. */
export function editChangedChars(edit: ProposedEdit): number {
  // Defensive on BOTH sides: this runs from the checkbox change handler, so a
  // malformed proposal (a field the server never sent, a non-string) must degrade
  // to a number rather than throw and wedge the panel.
  const oldText =
    typeof edit.resolvedText === "string"
      ? edit.resolvedText
      : typeof edit.old === "string"
        ? edit.old
        : "";
  const newText = typeof edit.new === "string" ? edit.new : "";
  return Math.max(oldText.length, newText.length);
}

/** Total changed chars over the SELECTED edits (`selected[i]` parallel to `edits`;
 *  a missing entry counts as selected, matching the all-on default). */
export function selectedChangedChars(edits: ProposedEdit[], selected: boolean[]): number {
  return edits.reduce((sum, e, i) => (selected[i] === false ? sum : sum + editChangedChars(e)), 0);
}

/** Render an LCS line diff with the gardener's `d-add`/`d-del`/`d-ctx` classes. */
function diffHtml(diff: DiffLine[]): string {
  return (
    '<div class="wiki-fc-int-diff">' +
    diff
      .map((l) => {
        const cls = l.type === "add" ? "d-add" : l.type === "del" ? "d-del" : "d-ctx";
        const prefix = l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ";
        return '<span class="' + cls + '">' + esc(prefix + l.text) + "</span>";
      })
      .join("") +
    "</div>"
  );
}

/**
 * One edit's preview card. The "old" side is `resolvedText` — the RAW slice the
 * server will actually replace — falling back to the model's `old` only when the
 * server didn't send one. Diffing `old` would show the reviewer a span that is not
 * what gets spliced whenever a tier-2 rescue widened it.
 */
export function editPreviewHtml(
  edit: ProposedEdit,
  index: number,
  checked: boolean,
  disabled = false,
): string {
  const oldText =
    typeof edit.resolvedText === "string"
      ? edit.resolvedText
      : typeof edit.old === "string"
        ? edit.old
        : "";
  const newText = typeof edit.new === "string" ? edit.new : "";
  const tierChip =
    edit.tier === "collapsed"
      ? '<span class="wiki-fc-int-tier" title="Matched after collapsing whitespace — the replaced span is shown below, not the model\'s quote">collapsed match</span>'
      : "";
  // `claimIndex` is model-derived and only re-shaped (not re-typed) on the way
  // here — escape it like every other untrusted field rather than interpolating.
  const claim =
    typeof edit.claimIndex === "number" && edit.claimIndex > 0
      ? '<span class="wiki-fc-int-claim">Claim ' + esc(String(edit.claimIndex)) + "</span>"
      : "";
  const ctxBefore = edit.beforeCtx
    ? '<div class="wiki-fc-int-ctx">…' + esc(edit.beforeCtx) + "</div>"
    : "";
  const ctxAfter = edit.afterCtx ? '<div class="wiki-fc-int-ctx">' + esc(edit.afterCtx) + "…</div>" : "";
  return (
    '<div class="wiki-fc-int-edit">' +
    '<label class="wiki-fc-int-row">' +
    '<input type="checkbox" class="wiki-fc-int-cb" data-edit-idx="' + index + '"' +
    (checked ? " checked" : "") + (disabled ? " disabled" : "") + " />" +
    '<span class="wiki-fc-int-verdict">' + esc(edit.verdict || "") + "</span>" +
    claim +
    '<span class="wiki-fc-int-reason">' + esc(edit.reason || "") + "</span>" +
    tierChip +
    "</label>" +
    ctxBefore +
    diffHtml(lineDiff(oldText, newText)) +
    ctxAfter +
    "</div>"
  );
}

/** The collapsed "not applied" list — every propose-time rejection with its
 *  honest reason, so a thin preview never reads as a silent drop. */
export function droppedListHtml(
  dropped: DroppedEditRow[],
  open = false,
  label?: string,
  extraClass = "",
): string {
  if (!dropped.length) return "";
  const rows = dropped
    .map((d) => {
      const quote = (d.edit?.old ?? "").slice(0, 120);
      return (
        '<div class="wiki-fc-int-drop">' +
        '<span class="wiki-fc-int-drop-reason">' + esc(d.reason || "dropped") + "</span>" +
        (quote ? '<span class="wiki-fc-int-drop-quote">' + esc(quote) + "</span>" : "") +
        "</div>"
      );
    })
    .join("");
  return (
    '<details class="wiki-fc-int-dropped' + (extraClass ? " " + extraClass : "") + '"' +
    (open ? " open" : "") + "><summary>" +
    esc(label ?? dropped.length + " not applied") + "</summary>" + rows + "</details>"
  );
}

/**
 * Everything the preview panel renders that is NOT the proposal itself — the
 * in-flight/outcome state of an apply, plus the two disclosure/enablement bits
 * the panel must reproduce across a re-render.
 *
 * This exists because the panel is re-rendered wholesale from state on every
 * checkbox toggle. Holding "an apply is running" on the DOM (a disabled button, a
 * captured `msg` node) meant one toggle mid-apply produced a fresh ENABLED Apply
 * button and detached the very nodes the error handler wrote into — an invisible
 * failure plus a second apply. Anything the panel must survive a re-render lives
 * here.
 */
export interface IntegratePreviewView {
  /** An apply is in flight: Apply reads "Applying…" and disables, as do Cancel
   *  and every checkbox. */
  applying?: boolean;
  /** Message rendered in the panel's msg row (error or outcome). */
  message?: string;
  /** Whether {@link message} renders as an error. */
  messageError?: boolean;
  /** Apply is disabled for the CURRENT selection (an `applied: 0` outcome — the
   *  same selection would reproduce it forever). Cleared by any toggle. */
  applyBlocked?: boolean;
  /** Per-edit rejection reasons the APPLY route reported, rendered under the
   *  propose-time drops so an `applied: 0` names why. */
  applyDropped?: DroppedEditRow[];
  /** `<details>` open state of the propose-time dropped list. */
  droppedOpen?: boolean;
  /** `<details>` open state of the APPLY-time dropped list (`.apply-drops`).
   *  Tracked separately from {@link droppedOpen}: both lists carry the same
   *  `.wiki-fc-int-dropped` class, so one shared field let each list's toggle
   *  clobber the other's open state on the next wholesale re-render. Defaults to
   *  OPEN (an `applied: 0` must name its reasons without a second click). */
  applyDroppedOpen?: boolean;
  /** The turn carries no answer, so no callout can be built from it — render the
   *  checkbox disabled instead of silently dropping the request at build time. */
  calloutDisabled?: boolean;
}

/** Copy for the "nothing integrable" outcome — an honest empty state, not an
 *  error: the model may legitimately have found nothing safe to change. */
export function nothingIntegrableHtml(proposal: IntegrateProposal): string {
  return (
    '<div class="wiki-fc-int-panel" id="wikiFcIntPanel">' +
    '<div class="wiki-fc-int-head">Nothing to integrate</div>' +
    '<div class="wiki-fc-int-note">' +
    esc(proposal.note || "The editor proposed no edits that could be placed in this page.") +
    "</div>" +
    droppedListHtml(proposal.dropped || []) +
    '<div class="wiki-fc-int-actions">' +
    '<button id="wikiFcIntCancel" class="wiki-fc-int-btn">Close</button>' +
    "</div></div>"
  );
}

/**
 * The full diff-preview panel. `selected` is parallel to `proposal.edits` (all ON
 * by default). Accept is disabled when nothing is selected or when the selected
 * set exceeds the echoed `maxChangedChars` — a UX guard only; the server
 * re-measures the freshly-resolved spans and owns the real 400.
 */
export function integratePreviewHtml(
  proposal: IntegrateProposal,
  selected: boolean[],
  calloutChecked: boolean,
  view: IntegratePreviewView = {},
): string {
  const edits = proposal.edits || [];
  if (!edits.length) return nothingIntegrableHtml(proposal);
  const applying = view.applying === true;
  const n = edits.filter((_, i) => selected[i] !== false).length;
  const changed = selectedChangedChars(edits, selected);
  const max = proposal.budget?.maxChangedChars;
  const overBudget = typeof max === "number" && changed > max;
  const acceptDisabled =
    n === 0 || overBudget || applying || view.applyBlocked === true ? " disabled" : "";
  const budgetNote =
    typeof max === "number"
      ? '<span class="wiki-fc-int-budget' + (overBudget ? " over" : "") + '">' +
        changed + " / " + max + " chars" + (overBudget ? " — over this page's change budget" : "") +
        "</span>"
      : "";
  // The page already carries a fact-check block ⇒ the checkbox REPLACES it in
  // place; a clean page ⇒ it adds one. Say which, since "add" on a page that has
  // one reads as stacking a second.
  const calloutLabel = proposal.hasSentinelBlock
    ? "refresh the existing summary callout (replaces the previous one)"
    : "also add summary callout";
  const calloutDisabled = view.calloutDisabled === true || applying;
  const calloutTitle = view.calloutDisabled
    ? ' title="This turn carries no stored answer, so no callout can be built from it"'
    : "";
  const msg = view.message
    ? '<div class="wiki-fc-int-msg' + (view.messageError ? " error" : "") +
      '" id="wikiFcIntMsg">' + esc(view.message) + "</div>"
    : '<div class="wiki-fc-int-msg" id="wikiFcIntMsg"></div>';
  return (
    '<div class="wiki-fc-int-panel" id="wikiFcIntPanel">' +
    '<div class="wiki-fc-int-head">' + edits.length +
    " proposed edit" + (edits.length === 1 ? "" : "s") + "</div>" +
    (proposal.note ? '<div class="wiki-fc-int-note">' + esc(proposal.note) + "</div>" : "") +
    edits.map((e, i) => editPreviewHtml(e, i, selected[i] !== false, applying)).join("") +
    droppedListHtml(proposal.dropped || [], view.droppedOpen === true) +
    // The apply route's OWN per-edit rejections — the honest reasons behind an
    // `applied: 0`, which a generic "nothing could be applied" line discarded.
    droppedListHtml(
      view.applyDropped || [],
      view.applyDroppedOpen !== false,
      (view.applyDropped || []).length + " could not be applied to the current page",
      "apply-drops",
    ) +
    '<div class="wiki-fc-int-actions">' +
    '<label class="wiki-fc-int-callout"' + calloutTitle + '><input type="checkbox" id="wikiFcIntCallout"' +
    (calloutChecked ? " checked" : "") + (calloutDisabled ? " disabled" : "") + " /> " +
    calloutLabel + "</label>" +
    '<button id="wikiFcIntAccept" class="wiki-fc-int-btn primary"' + acceptDisabled + ">" +
    (applying ? "Applying…" : "Apply " + n + " edit" + (n === 1 ? "" : "s")) + "</button>" +
    '<button id="wikiFcIntCancel" class="wiki-fc-int-btn"' + (applying ? " disabled" : "") +
    ">Cancel</button>" +
    budgetNote +
    "</div>" +
    msg +
    "</div>"
  );
}

// ── Apply-body construction ──────────────────────────────────────────────────

/** The `/api/wiki/factcheck/integrate/apply` request body. */
export interface IntegrateApplyBody {
  wiki?: string;
  page: string;
  baseHash: string;
  edits: ProposedEdit[];
  appendCallout?: boolean;
  answer?: string;
}

/**
 * Build the apply body from the selected subset. The edits go back VERBATIM (the
 * server re-resolves them against the freshly-read body). Returns null when
 * nothing is selected — the caller must not POST an empty edit list, which the
 * route rejects with a 400.
 *
 * `appendCallout` and `answer` travel together: the callout splice rides the SAME
 * write, so the server needs the answer to rebuild the block. Requesting the
 * callout without an answer silently drops the request back to edits-only rather
 * than sending a payload the route would 400.
 */
export function buildIntegrateApplyBody(input: {
  wiki?: string;
  page: string;
  baseHash: string;
  edits: ProposedEdit[];
  selected: boolean[];
  appendCallout: boolean;
  answer?: string;
}): IntegrateApplyBody | null {
  const edits = input.edits.filter((_, i) => input.selected[i] !== false);
  if (!edits.length) return null;
  const withCallout = input.appendCallout && !!input.answer;
  return {
    ...(input.wiki ? { wiki: input.wiki } : {}),
    page: input.page,
    baseHash: input.baseHash,
    edits,
    ...(withCallout ? { appendCallout: true, answer: input.answer } : {}),
  };
}

/**
 * Success copy for an apply, branching on the commit outcome. A write that
 * couldn't be committed has no git undo — say so rather than implying safety.
 *
 * The callout clause consumes the route's `calloutAdded`: when the user ASKED for
 * a callout and the route reports it wasn't added, say so explicitly rather than
 * letting an unmentioned outcome read as success.
 */
export function integrateSuccessCopy(result: {
  applied: number;
  committed?: boolean;
  reason?: string;
  calloutAdded?: boolean;
  /** Whether the client requested the callout on this apply. */
  calloutRequested?: boolean;
  /** True when the page already carried a block (⇒ "refreshed", not "added"). */
  calloutReplaced?: boolean;
}): string {
  if (result.applied === 0) {
    return "No edits could be applied (the page may have shifted) — nothing was written.";
  }
  const n = result.applied + " edit" + (result.applied === 1 ? "" : "s");
  let callout = "";
  if (result.calloutAdded) {
    callout = result.calloutReplaced ? " + summary callout refreshed" : " + summary callout added";
  } else if (result.calloutRequested) {
    callout = " (summary callout was NOT added)";
  }
  const head = "✓ Integrated " + n + callout;
  if (result.committed) return head;
  if (result.reason === "not-a-repo" || result.reason === "not-default-branch") {
    return head + " — applied, but not committed (no git undo)";
  }
  if (result.reason) return head + " — not committed (" + result.reason + ")";
  return head + " — not committed";
}
