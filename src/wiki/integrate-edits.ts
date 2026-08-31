/**
 * Pure engine for the fact-check reader's **Integrate into article** action —
 * the sibling of "➕ Add to article" that, instead of appending a callout, edits
 * the prose in place: a fenced one-shot returns a STRUCTURED EDIT LIST (❌ claims
 * corrected, ⚠️ hedged, with source links), which is validated + resolved here and
 * applied by `page-write.ts` under CAS + the per-wiki queue.
 *
 * The whole module is side-effect-free (no filesystem, no model call, no DOM) —
 * this is the test seam. Three responsibilities:
 *
 * ── 1. Two masks over the page body, NEVER fused ─────────────────────────────
 * Both hide the same EXCLUSION ZONES — frontmatter, persisted `factcheck:start/end`
 * blocks, fenced code blocks, and (on `.mdx`) BLOCK-component TAG MARKUP ONLY
 * (line-anchored opening/closing tags + attributes; the prose inside a `<Callout>`
 * stays editable) — but for different consumers and with different length
 * semantics:
 *
 *  - {@link matchMaskBody} (internal, drives unique-match + offset math) is
 *    SAME-LENGTH: every excluded UTF-16 code unit becomes ONE {@link ZONE_SENTINEL}
 *    (U+E000, private use — a single code unit that cannot occur in wiki source).
 *    Same-length is mandatory: region REMOVAL would splice the text on either side
 *    of a zone into adjacency and let a phantom `old` match across the seam.
 *    NUL is forbidden as the sentinel by defensive invariant — `Bun.spawn` rejects
 *    NUL in argv, so a NUL-bearing string leaking into any prompt path would hard
 *    crash the claude-cli bots. Indexing is by CODE UNIT (JS string offsets)
 *    throughout; byte offsets would desync on Norwegian characters and emoji.
 *  - {@link promptMaskBody} (the body handed to the model) is NOT length
 *    preserving: each zone collapses to a readable, argv-safe placeholder
 *    (`[code block omitted]`, …). Safe precisely because the model only ever
 *    quotes text OUTSIDE the zones; the match-mask alone owns offset math.
 *
 * ── 2. Validate-to-null parsing ──────────────────────────────────────────────
 * {@link parseEditList} mirrors `normalizeDraftOutput`/`parseClaimList` discipline:
 * a malformed model response yields `null` (⇒ a clean error, never a write).
 *
 * ── 3. Range resolution + descending splice ──────────────────────────────────
 * {@link applyEdits} resolves EVERY edit's `[start, end)` against the ORIGINAL
 * match-masked body first, rejects overlapping ranges (earlier edit wins, later is
 * dropped with an honest reason), then splices the ORIGINAL body DESCENDING by
 * start offset so no applied splice shifts an unapplied range. There is NO
 * `String.replace` anywhere in the apply path and, deliberately, NO per-edit
 * re-validation during application: with pinned original-body offsets and overlap
 * rejection, a duplicate string introduced by a sibling edit's `new` text is
 * irrelevant, and re-validating would false-drop unambiguously placeable edits.
 * A `old` that matches 0 or ≥2 times is DROPPED, never fuzzy-applied — with one
 * sanctioned second tier: on a 0-match, the lookup is retried against the
 * WHITESPACE-COLLAPSED body and mapped back to raw offsets through the existing
 * `collapseWithMap` machinery (line-wrap drift is the common miss). The tier is
 * recorded per edit so the acceptance gate can report exact-vs-collapsed rates.
 *
 * That second tier is GATED by {@link collapsedRescueRisk}: `collapseWithMap`
 * also strips `*`/`_`/backtick and rewrites `[label](url)` → `label`, so a
 * mapped-back range can start AFTER an opening delimiter while still consuming
 * the closing one (`**bold` → splice → `**NEW`), swallow a link's URL
 * (`See [NEW here.`), or arbitrarily exceed `old` across a paragraph break. A
 * rescued range whose RAW slice contains `\n\n`, or whose markup-delimiter counts
 * differ from `old`'s, is therefore rejected rather than applied — a false drop
 * is honest, a false apply corrupts the page. Every applied outcome also carries
 * `resolvedText` (the raw slice that will actually be replaced), so the preview
 * shows the truth rather than the model's `old`.
 *
 * NOTE on code blocks: only FENCED blocks (``` and ~~~) are zoned. A 4-space
 * INDENTED code block is left editable — it is indistinguishable from a deep list
 * continuation without a full block parse, and false-masking prose is the worse
 * failure here.
 */

import {
  COMPONENT_TAG_SOURCE_SINGLE_LINE,
  countFactWrappers,
  isFactWrapperText,
  normalizeFactVerdict,
  stripFactWrappers,
} from "../format/markdown-ast.ts";
import type { FactVerdict } from "../format/markdown-ast.ts";
import { collapseWithMap } from "./explain-context.ts";
import { formatWebHtml } from "../web/web-format.ts";
import {
  FACTCHECK_MAX_CLAIMS,
  FACTCHECK_SENTINEL_START,
  FACTCHECK_SENTINEL_END,
} from "./factcheck-context.ts";
import { extractJson } from "../ai/json-extract.ts";
import {
  factWrapperForms,
  fencedLineMask,
  frontmatterEndLine,
  isWrapperOnlyEdit,
  NESTED_FACT_SOURCE,
  NESTED_MARKUP_RE,
  WIKILINK_SPAN_SOURCE,
  type ClaimQuote,
  type FactcheckClaimAnchor,
} from "../dashboard/views/components/wiki-integrate.ts";

/** Re-exported so the write path has ONE import for the whole strip → resolve →
 *  splice shape. The strip itself lives in `markdown-ast.ts` beside the tag-shape
 *  authority, because the selection locator and claim extraction need it too and
 *  neither may import this (server-graph) module. */
export { stripFactWrappers, countFactWrappers };

/**
 * Cap on the page body handed to the integrate one-shot (chars, measured through
 * {@link integrateBodyLen}). ~2× `FACTCHECK_ARTICLE_BODY_MAX` — unlike claim
 * extraction the model must see the WHOLE page (it quotes `old` from it), so the
 * cap is a hard reject rather than a truncation.
 *
 * DECLARED in the import-safe `wiki-integrate.ts` and re-exported here: PR 2's
 * bundled reader client gates on the same number, and importing THIS module in the
 * browser would drag `explain-context.ts` → `research/answer.ts` (the whole server
 * graph) into the bundle. One constant, two consumers, no drift.
 */
export { INTEGRATE_BODY_MAX } from "../dashboard/views/components/wiki-integrate.ts";
/** Max edits accepted in one propose/apply call. */
export const INTEGRATE_MAX_EDITS = 12;
/** Max chars for one edit's `old` or `new`. */
export const INTEGRATE_MAX_EDIT_CHARS = 2000;

/**
 * The edit cap for ONE integration, given whether the page is annotatable.
 *
 * An annotated write legitimately carries the corrections PLUS up to one mark per
 * checked claim, so the cap rises by `FACTCHECK_MAX_CLAIMS` there. The ONE authority
 * on that number: propose's zero-claims early return, propose's full path, the apply
 * route's count check and the acceptance test all call this, after three
 * hand-written copies drifted (the early return echoed 12 while the full path
 * enforced 20).
 */
export function annotatedMaxEdits(annotatable: boolean): number {
  return annotatable ? FACTCHECK_MAX_CLAIMS + INTEGRATE_MAX_EDITS : INTEGRATE_MAX_EDITS;
}

/** Same-length match-mask sentinel: U+E000, private use, ONE UTF-16 code unit.
 *  Never NUL (see the module doc — `Bun.spawn` rejects NUL in argv). */
export const ZONE_SENTINEL = "\uE000";

/** Chars of surrounding body returned with each resolved edit for the client preview. */
const PREVIEW_CONTEXT = 120;

/**
 * The preview context slices must stop at an exclusion-zone boundary. A naive
 * `body.slice(start - 120, start)` reaches into frontmatter, a fenced code block
 * or a persisted fact-check callout and renders those bytes to the reviewer as
 * ordinary adjacent prose — text the edit provably cannot touch, shown as if it
 * were its neighbourhood. The masked body already marks every zone code unit with
 * {@link ZONE_SENTINEL}, so the clamp is a scan of the same window.
 */
function contextBefore(body: string, masked: string, start: number): string {
  const from = Math.max(0, start - PREVIEW_CONTEXT);
  const lastZone = masked.slice(from, start).lastIndexOf(ZONE_SENTINEL);
  return body.slice(lastZone === -1 ? from : from + lastZone + 1, start);
}

function contextAfter(body: string, masked: string, end: number): string {
  const to = Math.min(body.length, end + PREVIEW_CONTEXT);
  const firstZone = masked.slice(end, to).indexOf(ZONE_SENTINEL);
  return body.slice(end, firstZone === -1 ? to : end + firstZone);
}

// ── Exclusion zones ──────────────────────────────────────────────────────────

export type ZoneKind = "frontmatter" | "sentinel" | "fence" | "component";

export interface Zone {
  start: number;
  end: number;
  kind: ZoneKind;
}

/** Readable, argv-safe stand-ins for the model-facing prompt mask. Every kind
 *  gets a NON-EMPTY placeholder: an empty one is indistinguishable from editable
 *  prose in the model's copy of the page, so the model would quote across it and
 *  the resulting `old` could never resolve (the match mask fills the same span
 *  with sentinels). Only the TAG is replaced — a component's inner prose is not a
 *  zone and stays in place. */
const ZONE_PLACEHOLDER: Record<ZoneKind, string> = {
  frontmatter: "[frontmatter omitted]",
  sentinel: "[prior fact-check block omitted]",
  fence: "[code block omitted]",
  component: "[component tag omitted]",
};

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SENTINEL_BLOCK_RE = new RegExp(
  escapeRegExp(FACTCHECK_SENTINEL_START) + "[\\s\\S]*?" + escapeRegExp(FACTCHECK_SENTINEL_END),
  "g",
);

/**
 * A KNOWN component's opening / closing / self-closing tag **at the start of a
 * line** (leading indent captured separately so it is not swallowed into the
 * zone) — i.e. exactly the BLOCK form `markdown-ast`'s `COMPONENT_OPEN_RE`
 * recognizes, derived from the same shared tag source. The indent allowance is
 * deliberate: `tryParseComponent` matches `lines[i].trim()`, so an INDENTED block
 * tag really does render as a component and must therefore be masked.
 *
 * The SINGLE-LINE tag source is load-bearing: with a newline-crossing attribute
 * tail, an opening tag that is missing its `>` swallows every following line up
 * to the next `>` anywhere in the page (a blockquote's `>` marker, a later tag),
 * zoning editable prose that then reports a misleading "no longer found".
 *
 * INLINE component tags (`<Verdict>ok</Verdict>` mid-sentence, or a prose mention
 * of the `` `<Callout>` `` component) are deliberately NOT masked. Masking them
 * made every sentence that mentions one permanently unintegrable — the match mask
 * filled the tag's span with sentinels while the prompt mask deleted it, so the
 * model's honestly-copied `old` could never resolve, and the "reason" the user saw
 * was a misleading "no longer found in the page". Leaving them visible means an
 * edit COULD rewrite an inline tag; that is bounded (the human previews the exact
 * replaced text) and strictly better than guaranteed silent failure.
 */
const BLOCK_COMPONENT_TAG_RE = new RegExp(`^([ \\t]*)(${COMPONENT_TAG_SOURCE_SINGLE_LINE})`, "gm");

/** True when `pos` falls inside any of `ranges`. */
function inRanges(pos: number, ranges: Zone[]): boolean {
  return ranges.some((z) => pos >= z.start && pos < z.end);
}

/**
 * Every exclusion zone in `body`, merged and sorted by start offset. Component
 * tags are scanned only when `isMdx` — a plain `.md` page has no component
 * vocabulary, so masking `<Callout …>`-looking text there would be wrong.
 */
