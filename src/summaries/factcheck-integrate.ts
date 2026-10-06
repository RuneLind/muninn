/**
 * The pure half of the `/summaries` fact-check Integrate: the wiki's edit engine
 * (`src/wiki/integrate-edits.ts`) run over a capture summary's RAW slices.
 *
 * - **Slices (D12).** The model is shown, and its edits resolve against, the same
 *   ranges the check read (`summaryCheckedRanges`): the body above the
 *   `## Visual reference` section, and what follows that section's cut. The
 *   ranges are taken from the stored body with any earlier fact-check block
 *   stripped, so the verdicts are never edit targets. Each slice is masked,
 *   resolved and spliced on its own, so the engine's exclusion zones need no new
 *   kind, and the section between them and the transcript after them are never
 *   touched.
 * - **Voice (D5, D7).** A summary reports what its source says, so a ❌ or ⚠️ is
 *   ATTRIBUTED ("the video says X; sources say Y") rather than corrected in the
 *   source's mouth — checked mechanically ({@link attributionRefusal}). The noun
 *   is `sourceKindNoun`'s, shared with the drafter rider.
 * - **Structure.** An edit cannot add a line the next read cuts on, and a
 *   rebuild that moves the transcript, the visual section or the checked ranges
 *   is refused ({@link summaryStructureChanged}).
 * - **Preview.** Rendered here, server-side, so the `/summaries` client bundle
 *   carries no diff code.
 */

import {
  applyEdits,
  changedCharsOfOutcomes,
  enforceChangeBudget,
  promptMaskBody,
  type DroppedEdit,
  type EditOutcome,
  type IntegrateEdit,
  type IntegrateEditorVoice,
} from "../wiki/integrate-edits.ts";
import { lineDiff } from "../gardener/diff.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { stripSummaryFactcheckBlock } from "./factcheck-block.ts";
import { summaryCheckedRanges } from "./factcheck-body.ts";
import { mapProseLines, splitTranscript, TRANSCRIPT_HEADING_RE } from "./transcript-split.ts";
import { VISUAL_REFERENCE_HEADING_RE } from "./visual-detail.ts";

// ---------------------------------------------------------------------------
// The voice (D5, D7)
// ---------------------------------------------------------------------------

/** The summary editor's voice: every acted-on verdict attributes. `sourceNoun`
 *  is {@link sourceKindNoun}'s ("the video"). */
export function summaryEditorVoice(sourceNoun: string): IntegrateEditorVoice {
  const noun = sourceNoun.replace(/^the /, "");
  const article = /^[aeiou]/.test(noun) ? "an" : "a";
  return {
    role: `You are a meticulous summary editor applying fact-check results to a summary of ${article} ${noun}.`,
    given:
      `You are given the summary's text and the fact-check verdicts for some of its claims. ` +
      `The summary reports what the ${noun} says, so a correction must never put words in the ${noun}'s mouth.`,
    verdictRules: [
      `- ❌ (contradicted): ATTRIBUTE, never correct silently. The edited sentence must say what the ${noun} says and then what the sources say, in this shape: "The ${noun} says X; sources say Y ([hostname](url))." Cite the correcting source as a markdown link \`[hostname](url)\` right there in the sentence.`,
      `- ⚠️ (partly supported): attribute the same way: the claim stays the ${noun}'s ("the ${noun} says …"), followed by what the sources say — the missing precision or the caveat — with the same in-place source link.`,
      `- For ❌ and ⚠️ alike, the claim must READ as the ${noun}'s after the edit. If it states the claim as plain fact, rewrite it to start from the ${noun} ("The ${noun} says …"), and make \`old\` cover the sentence from its start. Appending "Sources say …" after a sentence that still asserts the claim as fact is NOT attribution.`,
      `- Every ❌/⚠️ edit's \`new\` must contain the words "the ${noun} says" (or "the ${noun} claims" / "the ${noun} states"), even when the sentence already names a speaker. An edit without them is discarded.`,
    ],
    noun: "summary",
    task: (title, collection) =>
      `Apply these fact-check verdicts to the summary of the ${noun} "${title}" (the "${collection}" collection).`,
  };
}

