/**
 * Pure, DOM-free helpers for the /wiki reader's **claim retry** (↻) affordance —
 * the client half of `GET /api/wiki/factcheck/claim`.
 *
 * Split out of `wiki-browser.ts` (which runs DOM code at module load and so can't
 * be imported in tests) for the same reason `wiki-integrate.ts` / `wiki-explain.ts`
 * / `wiki-ask-session.ts` were: the answer surgery here is where a bug is durable.
 * A fact-check answer is committed into the wiki page by ➕/integrate, so a splice
 * that damages a sibling block, or a lede amendment written where no lede exists,
 * ships to disk.
 *
 * The heading contract has TWO spellings and both are load-bearing:
 *
 *  - **markdown `###`** — what the model writes and what `parseFactcheckClaims`
 *    parses (its `###` anchor is deliberately not loosened);
 *  - **DOM `<h4>`** — what the reader actually paints, because `formatWebHtml`'s
 *    heading renderer emits `h${Math.min(level + 1, 6)}`. An `h3` selector for the
 *    ↻ button would therefore match NOTHING and ship an invisible affordance,
 *    which is why {@link claimRefFromHeadingText} is fed by a query over ALL
 *    heading levels and keyed on the `Claim n/m` text instead of on a tag name.
 */

import { parseFactcheckClaims, type FactcheckClaimAnchor } from "./wiki-integrate.ts";
import type { ClaimOutcomeCounts } from "./wiki-factcheck-outcomes.ts";

/**
 * The outcomes a ↻ can fix. A model-chosen `unverifiable` is deliberately NOT
 * here: the web genuinely could not confirm the claim, and re-running the same
 * verify would spend a 180s tool-enabled one-shot to land on the same ❓. These
 * three are the ones where nothing was ever ruled — the run ran out of budget,
 * never launched, or crashed.
 */
export const RETRYABLE_OUTCOMES = ["timeout", "skipped", "error"] as const;

/** Outcome values a persisted `claimOutcomeByIndex` may carry (the SSE
 *  `claim_result.outcome` vocabulary — `ClaimOutcome` in `factcheck-sse.ts`). */
export const CLAIM_OUTCOMES = [
  "verified",
  "unverifiable",
  "timeout",
  "skipped",
  "error",
] as const;

/** index (1-based, as the `Claim n/m` heading carries it) → outcome. */
export type ClaimOutcomeByIndex = Record<number, string>;

/** True when this outcome names a claim nothing ever ruled on. */
export function isRetryableOutcome(outcome: string | undefined): boolean {
  return !!outcome && (RETRYABLE_OUTCOMES as readonly string[]).includes(outcome);
}

/** True when `v` is one of the five wire outcomes. */
export function isClaimOutcome(v: unknown): boolean {
  return typeof v === "string" && (CLAIM_OUTCOMES as readonly string[]).includes(v);
}

/** One claim the reader can re-check, joined to the quote its extraction carried. */
export interface RetryableClaim {
  index: number;
  /** `m` from the heading — echoed back to the route, never `anchors.length`. */
  total: number;
  title: string;
  verdict: string;
  outcome: string;
  /** The extraction's verbatim passage, when the turn persisted one for this index. */
  quote?: string;
}

/**
 * The retryable subset of a persisted fact-check answer: parse the answer with the
 * SHARED heading parser, keep the anchors whose recorded outcome is
 * timeout/skipped/error, and join each to its `{index, quote}` pair BY INDEX (never
 * by list position — a claim the extractor gave no quote for is simply absent).
 *
 * An absent outcome map means the turn predates the field: it correctly yields no
 * ↻ rather than guessing from the ❓ emoji, which cannot tell a model-chosen
 * "unverifiable" apart from a claim that timed out.
 */
