/**
 * Slides in the summary (v2 PR 4, cadence tier): one 720p frame every ~40 s of
 * talk, pulled through the media seam, read by the model, and quoted INLINE in
 * the summary as `![Slide at HH:MM:SS](/api/vimeo/frames/<videoId>/<sec>.jpg)`.
 *
 * Cadence, not scene detection, deliberately: the plan's skip trigger asks for
 * two Norwegian talks captured at cadence first, and scene detection is built
 * only if fewer than half the inline slides turn out to add nothing the
 * transcript already said. Conference slides change every 1–3 minutes, so a
 * ~40 s cadence sees nearly every slide and shows some twice; the model is
 * told to quote a slide only where it adds something, capped at
 * {@link MAX_INLINE_SLIDES}.
 *
 * What is fetched: for each cadence time, the ONE 6 s segment covering it
 * (`downloadRendition` with a single index — init + segment, ~370 KB at 720p),
 * then one ffmpeg call seeks `t - segment.start` into that file and writes one
 * JPEG. 60 frames ≈ 22 MB of fetches and 60 sub-second ffmpeg runs; the whole
 * pass lives in one budget. A segment shared by two ticks is fetched once.
 *
 * Where frames live: extracted into the job's WORK dir (which the model reads
 * via `extraDirs`); after the summary is written, only the frames the summary
 * REFERENCES are copied to `~/.muninn/vimeo-frames/<videoId>/<sec>.jpg`
 * (`keepReferencedFrames`) — that is what `GET /api/vimeo/frames/...` serves —
 * and the work dir is deleted with the rest. Nothing else in the process
 * writes there.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { getLog } from "../logging.ts";
import { frameBudgetFor } from "../video/media.ts";
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

/** The most slides a summary may quote inline — past this it stops being a summary. */
export const MAX_INLINE_SLIDES = 8;

/** One ffmpeg run per frame; a seek + one decoded frame is well under a second. */
export const FRAME_FFMPEG_TIMEOUT_MS = 15_000;

/** The route's charset for the two path segments it serves. */
export const FRAME_VIDEO_ID_RE = /^\d{1,20}$/;
export const FRAME_FILE_RE = /^\d{1,6}\.jpg$/;

export interface VimeoFrame {
  /** Absolute path of the JPEG (inside the work dir while the job runs). */
  readonly path: string;
  /** The cadence time this frame was taken at, whole seconds — also its file name. */
  readonly tSeconds: number;
}

/** Where kept frames are served from. `~/.muninn/vimeo-frames`, beside `agent-cwd`. */
export function framesRootDir(): string {
  return join(homedir(), ".muninn", "vimeo-frames");
}

/**
 * The cadence: `frameBudgetFor(duration)` frames (the TikTok/X budget — ~40 s
 * spacing, ceiling 60 at 40 min, spacing growing again past that), at the
 * MIDPOINTS of equal slices rather than the slice starts, so the first frame is
 * not the title card at t=0 and the last is not the applause. Whole seconds,
 * since the second IS the frame's file name and the route's path segment.
 * Pure.
 */
export function cadenceTimes(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const n = frameBudgetFor(durationSec);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.floor(((i + 0.5) * durationSec) / n);
    if (out.length === 0 || t !== out[out.length - 1]) out.push(t);
  }
  return out;
}

