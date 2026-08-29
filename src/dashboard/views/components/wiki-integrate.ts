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
import {
  isFactWrapperText,
  normalizeFactVerdict,
  type FactVerdict,
} from "../../../format/markdown-ast.ts";
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
/** The verdict-emoji alternation, VS16-optional on all four. Exported as SOURCE
 *  (not a compiled regex) because the DOM-side matcher in `wiki-claim-retry.ts`
 *  reads a RENDERED heading, where the `###` is gone — deriving both from one
 *  spelling is what stops the markdown contract and the DOM contract drifting. */
export const CLAIM_VERDICT_SOURCE = "(✅️?|⚠️?|❌️?|❓️?)";

/** The `Claim n/m` reference itself — group 1 = index, group 2 = total (relative
 *  to this fragment; both consumers place it after the verdict group). */
export const CLAIM_REF_SOURCE = "Claim\\s+(\\d+)\\s*\\/\\s*(\\d+)";

/** The optional `— <title>` tail, anchored to end of line. */
const CLAIM_TITLE_SOURCE = "\\s*(?:[—–:-]\\s*(.*))?$";

const CLAIM_HEADING_RE = new RegExp(
  "^###\\s*" + CLAIM_VERDICT_SOURCE + "\\s*" + CLAIM_REF_SOURCE + CLAIM_TITLE_SOURCE,
  "iu",
);

/**
 * The ONE block-extent rule: a `###` heading line closes the block above it.
 *
 * Deliberately `^###\s` and not `startsWith("###")` — a `#### Sub-heading` inside
 * a verdict block is CONTENT, and treating it as a terminator truncated the block
 * (the splicer left a stale tail under a fresh verdict). Both
 * {@link parseFactcheckClaims} and `spliceClaimBlock` read this through
 * {@link scanClaimLines}, so parity is by construction rather than by comment.
 */
const CLAIM_BLOCK_END_RE = /^###\s/;

/**
 * A fenced-code delimiter's SHAPE: up to 3 leading spaces, a run of ≥3 backticks
 * or tildes, then its tail (an info string on an opener; a closer carries nothing).
 *
 * **Matched against the RAW line, never a trimmed one.** Trimming first made every
 * indented line a candidate, so a ```` ``` ```` sitting inside a 4-space INDENTED
 * code block opened a phantom fence — and per CommonMark a ≥4-space-indented line
 * is indented code and can never be a fence delimiter. A leading TAB is ≥4 columns
 * for the same reason and deliberately does not match either.
 */
const FENCE_SHAPE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A closer's tail rule: nothing but spaces/tabs after the run. */
const FENCE_CLOSE_TAIL_RE = /^[ \t]*$/;

/** An open fence: which marker character opened it, and how long its run was. */
interface OpenFence {
  marker: string;
  len: number;
}

/**
 * Is `line` a fence OPENER, and which fence does it open?
 *
 * The backtick rule is the one that bit: per CommonMark an info string on a
 * BACKTICK fence may not contain a backtick, so an ordinary prose line like
 * `` ```code``` `` (inline code the page happens to start a line with) is not a
 * fence at all. Treating it as one opened a fence that never closed, and every
 * claim heading after it was masked — `parseFactcheckClaims` lost claims on
 * already-persisted answers, `retryableClaims` silently dropped their ↻, and
 * `validateClaimQuotes` rejected the whole quote list as "more quotes than claims".
 */
function fenceOpener(line: string): OpenFence | null {
  const m = line.match(FENCE_SHAPE_RE);
  if (!m) return null;
  const run = m[1]!;
  const info = m[2] ?? "";
  if (run[0] === "`" && info.includes("`")) return null;
  return { marker: run[0]!, len: run.length };
}

/** Does `line` CLOSE `fence`? Same marker, at least as long, nothing after it. */
function isFenceCloser(line: string, fence: OpenFence): boolean {
  const m = line.match(FENCE_SHAPE_RE);
  if (!m) return false;
  const run = m[1]!;
  return (
    run[0] === fence.marker &&
    run.length >= fence.len &&
    FENCE_CLOSE_TAIL_RE.test(m[2] ?? "")
  );
}

/**
 * Per-line "is this line fenced code?" mask over a whole document — `true` for
 * every line inside a fenced block AND for the two delimiter lines themselves.
 *
 * The ONE fence walk any line-oriented scanner over wiki markdown should use
 * (`checkIndexTruncation`, `src/wiki/lint.ts`, is the first non-fact-check
 * consumer). It runs {@link fenceOpener}/{@link isFenceCloser}, i.e. CommonMark's
 * real rules, because the naive `/^\s*(```|~~~)/` toggle every hand-rolled walk
 * reaches for is wrong four ways: a ``` and a `~~~` close each other, a
 * ```` ```` ````-opened block is closed by its own three-backtick CONTENT, a
 * closer is accepted with a trailing info string, and — worst, because it is
 * silent and unbounded — an ordinary prose line carrying an inline code span
 * (`` ```mermaid``` is a fence ``) toggles the flag ON and masks the entire rest
 * of the file.
 *
 * An unclosed fence at EOF runs to the end of the document, per CommonMark. That
 * is deliberately NOT {@link scanClaimLines}' retirement rule: there, masking
 * hides claims from a parse that then SPLICES, so believing a stray opener
 * corrupts a file; here the cost is a missed report on a page whose fences do not
 * balance, and inventing content the author did not write is the worse error.
 */