export function retryableClaims(
  answer: string,
  outcomeByIndex: ClaimOutcomeByIndex | undefined,
  quotes?: { index: number; quote: string }[],
): RetryableClaim[] {
  if (!outcomeByIndex || typeof outcomeByIndex !== "object") return [];
  const quoteByIndex = new Map<number, string>();
  for (const q of quotes || []) {
    if (q && typeof q.index === "number" && typeof q.quote === "string" && !quoteByIndex.has(q.index)) {
      quoteByIndex.set(q.index, q.quote);
    }
  }
  const out: RetryableClaim[] = [];
  for (const anchor of parseFactcheckClaims(answer)) {
    const outcome = outcomeByIndex[anchor.index];
    if (!isRetryableOutcome(outcome)) continue;
    const quote = quoteByIndex.get(anchor.index);
    out.push({
      index: anchor.index,
      total: anchor.total,
      title: anchor.title,
      verdict: anchor.verdict,
      outcome: outcome as string,
      ...(quote ? { quote } : {}),
    });
  }
  return out;
}

/** True when this line IS a `### <emoji> Claim n/m` heading — run through the
 *  contract's ONE implementation rather than a re-spelled regex (the
 *  `isClaimVerdictBlock` trick). */
function isClaimHeadingLine(line: string): boolean {
  return parseFactcheckClaims(line.trim()).length === 1;
}

/** Line index of the first claim heading, or -1. */
function firstClaimHeadingLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) if (isClaimHeadingLine(lines[i]!)) return i;
  return -1;
}

/**
 * Replace exactly the block whose `Claim n/m` index is `index` with `newBlock`,
 * leaving every sibling byte-identical.
 *
 * Block extent matches {@link parseFactcheckClaims}'s own rule: from the heading
 * line up to (not including) the next line starting with `###`, whether that is
 * another claim or an unrelated heading. The trailing blank lines of the replaced
 * region are counted and re-emitted, so the separation between blocks is the same
 * number of bytes it was — a retried block must not silently reflow the answer
 * around it.
 *
 * Returns `null` when no block carries that index; the caller treats that as a
 * failed retry (nothing is written) rather than appending an orphan block.
 */
export function spliceClaimBlock(answer: string, index: number, newBlock: string): string | null {
  const block = (newBlock || "").trim();
  if (!block) return null;
  const lines = (answer || "").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseFactcheckClaims(lines[i]!.trim());
    if (parsed.length === 1 && parsed[0]!.index === index) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("###")) {
      end = i;
      break;
    }
  }
  // Preserve the exact blank-line separation the replaced region ended with.
  let trailingBlanks = 0;
  for (let i = end - 1; i > start && lines[i]!.trim() === ""; i--) trailingBlanks++;
  const replacement = block.split("\n");
  for (let i = 0; i < trailingBlanks; i++) replacement.push("");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}

/** The amendment sentence's shape, matched so repeated retries ACCUMULATE into one
 *  line instead of stacking near-identical sentences under the lede. */
const AMENDMENT_RE = /^_Claims? [\d,\s and]+ (?:was|were) re-checked after the initial run\._$/;

/** Render the amendment for a set of 1-based claim indexes (ascending, deduped). */
function amendmentLine(indexes: number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const list =
    sorted.length === 1
      ? String(sorted[0])
      : sorted.slice(0, -1).join(", ") + " and " + sorted[sorted.length - 1];
  const noun = sorted.length === 1 ? "Claim" : "Claims";
  const verb = sorted.length === 1 ? "was" : "were";
  return `_${noun} ${list} ${verb} re-checked after the initial run._`;
}

/**
 * Append (or extend) a one-line amendment under the compose lede after a
 * successful splice — **multi-claim answers only**.
 *
 * The lede is Phase 3's overall assessment, written over the block set INCLUDING
 * the hole the retry just filled: left alone it goes on saying a claim couldn't be
 * checked, contradicting the meta line beside it — and ➕/integrate commit the
 * ANSWER into the wiki page, so the contradiction is durable. This states the
 * amendment without spending a second model call.
 *
 * **Why the multi-claim gate is not a nicety:** `assembleFactcheckAnswer` returns
 * the lone block for a single-claim run and Phase 3 never runs, so there IS no
 * lede — writing one would invent a paragraph above the `###` heading in exactly
 * the sel-mode single-claim case the ↻ matters most for. Belt and braces, an
 * answer whose lede region is blank is left alone for the same reason.
 */
