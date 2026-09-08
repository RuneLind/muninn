/**
 * How much of a video a summary SHOWS — the reader's Selected/Detailed choice,
 * and the deterministic pass that holds the answer to it.
 *
 * It is a second axis, orthogonal to the summary KIND (`presets.ts`): Deep says
 * how hard the model thinks, this says how many frames the summary may quote and
 * what earns one. Both halves live here because they are one contract read
 * twice — the prompt states the caps, and {@link enforceVisualReferences} then
 * enforces exactly those numbers on the answer, so a model that quotes twelve
 * frames under an eight-frame policy cannot leave twelve in the stored document.
 *
 * **Why an enforcement pass at all.** Every frame reference is an ADDRESS the
 * route serves (`/api/frames/<source>/<id>/<sec>.jpg`), and only the frames the
 * summary quotes are copied out of the work dir before it dies
 * ({@link keepReferencedFrames}). So a quote of a second that was never
 * extracted, of another video, or of a non-canonical spelling (`047.jpg`) is a
 * promise of a picture nobody can ever serve — a broken image in the reader's
 * document, in the wiki source page drafted from it, and in the exported ZIP.
 * The model is asked not to invent paths; this is what makes that true.
 *
 * What a quote IS has exactly one definition, and it is not this module's:
 * {@link frameAddressRegExp} finds it and {@link parseFrameAddress} says what it
 * addresses, both from `frames.ts`, so what this pass counts and caps is what
 * {@link keepReferencedFrames} copies and the export rewrites. Two patterns for
 * one idea disagreed in both directions — a link-form quote and an alt carrying
 * `]` were served while being invisible here. Fenced blocks and inline code are
 * skipped on both sides ({@link markdownCodeRegions}).
 *
 * Two limits, stated rather than papered over:
 *
 *  - **A removed image can leave its caption behind — outside the appendix.**
 *    The removal takes the image's own line when nothing else is on it; a
 *    following prose sentence stays, because eating the next line would risk
 *    eating real content. Inside the appendix that residue is bounded instead:
 *    a section no entry survived is removed whole, heading and captions
 *    included, since a caption under a heading with no images left is not a
 *    reference section but a lie about one.
 *  - **The appendix rides the ingest body.** `appendTranscriptSection` caps the
 *    TRANSCRIPT alone, so `## Visual reference` adds to the posted body beyond
 *    that bound (~20 image lines and captions — kilobytes, against a 2 MiB
 *    transcript cap), and huginn ranks `similar` on the first 2000 characters of
 *    the summary string. Both are accepted, plan-stated consequences of putting
 *    the appendix before `## Transcript`.
 */

import { getLog } from "../logging.ts";
import { inProtectedRegion, markdownCodeRegions, type ProtectedRegion } from "../format/markdown-ast.ts";
import {
  MAX_INLINE_SLIDES,
  formatHms,
  frameAddressRegExp,
  frameQuoteTemplate,
  parseFrameAddress,
  type FrameSource,
  type FramesPromptPolicy,
} from "./frames.ts";

const log = getLog("summaries", "visual-detail");

/** The two visual-coverage policies, in the order a picker offers them. */
export const VISUAL_DETAIL_VALUES = ["selected", "detailed"] as const;

export type VisualDetail = (typeof VISUAL_DETAIL_VALUES)[number];

/**
 * What a caller that names no policy gets — including every client written
 * before this existed, which is why it is the CHEAPER of the two.
 */
export const DEFAULT_VISUAL_DETAIL: VisualDetail = "selected";

/**
 * The most distinct frames a `detailed` summary may carry, inline and appendix
 * together.
 *
 * An initial product limit to evaluate, not a measured optimum: 45 cadence
 * candidates over a 30-minute talk is the shape this was sized against, and 20
 * is roughly the point past which an appendix stops being a reference and
 * becomes the contact sheet. The INLINE half stays {@link MAX_INLINE_SLIDES} on
 * both policies — a body with more than eight images in it is no longer a
 * summary, whatever the appendix holds.
 */
export const MAX_DETAILED_VISUALS = 20;

/** The appendix heading, level 2 so it sits beside `## Transcript`. */
export const VISUAL_REFERENCE_HEADING = "## Visual reference";