export function fencedLineMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let open: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open) {
      mask[i] = true; // the closer line is itself fenced
      if (isFenceCloser(line, open)) open = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      open = opener;
      mask[i] = true;
    }
  }
  return mask;
}

/**
 * Strip inline code spans from ONE line, CommonMark's pairing rule: a run of N
 * backticks opens a span that only a run of exactly N closes.
 *
 * The per-LINE sibling of {@link fencedLineMask}, and the ONE implementation for
 * every line-oriented scanner that must tell markup from a literal quoted in
 * backticks (`checkIndexTruncation` + `checkNestedAnnotation` in `src/wiki/lint.ts`,
 * `repairNestedFactWrappers` in `src/wiki/integrate-edits.ts`). Deliberately NOT
 * the linter's whole-document `stripCodeSpans`, whose fence removal joins the lines
 * around a block and could balance a genuinely dangling `[[` against a later line's
 * `]]`.
 *
 * A `` `[^`]*` `` replace mis-pairs the double-backtick form the syntax exists
 * for — `` `` [[x `` `` is how a page writes a literal containing a backtick —
 * leaving the `[[` exposed and the line falsely reported. An UNMATCHED run is
 * emitted literally and the scan continues past it, so a stray backtick cannot
 * swallow the rest of the line either.
 */
export function stripLineCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i++;
      continue;
    }
    let openEnd = i;
    while (openEnd < line.length && line[openEnd] === "`") openEnd++;
    const runLen = openEnd - i;
    let closeAt = -1;
    let k = openEnd;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let runEnd = k;
      while (runEnd < line.length && line[runEnd] === "`") runEnd++;
      if (runEnd - k === runLen) {
        closeAt = k;
        break;
      }
      k = runEnd;
    }
    if (closeAt === -1) {
      out += line.slice(i, openEnd); // unmatched run — literal backticks
      i = openEnd;
    } else {
      i = closeAt + runLen; // whole span dropped
    }
  }
  return out;
}

/**
 * Could `line` be a fence delimiter at all (opener OR closer), judged context-free?
 *
 * Used only by the post-splice invariant guard, which compares a count across a
 * rewrite rather than tracking state — so it deliberately does not care WHICH of
 * the two a given line would be.
 */
function isFenceDelimiterLine(line: string): boolean {
  const m = line.match(FENCE_SHAPE_RE);
  if (!m) return false;
  const run = m[1]!;
  const info = m[2] ?? "";
  // A tilde fence may carry backticks in its info string; a backtick fence may not,
  // and a backtick-carrying tail is not a legal closer either.
  return run[0] === "~" || !info.includes("`");
}

/** How many lines of `text` carry a fence-delimiter shape. See
 *  {@link isFenceDelimiterLine} — the splice guard's cheap balance check. */
export function countFenceDelimiterLines(text: string): number {
  let n = 0;
  for (const line of (text || "").split("\n")) if (isFenceDelimiterLine(line)) n++;
  return n;
}

/**
 * The `n` of a claim heading judged by SHAPE ALONE — no fence tracking, no
 * document context.
 *
 * The counterpart of {@link scanClaimLines}, and it exists for exactly one caller:
 * the splice guard. A heading MASKED by a fence is invisible to the parse by
 * construction, so "did the splice delete a sibling claim?" cannot be answered from
 * the parse — the deleted claim was never in it. Line shape is the only evidence
 * left, and it is enough: a region about to be deleted that carries some OTHER
 * claim's heading text is a region whose extent nobody should trust.
 */
export function claimHeadingShapeIndexes(text: string): number[] {
  const out: number[] = [];
  for (const line of (text || "").split("\n")) {
    const m = line.trim().match(CLAIM_HEADING_RE);
    if (m) out.push(Number(m[2]));
  }
  return out;
}

/** Per-line classification of a fact-check answer — see {@link scanClaimLines}. */
export interface ClaimLineScan {
  /** The answer's lines, `split("\n")`, unmodified. */
  lines: string[];
  /** Per line: its `CLAIM_HEADING_RE` match, or null. Always null inside a fence. */
  claimMatch: (RegExpMatchArray | null)[];
  /** Per line: true when it is a `###` heading OUTSIDE any fence — i.e. when it
   *  ends the block above it. Always false inside a fence. */
  blockEnd: boolean[];
}

