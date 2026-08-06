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

import {
  claimHeadingShapeIndexes,
  countFenceDelimiterLines,
  parseFactcheckClaims,
  scanClaimLines,
  CLAIM_REF_SOURCE,
  CLAIM_VERDICT_SOURCE,
} from "./wiki-integrate.ts";
import type { FactcheckClaimAnchor } from "./wiki-integrate.ts";
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

/** One of the five wire outcomes. */
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/** The two outcomes a REAL model verdict block can carry — what the server's
 *  `outcomes.filter(o => o.real)` counts, and therefore what the meta line's claim
 *  count means. Named here so `claimCountFromMap` doesn't re-spell it. */
export const REAL_CLAIM_OUTCOMES = ["verified", "unverifiable"] as const;

/** index (1-based, as the `Claim n/m` heading carries it) → outcome. */
export type ClaimOutcomeByIndex = Record<number, string>;

/** True when this outcome names a claim nothing ever ruled on. */
export function isRetryableOutcome(outcome: string | undefined): boolean {
  return !!outcome && (RETRYABLE_OUTCOMES as readonly string[]).includes(outcome);
}

/** True when `v` is one of the five wire outcomes. The ONE gate every consumer
 *  runs — the persisted-map validator, the tally, the count, and the client's
 *  write of a `claim_result.outcome` off the wire. */
export function isClaimOutcome(v: unknown): v is ClaimOutcome {
  return typeof v === "string" && (CLAIM_OUTCOMES as readonly string[]).includes(v);
}

/** True when `v` names an outcome produced by a real model verdict block. */
export function isRealClaimOutcome(v: unknown): boolean {
  return typeof v === "string" && (REAL_CLAIM_OUTCOMES as readonly string[]).includes(v);
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
 *
 * **A DUPLICATED index is skipped, not offered.** With the fence-aware scan a
 * heading quoted inside a code fence can no longer produce a second anchor, but a
 * malformed model answer genuinely can (two blocks both claiming `Claim 2/3`).
 * There is then no single block a retry could replace — `spliceClaimBlock` would
 * silently rewrite the first and the batch would launch the same claim twice — so
 * the honest answer is "ambiguous, not retryable".
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
  const anchors = parseFactcheckClaims(answer);
  const seen = new Map<number, number>();
  for (const a of anchors) seen.set(a.index, (seen.get(a.index) || 0) + 1);
  const out: RetryableClaim[] = [];
  for (const anchor of anchors) {
    if ((seen.get(anchor.index) || 0) > 1) continue;
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

/**
 * The `Claim n/m` index of the FIRST claim heading in `text`, or null when it
 * carries none — the client's "did this reply come back as a verdict block at all?"
 * probe. Fence-aware via {@link scanClaimLines}, like every other heading probe here.
 *
 * NB a DIFFERING index is not a rejection: {@link renumberClaimBlockHeading}
 * corrects it, matching the route's own `isClaimVerdictBlock` contract.
 */
export function claimBlockIndex(text: string): number | null {
  const scan = scanClaimLines(text);
  for (const m of scan.claimMatch) if (m) return Number(m[2]);
  return null;
}

/** Line index of the first claim heading, or -1. */
function firstClaimHeadingLine(scan: { claimMatch: (RegExpMatchArray | null)[] }): number {
  for (let i = 0; i < scan.claimMatch.length; i++) if (scan.claimMatch[i]) return i;
  return -1;
}

/** The `Claim n/m` fragment on its own, for rewriting a heading's numbering. */
const CLAIM_REF_RE = new RegExp(CLAIM_REF_SOURCE, "iu");

/**
 * Rewrite the first claim heading's `n/m` to `index/total`, leaving the verdict
 * emoji, the title and the heading's own spelling (`Claim` vs `claim`, the spacing
 * around the slash) exactly as the model wrote them.
 *
 * **Why rewrite instead of reject.** The route deliberately ACCEPTS a retried block
 * whose heading renumbered — `isClaimVerdictBlock` (`factcheck-sse.ts`) calls that a
 * formatting wobble, not a wrong claim, because the alternative is throwing away a
 * completed 180s verification. The client refusing the same block re-introduced
 * exactly that loss on the last hop. Renumbering keeps the retry AND the anchor
 * integrity the splice depends on: `n` is what `parseFactcheckClaims` keys the
 * claim by and `m` is what its siblings all carry, so a block landing with either
 * out of step would create a duplicate index or a heading disagreeing with the rest
 * of the answer.
 *
 * Returns null only when the block carries NO claim heading at all — that block has
 * no anchor to correct and splicing it would destroy the claim.
 */
export function renumberClaimBlockHeading(
  block: string,
  index: number,
  total: number,
): string | null {
  const scan = scanClaimLines(block);
  const line = firstClaimHeadingLine(scan);
  if (line === -1) return null;
  const src = scan.lines[line]!;
  const m = src.match(CLAIM_REF_RE);
  if (!m || m.index === undefined) return null;
  let seen = 0;
  const ref = m[0].replace(/\d+/g, () => (seen++ === 0 ? String(index) : String(total)));
  const lines = [...scan.lines];
  lines[line] = src.slice(0, m.index) + ref + src.slice(m.index + m[0].length);
  return lines.join("\n");
}

/** Same claim set, block for block? The splice guard's equality — an index-only
 *  comparison would miss a sibling whose CONTENT the splice damaged. */
function sameAnchors(a: FactcheckClaimAnchor[], b: FactcheckClaimAnchor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.index !== b[i]!.index || a[i]!.block !== b[i]!.block) return false;
  }
  return true;
}