export function findExclusionZones(body: string, isMdx: boolean): Zone[] {
  const zones: Zone[] = [];

  const fm = body.match(FRONTMATTER_RE);
  if (fm && fm.index === 0) zones.push({ start: 0, end: fm[0].length, kind: "frontmatter" });

  for (const m of body.matchAll(SENTINEL_BLOCK_RE)) {
    if (m.index === undefined) continue;
    zones.push({ start: m.index, end: m.index + m[0].length, kind: "sentinel" });
  }

  // Fenced code blocks — a line-state scan, so an indented or info-string fence
  // (```ts) is handled and an UNTERMINATED fence masks to end of file (safer than
  // leaving half a code block editable). Both CommonMark markers are supported and
  // the OPENING marker is remembered, so a ``` inside a ~~~ block can't close it.
  //
  // The scan SKIPS lines already inside a frontmatter or fact-check-sentinel zone:
  // a persisted fact-check block routinely quotes a page's markdown, and a single
  // stray ``` in there used to invert fence parity for the whole rest of the page
  // (everything after it silently became "code" and thus unintegrable).
  //
  // CommonMark also requires the CLOSING fence's marker run to be at least as
  // long as the opener's, so a ```-line inside a ````-opened block is content,
  // not a closer (otherwise the rest of the page flips to "code" and the real
  // closing ```` opens a phantom fence).
  const preZones = [...zones];
  let offset = 0;
  let fenceStart = -1;
  let fenceMarker = "";
  let fenceRun = 0;
  for (const line of body.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m && !inRanges(offset, preZones)) {
      const run = m[1]!;
      const marker = run[0]!;
      if (fenceStart < 0) {
        fenceStart = offset;
        fenceMarker = marker;
        fenceRun = run.length;
      } else if (marker === fenceMarker && run.length >= fenceRun) {
        zones.push({ start: fenceStart, end: offset + line.length, kind: "fence" });
        fenceStart = -1;
        fenceMarker = "";
        fenceRun = 0;
      }
    }
    offset += line.length + 1;
  }
  if (fenceStart >= 0) zones.push({ start: fenceStart, end: body.length, kind: "fence" });

  if (isMdx) {
    for (const m of body.matchAll(BLOCK_COMPONENT_TAG_RE)) {
      if (m.index === undefined) continue;
      const start = m.index + m[1]!.length;
      zones.push({ start, end: start + m[2]!.length, kind: "component" });
    }
  }

  zones.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Zone[] = [];
  for (const z of zones) {
    const last = merged[merged.length - 1];
    if (last && z.start <= last.end) {
      if (z.end > last.end) last.end = z.end;
    } else {
      merged.push({ ...z });
    }
  }
  return merged;
}

/**
 * SAME-LENGTH mask: every code unit inside an exclusion zone becomes one
 * {@link ZONE_SENTINEL}. Drives unique-match counting and all offset math — an
 * `old` that reaches into (or across) a zone cannot match by construction.
 */
export function matchMaskBody(body: string, isMdx = false): string {
  const zones = findExclusionZones(body, isMdx);
  if (zones.length === 0) return body;
  const out: string[] = [];
  let cursor = 0;
  for (const z of zones) {
    out.push(body.slice(cursor, z.start));
    out.push(ZONE_SENTINEL.repeat(z.end - z.start));
    cursor = z.end;
  }
  out.push(body.slice(cursor));
  return out.join("");
}

/**
 * Model-facing mask: each zone collapses to a readable placeholder. NOT
 * length-preserving on purpose (see the module doc), and the single pinned
 * referent for every body-size measurement — see {@link integrateBodyLen}.
 */
export function promptMaskBody(body: string, isMdx = false): string {
  const zones = findExclusionZones(body, isMdx);
  if (zones.length === 0) return body;
  const out: string[] = [];
  let cursor = 0;
  for (const z of zones) {
    out.push(body.slice(cursor, z.start));
    out.push(ZONE_PLACEHOLDER[z.kind]);
    cursor = z.end;
  }
  out.push(body.slice(cursor));
  return out.join("");
}

/**
 * THE body-length referent for the integrate flow — the `bodyLen` on the
 * fact-check `done` SSE payload AND the integrate route's `INTEGRATE_BODY_MAX`
 * check both call this ONE function. A sentinel-only masker would diverge by
 * kilobytes on a code-heavy page (a fenced block's placeholder is not
 * length-preserving), so the client would size its budget against a number the
 * server never enforces.
 */
export function integrateBodyLen(body: string, isMdx = false): number {
  return promptMaskBody(body, isMdx).length;
}

// ── Edit list ────────────────────────────────────────────────────────────────

/** One proposed in-place correction. `old` must appear EXACTLY ONCE in the
 *  match-masked body; `new` replaces it verbatim. */
export interface IntegrateEdit {
  claimIndex: number;
  verdict: string;
  old: string;
  new: string;
  reason: string;
}

/** A parsed edit list plus the model's optional one-line summary. `dropped`
 *  carries the per-item rejections so a malformed entry is VISIBLE in the preview
 *  instead of vanishing (the #397 silent-drop class). */
export interface EditListResult {
  edits: IntegrateEdit[];
  dropped: DroppedEdit[];
  note?: string;
}

/**
 * Neutralize embedded fact-check sentinels in model- or client-supplied text —
 * the same treatment `buildFactcheckBlock` gives an answer body, for the same
 * reason: a lone injected `<!-- factcheck:start -->` spliced into the page makes
 * the NEXT "➕ Add to article" append's non-greedy `spliceSentinelBlock` match
 * from that stray marker and swallow the real prose between it and the true end
 * sentinel. Applied to every `new` at BOTH entry points (model parse + client
 * echo), so no path can inject one.
 */
export function neutralizeFactcheckSentinels(text: string): string {
  return text
    .replaceAll(FACTCHECK_SENTINEL_START, "factcheck:start")
    .replaceAll(FACTCHECK_SENTINEL_END, "factcheck:end");
}

/** A best-effort {@link IntegrateEdit} for a malformed item, so a drop can still
 *  name what it dropped. */
function coerceEditShape(o: Record<string, unknown>): IntegrateEdit {
  const idx = Number(o.claimIndex);
  return {
    claimIndex: Number.isFinite(idx) && idx > 0 ? Math.trunc(idx) : 0,
    verdict: o.verdict === "⚠" ? "⚠️" : typeof o.verdict === "string" ? o.verdict : "",
    old: typeof o.old === "string" ? o.old : "",
    new: typeof o.new === "string" ? neutralizeFactcheckSentinels(o.new) : "",
    reason: typeof o.reason === "string" ? o.reason.trim() : "",
  };
}

/**
 * Tolerant parse of the integrate one-shot's raw output. Accepts `{edits:[…]}`
 * (optionally with `note`) or a bare `[…]`. Returns null on any parse/shape
 * failure — the route turns that into a clean error and NEVER a write. An empty
 * but well-formed list is a legitimate "nothing to correct" answer, so it returns
 * `{edits: []}` rather than null.
 *
 * Per-ITEM failures are never `continue`d into the void: each lands in `dropped`
 * with its own reason. A missing or empty `new` is one of them — defaulting it to
 * `""` (the pre-review behaviour) turned "the model forgot a field" into a silent
 * DELETION of the anchored sentence.
 */
export function parseEditList(raw: string): EditListResult | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = extractJson<unknown>(raw);
  } catch {
    return null;
  }
  let rawEdits: unknown;
  let note: string | undefined;
  if (Array.isArray(parsed)) {
    rawEdits = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    rawEdits = obj.edits;
    if (typeof obj.note === "string" && obj.note.trim()) note = obj.note.trim();
  }
  if (!Array.isArray(rawEdits)) return null;

  const edits: IntegrateEdit[] = [];
  const dropped: DroppedEdit[] = [];
  const blank: IntegrateEdit = { claimIndex: 0, verdict: "", old: "", new: "", reason: "" };
  for (const item of rawEdits) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      dropped.push({ edit: { ...blank }, reason: "not an edit object" });
      continue;
    }
    const o = item as Record<string, unknown>;
    const edit = coerceEditShape(o);
    if (typeof o.old !== "string") {
      dropped.push({ edit, reason: "`old` is missing or not a string" });
      continue;
    }
    if (!edit.old.trim()) {
      dropped.push({ edit, reason: "`old` is empty — an empty anchor can never resolve" });
      continue;
    }
    if (typeof o.new !== "string") {
      dropped.push({ edit, reason: "`new` is missing — an absent replacement would DELETE the anchor" });
      continue;
    }
    if (!edit.new) {
      dropped.push({ edit, reason: "`new` is empty — deleting the anchor is not an integrate edit" });
      continue;
    }
    edits.push(edit);
  }
  return { edits, dropped, ...(note ? { note } : {}) };
}

/** An edit dropped before/at resolution, with the reason shown in the preview. */
export interface DroppedEdit {
  edit: IntegrateEdit;
  reason: string;
}

/**
 * Payload bounds, enforced at PROPOSE time so the preview only ever shows
 * appliable edits: over-cap edits land in `dropped` with honest reasons instead
 * of silently surviving to a 400 at apply. The same constants are re-checked as
 * a HARD 400 on the apply route (the client echoes edits verbatim, so apply must
 * not trust them).
 */
export function enforceEditBounds(edits: IntegrateEdit[]): {
  kept: IntegrateEdit[];
  dropped: DroppedEdit[];
} {
  const kept: IntegrateEdit[] = [];
  const dropped: DroppedEdit[] = [];
  for (const edit of edits) {
    if (edit.old.length > INTEGRATE_MAX_EDIT_CHARS || edit.new.length > INTEGRATE_MAX_EDIT_CHARS) {
      dropped.push({ edit, reason: `edit text exceeds ${INTEGRATE_MAX_EDIT_CHARS} chars` });
      continue;
    }
    if (kept.length >= INTEGRATE_MAX_EDITS) {
      dropped.push({ edit, reason: `over the ${INTEGRATE_MAX_EDITS}-edit cap for one integration` });
      continue;
    }
    kept.push(edit);
  }
  return { kept, dropped };
}

/**
 * PRE-resolution "changed chars" — per edit the LARGER of the model's quoted
 * `old` and the text inserted. It is NOT comparable to the authoritative
 * span-based measure in EITHER direction: a tier-2 rescue can resolve to a raw
 * span LONGER than `old` (line-wrap whitespace), while an `old` carrying reflowed
 * whitespace OVER-counts the span it actually resolves to. So the apply route
 * deliberately does not ratio-gate on this — {@link changedCharsOfOutcomes} over
 * resolved spans is the only budget referent. Kept as the descriptive payload
 * measure (and its unit-test seam).
 */
export function changedChars(edits: IntegrateEdit[]): number {
  return edits.reduce((sum, e) => sum + Math.max(e.old.length, e.new.length), 0);
}

/** Chars one RESOLVED edit changes: the larger of the raw span it replaces and
 *  the text it inserts. `old.length` under-measures a tier-2 rescue.
 *
 *  A WRAPPER-ONLY annotation scores 0 — structurally, via
 *  {@link isWrapperOnlyEdit} over the span it actually resolved to, never a payload
 *  flag. Without the carve-out a set of ✅ marks books every marked sentence as
 *  "changed" (≈1.2k chars on the creatine page) and either eats the whole budget or
 *  hard-400s the apply, for a write that alters no prose at all. */
export function outcomeChangedChars(o: EditOutcome): number {
  if (!o.applied || o.start === undefined || o.end === undefined) return 0;
  if (isWrapperOnlyEdit(o.edit, o.resolvedText)) return 0;
  return Math.max(o.end - o.start, o.edit.new.length);
}

/** Total changed chars over the APPLIED outcomes, measured on resolved spans. */
export function changedCharsOfOutcomes(outcomes: EditOutcome[]): number {
  return outcomes.reduce((sum, o) => sum + outcomeChangedChars(o), 0);
}