export function appendLedeAmendment(answer: string, index: number): string {
  const anchors = parseFactcheckClaims(answer);
  if (anchors.length < 2) return answer;
  const lines = (answer || "").split("\n");
  const firstHeading = firstClaimHeadingLine(lines);
  if (firstHeading <= 0) return answer;
  const lede = lines.slice(0, firstHeading);
  if (lede.join("").trim() === "") return answer;

  const existing = lede.findIndex((l) => AMENDMENT_RE.test(l.trim()));
  if (existing !== -1) {
    const prior = (lede[existing]!.match(/\d+/g) || []).map(Number);
    lede[existing] = amendmentLine([...prior, index]);
    return [...lede, ...lines.slice(firstHeading)].join("\n");
  }
  // Insert after the lede's last non-blank line, keeping the blank separation the
  // answer already had between the lede and the first block.
  let lastText = lede.length - 1;
  while (lastText >= 0 && lede[lastText]!.trim() === "") lastText--;
  const head = lede.slice(0, lastText + 1);
  const gap = lede.slice(lastText + 1);
  return [...head, "", amendmentLine([index]), ...gap, ...lines.slice(firstHeading)].join("\n");
}

/** Minimal shape read off a live claim checklist row (a full `ClaimRow` satisfies
 *  it structurally, the `OutcomeRow` precedent). */
export interface ClaimOutcomeRow {
  index: number;
  status: string;
  outcome?: string;
}

/**
 * Lift the live checklist's per-claim outcomes onto the persisted map.
 *
 * Mirrors `tallyClaimOutcomes`' rules exactly, because the two are read side by
 * side: a row that never reached `done` is skipped entirely (it has no outcome and
 * must not default to `verified`), and a `done` row with an absent outcome (an
 * older server) counts as `verified` — it WAS a real verdict block.
 */
export function claimOutcomeMapFromRows(
  rows: ClaimOutcomeRow[] | undefined,
): ClaimOutcomeByIndex | undefined {
  const map: ClaimOutcomeByIndex = {};
  let any = false;
  for (const r of rows || []) {
    if (!r || r.status !== "done" || typeof r.index !== "number") continue;
    const outcome = r.outcome || "verified";
    if (!isClaimOutcome(outcome)) continue;
    map[r.index] = outcome;
    any = true;
  }
  return any ? map : undefined;
}

/**
 * Re-derive the per-outcome tally from the outcome map.
 *
 * After a splice the map is the SINGLE AUTHORITY: `tallyClaimOutcomes` reads
 * `turn.claims`, which the `done` handler sets to `undefined` (the checklist is
 * transient), so it would tally nothing on a retried turn.
 */