/**
 * Replace exactly the block whose `Claim n/m` index is `index` with `newBlock`,
 * leaving every sibling byte-identical.
 *
 * Both the anchor search and the block extent run through the SHARED, fence-aware
 * {@link scanClaimLines}, so parity with {@link parseFactcheckClaims} is by
 * construction. Two failures this closes, both reproduced in a live browser:
 *
 *  - a `### … Claim n/m` heading QUOTED inside a ``` fence was taken as the
 *    anchor, so the splice started mid-fence and ate the closing ``` — the rest
 *    of the answer then rendered as one code block;
 *  - the extent rule was `trim().startsWith("###")` while the parser's was
 *    `/^###\s/`, so a `#### Sub-heading` ended the splice early and left a stale
 *    tail sitting under the fresh verdict.
 *
 * The trailing blank lines of the replaced region are counted and re-emitted, so
 * the separation between blocks is the same number of bytes it was — a retried
 * block must not silently reflow the answer around it.
 *
 * A heading that RENUMBERED is corrected in place rather than refused — see
 * {@link renumberClaimBlockHeading} for why the route and this must agree on that.
 * The `m` it is corrected to is the one the block being REPLACED carried, so the
 * spliced heading stays in step with its siblings.
 *
 * **The post-splice invariant guard is the backstop of the whole feature.** The
 * block extent comes from a fence-aware line walk, and a walk bug is not a
 * cosmetic problem here: a fence opening inside claim N's block and closing after
 * claim N+1's heading masks that heading, so the extent runs past it and the splice
 * DELETES a sibling claim — into an answer ➕/integrate then commit to the wiki
 * page. So the result is verified before it is returned: every sibling claim must
 * survive byte-identical, the target must still be there exactly once, and the
 * fence-delimiter line count must add up. A violation returns `null`, i.e. a failed
 * retry the caller reports on the row — a residual walk bug then costs one wasted
 * verification instead of a corrupted answer.
 *
 * Returns `null` when no block carries that index, when the block is blank, when
 * `newBlock` carries NO claim heading at all (nothing downstream could anchor to
 * it), or when the guard above fails. The caller treats null as a failed retry —
 * nothing is written — rather than appending an orphan block.
 */