/**
 * Walk an answer's lines ONCE, tracking fenced code blocks, and classify each line
 * as a claim heading / a block terminator / neither.
 *
 * **Fence tracking is load-bearing, not tidiness.** A verdict block may quote a
 * `### ❓ Claim 2/3` heading inside a ``` fence (models do this when explaining
 * what they were asked to check). Without this walk the parser sees a phantom
 * claim and the splicer targets the QUOTED heading — replacing the region from
 * inside the fence to the next `###`, which swallows the closing ``` and renders
 * the entire rest of the answer as code. Both consumers therefore share this one
 * implementation; neither re-spells the heading or extent rules.
 *
 * Fence matching follows the CommonMark closer rule the integrate engine already
 * uses: the closing run must use the same marker character, be at least as long as
 * the opener's, and carry nothing after it — and the OPENER rules are CommonMark's
 * too ({@link fenceOpener}), because "any line starting with ```" turned inline
 * code and indented code into fences that never closed.
 *
 * **An unclosed fence at EOF is not believed.** CommonMark says such a fence runs
 * to the end of the document, but here that is the runaway-masking failure: one
 * stray opener silently deletes every claim after it from the parse. A real
 * fact-check answer's fences close, so a dangling opener is far more likely prose —
 * it is retired to a literal line and the walk is re-run. Each pass retires exactly
 * one opener, so the loop terminates.
 */
export function scanClaimLines(answer: string): ClaimLineScan {
  const lines = (answer || "").split("\n");
  const literalOpeners = new Set<number>();
  let walk = walkClaimLines(lines, literalOpeners);
  while (walk.openAtEof !== -1) {
    literalOpeners.add(walk.openAtEof);
    walk = walkClaimLines(lines, literalOpeners);
  }
  return { lines, claimMatch: walk.claimMatch, blockEnd: walk.blockEnd };
}

/** One fence-tracking pass. `literalOpeners` names line indexes that must NOT be
 *  treated as openers (the unclosed-fence fallback's retirement list);
 *  `openAtEof` reports the line index of a fence still open at EOF, else -1. */
function walkClaimLines(
  lines: string[],
  literalOpeners: ReadonlySet<number>,
): { claimMatch: (RegExpMatchArray | null)[]; blockEnd: boolean[]; openAtEof: number } {
  const claimMatch: (RegExpMatchArray | null)[] = [];
  const blockEnd: boolean[] = [];
  let fence: OpenFence | null = null;
  let fenceLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (fence) {
      if (isFenceCloser(raw, fence)) {
        fence = null;
        fenceLine = -1;
      }
      claimMatch.push(null);
      blockEnd.push(false);
      continue;
    }
    const opener = literalOpeners.has(i) ? null : fenceOpener(raw);
    if (opener) {
      fence = opener;
      fenceLine = i;
      claimMatch.push(null);
      blockEnd.push(false);
      continue;
    }
    const line = raw.trim();
    claimMatch.push(line.match(CLAIM_HEADING_RE));
    blockEnd.push(CLAIM_BLOCK_END_RE.test(line));
  }
  return { claimMatch, blockEnd, openAtEof: fence ? fenceLine : -1 };
}