/**
 * Enforce the total-changed-chars ratio budget over ALREADY-RESOLVED outcomes,
 * greedily in edit order. Exists because `enforceEditBounds` only caps COUNT and
 * per-edit size: without this, propose could hand back a preview whose accept-all
 * was a guaranteed 400 at apply. Edits that would push the running total over
 * `maxChangedChars(bodyLen)` are flipped to dropped with an honest reason, so the
 * surviving set always applies within budget.
 *
 * Mutates the passed outcomes in place (they are the caller's fresh
 * {@link applyEdits} result) and returns the dropped entries plus the surviving
 * total.
 */
export function enforceChangeBudget(
  outcomes: EditOutcome[],
  bodyLen: number,
): { dropped: DroppedEdit[]; changedChars: number } {
  const max = maxChangedChars(bodyLen);
  const dropped: DroppedEdit[] = [];
  let running = 0;
  for (const o of outcomes) {
    if (!o.applied) continue;
    const cost = outcomeChangedChars(o);
    if (running + cost > max) {
      o.applied = false;
      o.reason = `over the page's ${max}-char change budget`;
      delete o.start;
      delete o.end;
      delete o.tier;
      delete o.resolvedText;
      delete o.beforeCtx;
      delete o.afterCtx;
      dropped.push({ edit: o.edit, reason: o.reason });
      continue;
    }
    running += cost;
  }
  return { dropped, changedChars: running };
}

/** The ceiling on {@link changedChars} for one apply: a quarter of the body, with
 *  an absolute floor so a single legitimate hedge on a short stub page is never
 *  ratio-rejected. */
export function maxChangedChars(bodyLen: number): number {
  return Math.max(Math.floor(0.25 * bodyLen), INTEGRATE_MAX_EDIT_CHARS);
}

// ── Resolution + application ─────────────────────────────────────────────────

/** How an edit's anchor was located. `collapsed` is the sanctioned tier-2 rescue
 *  (whitespace-collapsed match mapped back to raw offsets). */
export type ResolveTier = "exact" | "collapsed";

/** Per-edit outcome of {@link applyEdits}. Applied edits carry their resolved
 *  ORIGINAL-body range + a preview context window; dropped ones carry a reason. */
export interface EditOutcome {
  edit: IntegrateEdit;
  applied: boolean;
  reason?: string;
  start?: number;
  end?: number;
  tier?: ResolveTier;
  /** The RAW body slice `[start, end)` that will actually be replaced. On a
   *  tier-2 rescue this can differ from `edit.old` (whitespace), so the preview
   *  must show THIS, not the model's quote. */
  resolvedText?: string;
  beforeCtx?: string;
  afterCtx?: string;
  /** The `"mark"`-mode rescue grew this range over an emphasis delimiter run it
   *  cut ({@link growOverEmphasisRuns}) — carried so `markReason` can NAME the
   *  adjustment, the way it names a link expansion or a one-line trim. */
  grownOverEmphasis?: boolean;
}

export interface ApplyEditsResult {
  /** The spliced body. Byte-identical to the input when nothing applied. */
  body: string;
  outcomes: EditOutcome[];
  appliedCount: number;
}

/** All start offsets of `needle` in `haystack` (overlapping starts included). */
function allIndexes(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return hits;
    hits.push(i);
    from = i + 1;
  }
}

/** Tier-1 exact, then tier-2 whitespace-collapsed. Returns null when the anchor
 *  is absent or ambiguous at BOTH tiers (0 or ≥2 matches). */
function resolveRange(
  masked: string,
  old: string,
): { start: number; end: number; tier: ResolveTier } | { error: string } {
  const exact = allIndexes(masked, old);
  if (exact.length === 1) return { start: exact[0]!, end: exact[0]! + old.length, tier: "exact" };
  if (exact.length > 1) return { error: `matched ${exact.length} places in the page (ambiguous)` };

  // Tier 2 — collapse both sides and map the hit back to raw offsets. The zone
  // sentinel is neither whitespace nor markup, so it survives the collapse and a
  // match still cannot span a masked region.
  const { collapsed, map } = collapseWithMap(masked);
  const needle = collapseWithMap(old).collapsed.trim();
  if (!needle) return { error: "no text to match after whitespace collapse" };
  const hits = allIndexes(collapsed, needle);
  if (hits.length !== 1) {
    return {
      error:
        hits.length === 0
          ? "no longer found in the page"
          : `matched ${hits.length} places in the page (ambiguous)`,
    };
  }
  const idx = hits[0]!;
  const start = map[idx];
  if (start === undefined) return { error: "no longer found in the page" };
  const end = (map[idx + needle.length - 1] ?? start) + 1;
  return { start, end, tier: "collapsed" };
}

/**
 * What a tier-2 rescue's resolved range is about to be USED for, which decides how
 * much of `collapsedRescueRisk` binds.
 *
 * `"splice"` — the range is REPLACED by `new`. Everything the collapse threw away
 * matters: a range that starts after an opening `**` and consumes the closing one
 * leaves `**NEW`, and a half-eaten link re-pairs the replacement with another
 * link's URL. This is the original (and still default) behaviour.
 *
 * `"mark"` — the range is only WRAPPED (`X` → `<Fact …>X</Fact>`); the inner text
 * survives byte-for-byte, and `renderInline` leaves a wrapper's body in the stream
 * for the bold/link passes, so `<Fact …>**Bold** rest</Fact>` renders exactly as
 * `**Bold** rest` did. That equivalence holds for a BALANCED span and only for one
 * — and not even then when the wrapper changes INTRAWORD adjacency, which is what
 * decides emphasis (`beta*beta*` marked from `beta` onwards renders as `beta<em>`;
 * pre-existing, and the reason this is a bounded relaxation rather than a licence)
 * — it is not a licence to wrap any range at all, which is why the relaxation is
 * paired with {@link growOverEmphasisRuns}' odd-count precondition and with
 * {@link finalSpanCutReason}, and why the run-parity test below replaces the count
 * rule rather than removing it. The count-equality rule therefore has nothing left to
 * protect on the emphasis family and refuses the single most common legitimate
 * anchor there is: the claim extractor returns the READING text of a sentence
 * (`Norepinephrine acts as…`) while the body carries the SOURCE text
 * (`**Norepinephrine** acts as…`), a BALANCED superset. Measured on
 * `life/sources/Neurochemical Focus Stack…mdx` (2026-08-31): 8 quotes in, 1 mark
 * out, and two of the seven drops were exactly this.
 *
 * What `"mark"` keeps, because wrapping does not make them safe:
 *  - the paragraph-break ban (a mapped range can be arbitrarily larger than `old`),
 *  - the {@link offsetInsideMarkup} EDGE test, which binds for BOTH families and is
 *    doing real work here: growth is gated on an ODD run count, so a range that cuts
 *    nothing is never grown and its edge is still sitting against a delimiter. That
 *    is what refuses the neighbour-steal shape below, and the drop reason it produces
 *    is asserted in `integrate-mark-growth.test.ts`,
 *  - strict count-equality on the BRACKET family (`[`, `]`, `(`, `)`): wrapping
 *    half of a `[label](url)` still puts the tag inside link markup,
 *  - and, for the emphasis family, a RUN-PARITY test in place of count-equality —
 *    `**Bold** rest` has two `*` runs (balanced, allowed) while `Bold** rest` has
 *    one (cut, refused). Parity over RUNS, not over characters: `Bold** rest`
 *    carries an even CHARACTER count and would sail through a naive parity check.
 */
export type RescueMode = "splice" | "mark";

/**
 * The drop reasons of one propose run, collapsed to `N× <reason>` phrases ordered
 * most-frequent-first — the one line that turns `dropped=7` into a diagnosis.
 *
 * The route logged counts only, so a run that dropped every anchor for ONE
 * structural reason (all four table rows; every quote landing in a fenced mermaid
 * block) was indistinguishable in the log from seven unrelated misses, and the
 * reasons — which the response has carried all along — could only be read by
 * expanding a `<details>` in the preview panel nobody had a reason to open.
 *
 * Reasons are the engine's own bounded phrases, so they are tallied verbatim
 * rather than normalized; ties keep first-seen order (`Map` insertion order).
 */
export function dropReasonTally(dropped: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const d of dropped) {
    const reason = d.reason || "dropped";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n}× ${reason}`)
    .join("; ");
}

/** Markup delimiters whose balance a whitespace-rescued range must preserve. */
const RESCUE_DELIMS = ["*", "`", "_", "[", "]", "(", ")"] as const;

/** The EMPHASIS/code family — the ones a `"mark"`-mode rescue checks by run parity
 *  rather than by count equality, because a WRAPPER preserves a balanced one.
 *
 *  Listed EXPLICITLY, and the bracket family derived from it rather than the other
 *  way round, so the default for a delimiter added to {@link RESCUE_DELIMS} is the
 *  STRICT path. Deriving this one by subtraction reads tidier and fails OPEN: a `~`
 *  added for `~~strike~~` would silently join the lenient family with no compile
 *  error. `RESCUE_DELIM_FAMILIES_COVER_ALL` pins that every delimiter has a family. */
const EMPHASIS_DELIMS: readonly string[] = ["*", "`", "_"];

const EMPHASIS_DELIM_SET = new Set<string>(EMPHASIS_DELIMS);

/** The LINK/bracket family — count equality binds in BOTH rescue modes, because
 *  wrapping half a `[label](url)` puts the tag inside link markup just as splicing
 *  it does. DERIVED, so a new delimiter lands here until someone classifies it. */
const BRACKET_DELIMS: readonly string[] = RESCUE_DELIMS.filter(
  (d) => !EMPHASIS_DELIM_SET.has(d),
);

/** Exported for the test that pins the two families against {@link RESCUE_DELIMS}:
 *  every delimiter belongs to exactly one, and the emphasis list is the explicit
 *  half. A `~` added upstream must show up in `BRACKET_DELIMS` (strict), never
 *  silently in the parity path. */
export const RESCUE_DELIM_FAMILIES = {
  all: RESCUE_DELIMS as readonly string[],
  emphasis: EMPHASIS_DELIMS,
  bracket: BRACKET_DELIMS,
};

/** Runs (maximal consecutive stretches) of `ch` in `s`. A `**` pair is ONE run, so
 *  `**Bold** rest` answers 2 and `Bold** rest` answers 1 — the distinction
 *  character counts cannot make (both are even). */
function countRuns(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch && s[i - 1] !== ch) n++;
  }
  return n;
}