export function spliceClaimBlock(answer: string, index: number, newBlock: string): string | null {
  const block = (newBlock || "").trim();
  if (!block) return null;
  const scan = scanClaimLines(answer || "");
  const lines = scan.lines;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = scan.claimMatch[i];
    if (m && Number(m[2]) === index) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  // The replacement must carry the anchor everything downstream reads, for the
  // claim it is replacing — a renumbered heading is corrected, a missing one refused.
  const total = Number(scan.claimMatch[start]![3]);
  const anchored = renumberClaimBlockHeading(block, index, total);
  if (anchored === null) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (scan.blockEnd[i]) {
      end = i;
      break;
    }
  }
  // Preserve the exact blank-line separation the replaced region ended with.
  let trailingBlanks = 0;
  for (let i = end - 1; i > start && lines[i]!.trim() === ""; i--) trailingBlanks++;
  const replacement = anchored.split("\n");
  for (let i = 0; i < trailingBlanks; i++) replacement.push("");
  const spliced = [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");

  // ── invariant guard ───────────────────────────────────────────────────
  const region = lines.slice(start, end).join("\n");
  // (1) SHAPE level, and this is the one that catches the masked-sibling class.
  // A claim heading hidden inside a fence is invisible to `parseFactcheckClaims` by
  // construction, so a parse-level check can never notice that the extent ran
  // through it — the claim it deleted was never in the parse to begin with. Line
  // shape is the evidence that survives: if the region about to be deleted carries
  // a fence delimiter, or another claim's heading text, its extent is not
  // trustworthy and the retry fails instead of writing. Neither can occur in a
  // legitimate target — every retryable outcome (timeout/skipped/error) leaves a
  // one-line synthetic stub as the block.
  if (countFenceDelimiterLines(region) !== 0) return null;
  if (claimHeadingShapeIndexes(region).some((n) => n !== index)) return null;
  // (2) PARSE level: every claim the original answer had must still be there, and
  // every one OTHER than the target byte-identical.
  const before = parseFactcheckClaims(answer || "");
  const after = parseFactcheckClaims(spliced);
  if (before.length !== after.length) return null;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.index !== after[i]!.index) return null;
    if (before[i]!.index !== index && before[i]!.block !== after[i]!.block) return null;
  }
  if (after.filter((a) => a.index === index).length !== 1) return null;
  // (3) Fence balance across the rewrite: the delimiter count must be the
  // original's minus the region's plus the replacement's. Implied by the pure
  // concatenation above TODAY — it is here as a net under any future splice that
  // reflows, trims or re-joins, which is precisely where a swallowed closing fence
  // would come back.
  const expectedFences =
    countFenceDelimiterLines(answer || "") -
    countFenceDelimiterLines(region) +
    countFenceDelimiterLines(replacement.join("\n"));
  if (countFenceDelimiterLines(spliced) !== expectedFences) return null;
  return spliced;
}

/** The amendment sentence's shape, matched so repeated retries ACCUMULATE into one
 *  line instead of stacking near-identical sentences under the lede. */
const AMENDMENT_RE = /^_Claims? [\d,\s and]+ (?:was|were) re-checked after the initial run\._$/;

/** A line's leading BLOCK markup — blockquote markers and/or one list bullet.
 *  Split off before {@link AMENDMENT_RE} is applied and re-attached on rewrite:
 *  the regex is anchored at `_`, so a lede whose amendment sits inside a
 *  blockquote (`> _Claim 1 was re-checked…_`) matched nothing, and a naive rewrite
 *  would have dropped the `>` and pulled the sentence out of its quote. */
const LINE_PREFIX_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+[.)][ \t]+)?)([\s\S]*)$/;

/** `["> ", "_Claim 1 …_"]` — the block prefix and the rest of the line. */
function splitLinePrefix(line: string): [string, string] {
  const m = line.match(LINE_PREFIX_RE);
  if (!m) return ["", line];
  return [m[1] ?? "", m[2] ?? ""];
}

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
 *
 * **The write is verified before it is returned**, the {@link spliceClaimBlock}
 * discipline one level down: the amendment may only land STRICTLY ABOVE the first
 * parsed claim's heading, so re-parsing the result must yield exactly the claim set
 * (and blocks) the input had. If it does not — the walk put the "first heading"
 * somewhere the parser disagrees with, and the sentence would be inserted INSIDE a
 * verdict block — the answer is returned unchanged. A missing amendment is
 * cosmetic; a mid-answer one is corruption that ➕/integrate commit to disk.
 */