/** `HH:MM:SS` for the frame list — the same spelling the transcript's window headings use. */
export function formatHms(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** The URL path the summary quotes a frame by, and the route serves it at. */
export function frameUrlPath(videoId: string, tSeconds: number): string {
  return `/api/vimeo/frames/${videoId}/${Math.floor(tSeconds)}.jpg`;
}

/**
 * The `t=HH:MM:SS <path>` list handed to the model, plus the one rule the TikTok
 * prompt does not need: a slide is quoted as an image IN PLACE, by the exact
 * path shape the route serves, only where it adds something, at most
 * {@link MAX_INLINE_SLIDES} times.
 */
export function framesPromptSection(videoId: string, frames: readonly VimeoFrame[]): string {
  if (frames.length === 0) return "";
  const list = frames.map((f) => `t=${formatHms(f.tSeconds)} ${f.path}`).join("\n");
  return (
    `\n\nSlide frames, one every ~40 s of the talk (read EVERY image below with the Read tool FIRST, ` +
    `batching many Read calls into one turn — never one frame per message):\n${list}\n\n` +
    `When a frame shows a slide that ADDS something the transcript did not say — a diagram, code, a table, ` +
    `a number, a definition on screen — quote it as an image IN PLACE in the summary, right where the point ` +
    `it illustrates is made, using EXACTLY this markdown and nothing else in the alt text:\n` +
    `![Slide at HH:MM:SS](${frameUrlPath(videoId, 0).replace(/0\.jpg$/, "<sec>.jpg")})\n` +
    `where <sec> is the integer in that frame's file name (t=00:23:10 is the file 1390.jpg) and HH:MM:SS is ` +
    `its time. At most ${MAX_INLINE_SLIDES} slides in the whole summary; a speaker-only frame, a title card ` +
    `or a slide the transcript already states in full is not quoted. Never invent a path.`
  );
}

/**
 * The whole seconds of every frame the summary quotes by this video's path —
 * what `keepReferencedFrames` copies out of the work dir. Pure; duplicates
 * collapsed; a path of another video is not this video's frame.
 */
export function referencedFrameSeconds(summary: string, videoId: string): number[] {
  const re = new RegExp(`\\(/api/vimeo/frames/${videoId}/(\\d{1,6})\\.jpg\\)`, "g");
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary)) !== null) {
    // Only the CANONICAL spelling is a reference: the file is `47.jpg` and the
    // route serves exactly that, so `047.jpg` is an address that will 404 —
    // counting it as kept (via `Number`) would report a frame the reader never
    // gets. Logged and dropped, like an invented path.
    if (String(Number(m[1])) !== m[1]) {
      log.warn("Vimeo summary of {videoId} quotes a non-canonical frame path {path} — not a served address", {
        videoId,
        path: m[0],
      });
      continue;
    }
    out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Copy the frames the summary references into the served root; everything
 * else stays in the work dir and dies with it. Returns the seconds kept. A
 * reference to a frame that was never extracted (the model invented a path)
 * is logged and skipped — the reader gets a broken image, not a served file
 * from nowhere.
 */
export async function keepReferencedFrames(
  summary: string,
  videoId: string,
  frames: readonly VimeoFrame[],
  root: string = framesRootDir(),
): Promise<number[]> {
  const wanted = referencedFrameSeconds(summary, videoId);
  if (wanted.length === 0) return [];
  const bysecond = new Map(frames.map((f) => [f.tSeconds, f] as const));
  const dir = join(root, videoId);
  await mkdir(dir, { recursive: true });
  const kept: number[] = [];
  for (const sec of wanted) {
    const frame = bysecond.get(sec);
    if (!frame) {
      log.warn("Vimeo summary of {videoId} quotes frame {sec}.jpg, which was never extracted — skipped", {
        videoId,
        sec,
      });
      continue;
    }
    await copyFile(frame.path, join(dir, `${sec}.jpg`));
    kept.push(sec);
  }
  return kept;
}

export interface ExtractFramesOptions {
  /** Test seam for the segment fetches. */
  fetchImpl?: typeof fetch;
  /** Test seam for the frame grab; production spawns ffmpeg. */
  grabFrame?: (segmentFile: string, offsetSec: number, outPath: string) => Promise<void>;
  /** Whole-pass budget; default 30 s + 3 s per frame. */
  timeoutMs?: number;
}

/** 30 s + 3 s per frame: a segment fetch (~0.3 s) and one ffmpeg run (~0.3 s) each, with slack. */
export function framesTimeoutFor(frameCount: number): number {
  return 30_000 + 3_000 * Math.max(0, frameCount);
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
): Promise<VimeoFrame[]> {
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
  const frames: VimeoFrame[] = [];
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
    await grab(segmentFile, offset, out);
    frames.push({ path: out, tSeconds: t });
  }
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

/** One frame at `offsetSec` into `segmentFile`, scaled to the frame height, as JPEG. */
async function ffmpegGrabFrame(segmentFile: string, offsetSec: number, outPath: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-ss",
      offsetSec.toFixed(2),
      "-i",
      segmentFile,
      "-frames:v",
      "1",
      "-vf",
      `scale=-2:${VIMEO_FRAME_HEIGHT},format=yuvj420p`,
      "-q:v",
      "3",
      outPath,
    ],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
  );
  const timer = setTimeout(() => proc.kill(), FRAME_FFMPEG_TIMEOUT_MS);
  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg frame grab failed (exit ${exitCode}): ${stderr.slice(-300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
  if (!(await Bun.file(outPath).exists())) {
    throw new Error(`ffmpeg wrote no frame at ${offsetSec.toFixed(2)}s of ${segmentFile}`);
  }
}
