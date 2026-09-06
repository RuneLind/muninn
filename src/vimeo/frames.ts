/**
 * Slides in the summary (v2 PR 4, cadence tier) — the VIMEO half.
 *
 * Everything source-neutral lives in `src/summaries/frames.ts`: the cadence,
 * the served root, the URL shape, the prompt section, the id gate, the kept-
 * frame copy and removal, the ffmpeg grab. This module is what only Vimeo has —
 * a DASH manifest instead of a file on disk — and it imports the rest. The
 * dependency is one-way: the seam never imports this module.
 *
 * What is fetched: for each cadence time, the ONE 6 s segment covering it
 * (`downloadRendition` with a single index — init + segment, ~370 KB at 720p),
 * then one ffmpeg call seeks `t - segment.start` into that file and writes one
 * JPEG. 60 frames ≈ 22 MB of fetches and 60 sub-second ffmpeg runs; the whole
 * pass lives in one budget. A segment shared by two ticks is fetched once.
 *
 * Cadence, not scene detection, deliberately: the plan's skip trigger asks for
 * two Norwegian talks captured at cadence first, and scene detection is built
 * only if fewer than half the inline slides turn out to add nothing the
 * transcript already said. Conference slides change every 1–3 minutes, so a
 * ~40 s cadence sees nearly every slide and shows some twice; the model is told
 * to quote a slide only where it adds something, capped at `MAX_INLINE_SLIDES`.
 */

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { getLog } from "../logging.ts";
import {
  cadenceTimes,
  ffmpegGrabFrame,
  framesTimeoutFor,
  type CaptureFrame,
  type GrabFrame,
} from "../summaries/frames.ts";
import {
  chooseRepresentation,
  downloadRendition,
  segmentIndexAt,
  type VimeoManifest,
  type VimeoRepresentation,
} from "./media.ts";

const log = getLog("vimeo", "frames");

/** The rendition frames are pulled from. A slide's text is legible at 720p; 1080p is 1.6× the bytes. */
export const VIMEO_FRAME_HEIGHT = 720;

export interface ExtractFramesOptions {
  /** Test seam for the segment fetches. */
  fetchImpl?: typeof fetch;
  /** Test seam for the frame grab; production spawns ffmpeg. */
  grabFrame?: GrabFrame;
  /** Whole-pass budget; default 30 s + 3 s per frame. */
  timeoutMs?: number;
}

/**
 * One frame per cadence time, out of the {@link VIMEO_FRAME_HEIGHT} rendition.
 *
 * A failure on ONE frame fails the pass: a summary that quotes slide 23 but
 * never saw slide 24 is a partial record presented as complete, and the caller
 * (the summarizer) degrades the WHOLE capture to transcript-only with a warn,
 * the TikTok precedent. Returns `[]` with a warn when the manifest has no
 * video rendition.
 */
export async function extractCadenceFrames(
  input: {
    manifestUrl: string;
    manifest: VimeoManifest;
    durationSec: number;
    workDir: string;
  },
  opts: ExtractFramesOptions = {},
): Promise<CaptureFrame[]> {
  const rep = chooseRepresentation(input.manifest, { kind: "video", height: VIMEO_FRAME_HEIGHT });
  if (!rep) {
    log.warn("Vimeo manifest has no video rendition — no frames");
    return [];
  }
  const times = cadenceTimes(input.durationSec);
  if (times.length === 0) return [];
  const grab = opts.grabFrame ?? ffmpegGrabFrame;
  const timeoutMs = opts.timeoutMs ?? framesTimeoutFor(times.length);
  const deadline = Date.now() + timeoutMs;

  const segmentFiles = new Map<number, string>();
  const frames: CaptureFrame[] = [];
  for (const t of times) {
    if (Date.now() >= deadline) {
      throw new Error(`Frame extraction timed out after ${timeoutMs}ms (${frames.length}/${times.length} frames)`);
    }
    const index = segmentIndexAt(rep, t);
    let segmentFile = segmentFiles.get(index);
    if (!segmentFile) {
      segmentFile = join(input.workDir, `segment-${index}.mp4`);
      await downloadRendition(input.manifestUrl, input.manifest, rep, [index], segmentFile, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      segmentFiles.set(index, segmentFile);
    }
    const seg = rep.segments[index]!;
    // Seek RELATIVE to the segment's start (input `-ss` on this fMP4 is
    // measured from its `start_time`), and never past its last frame.
    const offset = Math.max(0, Math.min(t - seg.start, seg.end - seg.start - 0.04));
    const out = join(input.workDir, `${t}.jpg`);
    await grab(segmentFile, offset, out, VIMEO_FRAME_HEIGHT);
    frames.push({ path: out, tSeconds: t });
  }
  // The segments are spent: the work dir is what the model is handed as
  // --add-dir, and holds only the JPEGs from here on.
  await Promise.all([...segmentFiles.values()].map((f) => rm(f, { force: true }).catch(() => {})));
  log.info("Extracted {n} cadence frames from {rep} ({segments} segments fetched)", {
    n: frames.length,
    rep: repLabel(rep),
    segments: segmentFiles.size,
  });
  return frames;
}

function repLabel(rep: VimeoRepresentation): string {
  return rep.height ? `${rep.width}x${rep.height}` : rep.id;
}