/** What a picker calls each policy. Sent by the options endpoint, never re-spelled by a client. */
export const VISUAL_DETAIL_LABELS: Record<VisualDetail, string> = {
  selected: "Selected",
  detailed: "Detailed",
};

/** The picker's rows, in offer order — the `kinds` shape, so one client renderer serves both. */
export function visualDetailOptions(): Array<{ id: VisualDetail; label: string }> {
  return VISUAL_DETAIL_VALUES.map((id) => ({ id, label: VISUAL_DETAIL_LABELS[id] }));
}

/**
 * A line that IS the appendix heading, in every spelling a model reaches for.
 *
 * One exact byte sequence was the wrong predicate, and it failed in both
 * directions at once: `## Visual References`, `##Visual reference`,
 * `## **Visual reference**`, `### Visual reference` and `## Visual reference:`
 * each left the pass believing there was no appendix — so under `detailed`
 * every entry counted against the INLINE cap and the over-cap drops emptied a
 * section whose heading and captions stayed — while under `selected` the
 * section survived whole. Case, the level (2 or 3), bold decoration, a missing
 * space and a trailing colon are all accepted; the heading must still be the
 * whole line, because a sentence mentioning the appendix is not one.
 *
 * Exported so the replay harness reads the same rule the pass does rather than
 * re-typing a third spelling of it.
 */
export const VISUAL_REFERENCE_HEADING_RE =
  /^[ \t]{0,3}(#{2,3})[ \t]*(?:\*\*|__)?[ \t]*visual[ \t]+references?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/i;

/** Any ATX heading line, with its level — how the appendix section's END is found. */
const ANY_HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]/;

export function isVisualDetail(value: unknown): value is VisualDetail {
  return typeof value === "string" && (VISUAL_DETAIL_VALUES as readonly string[]).includes(value);
}

/** The two caps this policy is read by — the prompt states them, the pass enforces them. */
export function visualDetailCaps(detail: VisualDetail): { maxInline: number; maxTotal: number } {
  return detail === "detailed"
    ? { maxInline: MAX_INLINE_SLIDES, maxTotal: MAX_DETAILED_VISUALS }
    : { maxInline: MAX_INLINE_SLIDES, maxTotal: MAX_INLINE_SLIDES };
}

/**
 * The rules paragraph handed to {@link framesPromptSection}.
 *
 * The rubric is the plan's, and the one sentence that moved is the INCLUSION
 * test: "adds facts the transcript did not say" excluded exactly the frames a
 * talk is about — a speaker walking through a chart says the numbers out loud,
 * so the chart was disqualified by the very narration that made it worth
 * showing. It is now "helps explain, compare, verify or revisit", and a
 * presenter's face in the frame disqualifies nothing (the reference video is an
 * article walkthrough with an inset presenter, not a full-screen deck).
 *
 * The address shape comes from {@link frameQuoteTemplate}, i.e. from the route's
 * own layout — never spelled a second time here.
 */
export function visualDetailPolicy(
  detail: VisualDetail,
  source: FrameSource,
  id: string,
): FramesPromptPolicy {
  const caps = visualDetailCaps(detail);
  const quote = frameQuoteTemplate(source, id);
  const common =
    `Quote a frame as an image IN PLACE in the summary, right where the point it illustrates is made, ` +
    `using EXACTLY this markdown and nothing else in the alt text:\n${quote}\n` +
    `where <sec> is the integer in that frame's file name (t=00:23:10 is the file 1390.jpg) and HH:MM:SS ` +
    `is its time. Never invent a path: every <sec> must be one of the frames listed above.\n\n` +
    `Quote a frame when it HELPS the reader explain, compare, verify or revisit a substantive point. ` +
    `The speaker talking through a chart is a reason to show it, not a reason to leave it out. Charts, ` +
    `diagrams, code, tables and legible article or documentation excerpts are visual evidence; a ` +
    `presenter's face in the frame does not disqualify the rest of it. Do not quote a title card, a frame ` +
    `that is only a speaker, or two frames of the same thing.\n\n` +
    `Say what a frame shows as something the VIDEO shows — reproducing a screenshot is not verification, ` +
    `so a contentious claim stays a claim made in the video.`;

  if (detail === "selected") {
    return {
      ...caps,
      rules: `${common}\n\nAt most ${caps.maxInline} distinct frames in the whole summary.`,
    };
  }
  return {
    ...caps,
    rules:
      `${common}\n\n` +
      `Then, after the body of the summary and before any other section, add a \`${VISUAL_REFERENCE_HEADING}\` ` +
      `section holding the frames worth keeping that did not earn a place inline. Order it by timestamp. Each ` +
      `entry is the image on its own line, followed by one short sentence of ordinary prose saying why it is ` +
      `there — the caption is prose, never part of the alt text:\n\n` +
      `${quote}\nOne sentence on what this frame is for.\n\n` +
      `At most ${caps.maxInline} frames inline and ${caps.maxTotal} distinct frames in the summary as a whole, ` +
      `the appendix included. Never repeat a frame between the body and the appendix, never pad toward the ` +
      `limit, and never keep two frames of the same slide at slightly different scroll positions.`,
  };
}