/** One claim anchor derived SERVER-SIDE from the persisted fact-check answer. */
export interface FactcheckClaimAnchor {
  /** `n` from the `Claim n/m` heading (1-based, as the model wrote it). */
  index: number;
  /**
   * `m` from the `Claim n/m` heading — the claim TOTAL the model itself wrote.
   *
   * Deliberately NOT derivable as `anchors.length` by the caller: the two differ
   * exactly when a verify block failed the heading contract (the failure class the
   * ↻ retry exists for), and `total` is interpolated straight back into the heading
   * the retried block carries — a wrong value splices a block whose `n/m` disagrees
   * with its siblings. The claim-retry route takes it as a required param, and the
   * client has no other source for it.
   */
  total: number;
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
  const scan = scanClaimLines(answer);
  const anchors: FactcheckClaimAnchor[] = [];
  let current: FactcheckClaimAnchor | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) anchors.push({ ...current, block: buffer.join("\n").trim() });
    current = null;
    buffer = [];
  };

  for (let i = 0; i < scan.lines.length; i++) {
    const line = scan.lines[i]!;
    const m = scan.claimMatch[i];
    if (m) {
      flush();
      current = {
        index: Number(m[2]),
        total: Number(m[3]),
        verdict: normalizeVerdict(m[1]!),
        title: (m[4] ?? "").trim(),
        block: "",
      };
      buffer = [line];
      continue;
    }
    // A non-claim `###` heading closes the current block without opening one.
    if (current && scan.blockEnd[i]) {
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

/**
 * Mirror of `FACTCHECK_MAX_CLAIMS` (`src/wiki/factcheck-context.ts`) — duplicated
 * rather than imported to keep this module free of `src/wiki/*` (it is bundled into
 * the browser client). Drift is pinned by an equality assertion in
 * `wiki-integrate.test.ts`, which CAN import both.
 */
const FACTCHECK_MAX_CLAIMS_MIRROR = 8;

/**
 * Total character cap across the whole posted quote list, DERIVED as
 * `FACTCHECK_MAX_CLAIMS × CLAIM_QUOTE_MAX` — the largest a legitimate extraction
 * can be. It therefore only ever binds a CRAFTED answer (a client posting more
 * claim blocks than the extractor's own cap allows); a real run is at or under it
 * by construction.
 */
export const CLAIM_QUOTES_TOTAL_MAX = FACTCHECK_MAX_CLAIMS_MIRROR * CLAIM_QUOTE_MAX;

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
 * claim k+1's verdict would wrap the passage in the WRONG verdict colour. So
 * alignment safety is enforced by exactly two rules — **index membership** and
 * **no duplicate indexes**, on BOTH sides:
 *
 * - The WHOLE list is dropped when alignment is unknowable: a non-array payload,
 *   an item that is not an object or carries no integer `index`, a duplicate index
 *   in the POSTED list, a duplicate `Claim n/m` index in the ANSWER (one quote
 *   would then match two different-verdict blocks — `known` silently deduped it,
 *   hence the size comparison), more quotes than the answer has DISTINCT claim
 *   indexes, or a total size over {@link CLAIM_QUOTES_TOTAL_MAX}.
 * - Individual entries are dropped, with a note, when only THAT entry is unusable:
 *   a `quote` that is blank, non-string, or over {@link CLAIM_QUOTE_MAX} chars, and
 *   an `index` naming no claim block in the answer (a heading the model mangled).
 *   Dropping is safe because alignment is by explicit index, never by position —
 *   removing one entry cannot shift another.
 *
 * NB the count rule is `≤`, not `===`: `Claim.quote` is OPTIONAL at extraction
 * ("Omit it if the claim is implicit" — `buildClaimExtractionPrompt`), so a
 * legitimate run routinely carries fewer quotes than claims.
 *
 * Never throws; degrading to "no quotes" always leaves the caller with a working
 * propose.
 */
export function validateClaimQuotes(raw: unknown, answer: string): ClaimQuoteValidation {
  if (typeof raw === "undefined" || raw === null) return { quotes: [] };
  if (!Array.isArray(raw)) return { quotes: [], note: "claim quotes ignored — not a list" };

  const anchors = parseFactcheckClaims(answer);
  const known = new Set(anchors.map((a) => a.index));
  // A repeated `Claim n/m` index in the answer makes index-keyed alignment
  // ambiguous — the same quote would sit under two blocks whose verdicts may
  // differ. `known` dedupes silently, so compare its size against the anchor count.
  if (known.size !== anchors.length) {
    return { quotes: [], note: "claim quotes ignored — the answer repeats a claim index" };
  }
  // Compared against the DISTINCT index count, which is what the quotes key on.
  if (raw.length > known.size) {
    return { quotes: [], note: "claim quotes ignored — more quotes than claims in the answer" };
  }

  const seen = new Set<number>();
  const kept: ClaimQuote[] = [];
  let badQuote = 0;
  let unknownIndex = 0;
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { quotes: [], note: "claim quotes ignored — malformed entry" };
    }
    const o = item as Record<string, unknown>;
    const index = typeof o.index === "number" && Number.isInteger(o.index) ? o.index : null;
    if (index === null) {
      return { quotes: [], note: "claim quotes ignored — an entry carries no claim index" };
    }
    if (seen.has(index)) {
      return { quotes: [], note: "claim quotes ignored — duplicate claim index" };
    }
    seen.add(index);
    // An index naming no claim block is THIS entry's problem, not the list's: the
    // surviving entries are still each provably on their own claim, so there is
    // nothing to guess. Reported, never silent.
    if (!known.has(index)) {
      unknownIndex++;
      continue;
    }
    const quote = typeof o.quote === "string" ? o.quote.trim() : "";
    if (!quote || quote.length > CLAIM_QUOTE_MAX) {
      badQuote++;
      continue;
    }
    total += quote.length;
    kept.push({ index, quote });
  }
  if (total > CLAIM_QUOTES_TOTAL_MAX) {
    return { quotes: [], note: "claim quotes ignored — total size over the limit" };
  }
  const notes: string[] = [];
  if (badQuote > 0) {
    notes.push(
      `${badQuote} claim quote${badQuote === 1 ? "" : "s"} dropped ` +
        `(blank, non-string, or over ${CLAIM_QUOTE_MAX} chars)`,
    );
  }
  if (unknownIndex > 0) {
    notes.push(
      `${unknownIndex} claim quote${unknownIndex === 1 ? "" : "s"} dropped ` +
        "(index matches no claim in the answer)",
    );
  }
  return notes.length ? { quotes: kept, note: notes.join("; ") } : { quotes: kept };
}

/**
 * Lift the `claims` SSE event's list onto the flat `{index, quote}` pairs the turn
 * carries (and later re-posts to the propose route). The event is the ONLY place
 * the extractor's verbatim passages exist — the claim checklist is transient and
 * dropped at `done` — so this runs once, on arrival.
 *
 * A claim the extractor gave no usable quote for is simply ABSENT from the result
 * (never `{quote: ""}`): the server treats a blank quote as a dropped entry, so
 * emitting one would only produce a note about nothing. Returns `[]` for a
 * non-array / empty input; the caller stores `undefined` rather than an empty list.
 */