export function outcomeCountsFromMap(map: ClaimOutcomeByIndex | undefined): ClaimOutcomeCounts {
  const counts: ClaimOutcomeCounts = {};
  for (const v of Object.values(map || {})) {
    if (v === "verified" || v === "unverifiable" || v === "timeout" || v === "skipped" || v === "error") {
      counts[v] = (counts[v] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Re-derive the claim COUNT the meta line reports from the outcome map: the number
 * of claims that produced a REAL model verdict. Mirrors the server's
 * `outcomes.filter(o => o.real).length` — a synthetic ❓ (skipped / timed out /
 * errored) is excluded there, and `verified`/`unverifiable` are exactly the two
 * outcomes a real block can carry (`realOutcome`).
 */
export function claimCountFromMap(map: ClaimOutcomeByIndex | undefined): number {
  let n = 0;
  for (const v of Object.values(map || {})) if (v === "verified" || v === "unverifiable") n++;
  return n;
}

/** A `Claim n/m` reference read off a rendered heading's TEXT. */
export interface ClaimRef {
  index: number;
  total: number;
}

/**
 * Read `Claim n/m` out of a rendered heading's text content.
 *
 * Keyed on the text, never on the tag: the markdown contract is `###` but the DOM
 * contract is `<h4>` (see the module header), so the caller queries every heading
 * level and lets this decide. Tolerant of the emoji prefix, the VS16 variants and
 * the separator zoo for the same reason `CLAIM_HEADING_RE` is.
 */
export function claimRefFromHeadingText(text: string): ClaimRef | null {
  const m = (text || "").match(/\bclaim\s+(\d+)\s*\/\s*(\d+)\b/i);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1) return null;
  return { index, total };
}

/** Params the ↻ echoes back to `GET /api/wiki/factcheck/claim`. */
export interface ClaimRetryUrlOptions {
  page: string;
  wiki?: string;
  mode?: string;
  sel?: string;
  ctx?: string;
  index: number;
  total: number;
  title: string;
  quote?: string;
}

/** Cap mirrored from `FACTCHECK_SELECTION_MAX` — the route slices `sel` at 1500,
 *  and sending more just wastes the query string. */
const RETRY_SEL_MAX = 1500;

/**
 * Build the retry URL. `mode` defaults to `article`: a turn persisted before
 * `fcMode` existed carries no mode, and `article` is the mode that needs no `sel`
 * (the route 400s a `sel`-mode call without one). The claim text is echoed from
 * the turn — see the route's "re-extraction is not an option" contract.
 */
export function buildClaimRetryUrl(opts: ClaimRetryUrlOptions): string {
  const mode = opts.mode === "sel" && opts.sel ? "sel" : "article";
  let url = "/api/wiki/factcheck/claim?page=" + encodeURIComponent(opts.page);
  url += "&mode=" + mode;
  if (mode === "sel" && opts.sel) {
    const sel =
      opts.sel.length > RETRY_SEL_MAX ? [...opts.sel].slice(0, RETRY_SEL_MAX).join("") : opts.sel;
    url += "&sel=" + encodeURIComponent(sel);
    if (opts.ctx) url += "&ctx=" + encodeURIComponent(opts.ctx);
  }
  if (opts.wiki) url += "&wiki=" + encodeURIComponent(opts.wiki);
  url += "&index=" + opts.index + "&total=" + opts.total;
  url += "&title=" + encodeURIComponent(opts.title || "(untitled claim)");
  if (opts.quote) url += "&quote=" + encodeURIComponent(opts.quote);
  return url;
}

/**
 * Copy for the route's 409 `{state:"running", expiresAtMs}`. The deadline rides
 * the 409 precisely so this needs no second route — including for a row-level ↻
 * clicked mid-batch, which 409s by construction (the batch holds the page's slot).
 */
export function claimRetryRunningCopy(expiresAtMs: unknown, now: number = Date.now()): string {
  const base = "a retry for this page is still running";
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return base + ".";
  const leftMs = expiresAtMs - now;
  if (leftMs <= 0) return base + " — try again now.";
  const mins = Math.ceil(leftMs / 60_000);
  return `${base} — ~${mins}m left.`;
}

/** Copy for a ↻ on a turn that already wrote to the page. The affordance stays
 *  VISIBLE and disabled: check → ➕ → notice-the-❓ is a common sequence, and every
 *  other derived-disable state here explains itself (the `INTEGRATE_STALE_COPY`
 *  precedent). Silently removing the button reads as a bug. */
export const CLAIM_RETRY_WROTE_COPY =
  "already added to the article — re-run the check to fill this in";

/** The batch bar's label. Rendered only above ONE claim (a single retryable claim
 *  is served by its own row ↻). */
export function claimRetryBatchLabel(count: number): string {
  return "↻ Retry " + count + " unverified claims";
}

/** The cancel affordance's honest copy. There is NO abort plumbing on this path
 *  (`streamFactcheckSSE` treats a gone client as a launch gate; `tracedOneShot`
 *  carries no cancellation token), so cancel stops the BATCH from launching the
 *  next claim and detaches this client — the in-flight claim finishes server-side
 *  holding the page's single-flight slot. Saying otherwise would be a lie the 409
 *  immediately exposes. */
export const CLAIM_RETRY_CANCEL_COPY =
  "Stopped — the claim already running finishes on the server.";