/**
 * Grow a `"mark"`-mode range outward to COMPLETE an emphasis construct the range
 * already cuts — never to acquire one it does not.
 *
 * `collapseWithMap` strips `*`/`_`/backtick, so the plain-text quote
 * `Norepinephrine acts as…` maps back to a range that starts AFTER the opening
 * `**` and consumes the closing one. That slice carries an ODD number of `**`
 * runs: it provably cuts a construct, and taking the rest of that construct is the
 * honest repair — the wrapper preserves the inner text, and
 * `<Fact …>**Bold** rest</Fact>` renders exactly as the source did.
 *
 * **The odd-count precondition is the safety property, not an optimisation.** An
 * earlier spelling grew both edges unconditionally and two review passes
 * reproduced the corruption in rendered HTML:
 *  - `See **Alpha**|the middle words|**Beta** ok.` — the range cuts NOTHING (zero
 *    runs), and growing anyway steals `Alpha`'s closer and `Beta`'s opener. That
 *    is TWO runs, so a parity test waves it through, and `offsetInsideMarkup` sees
 *    ordinary letters because it runs on the GROWN edges. Render: crossed tags,
 *    `<strong>Alpha<span…></strong>the middle words<strong></span>Beta</strong>`.
 *  - `**Norepinephrine acts here\nand there**` — same zero-run shape across a line
 *    break; growing produced a balanced span that `factSpanForm` then trimmed back
 *    to one unbalanced line (see `finalSpanCutReason`, which is the second half of
 *    this guard and catches that one).
 * With the precondition both are refused exactly as they were before this feature,
 * which is what the pre-change `offsetInsideMarkup` edge test was already doing.
 *
 * An earlier docblock claimed the precondition was merely redundant for safety —
 * "growth adds exactly one run, so an even slice always turns odd". **That proof is
 * false** and the claim is withdrawn: the added run MERGES with one already at the
 * slice edge whenever `slice[0] === d` and the outside character is also `d`, so an
 * even slice can stay even. The precondition is load-bearing, not decoration; it is
 * pinned by the neighbour-steal fixture and by asserting the exact drop reason it
 * produces (the range cut nothing, so the truth is "starts or ends inside markdown
 * formatting", not "cuts through").
 *
 * Per DELIMITER CHARACTER, and only over a contiguous run of that same character:
 * an odd `*` count is completed with `*`, never with a neighbouring backtick. The
 * side is chosen by which one actually carries that delimiter (left first — a cut
 * construct's missing half is its opener whenever the quote ran past its closer,
 * which is the common case).
 *
 * ONE side, not both — and that is a readability choice, not a safety property; the
 * distinction is stated rather than pinned because the mutant is equivalent, and the
 * state space is small enough to enumerate. The two spellings differ only when BOTH
 * edges carry `d` while the count is odd. One side then leaves the other edge
 * sitting against `d` with the span's own edge character not being `d`, which
 * {@link offsetInsideMarkup} refuses; both sides add two runs to an odd count, which
 * is still odd, which the parity test refuses. Measured for all three emphasis
 * delimiters: the edit drops either way.
 *
 * The parity + edge tests still run on the GROWN range, so a growth that lands
 * somewhere unbalanced anyway is refused — growing is an attempt, not a waiver.
 *
 * The {@link ZONE_SENTINEL} test is DEFENSIVE and cold on today's zone set —
 * stated rather than pinned, and stated correctly this time (two reviewers caught
 * an earlier, wrong derivation). It is NOT that no zone begins or ends on one of
 * these three characters: `findExclusionZones` ends a fenced zone at
 * `offset + line.length`, i.e. ON the closing fence's last backtick, and begins one
 * on the opening fence's first backtick. What keeps it cold is that a fence is
 * LINE-ANCHORED — `findExclusionZones` starts a fence zone at the line offset (an
 * indented fence's zone therefore begins on the indentation, not on a backtick) and
 * ends it at `offset + line.length` — so the character between a fence zone and any
 * prose is always the `\n` this loop stops at. The guard is kept because that is a property of the
 * zone builder, not of this function.
 */
function growOverEmphasisRuns(
  body: string,
  masked: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s0 = start;
  let e0 = end;
  for (const d of EMPHASIS_DELIMS) {
    if (countRuns(body.slice(s0, e0), d) % 2 === 0) continue; // cuts nothing of `d`
    if (body[s0 - 1] === d) {
      while (s0 > 0 && body[s0 - 1] === d && masked[s0 - 1] !== ZONE_SENTINEL) s0--;
    } else if (body[e0] === d) {
      while (e0 < body.length && body[e0] === d && masked[e0] !== ZONE_SENTINEL) e0++;
    }
  }
  return { start: s0, end: e0 };
}

const RESCUE_DELIM_SET = new Set<string>(RESCUE_DELIMS);

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * True when a resolved range's EDGE sits offset inside markup: the body char just
 * outside the range is a rescue-stripped delimiter that `old`'s corresponding edge
 * char is not. Splicing there would leave the neighbour delimiter orphaned (or,
 * worse, re-pair it with a DIFFERENT construct's delimiter).
 */
function offsetInsideMarkup(neighbour: string, edge: string | undefined): boolean {
  return neighbour !== "" && RESCUE_DELIM_SET.has(neighbour) && neighbour !== edge;
}

/**
 * Safety gate on a TIER-2 (whitespace-collapsed) rescue: the reason to reject the
 * mapped-back range, or null when it is safe to splice.
 *
 * `collapseWithMap` does more than collapse whitespace — it STRIPS `*`, `_` and
 * backtick and rewrites `[label](url)` to `label`. So `map[hit]` can land after an
 * opening `**` while the range still consumes the closing one, and a link's
 * `](url)` can sit inside the range while `old` has no trace of it. Splicing then
 * produces orphaned bold (`**NEW`), a half-eaten link (`See [NEW here.`) or an
 * unbalanced code span. The collapse of the raw slice equals the needle BY
 * CONSTRUCTION, so the only thing worth comparing is what the collapse threw
 * away: delimiter counts, plus a hard ban on a range that spans a paragraph break
 * (the mapped range can be arbitrarily larger than `old`).
 *
 * The count comparison alone is NOT sufficient: it is invariant under a
 * ONE-DELIMITER SHIFT. On `Anthropic shipped [Claude 3](https://a.co/n) before
 * [GPT-4o](https://o.ai/g) launched.` an `old` of `[Claude 3](https://a.co/n)
 * before GPT-4o` maps back to the raw slice `Claude 3](https://a.co/n) before
 * [GPT-4o` — same `[`/`]`/`(`/`)` counts as `old`, yet splicing it re-pairs the
 * replacement with the OTHER link's URL (a wrong-URL citation). Same class for
 * `` `foo` and bar ``, `*fast* and slow`, `_alpha_ and beta`. So each EDGE of the
 * range is additionally boundary-tested against the body char just outside it
 * ({@link offsetInsideMarkup}); callers that can supply those chars must.
 *
 * Deliberately conservative — a false drop is honest and shows the user a reason;
 * a false apply corrupts the page.
 *
 * @param before body char immediately BEFORE the resolved range ("" at offset 0)
 * @param after  body char immediately AFTER the resolved range ("" at end of body)
 */
export function collapsedRescueRisk(
  rawSlice: string,
  old: string,
  before = "",
  after = "",
  mode: RescueMode = "splice",
): string | null {
  // `\r\n\r\n` is a paragraph break too — a bare `\n\n` test misses CRLF pages.
  if (/\n[ \t\r]*\n/.test(rawSlice)) {
    return "whitespace-rescued match would span a paragraph break in the page";
  }
  for (const d of RESCUE_DELIMS) {
    // In `"mark"` mode the emphasis family is checked by run PARITY instead: the
    // wrapper preserves the inner text, so a balanced superset is safe and only a
    // CUT construct is not. The bracket family keeps count-equality in both modes.
    if (mode === "mark" && EMPHASIS_DELIM_SET.has(d)) {
      if (countRuns(rawSlice, d) % 2 !== countRuns(old, d) % 2) {
        return "whitespace-rescued match would cut through markdown formatting";
      }
      continue;
    }
    if (countChar(rawSlice, d) !== countChar(old, d)) {
      return "whitespace-rescued match would cut through markdown formatting";
    }
  }
  if (offsetInsideMarkup(before, old[0]) || offsetInsideMarkup(after, old[old.length - 1])) {
    return "whitespace-rescued match would start or end inside markdown formatting";
  }
  return null;
}

/**
 * Resolve every edit against the ORIGINAL match-masked body, reject overlaps
 * (earlier wins), and splice the survivors into the original body descending by
 * start offset. See the module doc for why there is no per-edit re-validation
 * during application. Pure — the caller owns the write.
 */
export function applyEdits(
  body: string,
  edits: IntegrateEdit[],
  isMdx = false,
  mode: RescueMode = "splice",
): ApplyEditsResult {
  const masked = matchMaskBody(body, isMdx);
  const outcomes: EditOutcome[] = edits.map((edit) => {
    const r = resolveRange(masked, edit.old);
    if ("error" in r) return { edit, applied: false, reason: r.error };
    // Defensive: an anchor can only resolve outside the zones by construction
    // (a sentinel run never matches page text) — assert it rather than trust it.
    if (masked.slice(r.start, r.end).includes(ZONE_SENTINEL)) {
      return { edit, applied: false, reason: "resolves into an excluded region of the page" };
    }
    // A tier-2 rescue's raw span can cut through markup the collapse stripped. In
    // `"splice"` mode that is a rejection; in `"mark"` mode the range is first
    // grown over the delimiter runs its edges sit inside, and only what survives
    // THAT is rejected (see `growOverEmphasisRuns` / `collapsedRescueRisk`).
    let start = r.start;
    let end = r.end;
    let grownOverEmphasis = false;
    if (r.tier === "collapsed" && mode === "mark") {
      const grown = growOverEmphasisRuns(body, masked, start, end);
      grownOverEmphasis = grown.start !== start || grown.end !== end;
      start = grown.start;
      end = grown.end;
    }
    const resolvedText = body.slice(start, end);
    if (r.tier === "collapsed") {
      const risk = collapsedRescueRisk(
        resolvedText,
        edit.old,
        start > 0 ? body[start - 1]! : "",
        end < body.length ? body[end]! : "",
        mode,
      );
      if (risk) return { edit, applied: false, reason: risk };
    }
    return {
      edit,
      applied: true,
      start,
      end,
      tier: r.tier,
      resolvedText,
      ...(grownOverEmphasis ? { grownOverEmphasis: true } : {}),
      beforeCtx: contextBefore(body, masked, start),
      afterCtx: contextAfter(body, masked, end),
    };
  });

  // Overlap rejection in BODY order — the earlier range wins, later ones drop.
  const ordered = outcomes
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.applied)
    .sort((a, b) => a.o.start! - b.o.start! || a.i - b.i);
  let claimedTo = -1;
  for (const { o } of ordered) {
    if (o.start! < claimedTo) {
      o.applied = false;
      o.reason = "overlaps an earlier edit";
      delete o.start;
      delete o.end;
      delete o.tier;
      delete o.resolvedText;
      delete o.beforeCtx;
      delete o.afterCtx;
      continue;
    }
    claimedTo = o.end!;
  }

  // Splice DESCENDING so no applied splice shifts a not-yet-applied range.
  const survivors = outcomes.filter((o) => o.applied).sort((a, b) => b.start! - a.start!);
  let out = body;
  for (const o of survivors) {
    out = out.slice(0, o.start!) + o.edit.new + out.slice(o.end!);
  }
  return { body: out, outcomes, appliedCount: survivors.length };
}

// ── Inline `<Fact>` annotation pass ──────────────────────────────────────────

/** True when `[start, end)` is EXACTLY one complete blank-line-delimited BLOCK
 *  GROUP of `body` — the only shape the legal BLOCK wrapper form may take. Usually
 *  a prose paragraph, but a list or a table with no blank line inside it qualifies
 *  too: what is tested is "no blank line within, blank line (or edge) on both
 *  sides", not that the content is one paragraph of prose. */
function isWholeParagraph(body: string, start: number, end: number): boolean {
  const slice = body.slice(start, end);
  if (slice !== slice.trim()) return false;
  if (/\n[ \t\r]*\n/.test(slice)) return false; // more than one paragraph
  const prefix = body.slice(0, start);
  const suffix = body.slice(end);
  const beforeOk = /^\s*$/.test(prefix) || /(?:\r?\n)[ \t]*(?:\r?\n)[ \t]*$/.test(prefix);
  const afterOk = /^\s*$/.test(suffix) || /^[ \t]*(?:\r?\n)[ \t]*(?:\r?\n)/.test(suffix);
  return beforeOk && afterOk;
}

/** The longest newline-free sub-range of `[start, end)`, or null when every run in
 *  it is blank. The pragmatic reading of "the sub-range containing the quote's
 *  core": a partial-paragraph span's core is its bulk, which is its longest line. */