export function claimQuotesFromClaimsEvent(list: unknown): ClaimQuote[] {
  if (!Array.isArray(list)) return [];
  const out: ClaimQuote[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.index !== "number" || typeof o.quote !== "string") continue;
    if (!o.quote.trim()) continue;
    out.push({ index: o.index, quote: o.quote });
  }
  return out;
}

/** Verdicts the integrate flow acts on (v1): contradicted + partly supported.
 *  ✅ and ❓ blocks are never turned into edits. */
export const INTEGRATE_VERDICTS = ["❌", "⚠️"] as const;

/** The correctable subset of {@link parseFactcheckClaims} — ❌ and ⚠️ only. */
export function correctableClaims(answer: string): FactcheckClaimAnchor[] {
  const wanted = new Set<string>(INTEGRATE_VERDICTS);
  return parseFactcheckClaims(answer).filter((c) => wanted.has(c.verdict));
}

// ── Inline `<Fact>` wrappers ─────────────────────────────────────────────────
// The wrapper is BUILT AT PROPOSE, server-side, and rides the ordinary edit
// payload (`edit.new`) through the client's verbatim echo — there is no separate
// "annotation" wire shape and no client-supplied flag saying "this one is a
// wrapper". Everything downstream re-DERIVES that structurally from the edit plus
// the span it resolved to, which is why the builders and the predicate live here:
// the server engine, the apply re-measure and the client's budget mirror must all
// agree, and a fourth hand-rolled copy is how they would stop agreeing.

/**
 * The TWO legal spellings of one wrapper around `inner`:
 *  - `[0]` INLINE — the normal form, for a span with no newline in it.
 *  - `[1]` BLOCK — open tag and close tag each on their own line, the only legal
 *    form when the wrapped span is a whole paragraph. The inline component matcher
 *    is line-scoped, so an inline wrapper spanning a newline renders as literal
 *    escaped tags.
 *
 * Returned as a pair (rather than one chosen form) because the wrapper-only
 * PREDICATE has to recognize either without knowing which the writer picked.
 *
 * `nl` is the BODY's newline: on a CRLF page a block form joined with a bare `\n`
 * makes strip → re-annotate non-byte-stable (and leaves one LF line in a CRLF
 * file). Callers derive it from the body they are splicing into; the wrapper-only
 * predicate accepts either spelling since it cannot know which the writer picked.
 */
export function factWrapperForms(
  claimIndex: number,
  verdict: FactVerdict,
  inner: string,
  nl: string = "\n",
): [inline: string, block: string] {
  const open = '<Fact n="' + claimIndex + '" v="' + verdict + '">';
  return [open + inner + "</Fact>", open + nl + inner + nl + "</Fact>"];
}

/**
 * Is this edit a WRAPPER-ONLY annotation — i.e. does it change nothing but add the
 * mark around the text already there?
 *
 * STRUCTURAL, never a payload flag: `edit.new` must be EXACTLY one of the two
 * legal wrapper spellings around the span the edit resolved to. A client cannot
 * claim wrapper-only status for an edit that rewrites prose, because the check is
 * against `resolvedText` — the server's own slice of its own freshly-read body.
 *
 * This is the whole reason wrapper-only edits can cost 0 against the change
 * budget: a ✅ annotation on a long sentence would otherwise book the whole
 * sentence as "changed" (≈1.2k chars on the creatine page) and eat the budget the
 * real corrections need.
 */
export function isWrapperOnlyEdit(
  edit: { claimIndex?: number; verdict?: string; new?: string },
  resolvedText: string | undefined,
): boolean {
  if (typeof resolvedText !== "string" || typeof edit.new !== "string") return false;
  const n = typeof edit.claimIndex === "number" ? edit.claimIndex : 0;
  if (!(n > 0)) return false;
  const v = normalizeFactVerdict(typeof edit.verdict === "string" ? edit.verdict : "");
  if (v === "unknown") return false;
  // Both newline spellings of the BLOCK form count — the writer derives the
  // newline from the body, and this predicate never sees which it picked.
  const lf = factWrapperForms(n, v, resolvedText);
  const crlf = factWrapperForms(n, v, resolvedText, "\r\n")[1];
  return edit.new === lf[0] || edit.new === lf[1] || edit.new === crlf;
}

/**
 * Fail-closed PAYLOAD-SHAPE test: is any edit's replacement text a whole `<Fact>`
 * wrapper? Used by the apply route to decide whether the fact-check appendix (and
 * therefore the posted `answer`) is mandatory for this write.
 *
 * Deliberately distinct from {@link isWrapperOnlyEdit}: this one runs BEFORE the
 * body is read (no `resolvedText` exists yet) and it must also catch a CORRECTION
 * whose `new` is Fact-wrapped — those are not wrapper-only, but they still emit a
 * chip that needs its `#fc-claim-N` target in the appendix.
 *
 * The test is the FULL wrapper shape ({@link isFactWrapperText}), not a `^<Fact\b`
 * prefix: prose that merely begins with the literal tag would otherwise force the
 * mandatory-appendix path (and its answer-or-400) onto an ordinary edit.
 */
