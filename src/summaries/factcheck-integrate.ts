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
 *   source's mouth. The noun follows the source: the URL host first, then the
 *   collection, because 3 of 12 `article-summaries` documents are videos.
 * - **Preview.** Rendered here, server-side, so the `/summaries` client bundle
 *   carries no diff code.
 */

import {
  applyEdits,
  promptMaskBody,
  type EditOutcome,
  type IntegrateEdit,
  type IntegrateEditorVoice,
} from "../wiki/integrate-edits.ts";
import { lineDiff } from "../gardener/diff.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { stripSummaryFactcheckBlock } from "./factcheck-block.ts";
import { summaryCheckedRanges } from "./factcheck-body.ts";

// ---------------------------------------------------------------------------
// The source noun (D7)
// ---------------------------------------------------------------------------

/** What a summary's source is, as the attribution names it. */
export type SummarySourceNoun = "video" | "talk" | "post" | "article";

const HOST_NOUNS: readonly [RegExp, SummarySourceNoun][] = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "video"],
  [/(^|\.)vimeo\.com$/, "talk"],
  [/(^|\.)tiktok\.com$/, "video"],
  [/(^|\.)x\.com$|(^|\.)twitter\.com$/, "post"],
];

const COLLECTION_NOUNS: Readonly<Record<string, SummarySourceNoun>> = {
  "youtube-summaries": "video",
  "vimeo-summaries": "talk",
  "tiktok-summaries": "video",
  "x-articles": "post",
  "anthropic-summaries": "article",
  "article-summaries": "article",
};

/** The URL's host decides when it names a video or post site; otherwise the
 *  collection does, and anything unknown is an article. */
export function summarySourceNoun(url: string | null | undefined, collection: string): SummarySourceNoun {
  let host = "";
  try {
    host = url ? new URL(url).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  for (const [re, noun] of HOST_NOUNS) if (host && re.test(host)) return noun;
  return COLLECTION_NOUNS[collection] ?? "article";
}

/** The summary editor's voice: every acted-on verdict attributes. */
export function summaryEditorVoice(noun: SummarySourceNoun): IntegrateEditorVoice {
  const article = noun === "article" ? "an" : "a";
  return {
    role: `You are a meticulous summary editor applying fact-check results to a summary of ${article} ${noun}.`,
    given:
      `You are given the summary's text and the fact-check verdicts for some of its claims. ` +
      `The summary reports what the ${noun} says, so a correction must never put words in the ${noun}'s mouth.`,
    verdictRules: [
      `- ❌ (contradicted): ATTRIBUTE, never correct silently. The edited sentence must say what the ${noun} says and then what the sources say, in this shape: "The ${noun} says X; sources say Y ([hostname](url))." Cite the correcting source as a markdown link \`[hostname](url)\` right there in the sentence.`,
      `- ⚠️ (partly supported): attribute the same way: the claim stays the ${noun}'s ("the ${noun} says …"), followed by what the sources say — the missing precision or the caveat — with the same in-place source link.`,
      `- For ❌ and ⚠️ alike, the claim must READ as the ${noun}'s after the edit. If the sentence already names its source (the ${noun}, its speaker, "is described as", "claims"), keep that and add what the sources say. If it states the claim as plain fact, rewrite it to start from the ${noun} ("The ${noun} says …"), and make \`old\` cover the sentence from its start. Appending "Sources say …" after a sentence that still asserts the claim as fact is NOT attribution.`,
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
