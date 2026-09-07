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
 * Two limits, stated rather than papered over:
 *
 *  - **A removed image can leave its caption behind.** The removal takes the
 *    image's own line when nothing else is on it; an appendix entry's following
 *    prose sentence stays. Eating the next line would risk eating real content,
 *    and a caption with no image is honest about what happened where a silently
 *    deleted paragraph would not be.
 *  - **The appendix rides the ingest body.** `appendTranscriptSection` caps the
 *    TRANSCRIPT alone, so `## Visual reference` adds to the posted body beyond
 *    that bound (~20 image lines and captions — kilobytes, against a 2 MiB
 *    transcript cap), and huginn ranks `similar` on the first 2000 characters of
 *    the summary string. Both are accepted, plan-stated consequences of putting
 *    the appendix before `## Transcript`.
 */

import { getLog } from "../logging.ts";
import {
  FRAME_FILE_RE,
  MAX_INLINE_SLIDES,
  escapeRegExp,
  frameQuoteTemplate,
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

/** That heading as the renderer sees it — its own line, nothing after it. */
const VISUAL_REFERENCE_HEADING_RE = /^##[ \t]+Visual reference[ \t]*$/m;

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
  /** Null when the path is not an address this capture could ever serve. */
  readonly ref: { id: string; sec: number } | null;
}

/**
 * Every markdown IMAGE whose target is a frames address — of this source or of
 * the legacy prefix its documents were written with.
 *
 * Deliberately wider than {@link frameQuoteRegExp}, which matches only the
 * `(…)` half of a quote of ONE known video: this has to FIND the references to
 * refuse, including a quote of another video and a quote of another source, both
 * of which are broken images in this document. The path is captured whole and
 * parsed in code rather than pulled apart by more regex.
 */
function frameImagePattern(source: FrameSource): RegExp {
  const prefixes = ["/api/frames/", ...(source.legacyUrlPrefix ? [source.legacyUrlPrefix] : [])];
  return new RegExp(
    `!\\[[^\\]\\n]*\\]\\(((?:${prefixes.map(escapeRegExp).join("|")})[^)\\s]*)(?:\\s+"[^"\\n]*")?\\)`,
    "g",
  );
}

/**
 * The video and whole second a frames path addresses, or null when it addresses
 * nothing servable.
 *
 * Null covers all four ways a quote can be a broken promise: another source's
 * frames, a path that is not `<id>/<sec>.jpg`, a file name outside
 * {@link FRAME_FILE_RE}, and a NON-CANONICAL spelling — the file is `47.jpg` and
 * the route serves exactly that, so `047.jpg` 404s and counting it would report
 * a frame the reader never gets (the `referencedFrameSeconds` rule).
 */
export function parseFrameQuotePath(
  path: string,
  source: FrameSource,
): { id: string; sec: number } | null {
  const current = `/api/frames/${source.name}/`;
  let tail: string | null = null;
  if (path.startsWith(current)) tail = path.slice(current.length);
  else if (source.legacyUrlPrefix && path.startsWith(source.legacyUrlPrefix)) {
    tail = path.slice(source.legacyUrlPrefix.length);
  }
  if (tail === null) return null;
  const parts = tail.split("/");
  if (parts.length !== 2) return null;
  const [id, file] = parts as [string, string];
  if (id === "" || !FRAME_FILE_RE.test(file)) return null;
  const digits = file.slice(0, -".jpg".length);
  if (String(Number(digits)) !== digits) return null;
  return { id, sec: Number(digits) };
}

function findFrameQuotes(summary: string, source: FrameSource): FrameQuoteMatch[] {
  const out: FrameQuoteMatch[] = [];
  const re = frameImagePattern(source);
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary)) !== null) {
    const path = m[1]!;
    out.push({ start: m.index, end: m.index + m[0].length, path, ref: parseFrameQuotePath(path, source) });
  }
  return out;
}

/**
 * Cut the given quotes out of the summary.
 *
 * A quote whose LINE holds nothing else — an image on its own line, or a list
 * bullet around one — takes the whole line with it, since a bullet with no
 * content is visible damage. Anything else loses just the image markdown.
 * Applied back to front so no offset moves under a later splice.
 */
function removeQuotes(summary: string, quotes: readonly FrameQuoteMatch[]): string {
  let text = summary;
  for (const q of [...quotes].sort((a, b) => b.start - a.start)) {
    const lineStart = text.lastIndexOf("\n", q.start - 1) + 1;
    let lineEnd = text.indexOf("\n", q.end);
    if (lineEnd === -1) lineEnd = text.length;
    const rest = text.slice(lineStart, q.start) + text.slice(q.end, lineEnd);
    // Whitespace, a list marker or a dangling dash is not content.
    if (/^[\s>*+\-—–:.]*$/.test(rest)) {
      const cut = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      text = text.slice(0, lineStart) + text.slice(cut);
    } else {
      text = text.slice(0, q.start) + text.slice(q.end);
    }
  }
  return text;
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
  const quotes = findFrameQuotes(summary, source);
  if (quotes.length === 0) {
    return {
      text: summary,
      selected: [],
      referenced: [],
      droppedInvalid: 0,
      droppedDuplicate: 0,
      droppedOverCap: 0,
    };
  }

  // Where the appendix starts, when the policy has one. Everything at or past
  // that offset is an appendix entry; everything before it is inline.
  const headingMatch = detail === "detailed" ? VISUAL_REFERENCE_HEADING_RE.exec(summary) : null;
  const appendixAt = headingMatch ? headingMatch.index : Number.POSITIVE_INFINITY;

  const drop: FrameQuoteMatch[] = [];
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
    text: drop.length === 0 ? summary : removeQuotes(summary, drop),
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
  const drop = findFrameQuotes(summary, source).filter(
    (q) => q.ref !== null && q.ref.id === videoId && wanted.has(q.ref.sec),
  );
  if (drop.length === 0) return { text: summary, removed: 0 };
  return { text: removeQuotes(summary, drop), removed: drop.length };
}
