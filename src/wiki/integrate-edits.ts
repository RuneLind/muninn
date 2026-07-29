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

import { COMPONENT_TAG_SOURCE_SINGLE_LINE } from "../format/markdown-ast.ts";
import { collapseWithMap } from "./explain-context.ts";
import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";
import { extractJson } from "../ai/json-extract.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

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
 *  the text it inserts. `old.length` under-measures a tier-2 rescue. */
export function outcomeChangedChars(o: EditOutcome): number {
  if (!o.applied || o.start === undefined || o.end === undefined) return 0;
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

/** Markup delimiters whose balance a whitespace-rescued range must preserve. */
const RESCUE_DELIMS = ["*", "`", "_", "[", "]", "(", ")"] as const;

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
): string | null {
  // `\r\n\r\n` is a paragraph break too — a bare `\n\n` test misses CRLF pages.
  if (/\n[ \t\r]*\n/.test(rawSlice)) {
    return "whitespace-rescued match would span a paragraph break in the page";
  }
  for (const d of RESCUE_DELIMS) {
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
export function applyEdits(body: string, edits: IntegrateEdit[], isMdx = false): ApplyEditsResult {
  const masked = matchMaskBody(body, isMdx);
  const outcomes: EditOutcome[] = edits.map((edit) => {
    const r = resolveRange(masked, edit.old);
    if ("error" in r) return { edit, applied: false, reason: r.error };
    // Defensive: an anchor can only resolve outside the zones by construction
    // (a sentinel run never matches page text) — assert it rather than trust it.
    if (masked.slice(r.start, r.end).includes(ZONE_SENTINEL)) {
      return { edit, applied: false, reason: "resolves into an excluded region of the page" };
    }
    const resolvedText = body.slice(r.start, r.end);
    // A tier-2 rescue's raw span can cut through markup the collapse stripped —
    // reject rather than corrupt (see `collapsedRescueRisk`).
    if (r.tier === "collapsed") {
      const risk = collapsedRescueRisk(
        resolvedText,
        edit.old,
        r.start > 0 ? body[r.start - 1]! : "",
        r.end < body.length ? body[r.end]! : "",
      );
      if (risk) return { edit, applied: false, reason: risk };
    }
    return {
      edit,
      applied: true,
      start: r.start,
      end: r.end,
      tier: r.tier,
      resolvedText,
      beforeCtx: contextBefore(body, masked, r.start),
      afterCtx: contextAfter(body, masked, r.end),
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
