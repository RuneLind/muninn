/**
 * Everything a YouTube capture does BETWEEN the model's answer and the ingest —
 * one function, so a re-run cannot do it differently.
 *
 * The tail is not bookkeeping. It parses the envelope, holds the summary's frame
 * references to this capture's own manifest and this policy's caps, copies the
 * frames the text quotes out of the dying work dir, and then makes the text true
 * about whatever the copy did NOT keep. Skip any step and the stored document
 * promises pictures the route will 404 — which is exactly what a re-run that
 * re-implemented the tail would ship, silently, because the model's answer looks
 * fine either way.
 *
 * What it deliberately does NOT do is the JOB's: the ingest, `completeJob`, the
 * source draft and the status moves stay in `summarizer.ts`, because a re-run
 * writes into a different job. The one job-store touch the tail owns the TIMING
 * of is the category, which is why it is a callback rather than a return value:
 * the live card gets its category before the frame copies are awaited, exactly
 * as it did when this was inline.
 */

import { getLog } from "../logging.ts";
import { parseSummaryResponse } from "../utils/summary-parser.ts";
import {
  YOUTUBE_FRAME_SOURCE,
  keepReferencedFrames,
  type CaptureFrame,
} from "../summaries/frames.ts";
import {
  dropFrameReferences,
  enforceVisualReferences,
  type VisualDetail,
} from "../summaries/visual-detail.ts";
import {
  appendLinksSection,
  prepareLinksAnswer,
  renderLinksSection,
  type LinkLine,
  type LinksPick,
} from "../summaries/links-section.ts";
import { withRepoDetails, type RepoLineLookup } from "../summaries/github-repo.ts";
import { isPromoClass, linkCandidates, linkLineIcon, type DescriptionLink } from "./description-links.ts";

// The CATEGORY stays the vertical's own, not this file's: the JSONL sink is
// queried by category, and moving code between files must not move the records
// a saved query already selects. Pinned in `finish.test.ts`.
const log = getLog("youtube", "summarizer");

export interface FinishYouTubeSummaryInput {
  /** The RAW model text, envelope and all. */
  readonly raw: string;
  /** Named in every log line this tail writes. */
  readonly jobId: string;
  readonly videoId: string;
  /** What this capture actually extracted — the manifest the text is held to. */
  readonly frames: readonly CaptureFrame[];
  readonly visualDetail: VisualDetail;
  /** Where quoted frames are kept; default `framesRootDir()`. */
  readonly framesRoot?: string;
  /** Told the parsed category at the same instant the inline tail told the job store. */
  readonly onCategory?: (category: string) => void;
  /**
   * The description's classified links. With them the tail resolves the
   * model's `LINKS:` pick and appends the `## Links` section; without them (a
   * re-run, a capture with no description) it appends nothing and still strips
   * a stray `LINKS:` line.
   */
  readonly links?: readonly DescriptionLink[];
  /**
   * Looks a GitHub repo line up (`githubRepoLookup`). Absent, a repo link gets
   * the plain line — every caller but the capture itself (the re-run hands in
   * no links at all, and the tests stay off the network).
   */
  readonly repoLine?: RepoLineLookup;
}

/** What the `## Links` step decided, for the trace and the completion line. */
export interface FinishedLinks {
  /** The rendered section, or `null` when no line qualified. */
  readonly section: string | null;
  /** The section's lines, in order. */
  readonly lines: LinkLine[];
  /** Source URLs — in the section by rule. */
  readonly sources: number;
  /** Repo/candidate ids the model picked that exist in the list. */
  readonly picked: number[];
  /** Ids the model named that the list does not have — dropped. */
  readonly unknownIds: number[];
  /** Creator and social URLs left out and counted. */
  readonly omitted: number;
  /** What the model's line said: ids, `none`, or `null` for no line at all. */
  readonly pick: LinksPick;
}

/**
 * The `## Links` section for these links and this pick: every `source` URL by
 * rule, a `repo` or `candidate` URL only when its id was picked, creator and
 * social URLs counted and never listed (D12).
 */
export function buildDescriptionLinksSection(links: readonly DescriptionLink[], pick: LinksPick): FinishedLinks {
  const candidates = linkCandidates(links);
  const ids = new Set(candidates.map((c) => c.id));
  const asked = Array.isArray(pick) ? pick : [];
  const picked = asked.filter((id) => ids.has(id));
  const unknownIds = asked.filter((id) => !ids.has(id));
  const chosen = new Set(picked);
  const lines = candidates
    .filter((c) => c.cls === "source" || chosen.has(c.id))
    .map((c) => ({
      icon: linkLineIcon(c.url, c.cls),
      title: c.title,
      url: c.url,
      detail: c.attribution,
      provenance: "from description",
    }));
  const omitted = links.filter((l) => isPromoClass(l.cls)).length;
  return {
    section: renderLinksSection({ lines, omitted }),
    lines,
    sources: candidates.filter((c) => c.cls === "source").length,
    picked: picked.filter((id) => candidates.find((c) => c.id === id)!.cls !== "source"),
    unknownIds,
    omitted,
    pick,
  };
}