/** What one enforcement pass did, in the numbers a caller logs. */
export interface VisualReferenceOutcome {
  /** The summary with every reference this pass refused removed. */
  readonly text: string;
  /** Distinct EXTRACTED seconds the model quoted, before any cap applied. */
  readonly selected: number[];
  /** Distinct seconds the returned text quotes — what will be copied and served. */
  readonly referenced: number[];
  /** A quote of a second never extracted, of another video, or of an unservable spelling. */
  readonly droppedInvalid: number;
  /** A second quoted more than once. */
  readonly droppedDuplicate: number;
  /** A valid, distinct quote past `maxInline` or `maxTotal`. */
  readonly droppedOverCap: number;
}

/** One frame quote found in a summary: where it is, and what it addresses. */
interface FrameQuoteMatch {
  readonly start: number;
  readonly end: number;
  readonly path: string;
  /** Where the alt text (or a link's label) sits, so a wrong timestamp can be corrected in place. */
  readonly altStart: number;
  readonly altEnd: number;
  /** Whether this is an IMAGE (`![…]`) rather than a plain link to a frame. */
  readonly isImage: boolean;
  /** Null when the path is not an address this capture could ever serve. */
  readonly ref: { id: string; sec: number } | null;
}

/** A link WRAPPING an image — `[![alt](frame)](url)` — as seen from the image's end. */
const LINK_WRAP_TAIL_RE = /^\]\([^)\s]*(?:[ \t]+"[^"\n]*")?\)/;

/**
 * Every quote of a frames address in the summary's PROSE, in document order.
 *
 * The pattern is {@link frameAddressRegExp}, i.e. the same one
 * {@link keepReferencedFrames} keeps by and the export rewrites by — so what
 * this pass counts, caps and removes is exactly what would be copied and
 * served. It was two patterns for one round, and they disagreed in both
 * directions: a link-form quote and an alt carrying `]` were copied and served
 * while being invisible here (uncapped, and an invented second the pass could
 * not remove).
 *
 * Two things it does that the pattern alone cannot:
 *
 *  - **fenced blocks and inline code are skipped** ({@link markdownCodeRegions},
 *    the fact-check strip's walk). A quote inside a fence is a documented
 *    example — the model shown the address shape sometimes echoes it in one —
 *    and counting it spends a cap slot on a picture no reader sees, copies a
 *    JPEG for it, and lets a fenced block near the top exhaust the whole policy.
 *  - **a link WRAPPING an image is one quote**, taken whole. `[![alt](frame)](url)`
 *    removed at the image alone leaves `[](url)`, which renders as a live link
 *    with no label.
 */
function findFrameQuotes(summary: string, source: FrameSource, code: readonly ProtectedRegion[]): FrameQuoteMatch[] {
  const out: FrameQuoteMatch[] = [];
  const re = frameAddressRegExp(source);
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary)) !== null) {
    if (inProtectedRegion(m.index, code)) continue;
    const [whole, open, path] = m as unknown as [string, string, string];
    const isImage = open.startsWith("!");
    let start = m.index;
    let end = m.index + whole.length;
    // `open` is `![` or `[` … `](`, so the label runs between them.
    const altStart = start + open.indexOf("[") + 1;
    const altEnd = start + open.length - "](".length;
    if (isImage && summary[start - 1] === "[") {
      const tail = LINK_WRAP_TAIL_RE.exec(summary.slice(end));
      if (tail) {
        start -= 1;
        end += tail[0].length;
      }
    }
    out.push({ start, end, path, altStart, altEnd, isImage, ref: parseFrameAddress(path, source) });
  }
  return out;
}