function longestLineRange(
  body: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let runStart = start;
  for (let i = start; i <= end; i++) {
    if (i === end || body[i] === "\n") {
      // Trim the run's own edge whitespace — a mark must not start or end on a
      // space — and skip a leading BLOCK MARKER (list bullet, ordered number,
      // blockquote, heading hashes). A mark that swallows the `- ` turns the line
      // into one owned by a component tag, which the block parser then renders as a
      // verdict rail instead of an underline and demotes the list item to prose.
      let s = runStart;
      let e = i;
      while (s < e && /\s/.test(body[s]!)) s++;
      const marker = /^(?:[-*+]|\d+[.)]|>+|#{1,6})[ \t]+/.exec(body.slice(s, e));
      if (marker) s += marker[0].length;
      while (e > s && /\s/.test(body[e - 1]!)) e--;
      if (e > s && (!best || e - s > best.end - best.start)) best = { start: s, end: e };
      runStart = i + 1;
    }
  }
  return best;
}

/** A leading BLOCK MARKER: list bullet, ordered number, blockquote, heading. */
const LEADING_BLOCK_MARKER_RE = /^(?:[-*+]|\d+[.)]|>+|#{1,6})[ \t]+/;

/** This module's own `g` instance over the shared {@link WIKILINK_SPAN_SOURCE} — a
 *  shared `g` RegExp carries `lastIndex` between callers in different modules. */
const WIKILINK_SPAN_RE = new RegExp(WIKILINK_SPAN_SOURCE, "g");

/** The line-aligned window `[start, end)` sits in. A wikilink is newline-free by
 *  construction, so a link intersecting the span lies wholly inside these lines —
 *  which is why the scan is scoped here instead of running over the whole body. */
function lineWindowAround(body: string, start: number, end: number): { from: number; to: number } {
  const prevNl = start === 0 ? -1 : body.lastIndexOf("\n", start - 1);
  const nextNl = body.indexOf("\n", end);
  return { from: prevNl + 1, to: nextNl === -1 ? body.length : nextNl };
}

/**
 * Every real `[[wikilink]]` in the line window `[from, to)`, as body offsets.
 *
 * The scan runs over the RAW line, and inline code spans are deliberately NOT
 * excluded. `renderWikiHtml` substitutes wikilinks over the raw body BEFORE
 * `formatWebHtml` ever sees a backtick, so a backticked `` `[[Old Name]]` ``
 * renders as `<code><a class="wiki-link">…</a></code>` — a LIVE link (measured
 * 2026-08-30 through the shipped renderer). Masking those spans here made this
 * scanner disagree with the renderer in the one direction that produces damage:
 * the annotator spliced `` `[[<Fact …>Old Name</Fact>]]` `` — the forbidden shape,
 * rendering as a dead `wiki-link-missing` — while the backstop and the lint were
 * blinded by the same mask. Whatever the renderer resolves IS a link here:
 * expansion wraps it, and a correction crossing it is dropped as link-crossing.
 * Fenced blocks need no handling: a fence is already an exclusion zone, so no
 * edit can resolve into one, and frontmatter likewise.
 *
 * ONE thing is still excluded, and it was a live defect:
 *
 *  - **A candidate spanning a DANGLING `[[`.** The target class admits `[` (as every
 *    sibling copy does), so on `A [[ b [[ c [[Real Page]]` the regex pairs the FIRST
 *    opener with the only `]]` and yields a 20-char "link" — expanding a mark over
 *    which marks prose nobody checked, and inside a table row runs the mark across a
 *    `|` cell separator. That is exactly the shape `firstDanglingWikilinkOpen`
 *    (`src/wiki/store.ts`) calls dangling; the candidate is rejected and the scan
 *    RESUMES two chars in, so the genuine inner link is still found (skipping the
 *    match wholesale would consume it).
 *
 * NB the dangling test starts at index 2 for a reason and has one known gap: on
 * `[[[Tidal Router]]` the extra opener is at index 2 of the match, so `includes("[[", 2)`
 * sees `[T` and passes it. That is CORRECT rather than a miss — `renderWikiHtml` runs
 * the same regex from the same start and replaces the same 17 characters, so the mark
 * and the link the reader sees cover exactly the same range (measured; probe in the
 * `[[[` case of `integrate-wikilink.test.ts`). The identity holds for exactly ONE
 * extra opener: at `[[[[` and beyond the rescan lands on an inner span the renderer
 * does not use, so writer and reader diverge and the spliced mark can nest — measured,
 * 0 occurrences of `[[[[` across both live corpora (2026-08-30), accepted as a
 * pathological-input gap rather than guarded.
 */
function wikilinkSpansIn(body: string, from: number, to: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let lineStart = from;
  for (const line of body.slice(from, to).split("\n")) {
    WIKILINK_SPAN_RE.lastIndex = 0;
    for (let m = WIKILINK_SPAN_RE.exec(line); m; m = WIKILINK_SPAN_RE.exec(line)) {
      if (m[0].includes("[[", 2)) {
        WIKILINK_SPAN_RE.lastIndex = m.index + 2; // dangling opener — re-scan inside it
        continue;
      }
      spans.push({ start: lineStart + m.index, end: lineStart + m.index + m[0].length });
    }
    lineStart += line.length + 1;
  }
  return spans;
}

/**
 * The smallest range covering `[start, end)` PLUS every wikilink it intersects, or
 * `null` when it already covers each of them whole (i.e. nothing to expand).
 *
 * A span that starts inside a link, ends inside one, or sits WHOLLY inside one is
 * cutting a link in half — wrapping it where it sits makes the mark's tags the link
 * TARGET (`[[<Fact …>Some Page</Fact>]]`, shipped 2026-08-10). This range is the
 * inverse nesting the fix wraps instead. The whole rule and its measurements live in
 * `src/web/CLAUDE.md`.
 *
 * Intersection is judged against the ORIGINAL span, so one pass suffices: the
 * expanded edges land ON link boundaries, and a link merely TOUCHING an edge does
 * not intersect (`[[A]][[B]]` with the span inside A expands to `[[A]]` alone).
 *
 * A `null` answer is also the CORRECTION path's predicate — see the call in
 * {@link annotateEdits}' pass 1. Expansion is not expressible there (the wrapper
 * covers `edit.new`, which is not in the page), so a crossing correction is refused
 * instead of stretched.
 */
function expandOverWikilinks(
  body: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let s = start;
  let e = end;
  const window = lineWindowAround(body, start, end);
  for (const link of wikilinkSpansIn(body, window.from, window.to)) {
    if (link.start >= end || link.end <= start) continue;
    if (link.start < s) s = link.start;
    if (link.end > e) e = link.end;
  }
  return s === start && e === end ? null : { start: s, end: e };
}

/** True when only whitespace precedes `pos` on its line — i.e. a wrapper spliced
 *  at `pos` would put its opening tag at the START of the line. `COMPONENT_OPEN_RE`
 *  matches the TRIMMED line, so such a tag makes the block parser claim the whole
 *  line as a component. */
function ownsLineStart(body: string, pos: number): boolean {
  let i = pos - 1;
  while (i >= 0 && (body[i] === " " || body[i] === "\t")) i--;
  return i < 0 || body[i] === "\n";
}

/**
 * Guard for a newline-free candidate mark: a wrapper whose opening tag would own
 * the start of a line is parsed as a BLOCK component, which destroys any block
 * structure that line's leading marker carried.
 *
 * Two outcomes, matching what the tier-3 trim already does for the same reason:
 *  - a LIST / QUOTE / HEADING marker is left OUTSIDE the mark (the span shrinks);
 *  - a TABLE row (or delimiter row) is REFUSED — there is no sub-range to shrink to
 *    that keeps the row a row, and wrapping one empirically destroys the whole
 *    table, not just that line.
 * A span that does not start its own line is inline by construction and untouched.
 *
 * There is deliberately NO third outcome for a span EXPANDED leftwards over a `[[`
 * at column 0, and the reason is a render measurement rather than a reading of the
 * parser. Such a span is returned as an ordinary success — the same answer the
 * paragraph-initial mark gets (89 inline marks live on the jarvis wiki, 15 of them
 * at column 0; an old-vs-new run of the shipped pass over every one of them diffs to
 * zero). Driven through the real `renderWikiHtml`/`web-format` pipeline, BOTH shapes
 * the expansion can produce render correctly: `<Fact …>[[Some Page]]</Fact> rest.`
 * comes out as an `fc-mark` span with a LIVE `<a class="wiki-link">` inside it, and
 * one owning its whole line comes out as the block form's `fc-mark-block` div with
 * the same live link — which is the sanctioned second spelling (`src/web/CLAUDE.md`:
 * both forms must look marked). The refusal that shipped here cost the mark on the
 * PRIMARY defect shape (`[[Some Page]] is a good resource.`), on every tier-3
 * multi-line quote (those ranges start at column 0 by construction) and on any span
 * merely expanded RIGHTWARDS, and it reported all of them as a wikilink "opening its
 * own line". Emitting the BLOCK form instead is NOT the alternative it looks like:
 * measured through the same renderer, `<Fact …>\n[[Some Page]]\n</Fact> rest.` puts
 * prose after the closing tag line and renders the tags as escaped literal text.
 */
function markableRange(
  body: string,
  start: number,
  end: number,
): { start: number; end: number; trimmedMarker?: boolean } | { error: string } {
  if (!ownsLineStart(body, start)) return { start, end };
  let s = start;
  while (s < end && (body[s] === " " || body[s] === "\t")) s++;
  if (body[s] === "|") {
    return { error: "the checked passage is a table row — marking it would break the table" };
  }
  const marker = LEADING_BLOCK_MARKER_RE.exec(body.slice(s, end));
  if (!marker) return { start: s, end };
  const after = s + marker[0].length;
  if (after >= end) {
    return { error: "the checked passage is only a list or quote marker — nothing to mark" };
  }
  return { start: after, end, trimmedMarker: true };
}

/**
 * Which wrapper FORM (and over which sub-range) a resolved span may legally take.
 *
 * The inline component matcher is LINE-SCOPED, so an inline `<Fact>` wrapper
 * spliced around a span containing a newline renders as literal escaped tags in
 * the reader — a visible corruption, not a missing feature. Four tiers:
 *
 *  1. newline-free span ⇒ the INLINE form over the span as-is (past the
 *     {@link markableRange} block-marker guard).
 *  2. the span is exactly ONE whole block group ⇒ the BLOCK form (open tag and
 *     close tag each on their own line). One group maximum: the block parser closes
 *     a component at its matching tag, but a wrapper spanning a blank line would
 *     swallow whatever block structure sits between the two paragraphs.
 *  3. a partial-paragraph multi-line span ⇒ TRIM to the largest newline-free
 *     sub-range (an honestly truncated mark beats no mark and beats a broken one),
 *     then through the same guard.
 *  4. nothing left after trimming, or a span that cannot be marked without breaking
 *     a table ⇒ refuse, with a reason the reviewer sees.
 *
 * On the two INLINE tiers the span is first widened over any `[[wikilink]]` it cuts
 * in half ({@link expandOverWikilinks}) and the guard then runs on the EXPANDED
 * range — that order is the point: `ownsLineStart` is evaluated on the span's start,
 * and expanding leftwards over a `[[` at column 0 is exactly what flips it. Tier 2
 * needs no expansion by construction: a whole block group starts and ends on blank
 * lines, and a wikilink is newline-free, so it can never straddle either edge.
 */
function factSpanForm(
  body: string,
  start: number,
  end: number,
): FactSpan | { error: string } {
  if (!body.slice(start, end).includes("\n")) {
    return withForm(expandAndGuard(body, { start, end }));
  }
  if (isWholeParagraph(body, start, end)) return { form: "block", start, end };
  const trimmed = longestLineRange(body, start, end);
  if (!trimmed) {
    return { error: "the checked passage spans several lines with no markable text on any of them" };
  }
  // `longestLineRange` already skips a leading list/quote marker; the guard adds the
  // table refusal (its longest line can be a table row). Expansion stays on the
  // trimmed line — a wikilink is newline-free.
  const guarded = expandAndGuard(body, trimmed);
  if ("error" in guarded) return guarded;
  return { form: "inline", ...guarded, truncated: true };
}