export interface FinishedYouTubeSummary {
  /** The text to store, ingest and draft from — never the parser's own output. */
  readonly summary: string;
  readonly category: string;
  /** Distinct EXTRACTED seconds the model quoted, before any cap applied. */
  readonly selected: number[];
  /** Distinct seconds the enforcement pass kept. */
  readonly referenced: number[];
  /** Seconds actually copied to the served root. */
  readonly kept: number[];
  /** Referenced seconds the copy did not keep — their quotes were removed. */
  readonly unserved: number[];
  /** The `## Links` step's outcome; `null` when no links were handed in. */
  readonly links: FinishedLinks | null;
}

export async function finishYouTubeSummary(
  input: FinishYouTubeSummaryInput,
): Promise<FinishedYouTubeSummary> {
  const { raw, jobId, videoId, frames, visualDetail } = input;

  // The summary STREAMED to the job card delta by delta while the model wrote
  // it, so this rewrite happens after the reader has already seen the unrewritten
  // text. That is what `completeReplacesText` + `completeCarriesSummary` are for
  // (`state.ts`, `youtube-routes.ts`): the terminal event carries the rewritten
  // body, so the live card swaps it in and an SSE replay after a reload serves it
  // too. Everything downstream is built from `summary` below, never from `parsed`.
  // The `LINKS:` line comes out BEFORE the envelope parse, wherever the model
  // put it, and a model-written `## Links` heading is demoted — so the stored
  // body never carries the line nor a second `## Links`.
  const prepared = prepareLinksAnswer(raw);
  const { category, summary: parsed } = parseSummaryResponse(prepared.text);
  input.onCategory?.(category);

  const enforced = enforceVisualReferences({
    summary: parsed,
    source: YOUTUBE_FRAME_SOURCE,
    videoId,
    extracted: frames.map((f) => f.tSeconds),
    detail: visualDetail,
  });
  let summary = enforced.text;

  // The frames the summary QUOTES are copied out of the work dir to the served
  // root before the work dir dies; the rest go with it. The list is the
  // enforcement pass's OWN answer, not a second reading of the text: the pass has
  // just decided which quotes may be served, and a re-parse is how the two come
  // to disagree. Inside its own try: a copy failure must not fail a capture whose
  // text is already on the reader's screen — and the copy is per file, so one
  // missing frame costs its own reference and no other.
  let kept: number[] = [];
  let copyFailed = false;
  if (frames.length > 0) {
    try {
      kept = await keepReferencedFrames(
        summary,
        YOUTUBE_FRAME_SOURCE,
        videoId,
        frames,
        input.framesRoot,
        enforced.referenced,
      );
    } catch (err) {
      copyFailed = true;
      log.error("YouTube capture {jobId}: keeping quoted frames failed: {error}", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The copy is the last thing between a reference and a served file, so whatever
  // it did NOT keep is a promise of a picture the route will 404 — including the
  // case where it threw and kept nothing at all. The text is made true before it
  // is stored, ingested or drafted from.
  const unserved = enforced.referenced.filter((sec) => !kept.includes(sec));
  if (unserved.length > 0) {
    const repaired = dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, videoId, unserved);
    summary = repaired.text;
    log.warn(
      "YouTube capture {jobId}: {n} quoted frame(s) were not copied ({seconds}) — their references were " +
        "removed from the stored summary{because}",
      {
        jobId,
        videoId,
        n: repaired.removed,
        seconds: unserved.join(", "),
        because: copyFailed ? " (the copy failed)" : "",
      },
    );
  }

  // The section is the summary's LAST block, after any `## Visual reference`
  // appendix (D12 order); `## Transcript` is appended later by the caller.
  let links: FinishedLinks | null = null;
  if (input.links !== undefined) {
    links = buildDescriptionLinksSection(input.links, prepared.pick);
    if (input.repoLine !== undefined) {
      // A GitHub repo line carries its description, language, license and
      // stars (D7); a lookup that fails leaves the plain line.
      const lines = await withRepoDetails(links.lines, input.repoLine);
      links = { ...links, lines, section: renderLinksSection({ lines, omitted: links.omitted }) };
    }
    summary = appendLinksSection(summary, links.section);
    if (links.unknownIds.length > 0) {
      log.warn("YouTube capture {jobId}: the LINKS line named id(s) {ids} the list does not have — dropped", {
        jobId,
        ids: links.unknownIds.join(", "),
      });
    }
  }

  return { summary, category, selected: enforced.selected, referenced: enforced.referenced, kept, unserved, links };
}