export function appendLedeAmendment(answer: string, index: number): string {
  const anchors = parseFactcheckClaims(answer);
  if (anchors.length < 2) return answer;
  const scan = scanClaimLines(answer || "");
  const lines = scan.lines;
  const firstHeading = firstClaimHeadingLine(scan);
  if (firstHeading <= 0) return answer;
  const lede = lines.slice(0, firstHeading);
  if (lede.join("").trim() === "") return answer;

  // Match through the block prefix, and re-emit it: an amendment sitting inside a
  // blockquote/list lede must be RECOGNISED (else every retry stacks another
  // sentence) and must stay where it is (else the rewrite yanks it out of the
  // quote it belonged to).
  const existing = lede.findIndex((l) => AMENDMENT_RE.test(splitLinePrefix(l)[1].trim()));
  let out: string;
  if (existing !== -1) {
    const [prefix, body] = splitLinePrefix(lede[existing]!);
    const prior = (body.match(/\d+/g) || []).map(Number);
    lede[existing] = prefix + amendmentLine([...prior, index]);
    out = [...lede, ...lines.slice(firstHeading)].join("\n");
  } else {
    // Insert after the lede's last non-blank line, keeping the blank separation the
    // answer already had between the lede and the first block. The inserted line is
    // FLUSH and preceded by a blank line — which is also what keeps it out of a
    // blockquote/list lede rather than becoming a lazy continuation of it.
    let lastText = lede.length - 1;
    while (lastText >= 0 && lede[lastText]!.trim() === "") lastText--;
    const head = lede.slice(0, lastText + 1);
    const gap = lede.slice(lastText + 1);
    out = [...head, "", amendmentLine([index]), ...gap, ...lines.slice(firstHeading)].join("\n");
  }
  // The amendment is a LEDE edit by definition — if the claim set moved, it landed
  // somewhere it had no business being.
  return sameAnchors(anchors, parseFactcheckClaims(out)) ? out : answer;
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
    // ONE spelling of the vocabulary (`isClaimOutcome`), never a re-listed
    // alternation: three separate hand-written copies of the five values is
    // exactly how a sixth outcome ships half-handled.
    if (isClaimOutcome(v)) counts[v as ClaimOutcome] = (counts[v as ClaimOutcome] || 0) + 1;
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
  for (const v of Object.values(map || {})) if (isRealClaimOutcome(v)) n++;
  return n;
}

/** A `Claim n/m` reference read off a rendered heading's TEXT. */
export interface ClaimRef {
  index: number;
  total: number;
}

/**
 * The rendered-heading form of the markdown heading contract: optional verdict
 * emoji, then `Claim n/m`, ANCHORED at the start of the heading text.
 *
 * Built from the same `CLAIM_VERDICT_SOURCE` / `CLAIM_REF_SOURCE` fragments as
 * `CLAIM_HEADING_RE`, minus the `###` (which `formatWebHtml` has consumed by the
 * time this sees the text) — so the two contracts cannot drift silently.
 *
 * **The anchor is the fix, not decoration:** the previous `\bclaim\s+(\d+)…`
 * matched ANYWHERE in ANY heading, so a prose heading like "Revisiting claim 2/3
 * later" grew a stray ↻ row pointed at a claim it doesn't own.
 */
const CLAIM_HEADING_TEXT_RE = new RegExp(
  "^\\s*(?:" + CLAIM_VERDICT_SOURCE + "\\s*)?" + CLAIM_REF_SOURCE + "\\b",
  "iu",
);

/**
 * Read `Claim n/m` out of a rendered heading's text content.
 *
 * Keyed on the text, never on the tag: the markdown contract is `###` but the DOM
 * contract is `<h4>` (see the module header), so the caller queries every heading
 * level and lets this decide. Tolerant of the emoji prefix and the VS16 variants
 * for the same reason `CLAIM_HEADING_RE` is — it shares their spelling.
 */