interface FactSpan {
  form: "inline" | "block";
  start: number;
  end: number;
  truncated?: boolean;
  trimmedMarker?: boolean;
  expandedOverLink?: boolean;
  /** The tier-2 rescue grew this range over an emphasis delimiter run it cut
   *  ({@link growOverEmphasisRuns}) — an adjustment `markReason` must name. */
  grownOverEmphasis?: boolean;
}

/** Expand over any wikilink the range cuts, then guard the EXPANDED range — the
 *  order is the point (`ownsLineStart` is evaluated on the span's start, and
 *  expanding leftwards over a `[[` at column 0 is what flips it). Written out at
 *  both inline tiers before; one spelling now, because the two copies are exactly
 *  what a fix to either half would have to remember to apply twice. */
function expandAndGuard(
  body: string,
  range: { start: number; end: number },
): { start: number; end: number; trimmedMarker?: boolean; expandedOverLink?: boolean } | { error: string } {
  const expanded = expandOverWikilinks(body, range.start, range.end);
  const guarded = markableRange(body, (expanded ?? range).start, (expanded ?? range).end);
  if ("error" in guarded) return guarded;
  return { ...guarded, ...(expanded ? { expandedOverLink: true } : {}) };
}

function withForm(
  guarded: ReturnType<typeof expandAndGuard>,
): FactSpan | { error: string } {
  return "error" in guarded ? guarded : { form: "inline", ...guarded };
}

/**
 * What the preview tells the reviewer about a mark whose range is not the quote's.
 *
 * EVERY adjustment is named, not the first one that matched: a 4-deep ternary
 * reported a tier-3 truncation and stayed silent about the same mark having grown
 * over a `[[wikilink]]` — which is the one adjustment that changes what text the
 * mark covers.
 */
/**
 * Whether the span `factSpanForm` settled on may be WRAPPED — decided by ASKING THE
 * RENDERER, not by a delimiter heuristic.
 *
 * The property a wrapper-only mark must have is exact and simple: **the page must
 * render the same with the mark as without it**, apart from the mark's own chrome.
 * That is what "the wrapper preserves the inner text" means operationally, and it is
 * cheap to check — `formatWebHtml` is pure, and the propose path has at most
 * `FACTCHECK_MAX_CLAIMS` candidates.
 *
 * It replaces three rounds of delimiter bookkeeping, and the history is the argument.
 * Round 1 asked "is the final span balanced in isolation" and refused `user_id`,
 * `2 * 3` and a glob. Round 2 asked "did the trim change parity" and lost the
 * corruption catches while refusing an `*` list bullet and a multi-line wikilink.
 * Round 3 enumerated neighbours and parity, and an independent sweep measured 394
 * marks lost against round 2 — 338 of them provably render-safe — because a WHOLLY
 * bolded sentence, the single most common wrapper anchor there is, sits between two
 * delimiters and is perfectly safe. That enumeration also had no rule at all for the
 * bracket family, so marking a `[label](url)`'s URL destroyed the link.
 *
 * Every one of those is decided correctly, and without a rule of its own, by
 * comparing two renders. A heuristic about delimiters is a model of the renderer;
 * the renderer is available, so the model is what keeps being wrong.
 *
 * THE ONE EXEMPTION is a span `expandOverWikilinks` widened to a whole `[[…]]`.
 * `formatWebHtml` shows the tags as escaped text inside a `<code>` there, so the
 * property refuses it — but `renderWikiHtml` substitutes wikilinks over the RAW body
 * before any code handling, so that link is LIVE and marking it whole is the
 * documented behaviour (`src/web/CLAUDE.md`, pinned by `integrate-wikilink.test.ts`).
 * Refusing it would trade durable damage — a mark that rewrites the link TARGET —
 * for a cosmetic one. It is the only case where the two renderers disagree about
 * what a mark costs, which is why it is the only exemption.
 */
function markSpanRefusal(
  body: string,
  span: FactSpan,
  verdict: FactVerdict,
  nl: string,
): string | null {
  if (span.expandedOverLink) return null;
  // The inline/block spelling comes from the shared `wrapperTextFor`, which IS
  // render-visible and is the one argument that has to match the emit site. The
  // verdict and the newline are passed through for honesty rather than necessity:
  // measured, an LF-joined and a CRLF-joined block wrapper render byte-identical
  // html, so `nl` is render-invariant here — an earlier comment claimed otherwise and
  // was wrong. The index is substituted outright; see below.
  const plain = formatWebHtml(body);
  // The guard's own mark is spliced under an index the PAGE provably does not use, so
  // `removeOneMark` cannot delete someone else's. `data-fact` is not unique: a page
  // that shows a `<Fact>` in prose renders a real mark with a real index, and if it
  // sits before the guarded span under the SAME number the removal took the page's
  // mark and left the guard's — two renders differ, and every claim carrying that
  // number was refused with a reason untrue of the passage. Measured on a real mimir
  // page: identical quotes marked at claim 1 and 3 and refused at claim 2, because
  // that page documents `<Fact n="2">`.
  //
  // Substituting the index is sound because it is RENDER-INVARIANT: it appears only
  // in `data-fact` and in the chip's title, both inside elements this comparison
  // removes. `verdict` is invariant for the same reason (`fc-mark-<v>` sits in the
  // removed opening tag) but is passed through honestly rather than substituted,
  // since nothing is gained by faking it.
  const sentinel = unusedFactIndex(plain);
  const mark = wrapperTextFor(body, span, sentinel, verdict, nl);
  const wrapped = body.slice(0, span.start) + mark + body.slice(span.end);
  return removeOneMark(formatWebHtml(wrapped), sentinel) === plain
    ? null
    : "marking this passage would change how the page renders";
}

/**
 * The highest `data-fact` index this html does not already use — the index
 * {@link markSpanRefusal} splices its own mark under, so that mark is the only one
 * carrying it.
 *
 * Searched DOWNWARD from {@link SENTINEL_FACT_BASE}, which is `factClaimIndex`'s
 * largest valid value. The range is the constraint that shapes this: an index
 * outside `0 < n < 1000` is not a claim index at all, so the renderer emits the mark
 * with NO `data-fact` attribute — measured, and it is why a first attempt at this
 * used 1_000_000 and refused every candidate on every page. Real indices are bounded
 * by `FACTCHECK_MAX_CLAIMS`, so the first probe is free in practice.
 *
 * Exhaustion (999 distinct rendered indices on one page) returns
 * `SENTINEL_FACT_BASE` and degrades to the collision this function exists to remove —
 * a false refusal, which is the safe direction, on a page no run can produce.
 */
function unusedFactIndex(html: string): number {
  const used = new Set<string>();
  for (const m of html.matchAll(/ data-fact="(\d+)"/g)) used.add(m[1]!);
  for (let n = SENTINEL_FACT_BASE; n > 0; n--) if (!used.has(String(n))) return n;
  return SENTINEL_FACT_BASE;
}

/** `factClaimIndex`'s largest valid value (`0 < n < 1000`). Anything above it renders
 *  with no `data-fact` at all, which would make the removal a no-op. */
const SENTINEL_FACT_BASE = 999;

/**
 * One rendered mark — the one THIS guard spliced, identified by its `data-fact` —
 * removed from the html, leaving everything else byte-for-byte.
 *
 * The removal is targeted rather than a sweep of `fc-` chrome, and that is the whole
 * point. A sweep has to run on the marked side only (the unmarked side has nothing to
 * sweep), which makes the comparison unequal for any page that renders chrome OF ITS
 * OWN — a `<CodeTabs>` block emits `<button class="code-tabs-tab">`, and a page
 * DOCUMENTING this feature keeps a `<Fact>` inside inline code that the zone-aware
 * `stripFactWrappers` preserves by design and `formatWebHtml` renders as a real mark.
 * Measured: 33 and 36 claims dropped on two real mimir pages, every one with a reason
 * untrue of the passage. Sweeping BOTH sides removes the page's own marks from each
 * render, which is a comparison that can no longer see a difference confined to them.
 * One verify pass reported two re-admitted corruptions from that; a later one could
 * not reproduce the number over 18 646 quotes on 1 574 real pages, so the NUMBER is
 * withdrawn and only the structural argument stands. The targeted removal is
 * preferred for being the narrower operation, not on the strength of that count.
 *
 * The closing tag is found by a BALANCED scan rather than a regex. That is currently
 * DEFENSIVE and is stated as such: an inline (`<span>`) wrapper cannot contain a
 * component-rendered span, because `renderInline` escapes nested component tags — a
 * `<Pill>` inside one comes out as `&lt;Pill&gt;`, which is a render change and is
 * refused on its own. A block (`<div>`) wrapper CAN nest divs — a `<Callout>` renders
 * several — so the block half of this argument is about REACHABILITY, not the render:
 * no quote resolves to a component's raw source (`"<Callout>…</Callout>"` answers "no
 * longer found in the page"), and a single line inside such a group takes the inline
 * form. So nothing reachable today nests the same tag inside a wrapper, and a
 * first-close-tag match would behave identically. The counting is kept because that argument is about the COMPONENT
 * SET, which grows, while the cost is four lines. The chip is a `<button>`, which
 * cannot nest, so a non-greedy match is sound there.
 */
function removeOneMark(html: string, claimIndex: number): string {
  const attr = ` data-fact="${claimIndex}"`;
  const withoutChip = html.replace(
    new RegExp(`<button[^>]*${escapeRegExp(attr)}[^>]*>[\\s\\S]*?</button>`),
    "",
  );
  const openRe = new RegExp(`<(span|div) class="fc-mark[^"]*"${escapeRegExp(attr)}>`);
  const open = openRe.exec(withoutChip);
  if (!open) return withoutChip;
  const tag = open[1]!;
  let depth = 1;
  let i = open.index + open[0].length;
  // `[^>]*>` is load-bearing: the match must CONSUME the tag's closing `>`, or the
  // splice below leaves a stray `>` in the html and every comparison fails.
  const scan = new RegExp(`</?${tag}\\b[^>]*>`, "g");
  scan.lastIndex = i;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(withoutChip)) !== null) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return (
        withoutChip.slice(0, open.index) +
        withoutChip.slice(open.index + open[0].length, m.index) +
        withoutChip.slice(m.index + m[0].length)
      );
    }
  }
  // Unbalanced — the wrapper did not close. That is itself a render difference, so
  // returning the html untouched makes the comparison fail, which is the right answer.
  return withoutChip;
}

/** The wrapper text for one span — the ONE place the inline/block spelling is
 *  chosen. `factWrapperForms` returns both because the wrapper-only PREDICATE has to
 *  recognize either; the writer has to pick, and the picker is here so the guard and
 *  the emit site cannot disagree about what is being written. */
function wrapperTextFor(
  body: string,
  span: FactSpan,
  claimIndex: number,
  verdict: FactVerdict,
  nl: string,
): string {
  const forms = factWrapperForms(claimIndex, verdict, body.slice(span.start, span.end), nl);
  return span.form === "block" ? forms[1] : forms[0];
}

function markReason(span: FactSpan): string {
  const notes: string[] = [];
  if (span.grownOverEmphasis) notes.push("expanded to cover the whole **formatting** span");
  if (span.expandedOverLink) notes.push("expanded to cover the whole [[wikilink]]");
  if (span.truncated) notes.push("trimmed to one line");
  if (span.trimmedMarker) notes.push("list or quote marker left outside the mark");
  return notes.length === 0
    ? "marks the checked passage"
    : `marks the checked passage (${notes.join("; ")})`;
}