/** One splice this pass will make: a quote removal, a whole-section cut, or an alt correction. */
type Edit =
  | { kind: "quote"; start: number; end: number }
  | { kind: "block"; start: number; end: number }
  | { kind: "replace"; start: number; end: number; text: string };

/**
 * What a line may hold BESIDES a quote and still count as holding nothing.
 *
 * The residue of a removed image, enumerated rather than guessed at, because
 * each of these renders as visible damage on its own: a bullet or a numbered
 * list marker with no item, a heading marker with no heading, a bold label
 * (`**Figure:**`) with nothing to label, a blockquote arrow, and the dash or
 * colon a caption was joined on with.
 */
const LINE_RESIDUE_RE =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[*+\-]|\d{1,3}[.)])[ \t]*)?(?:#{1,6}[ \t]*)?(?:\*\*[^*\n]*\*\*[ \t]*)?[\s:.\-—–]*$/;

/**
 * Apply the pass's splices back to front, so no offset moves under a later one.
 *
 * A `quote` whose LINE holds nothing else takes the whole line with it
 * ({@link LINE_RESIDUE_RE}); anything else loses only the quote's own markdown,
 * since eating the prose around it would eat real content. A `block` is already
 * a line range and is cut as it stands.
 */
function applyEdits(summary: string, edits: readonly Edit[]): string {
  let text = summary;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    if (e.kind === "replace") {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
      continue;
    }
    if (e.kind === "block") {
      text = text.slice(0, e.start) + text.slice(e.end);
      continue;
    }
    const lineStart = text.lastIndexOf("\n", e.start - 1) + 1;
    let lineEnd = text.indexOf("\n", e.end);
    if (lineEnd === -1) lineEnd = text.length;
    const rest = text.slice(lineStart, e.start) + text.slice(e.end, lineEnd);
    if (LINE_RESIDUE_RE.test(rest)) {
      const cut = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      text = text.slice(0, lineStart) + text.slice(cut);
    } else {
      text = text.slice(0, e.start) + text.slice(e.end);
    }
  }
  return text;
}

/** Where the appendix is: its heading line, and the whole section it opens. */
interface AppendixSection {
  /** Offset of the heading LINE's first character — the boundary inline/appendix is decided by. */
  readonly start: number;
  /** Offset just past the section, i.e. the start of the next heading of the same level or above. */
  readonly end: number;
}

/**
 * The `## Visual reference` section, located in PROSE.
 *
 * Fence-aware for the reason the quote walk is: a fenced block quoting the
 * appendix's own shape — which the `detailed` rules paragraph shows the model —
 * would otherwise be read as the appendix starting at the top of the summary,
 * and every inline quote after it would be an "appendix" entry with the inline
 * cap never applying at all.
 *
 * The section ENDS at the next heading of the same level or above (`## Transcript`
 * is the one that follows it in a stored capture), or at the end of the text.
 */
function findAppendixSection(summary: string, code: readonly ProtectedRegion[]): AppendixSection | null {
  const lines = summary.split("\n");
  let offset = 0;
  let start = -1;
  let level = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (inProtectedRegion(lineStart, code)) continue;
    if (start < 0) {
      const m = VISUAL_REFERENCE_HEADING_RE.exec(line);
      if (m) {
        start = lineStart;
        level = m[1]!.length;
      }
      continue;
    }
    const heading = ANY_HEADING_RE.exec(line);
    if (heading && heading[1]!.length <= level) return { start, end: lineStart };
  }
  return start < 0 ? null : { start, end: summary.length };
}