export function carriesFactWrapper(edits: { new?: unknown }[]): boolean {
  return edits.some((e) => isFactWrapperText(e.new));
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
  /** The claim quotes the propose route ACCEPTED (echoed back from
   *  {@link validateClaimQuotes}) — the posted list minus anything it dropped. */
  quotes?: ClaimQuote[];
  /** Why any posted quote was dropped. RENDERED in the preview panel: this is the
   *  anti-silent-drop mechanism (#397's class), and a note that only ever reaches
   *  the server log is a silent drop as far as the reader is concerned. */
  quotesNote?: string;
  /** The SUPERSEDE rule made visible: prior marks the strip removed and this
   *  run does not re-emit. A RUN-level statement, so it rides its own field rather
   *  than a blank row in `dropped` (which inflated the "N not applied" count). */
  supersededNote?: string;
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
  | "blocked-append"
  /** An all-✅ check on an annotatable page whose extraction kept NO verbatim claim
   *  quotes: there is nothing to correct and nothing to anchor a mark to, so the
   *  run could only ever report "no edits". Say that instead of offering a button
   *  whose single outcome is an empty panel. */
  | "no-anchors";

/** The subset of an `AskTurn` the two write-action gates read. */
export interface IntegrateGateTurn {
  kind?: string;
  page?: string;
  pageType?: string;
  answer?: string;
  bodyLen?: number;
  wrote?: string;
  /** The checked page is a native `.mdx` and therefore carries INLINE `<Fact>`
   *  annotations (`isAnnotatablePage`, server-derived and ridden in on the `done`
   *  payload). On such a page an ALL-✅ check is still integrable — the write marks
   *  the confirmed passages — so the ≥1-❌/⚠️ gate relaxes to ≥1 parsed claim. */
  annotatable?: boolean;
  /** The extractor's per-claim verbatim passages carried on the turn. On the
   *  annotate-only (all-✅) path these ARE the anchors every mark resolves against,
   *  so an empty list means the run has nothing at all to write. */
  claimQuotes?: { index: number; quote: string }[];
}

/** True when the persisted answer carries at least one ❌/⚠️ claim block. Uses the
 *  shared heading parser, NOT a substring scan — a ⚠️ in the compose lede or in a
 *  claim's reasoning must not make an all-✅ check look correctable. */
export function hasCorrectableClaims(answer: string | undefined): boolean {
  return correctableClaims(answer ?? "").length > 0;
}

/**
 * Is there anything for an integrate run to WRITE on this turn?
 *
 * On a plain `.md` page the only output is corrected prose, so it takes a ❌/⚠️
 * claim. On an ANNOTATABLE (`.mdx`) page the run also writes the inline `<Fact>`
 * marks and the `<FactCheck>` appendix, so ANY parsed claim is enough — an all-✅
 * check has a real, useful result there (every confirmed passage gets marked), and
 * propose skips the model one-shot entirely since there is nothing to correct.
 *
 * The three former ❌/⚠️-only gates (this one behind the button, the propose
 * early-return, and the e2e all-✅ assertion) relax together or not at all.
 *
 * The annotate-only path additionally needs at least one CLAIM QUOTE: with nothing
 * to correct, the quotes are the only anchors a mark can resolve against, so a
 * quote-less all-✅ turn can only ever reach "the editor proposed no edits" — noise
 * dressed as an action. That case renders {@link annotateOnlyWithoutAnchors}'
 * honest empty state instead.
 */
export function hasIntegrableClaims(turn: IntegrateGateTurn): boolean {
  const answer = turn.answer ?? "";
  if (hasCorrectableClaims(answer)) return true;
  return (
    turn.annotatable === true &&
    parseFactcheckClaims(answer).length > 0 &&
    (turn.claimQuotes?.length ?? 0) > 0
  );
}

/** The all-✅-on-an-annotatable-page-with-no-quotes case: integrable in every
 *  respect except that no mark has an anchor. Split out so the bar can say WHY
 *  rather than silently rendering nothing. */
export function annotateOnlyWithoutAnchors(turn: IntegrateGateTurn): boolean {
  const answer = turn.answer ?? "";
  return (
    turn.annotatable === true &&
    !hasCorrectableClaims(answer) &&
    parseFactcheckClaims(answer).length > 0 &&
    (turn.claimQuotes?.length ?? 0) === 0
  );
}

/** Copy for {@link IntegrateBarState} `no-anchors` — every claim checked out, but
 *  the extraction kept no verbatim passage to hang a mark on. */
export const INTEGRATE_NO_ANCHORS_COPY =
  "Every claim held up, but this check kept no verbatim passages — there is nothing to mark.";

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
  if (!hasIntegrableClaims(turn)) {
    return annotateOnlyWithoutAnchors(turn) ? "no-anchors" : "hidden";
  }
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
  // A wrapper-only annotation changes no prose — it only marks what is already
  // there — so it costs 0, exactly as the server's `outcomeChangedChars` scores it.
  // Without the carve-out a handful of ✅ marks would book the whole marked
  // sentences and disable Apply on a page nothing was actually being rewritten in.
  if (isWrapperOnlyEdit(edit, edit.resolvedText)) return 0;
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

/**
 * Indexes of the WRAPPER-ONLY edits in a proposal — the annotations. Split out so
 * the preview can present them as ONE group instead of N no-op diffs: a diff card
 * per ✅ mark shows the same line on both sides and buries the two or three edits
 * that actually rewrite prose.
 */
export function annotationIndexes(edits: ProposedEdit[]): number[] {
  const out: number[] = [];
  edits.forEach((e, i) => {
    if (isWrapperOnlyEdit(e, e.resolvedText)) out.push(i);
  });
  return out;
}

/**
 * The annotation group card: one checkbox for ALL wrapper-only edits, plus a
 * per-claim anchor excerpt so the reviewer can see WHICH passages get marked.
 *
 * One checkbox, not N: the marks are a single editorial act ("annotate this page
 * with the check results"), and per-wrapper checkboxes invite a half-marked page
 * whose chips and appendix disagree about what was checked.
 */
function annotationGroupHtml(
  edits: ProposedEdit[],
  idxs: number[],
  checked: boolean,
  disabled: boolean,
): string {
  if (!idxs.length) return "";
  const rows = idxs
    .map((i) => {
      const e = edits[i]!;
      const v = normalizeFactVerdict(e.verdict || "");
      const anchor = (typeof e.resolvedText === "string" ? e.resolvedText : e.old || "")
        .replace(/\s+/g, " ")
        .slice(0, 140);
      const claim =
        typeof e.claimIndex === "number" && e.claimIndex > 0
          ? '<span class="wiki-fc-int-claim">Claim ' + esc(String(e.claimIndex)) + "</span>"
          : "";
      return (
        '<div class="wiki-fc-int-anno-row">' +
        '<span class="wiki-fc-int-anno-badge v-' + esc(v) + '">' + esc(e.verdict || "") + "</span>" +
        claim +
        '<span class="wiki-fc-int-anno-text">' + esc(anchor) + "</span>" +
        "</div>"
      );
    })
    .join("");
  return (
    '<div class="wiki-fc-int-edit wiki-fc-int-anno">' +
    '<label class="wiki-fc-int-row">' +
    '<input type="checkbox" class="wiki-fc-int-cb" data-edit-group="annotations"' +
    (checked ? " checked" : "") + (disabled ? " disabled" : "") + " />" +
    '<span class="wiki-fc-int-reason">Mark ' + idxs.length +
    " checked passage" + (idxs.length === 1 ? "" : "s") +
    " inline (no prose changes)</span>" +
    "</label>" +
    rows +
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

/**
 * The propose route's claim-quote drop note, rendered in the panel's note region
 * (same `.wiki-fc-int-note` styling as the model's own note) so a dropped anchor is
 * VISIBLE rather than log-only. Prefixed "Claim anchors:" so it can't be misread as
 * a statement about the proposed edits.
 */
function quotesNoteHtml(proposal: IntegrateProposal): string {
  return (
    (proposal.quotesNote
      ? '<div class="wiki-fc-int-note">Claim anchors: ' + esc(proposal.quotesNote) + "</div>"
      : "") +
    // The run-level supersede statement sits beside it, prefixed for the same
    // reason: it is a statement about PRIOR marks, not about this run's edits.
    (proposal.supersededNote
      ? '<div class="wiki-fc-int-note">Previous marks: ' + esc(proposal.supersededNote) + "</div>"
      : "")
  );
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
    quotesNoteHtml(proposal) +
    droppedListHtml(proposal.dropped || []) +
    '<div class="wiki-fc-int-actions">' +
    '<button id="wikiFcIntCancel" class="wiki-fc-int-btn">Close</button>' +
    "</div></div>"
  );
}

/**
 * The "also add / refresh summary callout" checkbox — the NON-annotated branch's
 * callout control. The page already carries a fact-check block ⇒ the checkbox
 * REPLACES it in place; a clean page ⇒ it adds one. Say which, since "add" on a
 * page that has one reads as stacking a second.
 */
function calloutCheckboxHtml(
  proposal: IntegrateProposal,
  checked: boolean,
  disabled: boolean,
  view: IntegratePreviewView,
): string {
  const label = proposal.hasSentinelBlock
    ? "refresh the existing summary callout (replaces the previous one)"
    : "also add summary callout";
  const title = view.calloutDisabled
    ? ' title="This turn carries no stored answer, so no callout can be built from it"'
    : "";
  return (
    '<label class="wiki-fc-int-callout"' + title + '><input type="checkbox" id="wikiFcIntCallout"' +
    (checked ? " checked" : "") + (disabled ? " disabled" : "") + " /> " + label + "</label>"
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
  // Annotations are grouped; the remaining edits are the ones that rewrite prose.
  const annoIdxs = annotationIndexes(edits);
  const annoSet = new Set(annoIdxs);
  const annoChecked = annoIdxs.every((i) => selected[i] !== false);
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
  // An ANNOTATED write has no callout CHOICE: every `<Fact>` chip links to a
  // `#fc-claim-N` section that only the appendix provides, so shipping the marks
  // without it would ship dead chips. The checkbox is replaced by a statement (so
  // the checkbox's label/disabled/title computation belongs to the OTHER branch).
  const annotated = carriesFactWrapper(edits);
  const calloutControl = annotated
    ? '<span class="wiki-fc-int-callout fixed" title="Every inline mark links into this block, so it is written with them">' +
      (proposal.hasSentinelBlock
        ? "the fact-check appendix will be refreshed"
        : "the fact-check appendix will be added") +
      "</span>"
    : calloutCheckboxHtml(proposal, calloutChecked, view.calloutDisabled === true || applying, view);
  // Head count and button label agree: the marks are counted as MARKS in both, so a
  // "0 proposed edits" head can't sit above an "Apply 5 edits" button.
  const prose = edits.length - annoIdxs.length;
  const selectedAnno = annoIdxs.filter((i) => selected[i] !== false).length;
  const selectedProse = n - selectedAnno;
  const headCount =
    prose + " proposed edit" + (prose === 1 ? "" : "s") +
    (annoIdxs.length
      ? " · " + annoIdxs.length + " passage" + (annoIdxs.length === 1 ? "" : "s") + " marked"
      : "");
  const applyLabel =
    selectedProse + " edit" + (selectedProse === 1 ? "" : "s") +
    (selectedAnno ? " + " + selectedAnno + " mark" + (selectedAnno === 1 ? "" : "s") : "");
  const msg = view.message
    ? '<div class="wiki-fc-int-msg' + (view.messageError ? " error" : "") +
      '" id="wikiFcIntMsg">' + esc(view.message) + "</div>"
    : '<div class="wiki-fc-int-msg" id="wikiFcIntMsg"></div>';
  return (
    '<div class="wiki-fc-int-panel" id="wikiFcIntPanel">' +
    '<div class="wiki-fc-int-head">' + headCount + "</div>" +
    (proposal.note ? '<div class="wiki-fc-int-note">' + esc(proposal.note) + "</div>" : "") +
    quotesNoteHtml(proposal) +
    edits
      .map((e, i) =>
        annoSet.has(i) ? "" : editPreviewHtml(e, i, selected[i] !== false, applying),
      )
      .join("") +
    annotationGroupHtml(edits, annoIdxs, annoChecked, applying) +
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
    calloutControl +
    '<button id="wikiFcIntAccept" class="wiki-fc-int-btn primary"' + acceptDisabled + ">" +
    (applying ? "Applying…" : "Apply " + applyLabel) + "</button>" +
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
  /** Exact wiki-relative path — see {@link buildIntegrateApplyBody}. */
  relPath?: string;
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
 *
 * On an ANNOTATED apply (any selected edit's `new` opens with a `<Fact` tag) the
 * pair is NOT optional: the chips those wrappers emit link to `#fc-claim-N`
 * sections that live only in the appendix, so the server rejects a wrapper-carrying
 * apply that arrives without an `answer`. The checkbox is not the authority there —
 * this is — because the checkbox defaults OFF on a clean page and would ship chips
 * with no targets.
 */
export function buildIntegrateApplyBody(input: {
  wiki?: string;
  page: string;
  /** The page's exact wiki-relative path — sent beside the name so the apply
   *  edits the page that was CHECKED, not whichever shares its stem and
   *  registered first. Omitted when the turn carries none (a pre-relPath turn),
   *  where the route falls back to the name exactly as before. */
  relPath?: string;
  baseHash: string;
  edits: ProposedEdit[];
  selected: boolean[];
  appendCallout: boolean;
  answer?: string;
}): IntegrateApplyBody | null {
  const edits = input.edits.filter((_, i) => input.selected[i] !== false);
  if (!edits.length) return null;
  const withCallout = (input.appendCallout || carriesFactWrapper(edits)) && !!input.answer;
  return {
    ...(input.wiki ? { wiki: input.wiki } : {}),
    page: input.page,
    ...(input.relPath ? { relPath: input.relPath } : {}),
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
  /** The write carried inline `<Fact>` marks, so what landed is the fact-check
   *  APPENDIX (`<FactCheck>`), not the `.md` summary callout. Naming the wrong one
   *  sends the reader looking for a box that isn't on the page. */
  annotated?: boolean;
}): string {
  if (result.applied === 0) {
    return "No edits could be applied (the page may have shifted) — nothing was written.";
  }
  const n = result.applied + " edit" + (result.applied === 1 ? "" : "s");
  const what = result.annotated ? "fact-check appendix" : "summary callout";
  let callout = "";
  if (result.calloutAdded) {
    callout = result.calloutReplaced ? " + " + what + " refreshed" : " + " + what + " added";
  } else if (result.calloutRequested) {
    callout = " (" + what + " was NOT added)";
  }
  const head = "✓ Integrated " + n + callout;
  if (result.committed) return head;
  if (result.reason === "not-a-repo" || result.reason === "not-default-branch") {
    return head + " — applied, but not committed (no git undo)";
  }
  if (result.reason) return head + " — not committed (" + result.reason + ")";
  return head + " — not committed";
}