/** The wrapper text for a CORRECTION: the mark goes around the replacement prose,
 *  which is not in the page yet, so the tier test runs on `edit.new` plus the shape
 *  of the span it replaces.
 *
 *  The block-marker guard applies here as a straight REFUSAL rather than a trim:
 *  the wrapper must cover the whole replacement (a marker left outside it would put
 *  prose before the `<Fact` tag, and `carriesFactWrapper` — the payload-shape gate
 *  that makes the appendix mandatory — would then not recognize the edit at all,
 *  shipping a chip with no `#fc-claim-N` target). A refused mark is never fatal:
 *  the correction applies unwrapped.
 *
 *  A correction CROSSING a wikilink never reaches this function — {@link annotateEdits}
 *  drops the whole edit one step earlier. Expansion is not expressible here (the
 *  wrapper covers `edit.new`, which is not in the page, while the caller keeps `old`
 *  unchanged), and "apply it unwrapped" is the one outcome that must not happen: it
 *  rewrites the link TARGET. */
function wrapCorrectionText(
  body: string,
  outcome: EditOutcome,
  claimIndex: number,
  verdict: FactVerdict,
  nl: string,
): { text: string } | { error: string } {
  const inner = outcome.edit.new;
  const forms = factWrapperForms(claimIndex, verdict, inner, nl);
  if (!inner.includes("\n")) {
    if (ownsLineStart(body, outcome.start!)) {
      const head = inner.replace(/^[ \t]*/, "");
      if (head.startsWith("|")) {
        return { error: "the corrected line is a table row — a mark there would break the table" };
      }
      if (LEADING_BLOCK_MARKER_RE.test(head)) {
        return { error: "the corrected line opens with a list or quote marker" };
      }
    }
    return { text: forms[0] };
  }
  if (
    !/\n[ \t\r]*\n/.test(inner) &&
    isWholeParagraph(body, outcome.start!, outcome.end!)
  ) {
    return { text: forms[1] };
  }
  return { error: "the replacement text spans more than one block" };
}

/** The newline the BODY uses — a CRLF page must get CRLF-joined block wrappers, or
 *  strip → re-annotate is not byte-stable and one LF line lands in a CRLF file. */
function bodyNewline(body: string): string {
  return body.includes("\r\n") ? "\r\n" : "\n";
}

/** Input to {@link annotateEdits}. */
export interface AnnotateEditsInput {
  /** The page body with every PRIOR wrapper already stripped
   *  ({@link stripFactWrappers}) — offsets here must match what the model saw. */
  body: string;
  isMdx: boolean;
  /** The model's correction edits, already through {@link enforceEditBounds}. */
  corrections: IntegrateEdit[];
  /** EVERY claim parsed from the persisted answer (all four verdicts). */
  claims: FactcheckClaimAnchor[];
  /** Phase-1 verbatim quotes keyed by claim index, already validated. */
  quotes: ClaimQuote[];
  /** Hard cap on the FINAL edit list (the annotated apply cap). */
  maxEdits: number;
  /** Per-edit char cap, re-checked on the POST-wrapper `new`. */
  maxEditChars: number;
}

/** {@link annotateEdits}' result — an ordinary edit list plus the bookkeeping the
 *  appendix needs. */
export interface AnnotateEditsResult {
  /** The final edit list: corrections (their `new` Fact-wrapped where legal) then
   *  the wrapper-only annotations. Resolve + splice this like any edit list. */
  edits: IntegrateEdit[];
  dropped: DroppedEdit[];
}

/**
 * Turn a fact-check result into ONE edit list that both corrects the prose and
 * marks the checked passages.
 *
 * **Two passes, corrections first.** This ordering is load-bearing. `applyEdits`
 * rejects overlaps by BODY POSITION (earlier start wins), not by list order — so a
 * ✅ wrapper that happens to start earlier in the page would silently kill an
 * overlapping ❌ correction, losing the whole point of the run. Corrections
 * therefore resolve first and CLAIM their spans; any wrapper intersecting a claimed
 * span is dropped with that reason, so by the time the combined list is re-resolved
 * there are no correction/wrapper overlaps left for position order to arbitrate.
 *
 * Per claim there is at most ONE chip: a model may return several edits for one
 * claim, and only the first accepted one carries the wrapper (the rest apply
 * unwrapped). ❓ claims get no wrapper at all — they are counted in the appendix's
 * `unknown=` attr instead of being marked as if something had been checked.
 *
 * A wrapper that cannot be built is never fatal to the CORRECTION: the correction
 * applies unwrapped and the skipped mark is reported. The one exception is a
 * post-wrapper `new` over `maxEditChars`, which would hard-400 the apply route —
 * that edit is dropped outright.
 */
/** The ONE sentence a link-crossing correction is refused with, on BOTH paths that
 *  refuse one ({@link annotateEdits}' pass 1 and {@link dropLinkCrossingCorrections}) —
 *  the drop is the same decision about the same hazard, and the reviewer reads the
 *  reason. */
const LINK_CROSSING_CORRECTION_REASON =
  "the correction starts or ends inside a [[wikilink]] — applying it would rewrite the link target, so the whole edit was dropped";

/**
 * The link-crossing correction guard ALONE, for a page that takes no marks.
 *
 * `annotateEdits` runs on `.mdx` only (a `.md` page carries no inline annotations by
 * policy), and the propose route's non-annotatable branch used to hand the model's
 * corrections straight through as `{edits: bounded.kept, dropped: []}` — so a
 * correction rewriting `[[Old Name]]` → `[[New Name]]` applied UNCHECKED on exactly
 * the pages where nothing else looks. The harm is not the mark (there is none), it is
 * the link target: `[[X]]` → `[[Y]]` invents a target no editor chose, downstream of
 * every gardener containment seam, in a shape the `[[<` scan cannot see. Gating a
 * containment check on the file extension is the same mistake `stripFactWrappers`
 * documents (`src/web/CLAUDE.md`): "a `.md` page never carries marks" is an invariant
 * of the write paths, not of the file.
 *
 * Corrections ONLY — nothing here wraps anything. Unresolvable edits are passed
 * through rather than dropped, because the caller re-resolves the surviving list and
 * reports those misses itself; dropping them here would report each one twice.
 */
export function dropLinkCrossingCorrections(
  body: string,
  corrections: IntegrateEdit[],
  isMdx: boolean,
): AnnotateEditsResult {
  const edits: IntegrateEdit[] = [];
  const dropped: DroppedEdit[] = [];
  for (const o of applyEdits(body, corrections, isMdx).outcomes) {
    if (o.applied && o.start !== undefined && o.end !== undefined && expandOverWikilinks(body, o.start, o.end)) {
      dropped.push({ edit: o.edit, reason: LINK_CROSSING_CORRECTION_REASON });
      continue;
    }
    edits.push(o.edit);
  }
  return { edits, dropped };
}

export function annotateEdits(input: AnnotateEditsInput): AnnotateEditsResult {
  const { body, isMdx } = input;
  const nl = bodyNewline(body);
  const dropped: DroppedEdit[] = [];
  const verdictByClaim = new Map<number, FactVerdict>();
  for (const c of input.claims) verdictByClaim.set(c.index, normalizeFactVerdict(c.verdict));

  // ── Pass 1: corrections resolve and CLAIM their spans ────────────────────
  const pass1 = applyEdits(body, input.corrections, isMdx);
  const claimed: { start: number; end: number }[] = [];
  const wrappedClaims = new Set<number>();
  const corrections: IntegrateEdit[] = [];
  for (const o of pass1.outcomes) {
    if (!o.applied || o.start === undefined || o.end === undefined) {
      dropped.push({ edit: o.edit, reason: o.reason ?? "could not be placed" });
      continue;
    }
    // A correction whose span cuts a `[[wikilink]]` in half rewrites the link
    // TARGET (`[[X]]` → `[[Y]]`), inventing a target no editor chose, downstream of
    // every gardener containment seam and in a shape the `[[<` scan cannot see. The
    // WHOLE EDIT is dropped, not just its mark: "the correction still applies
    // unwrapped" is the file's default for a refused wrapper, and here that default
    // IS the damage. The test is placed BEFORE the wrapping branches on purpose —
    // most of them (unknown claim, ❓ verdict, a claim pass 1 already wrapped) never
    // reach `wrapCorrectionText` at all, and those are the paths the rewrite hid on.
    // A correction CONTAINING a whole link is untouched: it covers the link's own
    // brackets, so `expandOverWikilinks` has nothing to widen and answers null.
    if (expandOverWikilinks(body, o.start, o.end)) {
      dropped.push({ edit: o.edit, reason: LINK_CROSSING_CORRECTION_REASON });
      continue;
    }
    claimed.push({ start: o.start, end: o.end });
    const n = o.edit.claimIndex;
    // The ANSWER is the only authority on a claim's verdict. A `claimIndex` that
    // names no parsed claim (a model-invented number) must NOT be wrapped: the chip
    // would link to a `#fc-claim-N` section the appendix cannot contain, and the
    // `Was:` line keyed to it would be silently dropped too. The correction itself
    // is still applied — unwrapped, and said out loud.
    const verdict = verdictByClaim.get(n);
    let edit = o.edit;
    if (n > 0 && verdict === undefined) {
      dropped.push({
        edit: o.edit,
        reason: `claim ${n} is not in the answer — the correction was applied without a mark`,
      });
    } else if (n > 0 && verdict !== undefined && verdict !== "unknown" && !wrappedClaims.has(n)) {
      const wrapped = wrapCorrectionText(body, o, n, verdict, nl);
      if ("error" in wrapped) {
        dropped.push({
          edit: o.edit,
          reason: `inline mark skipped (${wrapped.error}) — the correction itself still applies`,
        });
      } else if (wrapped.text.length > input.maxEditChars) {
        // An over-length `new` is a guaranteed 400 at apply, so drop the edit here
        // rather than shipping a preview whose accept-all cannot succeed.
        dropped.push({
          edit: o.edit,
          reason: `the correction plus its inline mark exceeds ${input.maxEditChars} chars`,
        });
        continue;
      } else {
        wrappedClaims.add(n);
        edit = { ...o.edit, new: wrapped.text };
      }
    }
    corrections.push(edit);
  }

  // ── Pass 2: wrapper-only marks on the claims' own quotes ─────────────────
  // ✅ claims (whose prose is never rewritten) AND any ⚠️ claim pass 1 left
  // UNMARKED — a ⚠️ whose correction dropped would otherwise leave the reader no
  // visible trace at all on the passage the check flagged, which is the whole point
  // of the feature. Claims already wrapped by pass 1 are excluded: two chips with
  // the same `n` would both point at the one appendix section.
  const candidates: IntegrateEdit[] = input.quotes
    .filter((q) => {
      if (wrappedClaims.has(q.index)) return false;
      const v = verdictByClaim.get(q.index);
      return v === "ok" || v === "warn";
    })
    .map((q) => ({
      claimIndex: q.index,
      // The emoji must AGREE with the `v` the wrapper carries, or the structural
      // wrapper-only predicate stops recognizing the mark and it costs budget.
      verdict: verdictByClaim.get(q.index) === "warn" ? "⚠️" : "✅",
      old: q.quote,
      new: "",
      reason: "",
    }));
  const wrappers: IntegrateEdit[] = [];
  // Where the marks emitted so far actually landed — the POST-expansion ranges, which
  // is the whole point (see the collision drop below).
  const markedSpans: { start: number; end: number; claimIndex: number }[] = [];
  // `"mark"`: this call is a LOCATOR. Nothing it resolves is spliced — the range is
  // handed to `factSpanForm` and the surviving edit replaces the raw slice with
  // itself inside a `<Fact>` wrapper — so the splice-only half of the rescue gate
  // must not refuse it. See {@link RescueMode}.
  for (const o of applyEdits(body, candidates, isMdx, "mark").outcomes) {
    if (!o.applied || o.start === undefined || o.end === undefined) {
      dropped.push({ edit: o.edit, reason: o.reason ?? "could not be placed" });
      continue;
    }
    if (claimed.some((c) => o.start! < c.end && c.start < o.end!)) {
      dropped.push({ edit: o.edit, reason: "overlaps a correction — the correction wins" });
      continue;
    }
    const span = factSpanForm(body, o.start, o.end);
    if ("error" in span) {
      dropped.push({ edit: o.edit, reason: span.error });
      continue;
    }
    if (o.grownOverEmphasis) span.grownOverEmphasis = true;
    // The LAST word on markup safety, and it re-judges EVERY span rather than only
    // what `factSpanForm` adjusted — which is the whole thesis of `markSpanRefusal`:
    // an exact-tier match passes no gate at all, so nothing else ever looks at it.
    const markVerdict = verdictByClaim.get(o.edit.claimIndex) ?? "ok";
    const cut = markSpanRefusal(body, span, markVerdict, nl);
    if (cut) {
      dropped.push({ edit: o.edit, reason: cut });
      continue;
    }
    // There is deliberately no wrapper-vs-CORRECTION re-test on the expanded range.
    // It is unreachable by construction and was verified so: pass 1 drops every
    // correction that cuts a link, so a surviving correction's span either contains a
    // link whole or touches none — and an expansion only ever grows the wrapper over
    // links it already intersects, whose overlap with such a correction therefore
    // existed before the expansion and was caught by the gate above.
    //
    // Wrapper-vs-WRAPPER is the reachable half of that hazard, and it is REAL: two
    // claims quoting different words inside ONE link expand to the same extent, so
    // both edits carry an identical `old` and the second dies in `applyEdits` under
    // the generic "overlaps an earlier edit" — leaving the appendix with a section no
    // chip points at, and the gate with no explanation. Named here instead.
    const collision = markedSpans.find((m) => span.start < m.end && m.start < span.end);
    if (collision) {
      dropped.push({
        edit: o.edit,
        reason:
          span.expandedOverLink && span.start === collision.start && span.end === collision.end
            ? `expanded over the same [[wikilink]] as claim ${collision.claimIndex} — one mark carries both`
            : `overlaps the mark for claim ${collision.claimIndex} — one mark carries both`,
      });
      continue;
    }
    const inner = body.slice(span.start, span.end);
    const text = wrapperTextFor(body, span, o.edit.claimIndex, markVerdict, nl);
    if (text.length > input.maxEditChars) {
      dropped.push({ edit: o.edit, reason: `the inline mark exceeds ${input.maxEditChars} chars` });
      continue;
    }
    markedSpans.push({ start: span.start, end: span.end, claimIndex: o.edit.claimIndex });
    wrappers.push({ ...o.edit, old: inner, new: text, reason: markReason(span) });
  }

  // Corrections first, so the cap can only ever trim MARKS — never a correction.
  const edits: IntegrateEdit[] = [];
  for (const e of [...corrections, ...wrappers]) {
    if (edits.length >= input.maxEdits) {
      dropped.push({ edit: e, reason: `over the ${input.maxEdits}-edit cap for one integration` });
      continue;
    }
    edits.push(e);
  }
  return { edits, dropped };
}