/**
 * Every clock-shaped run in an alt text — what a quote CLAIMS its second is.
 *
 * Deliberately loose about the field widths and read by ARITHMETIC below rather
 * than by the pattern: an alt is model-written, and `00:00:137` is a real thing
 * to write for the file `137.jpg`. A `[0-5]\d`-strict pattern matched the
 * `00:00` prefix of it, decided the quote claimed second 0, and rewrote the alt
 * to `00:02:17:137` — a correction that invented a disagreement and then wrote
 * it down. A run needs at least one colon — `MM:SS` or `HH:MM:SS`, never a bare
 * `SS`, since an alt's lone number is as likely a slide or a figure number as a
 * time — and is then read by its field count, so `00:00:137` and `00:02:17` are
 * the same claim and neither is touched. Accepted consequence: a clock-
 * shaped number in an alt that is NOT the frame's time is rewritten too; the alt
 * of a frame quote is a caption for that frame, and the prompt's template for it
 * is `Slide at HH:MM:SS`.
 */
const ALT_TIMESTAMP_RE = /\d{1,6}(?::\d{1,6}){1,2}/g;

/**
 * The alt text this quote should carry, or null when it already agrees.
 *
 * A `![Slide at 00:24:32](…/1472.jpg)` whose alt names a DIFFERENT time than the
 * file is a caption that lies about the picture under it, and the pass is the
 * one place that knows both numbers. The timestamp is corrected in place rather
 * than the whole alt replaced, so any words the model wrote around it survive;
 * an alt with no timestamp claims nothing and is left alone.
 */
function correctedAlt(alt: string, sec: number): string | null {
  const want = formatHms(sec);
  const fixed = alt.replace(ALT_TIMESTAMP_RE, (whole: string) => {
    const parts = whole.split(":").map(Number);
    const claimed = parts.reduce((total, part) => total * 60 + part, 0);
    return claimed === sec ? whole : want;
  });
  return fixed === alt ? null : fixed;
}

/**
 * Hold the summary to this capture's frame manifest and this policy's caps.
 *
 * Every decision is deterministic and in document order, so two runs over one
 * answer produce one text: an unservable quote goes, a repeat of a second
 * already kept goes, and a valid distinct quote past `maxInline` (inline) or
 * `maxTotal` (anywhere) goes. Under `selected` there is no appendix, so every
 * quote counts against the one cap.
 *
 * Runs on EVERY capture, frames on or off: with nothing extracted, a frames
 * address is by definition invented, and a transcript-only summary must not
 * promise pictures.
 */