// ---------------------------------------------------------------------------
// Slices (D12)
// ---------------------------------------------------------------------------

/** The prompt's stand-in for the section between two slices. */
export const SLICE_GAP_PLACEHOLDER = "[visual reference section omitted]";

export interface SummaryEditSlices {
  /** The stored body (no transcript) with any fact-check block stripped. */
  readonly base: string;
  /** The editable ranges of {@link base}, in order. */
  readonly ranges: readonly { start: number; end: number }[];
}

export function summaryEditSlices(storedBody: string): SummaryEditSlices {
  const base = stripSummaryFactcheckBlock(storedBody);
  return { base, ranges: summaryCheckedRanges(base) };
}

export function sliceTexts(slices: SummaryEditSlices): string[] {
  return slices.ranges.map((r) => slices.base.slice(r.start, r.end));
}

/** The body the model is shown: each slice prompt-masked, joined by a placeholder. */
export function summaryPromptBody(slices: SummaryEditSlices): string {
  return sliceTexts(slices)
    .map((t) => promptMaskBody(t))
    .join(`\n\n${SLICE_GAP_PLACEHOLDER}\n\n`)
    .trim();
}

/** The integrate body-length referent for a summary: the masked slices. */
export function summaryIntegrateBodyLen(slices: SummaryEditSlices): number {
  return sliceTexts(slices).reduce((n, t) => n + promptMaskBody(t).length, 0);
}

/** One edit's outcome, with the slice it resolved in (`-1` when dropped). */
export type SliceEditOutcome = EditOutcome & { slice: number };

export interface ResolvedSummaryEdits {
  /** One per input edit, in input order. */
  readonly outcomes: SliceEditOutcome[];
  /** Each slice's text with its applied edits spliced in. */
  readonly texts: string[];
  readonly appliedCount: number;
}

/**
 * Resolve every edit to the ONE slice its `old` anchors in, then apply each
 * slice's edits with the engine (overlap rejection and descending splice
 * included). An `old` that anchors in two slices is ambiguous and drops; one
 * that anchors in none drops with the engine's reason. Pure.
 */
export function resolveSummaryEdits(slices: SummaryEditSlices, edits: readonly IntegrateEdit[]): ResolvedSummaryEdits {
  const texts = sliceTexts(slices);
  const assigned: number[] = edits.map(() => -1);
  const reasons: (string | undefined)[] = edits.map(() => undefined);
  edits.forEach((edit, i) => {
    const hits: number[] = [];
    texts.forEach((t, s) => {
      const probe = applyEdits(t, [edit]).outcomes[0]!;
      if (probe.applied) hits.push(s);
      else if (s === 0) reasons[i] = probe.reason;
    });
    if (hits.length === 1) assigned[i] = hits[0]!;
    else if (hits.length > 1) reasons[i] = "matches in more than one part of the summary";
  });

  const outcomes: SliceEditOutcome[] = edits.map((edit, i) => ({
    edit,
    applied: false,
    reason: reasons[i] ?? "could not be placed",
    slice: -1,
  }));
  const out = texts.slice();
  texts.forEach((t, s) => {
    const mine = edits.map((e, i) => ({ e, i })).filter(({ i }) => assigned[i] === s);
    if (mine.length === 0) return;
    const r = applyEdits(t, mine.map(({ e }) => e));
    out[s] = r.body;
    r.outcomes.forEach((o, k) => {
      outcomes[mine[k]!.i] = { ...o, slice: o.applied ? s : -1 };
    });
  });
  return { outcomes, texts: out, appliedCount: outcomes.filter((o) => o.applied).length };
}