/** This module's own `g` instance over the shared {@link NESTED_FACT_SOURCE} — the
 *  repairable shape, whose every clause is documented there. */
const NESTED_FACT_RE = new RegExp(NESTED_FACT_SOURCE, "g");

/** How much of an unrepaired line the log line quotes. */
const RESIDUAL_EXCERPT_MAX = 120;

/**
 * Post-splice backstop: re-nest any `<Fact>` mark that ended up INSIDE a wikilink.
 *
 * `factSpanForm` expands a span over the link it intersects, so this should never
 * fire on a write this build produced — it is here because the damage is silent and
 * durable (the tags become the link TARGET; `src/web/CLAUDE.md` owns the rule) and
 * because the apply route also splices CLIENT-ECHOED edits, which no engine tier
 * constrains. Deliberately NOT a write-time reject at `writeWikiPage`: pages
 * documenting this bug carry the shape legitimately, and refusing the whole write
 * would be worse than the defect.
 *
 * **It rewrites only what it can parse WHOLE**, which is the difference between a
 * backstop and a second source of damage. `NESTED_FACT_SOURCE` requires a
 * quote-balanced opening tag, non-empty inner text and a `]]` not followed by another
 * `]`; anything else falls through to the residual report. Each of those was a
 * measured corruption: `title="a>b"` moved the brackets inside the attribute, an
 * empty inner emitted the bare `[[]]`, and a trailing `]]]` left an orphan bracket.
 *
 * FENCED lines are documentation and are left alone (the shared `fencedLineMask`),
 * and YAML frontmatter is skipped because its values are strings, not markdown.
 * INLINE CODE is deliberately NOT skipped, and that asymmetry is the point:
 * `renderWikiHtml` substitutes wikilinks over the raw body before any code handling,
 * so a backticked `` `[[<Fact …>P</Fact>]]` `` renders as a DEAD
 * `wiki-link-missing` inside a `<code>` — live damage, not documentation (measured
 * 2026-08-30). A fence is different: `formatWebHtml` renders a fenced block as a code
 * block and `renderWikiHtml`'s substitution is invisible inside one, so a fenced
 * example really is inert. `checkNestedAnnotation` (`src/wiki/lint.ts`) keeps masking
 * inline code and therefore does NOT report what this repairs — see the asymmetry
 * note in its docblock and in `src/web/CLAUDE.md`.
 *
 * **Known gap, deliberate:** a MULTI-LINE nesting (`[[<Fact …>` … `</Fact>]]` across
 * a line break) is invisible to this repair AND to the lint check, both of which are
 * line-scoped. No engine tier can produce one (a wrapper is refused outright when its
 * span carries a newline and the block form starts on its own line), so it is
 * reachable only through a client-echoed edit that spells it deliberately.
 *
 * Returns the (possibly unchanged) body plus two excerpt lists for the caller's log
 * line: what was repaired, and what still carries the shape.
 */
export function repairNestedFactWrappers(body: string): {
  body: string;
  repaired: string[];
  residual: string[];
} {
  const repaired: string[] = [];
  const residual: string[] = [];
  const lines = body.split("\n");
  const fenced = fencedLineMask(lines);
  for (let i = frontmatterEndLine(lines); i < lines.length; i++) {
    const raw = lines[i]!;
    if (fenced[i]) continue;
    const fixedLine =
      raw.match(NESTED_FACT_RE) === null
        ? raw
        : raw.replace(NESTED_FACT_RE, (_m, open: string, inner: string) => {
            const fixed = `${open}[[${inner}]]</Fact>`;
            repaired.push(fixed);
            return fixed;
          });
    lines[i] = fixedLine;
    // What is LEFT after the rewrite — a nesting the repairable shape refuses, on a
    // line whose other occurrences may well have been repaired. Scanned on the RAW
    // line with the consumed occurrences masked out (a `]` breaks the char class),
    // because the repair's own output `<Fact…>[[inner]]</Fact>` re-matches
    // NESTED_MARKUP_RE whenever `inner` carries a tag — searching the rewritten
    // line reported a fully-corrected page as residual. The excerpt is still
    // quoted from the rewritten line, which is what is on disk.
    const scanBase = raw.replace(NESTED_FACT_RE, "]");
    const m2 = scanBase.match(NESTED_MARKUP_RE);
    if (m2) {
      const at = fixedLine.indexOf(m2[0]);
      residual.push((at !== -1 ? fixedLine.slice(at) : m2[0]).trim().slice(0, RESIDUAL_EXCERPT_MAX));
    }
  }
  return { body: repaired.length > 0 ? lines.join("\n") : body, repaired, residual };
}

/**
 * `Was:` originals re-derived from FRESHLY-resolved apply outcomes — the pre-edit
 * text each Fact-wrapped CORRECTION is about to replace, keyed by claim index.
 *
 * Wrapper-only outcomes are excluded: they replace a passage with itself, so a
 * `Was:` line for one would state that the text used to be the text it still is.
 * The apply route cannot reuse propose's map — the body may have drifted, and the
 * appendix must describe the write that actually happened.
 */
export function originalsOfOutcomes(outcomes: EditOutcome[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const o of outcomes) {
    if (!o.applied || o.edit.claimIndex <= 0) continue;
    // The SHARED wrapper-shape authority, not a local `^<Fact\b` prefix test.
    if (!isFactWrapperText(o.edit.new)) continue;
    if (isWrapperOnlyEdit(o.edit, o.resolvedText)) continue;
    if (!out.has(o.edit.claimIndex)) out.set(o.edit.claimIndex, o.resolvedText ?? "");
  }
  return out;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export interface IntegratePromptInput {
  pageTitle: string;
  wikiName: string;
  /** The ❌/⚠️ claim blocks from the persisted answer (server-derived anchors). */
  claims: FactcheckClaimAnchor[];
  /** The page body, already {@link promptMaskBody}-ed. */
  maskedBody: string;
  /** True when the page carries a trailing `## Sources` section. */
  hasSourcesSection: boolean;
}

/**
 * The integrate one-shot's prompts. The model gets the page (zones replaced by
 * placeholders) plus the fact-check verdict blocks, and must answer with JSON
 * only — every `old` copied EXACTLY from the body it was shown. Tool use is
 * steered against (the sources are already in the verdict blocks); the file-write
 * tools are additionally FENCED at the call site, because a model that can write
 * the page directly bypasses the preview and the CAS entirely.
 */
export function buildIntegratePrompt(input: IntegratePromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = [
    "You are a meticulous wiki editor applying fact-check results to an article.",
    "",
    "You are given an article body and the fact-check verdicts for some of its claims.",
    "Produce a MINIMAL list of in-place text edits that make the article accurate.",
    "",
    "Rules:",
    "- ❌ (contradicted): correct the statement, and cite the correcting source as a markdown link `[hostname](url)` right there in the sentence.",
    "- ⚠️ (partly supported): hedge or add the missing precision, with the same in-place source link.",
    "- Edit NOTHING else. Do not restructure, retitle, reformat, or improve prose that no verdict challenges.",
    "- Use ONLY the source URLs that appear in the verdict blocks. Never invent a URL, and do NOT use any tool — everything you need is in this message.",
    "",
    "Each edit is an exact string replacement:",
    "- `old` MUST be copied VERBATIM from the article body below, character for character, and must be long enough to occur EXACTLY ONCE in it (extend it with surrounding words if the short form repeats).",
    "- `old` must NOT contain, start in, or run past any `[… omitted]` placeholder — those regions are not editable.",
    "- `new` is the full replacement for `old`.",
    "- Prefer a handful of surgical sentence-level edits over one large block.",
    "",
    "Produce ONLY valid JSON (no markdown fences, no commentary), shaped:",
    '{"edits": [{"claimIndex": 3, "verdict": "❌", "old": "exact substring currently in the page", "new": "replacement text", "reason": "one-line why"}], "note": "optional one-line summary"}',
    "",
    "Return an empty `edits` array if no verdict warrants a change to the text.",
  ].join("\n");

  const claimLines = input.claims.map((c) => c.block).join("\n\n");
  const userPrompt = [
    `Apply these fact-check verdicts to "${input.pageTitle}" in the "${input.wikiName}" knowledge wiki.`,
    "",
    "VERDICTS:",
    '"""',
    claimLines,
    '"""',
    "",
    "ARTICLE BODY (copy `old` verbatim from this text; `[… omitted]` regions are not editable):",
    '"""',
    input.maskedBody,
    '"""',
    "",
    input.hasSourcesSection
      ? "The article has a `## Sources` section; a correcting source may be added there as a list item edit INSTEAD of inline when that reads better."
      : "The article has no `## Sources` section — keep source links inline.",
    "",
    "Output the JSON edit list now.",
  ].join("\n");

  return { systemPrompt, userPrompt };
}

/** True when the page carries a trailing `## Sources` heading. */
export function hasSourcesSection(body: string): boolean {
  return body.split("\n").some((l) => /^##\s+Sources\b/i.test(l));
}