export function enforceVisualReferences(input: {
  summary: string;
  source: FrameSource;
  videoId: string;
  /** The seconds actually extracted for this capture. */
  extracted: readonly number[];
  detail: VisualDetail;
}): VisualReferenceOutcome {
  const { summary, source, videoId, detail } = input;
  const caps = visualDetailCaps(detail);
  const available = new Set(input.extracted);
  const code = markdownCodeRegions(summary);
  const quotes = findFrameQuotes(summary, source, code);
  const appendix = findAppendixSection(summary, code);
  // Nothing to hold the summary to only when there is neither a quote nor a
  // section. An appendix with NO quote in it at all is the emptied-appendix
  // case one step earlier — a heading over captions for pictures that were
  // never there — and it is cut under EITHER policy, so returning here on the
  // quote count alone left `detailed` shipping it verbatim.
  if (quotes.length === 0 && appendix === null) {
    return {
      text: summary,
      selected: [],
      referenced: [],
      droppedInvalid: 0,
      droppedDuplicate: 0,
      droppedOverCap: 0,
    };
  }

  // Where the appendix starts, when the policy HAS one. Everything at or past
  // that offset is an appendix entry; everything before it is inline. Under
  // `selected` there is no appendix at all: a section the model wrote anyway is
  // cut whole below, so nothing in it is an entry to keep.
  const appendixAt = detail === "detailed" && appendix ? appendix.start : Number.POSITIVE_INFINITY;
  const cutAppendix = detail === "selected" && appendix !== null;
  const inCutSection = (q: FrameQuoteMatch): boolean =>
    cutAppendix && appendix !== null && q.start >= appendix.start && q.start < appendix.end;

  const drop: FrameQuoteMatch[] = [];
  const edits: Edit[] = [];
  const selected = new Set<number>();
  const kept = new Set<number>();
  let inlineKept = 0;
  let droppedInvalid = 0;
  let droppedDuplicate = 0;
  let droppedOverCap = 0;

  for (const q of quotes) {
    if (q.ref === null || q.ref.id !== videoId || !available.has(q.ref.sec)) {
      droppedInvalid++;
      drop.push(q);
      continue;
    }
    selected.add(q.ref.sec);
    // An entry of a section that is about to go is over this policy's cap by
    // definition — `selected` has no appendix, so there is no room for it.
    if (inCutSection(q)) {
      droppedOverCap++;
      continue;
    }
    if (kept.has(q.ref.sec)) {
      droppedDuplicate++;
      drop.push(q);
      continue;
    }
    const inline = q.start < appendixAt;
    if (kept.size >= caps.maxTotal || (inline && inlineKept >= caps.maxInline)) {
      droppedOverCap++;
      drop.push(q);
      continue;
    }
    kept.add(q.ref.sec);
    if (inline) inlineKept++;
    // A kept quote whose alt names a time other than its own file is corrected
    // here, where both numbers are known.
    if (q.isImage) {
      const alt = correctedAlt(summary.slice(q.altStart, q.altEnd), q.ref.sec);
      if (alt !== null) edits.push({ kind: "replace", start: q.altStart, end: q.altEnd, text: alt });
    }
  }

  // The appendix section goes WHOLE — heading, entries and captions — in the
  // two states where what is left of it is not a reference section: `selected`,
  // which has no appendix, and a `detailed` appendix no entry survived. Bounding
  // the orphan-caption residue to the appendix is the point: elsewhere a removed
  // image's caption is left standing rather than risking real prose, but a
  // caption under a heading with no images left is the whole section lying.
  const appendixEmptied =
    detail === "detailed" &&
    appendix !== null &&
    !quotes.some((q) => q.start >= appendix.start && q.start < appendix.end && !drop.includes(q));
  if (appendix && (cutAppendix || appendixEmptied)) {
    edits.push({ kind: "block", start: appendix.start, end: appendix.end });
    log.info("Removed the {detail} summary's `{heading}` section of {source} {id} — {why}", {
      detail,
      heading: VISUAL_REFERENCE_HEADING,
      source: source.name,
      id: videoId,
      why: cutAppendix ? "this policy has no appendix" : "no entry survived the pass",
    });
  }
  // A quote inside a section that is being cut is already gone with it; a
  // splice inside a `block` would be applied to text the block also removes.
  for (const q of drop) {
    if (appendix && (cutAppendix || appendixEmptied) && q.start >= appendix.start && q.start < appendix.end) continue;
    edits.push({ kind: "quote", start: q.start, end: q.end });
  }

  if (drop.length > 0) {
    log.warn(
      "The {source} summary of {id} quoted {dropped} frame reference(s) this capture will not serve " +
        "({invalid} invalid, {duplicate} repeated, {overCap} past the {detail} cap) — removed",
      {
        source: source.name,
        id: videoId,
        dropped: drop.length,
        invalid: droppedInvalid,
        duplicate: droppedDuplicate,
        overCap: droppedOverCap,
        detail,
      },
    );
  }

  return {
    text: edits.length === 0 ? summary : applyEdits(summary, edits),
    selected: [...selected].sort((a, b) => a - b),
    referenced: [...kept].sort((a, b) => a - b),
    droppedInvalid,
    droppedDuplicate,
    droppedOverCap,
  };
}

/**
 * Remove this video's quotes of the given seconds — the repair for a frame the
 * summary references and {@link keepReferencedFrames} could not copy.
 *
 * The copy is the last thing between a reference and a served file, so a failed
 * one leaves text promising a picture the route will 404. Called with whatever
 * the copy did NOT keep, it makes the stored text true again.
 */
export function dropFrameReferences(
  summary: string,
  source: FrameSource,
  videoId: string,
  seconds: readonly number[],
): { text: string; removed: number } {
  if (seconds.length === 0) return { text: summary, removed: 0 };
  const wanted = new Set(seconds);
  const drop = findFrameQuotes(summary, source, markdownCodeRegions(summary)).filter(
    (q) => q.ref !== null && q.ref.id === videoId && wanted.has(q.ref.sec),
  );
  if (drop.length === 0) return { text: summary, removed: 0 };
  return {
    text: applyEdits(
      summary,
      drop.map((q) => ({ kind: "quote" as const, start: q.start, end: q.end })),
    ),
    removed: drop.length,
  };
}