export function claimRefFromHeadingText(text: string): ClaimRef | null {
  const m = (text || "").match(CLAIM_HEADING_TEXT_RE);
  if (!m) return null;
  const index = Number(m[2]);
  const total = Number(m[3]);
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

/** The persisted fact-check context a retry re-issues its call against — the
 *  structural subset of `AskTurn` this module needs (it stays DOM-free). */
export interface ClaimRetryTurnContext {
  page?: string;
  fcMode?: string;
  fcSel?: string;
  fcCtx?: string;
}

/**
 * Build the retry URL for one claim ON one turn — the single spelling of the
 * ten-line argument object the row ↻ and the batch loop used to carry a copy of
 * each (they had already drifted once).
 *
 * **`title` is `claim.title` and NOTHING else.** The earlier `claim.title ||
 * turn.question` fell back to the turn's question, which on a fact-check turn is
 * the synthetic label `Fact check: <page>` — so an untitled claim spent a 180s
 * tool-enabled one-shot re-verifying the string "Fact check: Retry Note" as if it
 * were the claim. `buildClaimRetryUrl`'s `"(untitled claim)"` fallback exists for
 * exactly this case; letting it be reachable is the fix.
 */
export function claimRetryUrlFor(
  turn: ClaimRetryTurnContext,
  claim: RetryableClaim,
  wiki?: string,
): string {
  return buildClaimRetryUrl({
    page: turn.page || "",
    ...(wiki ? { wiki } : {}),
    ...(turn.fcMode ? { mode: turn.fcMode } : {}),
    ...(turn.fcSel ? { sel: turn.fcSel } : {}),
    ...(turn.fcCtx ? { ctx: turn.fcCtx } : {}),
    index: claim.index,
    total: claim.total,
    title: claim.title,
    ...(claim.quote ? { quote: claim.quote } : {}),
  });
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
 *  is served by its own row ↻) — but the singular is still spelled, because the
 *  RUNNING bar renders `claimRetryBatchLabel(run.total)` and a batch whose queue
 *  shrank to one would otherwise read "Retry 1 unverified claims". */
export function claimRetryBatchLabel(count: number): string {
  return "↻ Retry " + count + " unverified claim" + (count === 1 ? "" : "s");
}

/** Terminal copy for a batch that RAN TO THE END of its queue, held on the bar
 *  until the turn is repainted from scratch. Counts SUCCESSES — a batch whose
 *  claims all 409'd reporting "Re-checked 3 of 3" is the lie this exists to
 *  avoid. A batch that STOPPED early gets {@link claimRetryStoppedCopy}, not this. */
export function claimRetryDoneCopy(done: number, total: number): string {
  return "Re-checked " + done + " of " + total;
}

/** Why a batch stopped before its queue was empty. `cancelled` has its own copy
 *  ({@link CLAIM_RETRY_CANCEL_COPY}) because it also has to explain the slot the
 *  in-flight claim keeps holding. */
export type ClaimRetryStopReason = "switched" | "navigated" | "wrote";

const STOP_REASON_COPY: Record<ClaimRetryStopReason, string> = {
  switched: "you opened another answer",
  navigated: "you left this page",
  wrote: "the article was written from this answer",
};

/**
 * Terminal copy for a batch that stopped EARLY.
 *
 * Distinct from {@link claimRetryDoneCopy} on purpose: all three of these break the
 * loop mid-queue, and reporting "Re-checked 1 of 4" reads as a completed run that
 * managed one success — so a reader who navigated away mid-batch was told the batch
 * had finished and three claims were simply unfixable.
 */
export function claimRetryStoppedCopy(
  reason: ClaimRetryStopReason,
  done: number,
  total: number,
): string {
  return `Stopped after ${done} of ${total} — ${STOP_REASON_COPY[reason]}.`;
}

/** A ✎ apply was already in flight when a retry spliced the answer under it. The
 *  apply posts the PRE-splice answer and sets `turn.wrote` when it lands, so the
 *  page and the turn end up disagreeing about what the check found. Nothing can
 *  recall the apply — the one thing that must not happen is for the disagreement to
 *  be silent. */
export const CLAIM_RETRY_APPLY_RACE_COPY =
  "The article is being written from the answer as it was BEFORE this re-check — re-run the check to reconcile.";

/** The cancel affordance's honest copy. There is NO abort plumbing on this path
 *  (`streamFactcheckSSE` treats a gone client as a launch gate; `tracedOneShot`
 *  carries no cancellation token), so cancel stops the BATCH from launching the
 *  next claim and detaches this client — the in-flight claim finishes server-side
 *  holding the page's single-flight slot. Saying otherwise would be a lie the 409
 *  immediately exposes, which is why the slot's lifetime is named too: the
 *  `~4 min` mirrors `FACTCHECK_RETRY_TIMEOUT_MS` (180s) + `CLAIM_RETRY_SLOT_SLACK_MS`
 *  (30s) from `factcheck-retry-sse.ts`. This copy must PERSIST after the run
 *  record clears — the first cut painted it for one frame and then repainted an
 *  enabled bar whose next click could only 409. */
export const CLAIM_RETRY_CANCEL_COPY =
  "Stopped — the claim already running finishes on the server (it holds this page's retry slot for up to ~4 min).";
