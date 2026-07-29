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
 * blocks, fenced code blocks, and (on `.mdx`) block-component TAG MARKUP ONLY
 * (opening/closing tags + attributes; the prose inside a `<Callout>` stays
 * editable) — but for different consumers and with different length semantics:
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
 */

import { COMPONENT_NAMES } from "../format/markdown-ast.ts";
import { collapseWithMap } from "./explain-context.ts";
import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";
import { extractJson } from "../ai/json-extract.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

/**
 * Cap on the page body handed to the integrate one-shot (chars, measured through
 * {@link integrateBodyLen}). ~2× `FACTCHECK_ARTICLE_BODY_MAX` — unlike claim
 * extraction the model must see the WHOLE page (it quotes `old` from it), so the
 * cap is a hard reject rather than a truncation.
 */
export const INTEGRATE_BODY_MAX = 24_000;
/** Max edits accepted in one propose/apply call. */
export const INTEGRATE_MAX_EDITS = 12;
/** Max chars for one edit's `old` or `new`. */
export const INTEGRATE_MAX_EDIT_CHARS = 2000;

/** Same-length match-mask sentinel: U+E000, private use, ONE UTF-16 code unit.
 *  Never NUL (see the module doc — `Bun.spawn` rejects NUL in argv). */
export const ZONE_SENTINEL = "\uE000";

/** Chars of surrounding body returned with each resolved edit for the client preview. */
const PREVIEW_CONTEXT = 120;

// ── Exclusion zones ──────────────────────────────────────────────────────────

export type ZoneKind = "frontmatter" | "sentinel" | "fence" | "component";

export interface Zone {
  start: number;
  end: number;
  kind: ZoneKind;
}

/** Readable, argv-safe stand-ins for the model-facing prompt mask. A component
 *  tag collapses to nothing (its prose is NOT a zone and stays in place). */
const ZONE_PLACEHOLDER: Record<ZoneKind, string> = {
  frontmatter: "[frontmatter omitted]",
  sentinel: "[prior fact-check block omitted]",
  fence: "[code block omitted]",
  component: "",
};

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SENTINEL_BLOCK_RE = new RegExp(
  escapeRegExp(FACTCHECK_SENTINEL_START) + "[\\s\\S]*?" + escapeRegExp(FACTCHECK_SENTINEL_END),
  "g",
);

/** Opening / closing / self-closing tag of a KNOWN block component, with its
 *  attributes. Matches tag markup only — never the body between a pair. */
const COMPONENT_TAG_RE = new RegExp(
  `</?(?:${COMPONENT_NAMES.join("|")})(?:\\s+[A-Za-z][\\w-]*="[^"]*")*\\s*/?>`,
  "g",
);

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
  // leaving half a code block editable).
  let offset = 0;
  let fenceStart = -1;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (fenceStart < 0) fenceStart = offset;
      else {
        zones.push({ start: fenceStart, end: offset + line.length, kind: "fence" });
        fenceStart = -1;
      }
    }
    offset += line.length + 1;
  }
  if (fenceStart >= 0) zones.push({ start: fenceStart, end: body.length, kind: "fence" });

  if (isMdx) {
    for (const m of body.matchAll(COMPONENT_TAG_RE)) {
      if (m.index === undefined) continue;
      zones.push({ start: m.index, end: m.index + m[0].length, kind: "component" });
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

/** A parsed edit list plus the model's optional one-line summary. */
export interface EditListResult {
  edits: IntegrateEdit[];
  note?: string;
}

/**
 * Tolerant parse of the integrate one-shot's raw output. Accepts `{edits:[…]}`
 * (optionally with `note`) or a bare `[…]`. Returns null on any parse/shape
 * failure — the route turns that into a clean error and NEVER a write. An empty
 * but well-formed list is a legitimate "nothing to correct" answer, so it returns
 * `{edits: []}` rather than null.
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
  for (const item of rawEdits) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const oldText = typeof o.old === "string" ? o.old : "";
    if (!oldText.trim()) continue; // an empty anchor can never resolve
    const newText = typeof o.new === "string" ? o.new : "";
    const idx = Number(o.claimIndex);
    edits.push({
      claimIndex: Number.isFinite(idx) && idx > 0 ? Math.trunc(idx) : 0,
      verdict: o.verdict === "⚠" ? "⚠️" : typeof o.verdict === "string" ? o.verdict : "",
      old: oldText,
      new: newText,
      reason: typeof o.reason === "string" ? o.reason.trim() : "",
    });
  }
  return { edits, ...(note ? { note } : {}) };
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
 * "Changed chars" for the apply-time ratio bound: per edit, the LARGER of the
 * text removed and the text inserted (a hedge that grows a sentence is measured
 * by the grown length, not the sum).
 */
export function changedChars(edits: IntegrateEdit[]): number {
  return edits.reduce((sum, e) => sum + Math.max(e.old.length, e.new.length), 0);
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
    return {
      edit,
      applied: true,
      start: r.start,
      end: r.end,
      tier: r.tier,
      beforeCtx: body.slice(Math.max(0, r.start - PREVIEW_CONTEXT), r.start),
      afterCtx: body.slice(r.end, r.end + PREVIEW_CONTEXT),
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