/** {@link SummaryEditSlices.base} with each slice replaced by `texts[i]`. */
export function rebuildSummaryBody(slices: SummaryEditSlices, texts: readonly string[]): string {
  let out = slices.base;
  for (let i = slices.ranges.length - 1; i >= 0; i--) {
    const r = slices.ranges[i]!;
    out = out.slice(0, r.start) + texts[i]! + out.slice(r.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refusals (fix round 1)
// ---------------------------------------------------------------------------

/** `the <noun> says|claims|states`, case-insensitive: what a ❌/⚠️ edit must carry. */
export function attributionRefusal(newText: string, sourceNoun: string): string | null {
  const noun = sourceNoun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`\\b${noun}\\s+(?:says|claims|states)\\b`, "i").test(newText) ? null : "not attributed";
}

const FACTCHECK_HEADING_RE = /^ {0,3}#{1,6}[ \t]+fact[ \t-]*check\b/i;
const SENTINEL_LINE_RE = /^\s*<!--\s*factcheck:(?:start|end)\s*-->\s*$/;

/** An unfenced line in an edit that the next read cuts on — the transcript
 *  heading, the visual-reference heading, a fact-check heading or a sentinel. */
export function structuralLineRefusal(text: string): string | null {
  let hit: string | null = null;
  mapProseLines(text, (line) => {
    if (
      hit === null &&
      (TRANSCRIPT_HEADING_RE.test(line) || VISUAL_REFERENCE_HEADING_RE.test(line) || FACTCHECK_HEADING_RE.test(line) || SENTINEL_LINE_RE.test(line))
    ) {
      hit = line.trim();
    }
    return line;
  });
  return hit === null ? null : `adds a "${hit}" line, which would change the summary's structure`;
}

const TRANSCRIPT_PROBE = "\uE001transcript-probe\uE001";

/** What the next read cuts on: the checked ranges, the text between them, and
 *  whether a transcript appended after `text` is read back as exactly that. */
function structureSignature(text: string): string {
  const base = stripSummaryFactcheckBlock(text);
  const ranges = summaryCheckedRanges(base);
  const gaps = ranges.map((r, i) => base.slice(r.end, ranges[i + 1]?.start ?? base.length));
  const probe = splitTranscript(`${text.trimEnd()}\n\n## Transcript\n\n${TRANSCRIPT_PROBE}`).transcript?.trim();
  return JSON.stringify([ranges.length, gaps, probe === TRANSCRIPT_PROBE]);
}

/** Does `after` (a rebuilt body, block allowed) read back with a different
 *  structure from `before`? */
export function summaryStructureChanged(before: string, after: string): boolean {
  return structureSignature(before) !== structureSignature(after);
}

function dropOutcome(o: SliceEditOutcome, reason: string): void {
  o.applied = false;
  o.reason = reason;
  o.slice = -1;
  delete o.start;
  delete o.end;
  delete o.tier;
  delete o.resolvedText;
  delete o.beforeCtx;
  delete o.afterCtx;
}

export interface ProposeSummaryEditsInput {
  slices: SummaryEditSlices;
  /** The model's edits, already parsed and bounded. */
  edits: readonly IntegrateEdit[];
  /** Drops made before this step (parse, bounds), for the claim-group rule. */
  priorDrops: readonly DroppedEdit[];
  sourceNoun: string;
  /** Claim indices whose saved verdict is ❌ or ⚠️. */
  correctable: ReadonlySet<number>;
  bodyLen: number;
}

/**
 * Propose-side screening, in order: structural lines and attribution (per edit),
 * resolution, the change budget, the per-edit structure check, then the claim
 * group — when any edit for a claim is dropped, every edit for it is (a half
 * correction reads as the whole one). Mutates nothing it was given.
 */
export function proposeSummaryEdits(input: ProposeSummaryEditsInput): {
  outcomes: SliceEditOutcome[];
  dropped: DroppedEdit[];
  changedChars: number;
} {
  const { slices, sourceNoun, correctable } = input;
  const screenDrops: DroppedEdit[] = [];
  const kept = input.edits.filter((edit) => {
    const reason =
      structuralLineRefusal(edit.new) ??
      (correctable.has(edit.claimIndex) || /❌|⚠/.test(edit.verdict) ? attributionRefusal(edit.new, sourceNoun) : null);
    if (reason) screenDrops.push({ edit, reason });
    return !reason;
  });
  const resolved = resolveSummaryEdits(slices, kept);
  const { outcomes } = resolved;
  enforceChangeBudget(outcomes, input.bodyLen);
  for (const o of outcomes) {
    if (!o.applied) continue;
    const alone = resolveSummaryEdits(slices, [o.edit]);
    if (summaryStructureChanged(slices.base, rebuildSummaryBody(slices, alone.texts))) {
      dropOutcome(o, "would change the summary's structure (the transcript, the visual reference or the checked text)");
    }
  }
  const failed = new Set(
    [...input.priorDrops, ...screenDrops, ...outcomes.filter((o) => !o.applied)].map((d) => d.edit.claimIndex).filter((i) => i > 0),
  );
  for (const o of outcomes) {
    if (o.applied && failed.has(o.edit.claimIndex)) {
      dropOutcome(o, `another edit for claim ${o.edit.claimIndex} was dropped, so this one is too`);
    }
  }
  const applied = outcomes.filter((o) => o.applied);
  if (applied.length > 1) {
    const together = resolveSummaryEdits(slices, applied.map((o) => o.edit));
    if (summaryStructureChanged(slices.base, rebuildSummaryBody(slices, together.texts))) {
      for (const o of applied) dropOutcome(o, "together with the other edits, would change the summary's structure");
    }
  }
  const dropped: DroppedEdit[] = [
    ...screenDrops,
    ...outcomes.filter((o) => !o.applied).map((o) => ({ edit: o.edit, reason: o.reason ?? "could not be placed" })),
  ];
  return { outcomes, dropped, changedChars: changedCharsOfOutcomes(outcomes) };
}

// ---------------------------------------------------------------------------
// The preview (server-rendered)
// ---------------------------------------------------------------------------

export interface SummaryPreviewEdit {
  claimIndex: number;
  verdict: string;
  new: string;
  reason: string;
  resolvedText?: string;
  beforeCtx?: string;
  afterCtx?: string;
}

/**
 * The preview: one card per proposed edit with a checkbox (`data-edit-idx`, the
 * edit's index in the response's `edits`), a line diff of the RAW span it
 * replaces against its replacement, and the dropped edits with their reasons.
 */
export function summaryIntegratePreviewHtml(
  edits: readonly SummaryPreviewEdit[],
  dropped: readonly { edit: { claimIndex?: number; old?: string }; reason: string }[],
  claimTitles: ReadonlyMap<number, string>,
): string {
  const cards = edits.map((e, i) => {
    const diff = lineDiff(e.resolvedText ?? "", e.new)
      .map((l) => {
        const cls = l.type === "add" ? "d-add" : l.type === "del" ? "d-del" : "d-ctx";
        const prefix = l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ";
        return `<span class="${cls}">${escapeHtml(prefix + l.text)}</span>`;
      })
      .join("");
    const title = claimTitles.get(e.claimIndex);
    return (
      '<div class="sum-fc-int-edit">' +
      '<label class="sum-fc-int-row">' +
      `<input type="checkbox" class="sum-fc-int-cb" data-edit-idx="${i}" checked>` +
      `<span class="sum-fc-int-verdict">${escapeHtml(e.verdict)}</span>` +
      `<span class="sum-fc-int-claim">Claim ${escapeHtml(String(e.claimIndex))}${title ? ` — ${escapeHtml(title)}` : ""}</span>` +
      "</label>" +
      (e.reason ? `<div class="sum-fc-int-reason">${escapeHtml(e.reason)}</div>` : "") +
      (e.beforeCtx ? `<div class="sum-fc-int-ctx">…${escapeHtml(e.beforeCtx)}</div>` : "") +
      `<div class="sum-fc-int-diff">${diff}</div>` +
      (e.afterCtx ? `<div class="sum-fc-int-ctx">${escapeHtml(e.afterCtx)}…</div>` : "") +
      "</div>"
    );
  });
  const drops = dropped.length
    ? '<details class="sum-fc-int-dropped"><summary>' +
      `${dropped.length} not applied</summary>` +
      dropped
        .map(
          (d) =>
            '<div class="sum-fc-int-drop">' +
            `<span class="sum-fc-int-drop-reason">${escapeHtml(d.reason)}</span>` +
            `<span class="sum-fc-int-drop-quote">${escapeHtml((d.edit.old ?? "").slice(0, 160))}</span>` +
            "</div>",
        )
        .join("") +
      "</details>"
    : "";
  return cards.join("") + drops;
}
