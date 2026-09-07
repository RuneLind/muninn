/**
 * Slides in a capture summary — the SOURCE-NEUTRAL half.
 *
 * One frame every `frameBudgetFor(duration)` ticks of a video, read by the
 * model and quoted INLINE in the summary as
 * `![Slide at HH:MM:SS](/api/frames/<source>/<id>/<sec>.jpg)`. Vimeo pulls its
 * ticks out of a DASH manifest (`src/vimeo/frames.ts`); YouTube downloads the
 * whole file with yt-dlp and uses {@link extractCadenceFramesFromFile}
 * (`src/youtube/frames.ts` is its own pure half — the probe that gives it a
 * duration, the video-only format selector, the transcript rules). Everything
 * either of them does with a URL, a path, the served root or the summary text
 * is here.
 *
 * Three contracts this module lives by:
 *
 * **The id gate is an invariant of the SEAM, not of the route.** Every function
 * that turns an id into a path, a pattern or a filesystem operation refuses an
 * id that fails its `source.idRe` — a builder ({@link frameUrlPath},
 * {@link framesPromptSection}) by THROWING, since there is no honest address to
 * return for a non-address, and a reader or writer over untrusted input
 * ({@link referencedFrameSeconds}, {@link keepReferencedFrames},
 * {@link removeKeptFrames}) by refusing to match or touch anything and saying
 * so. The route's charset gates are a second line, not the first: before this
 * module `referencedFrameSeconds` interpolated the id RAW into a `RegExp` and
 * only `removeKeptFrames` gated at all. The id is regex-escaped on top of the
 * gate, so the two failures are independent.
 *
 * **The file name IS the integer second.** `<tick>.jpg`, no padding — the route
 * serves exactly that spelling, so `047.jpg` is an address that 404s and a
 * summary quoting it is treated as quoting nothing ({@link FRAME_FILE_RE},
 * and the canonical-spelling check in {@link referencedFrameSeconds}). Every
 * path {@link extractCadenceFramesFromFile} produces satisfies that shape by
 * construction; ticks are distinct integers, so no two frames collide.
 *
 * **The dependency direction is one-way.** This module owns every
 * source-neutral symbol — the helpers above plus {@link FRAME_FILE_RE},
 * {@link CAPTURE_FRAME_HEIGHT}, {@link FRAME_FFMPEG_TIMEOUT_MS},
 * {@link framesTimeoutFor} and the ffmpeg grab — and never imports a vertical.
 * `src/vimeo/frames.ts` keeps only its manifest-shaped `extractCadenceFrames`
 * (and `VIMEO_FRAME_HEIGHT`, an alias of the height constant here), and imports
 * the rest from here. A second copy of a timeout constant next door is
 * exactly the two-literals failure `src/video/media.ts` documents for the frame
 * budget, where a raised ceiling stayed inert behind a second literal.
 *
 * Where frames live: extraction writes into the job's WORK dir (which the model
 * reads via `extraDirs`); after the summary is written, only the frames the
 * summary REFERENCES are copied to `~/.muninn/frames/<source>/<id>/<sec>.jpg`
 * ({@link keepReferencedFrames}) — that is what `GET /api/frames/...` serves
 * (`src/dashboard/routes/frames-routes.ts`) — and the work dir is deleted with
 * the rest. **The root has exactly TWO writers**, and both matter to the
 * route's containment guarantee: {@link migrateLegacyVimeoFramesRoot}, which
 * moves an arbitrary pre-existing tree in ONCE at startup (and refuses a
 * SYMLINKED legacy root for exactly that reason), and `keepReferencedFrames`
 * from then on, which writes plain files it copied itself.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { getLog } from "../logging.ts";
import { frameBudgetFor } from "../video/media.ts";

const log = getLog("summaries", "frames");

/** The capture verticals that keep frames. One path segment each. */
export type FrameSourceName = "vimeo" | "youtube";

/**
 * What the seam needs to know about a vertical: its name (the path segment and
 * the directory under the root) and the CHARSET of its video ids, which is the
 * gate every helper here applies.
 */
export interface FrameSource {
  readonly name: FrameSourceName;
  /** The whole id, anchored. Never carries `g` — these regexes are re-tested. */
  readonly idRe: RegExp;
  /**
   * A path prefix documents written BEFORE the seam quote their frames by,
   * still served by an alias route. `referencedFrameSeconds` accepts it beside
   * the current shape, so a re-run over old markdown keeps its frames.
   */
  readonly legacyUrlPrefix?: string;
}

/** Vimeo ids are digits, and a leading zero is a second key for one video (`src/vimeo/url.ts`). */
export const VIMEO_FRAME_SOURCE: FrameSource = {
  name: "vimeo",
  idRe: /^\d{1,20}$/,
  // Every Vimeo document ingested before the seam quotes this prefix.
  legacyUrlPrefix: "/api/vimeo/frames/",
};

/** A YouTube video id is 11 characters of the URL-safe base64 alphabet. */
export const YOUTUBE_FRAME_SOURCE: FrameSource = {
  name: "youtube",
  idRe: /^[A-Za-z0-9_-]{11}$/,
};

export const FRAME_SOURCES: readonly FrameSource[] = [VIMEO_FRAME_SOURCE, YOUTUBE_FRAME_SOURCE];

/** The source with this name, or undefined — the route's default-deny lookup. */
export function frameSourceByName(name: string): FrameSource | undefined {
  return FRAME_SOURCES.find((s) => s.name === name);
}

/** The most slides a summary may quote inline — past this it stops being a summary. */
export const MAX_INLINE_SLIDES = 8;

/**
 * The height every vertical's frames are scaled to.
 *
 * 720p: a slide's text is legible there, and 1080p is ~1.6× the bytes and
 * ~2.25× the image tokens for the same picture. {@link ffmpegFrameArgs}' filter
 * is `min(height, ih)`, so a source SHORTER than this is never upscaled.
 *
 * It lives here, with the extractor that applies it, rather than once per
 * vertical — a per-vertical copy is the two-literals shape `src/video/media.ts`
 * documents for the frame budget, where a raised ceiling stayed inert behind
 * the second literal.
 */
export const CAPTURE_FRAME_HEIGHT = 720;

/** One ffmpeg run per frame; a seek + one decoded frame is well under a second. */
export const FRAME_FFMPEG_TIMEOUT_MS = 15_000;

/** The route's charset for the file segment it serves. The name IS the integer second. */
export const FRAME_FILE_RE = /^\d{1,6}\.jpg$/;

/**
 * The longest video {@link cadenceTimes} will lay a cadence over, in seconds.
 *
 * Derived from {@link FRAME_FILE_RE}, not chosen: the file name IS the integer
 * second, that pattern accepts six digits, so this is the largest duration that
 * is itself a servable second — and every tick is strictly smaller than the
 * duration, so all of them fit by construction. Past it the ticks really do
 * leave the charset (measured: the last tick reaches seven digits at a duration
 * of 1 008 404), and a capture would spend a whole frame budget of ffmpeg runs
 * and image reads on frames no summary can quote, silently. 999 999 s is 11.6
 * days, well past any caller's own cap — Vimeo's is 3 h — so this binds only on
 * a duration that came back wrong.
 */
export const FRAME_MAX_DURATION_SEC = 999_999;

export interface CaptureFrame {
  /** Absolute path of the JPEG (inside the work dir while the job runs). */
  readonly path: string;
  /** The cadence time this frame was taken at, whole seconds — also its file name. */
  readonly tSeconds: number;
}

/** Thrown when an id that cannot be part of an address is asked to become one. */
export class FrameIdError extends Error {
  constructor(source: FrameSource, id: string) {
    super(`Not a ${source.name} video id: ${JSON.stringify(id)}`);
    this.name = "FrameIdError";
  }
}

/** Whether this id may be used as a path segment and a pattern for this source. */
export function isFrameId(source: FrameSource, id: string): boolean {
  return source.idRe.test(id);
}

/** The gate the BUILDERS apply: there is no honest address for a non-address. */
export function assertFrameId(source: FrameSource, id: string): void {
  if (!isFrameId(source, id)) throw new FrameIdError(source, id);
}

/** Where kept frames are served from. `~/.muninn/frames`, beside `agent-cwd`. */
export function framesRootDir(): string {
  return join(homedir(), ".muninn", "frames");
}

/**
 * `<root>/<source>/<id>` — the ONE spelling of the layout. Every site that
 * needs a video's directory goes through this: {@link keepReferencedFrames},
 * {@link removeKeptFrames} and the route (`frames-routes.ts`, which resolves
 * the file segment against it). Spelled inline at each, the layout was three
 * literals a rename would have to find.
 */
export function frameDirFor(source: FrameSource, id: string, root: string = framesRootDir()): string {
  assertFrameId(source, id);
  return join(root, source.name, id);
}

/**
 * The cadence: `frameBudgetFor(duration)` frames (the TikTok/X budget — ~40 s
 * spacing, ceiling 60 at 40 min, spacing growing again past that), at the
 * MIDPOINTS of equal slices rather than the slice starts, so the first frame is
 * not the title card at t=0 and the last is not the applause. Whole seconds,
 * since the second IS the frame's file name and the route's path segment.
 * Pure.
 *
 * A duration that is not a measurement — non-finite — or past
 * {@link FRAME_MAX_DURATION_SEC} THROWS rather than returning ticks: the one
 * production caller today (the Vimeo summarizer) degrades a thrown frame pass
 * to a warn plus a transcript-only capture, and a caller of
 * {@link extractCadenceFramesFromFile} must do the same, since returning ticks
 * would spend the whole budget on frames the route cannot address. A vertical
 * that takes its duration from an external probe (yt-dlp, oEmbed) has no cap
 * of its own.
 */
export function cadenceTimes(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec > FRAME_MAX_DURATION_SEC) {
    throw new Error(`Not a usable video duration for a frame cadence: ${durationSec}s`);
  }
  if (durationSec <= 0) return [];
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
export function frameUrlPath(source: FrameSource, id: string, tSeconds: number): string {
  assertFrameId(source, id);
  return `/api/frames/${source.name}/${id}/${Math.floor(tSeconds)}.jpg`;
}

/**
 * The `t=HH:MM:SS <path>` list handed to the model, plus the one rule the TikTok
 * prompt does not need: a slide is quoted as an image IN PLACE, by the exact
 * path shape the route serves, only where it adds something, at most
 * {@link MAX_INLINE_SLIDES} times.
 *
 * **No frames ⇒ `""`, BEFORE the id is looked at.** A frames-off capture builds
 * no address, so there is nothing for the gate to refuse — and the gate is
 * narrower than the verticals' own id rules (`src/vimeo/url.ts` accepts any
 * `/^[1-9]\d*$/`, this seam caps at 20 digits), so asserting first turned a
 * capture that would have succeeded into a throw at prompt assembly.
 *
 * The spacing it states is DERIVED from the frames it was handed — the median
 * gap — because the cadence is not a constant: `frameBudgetFor` gives 30 frames
 * over a 10-minute talk (20 s apart) and 60 over a 3-hour one (180 s apart), so
 * a fixed "~40 s" was wrong at both ends.
 */
export function framesPromptSection(
  source: FrameSource,
  id: string,
  frames: readonly CaptureFrame[],
): string {
  if (frames.length === 0) return "";
  assertFrameId(source, id);
  const list = frames.map((f) => `t=${formatHms(f.tSeconds)} ${f.path}`).join("\n");
  const spacing = medianGapSec(frames);
  const cadence = spacing === null ? "" : `, one every ~${spacing} s of the talk`;
  return (
    `\n\nSlide frames${cadence} (read EVERY image below with the Read tool FIRST, ` +
    `batching many Read calls into one turn — never one frame per message):\n${list}\n\n` +
    `When a frame shows a slide that ADDS something the transcript did not say — a diagram, code, a table, ` +
    `a number, a definition on screen — quote it as an image IN PLACE in the summary, right where the point ` +
    `it illustrates is made, using EXACTLY this markdown and nothing else in the alt text:\n` +
    `![Slide at HH:MM:SS](${frameUrlPath(source, id, 0).replace(/0\.jpg$/, "<sec>.jpg")})\n` +
    `where <sec> is the integer in that frame's file name (t=00:23:10 is the file 1390.jpg) and HH:MM:SS is ` +
    `its time. At most ${MAX_INLINE_SLIDES} slides in the whole summary; a speaker-only frame, a title card ` +
    `or a slide the transcript already states in full is not quoted. Never invent a path.`
  );
}

/**
 * The typical gap between consecutive frames, whole seconds — what the prompt
 * reports as the cadence. `null` for fewer than two frames, which have no gap:
 * one frame is a still, not a cadence, and stating one would be an invention.
 * The MEDIAN rather than the mean, because the ticks are floored midpoints and
 * a single rounding artefact must not move the number the model is told.
 */
function medianGapSec(frames: readonly CaptureFrame[]): number | null {
  if (frames.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i]!.tSeconds - frames[i - 1]!.tSeconds);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 0 ? (gaps[mid - 1]! + gaps[mid]!) / 2 : gaps[mid]!;
  return Math.max(1, Math.round(median));
}

/** Every character a `RegExp` gives meaning to, made literal. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ONE pattern for "a markdown image quoting a served frame": the `(…)`
 * half of `![alt](<prefix><id>/<sec>.jpg)`, with an optional markdown title.
 * Group 1 is the id (the literal `id` when given, else any non-slash run for a
 * caller that wants to DISCOVER it), group 2 the seconds. Both spellings —
 * the current `/api/frames/<source>/` and the source's `legacyUrlPrefix` —
 * count. Shared by {@link referencedFrameSeconds} (what to keep) and the
 * export's rewrite (what to relocate), so the two can never disagree about
 * which addresses are references. Fresh `g` regex per call: these are reused
 * with `exec`.
 */
export function frameQuoteRegExp(source: FrameSource, id: string | null): RegExp {
  const prefixes = [`/api/frames/${source.name}/`, ...(source.legacyUrlPrefix ? [source.legacyUrlPrefix] : [])];
  const idPart = id === null ? "([^/\\s)]+)" : `(${escapeRegExp(id)})`;
  return new RegExp(
    `\\((?:${prefixes.map(escapeRegExp).join("|")})${idPart}/(\\d{1,6})\\.jpg(?:\\s+"[^"\\n]*")?\\)`,
    "g",
  );
}

/**
 * The whole seconds of every frame the summary quotes by this video's path —
 * what {@link keepReferencedFrames} copies out of the work dir. Pure;
 * duplicates collapsed; a path of another video is not this video's frame.
 *
 * BOTH spellings count: the current `/api/frames/<source>/<id>/` and, where the
 * source declares one, the `legacyUrlPrefix` documents written before the seam
 * quote. A re-run over old markdown that accepted only the new shape would keep
 * no frames at all.
 *
 * The id is gated AND escaped before it enters the pattern: gated because an id
 * outside the charset addresses nothing this route serves, escaped because a
 * pattern is not a place to find out.
 */
export function referencedFrameSeconds(summary: string, source: FrameSource, id: string): number[] {
  if (!isFrameId(source, id)) {
    log.warn("Not a {source} video id, so nothing is a reference to its frames: {id}", { source: source.name, id });
    return [];
  }
  const re = frameQuoteRegExp(source, id);
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary)) !== null) {
    // Only the CANONICAL spelling is a reference: the file is `47.jpg` and the
    // route serves exactly that, so `047.jpg` is an address that will 404 —
    // counting it as kept (via `Number`) would report a frame the reader never
    // gets. Logged and dropped, like an invented path.
    if (String(Number(m[2])) !== m[2]) {
      log.warn("The {source} summary of {id} quotes a non-canonical frame path {path} — not a served address", {
        source: source.name,
        id,
        path: m[0],
      });
      continue;
    }
    out.add(Number(m[2]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Copy the frames the summary references into the served root; everything
 * else stays in the work dir and dies with it. Returns the seconds kept. A
 * reference to a frame that was never extracted (the model invented a path)
 * is logged and skipped — the reader gets a broken image, not a served file
 * from nowhere. An id outside the source's charset keeps nothing and creates
 * no directory.
 */
export async function keepReferencedFrames(
  summary: string,
  source: FrameSource,
  id: string,
  frames: readonly CaptureFrame[],
  root: string = framesRootDir(),
): Promise<number[]> {
  if (!isFrameId(source, id)) {
    log.warn("Not a {source} video id — no frames kept for {id}", { source: source.name, id });
    return [];
  }
  const wanted = referencedFrameSeconds(summary, source, id);
  if (wanted.length === 0) return [];
  const dir = frameDirFor(source, id, root);
  const bysecond = new Map(frames.map((f) => [f.tSeconds, f] as const));
  await mkdir(dir, { recursive: true });
  const kept: number[] = [];
  for (const sec of wanted) {
    const frame = bysecond.get(sec);
    if (!frame) {
      log.warn("The {source} summary of {id} quotes frame {sec}.jpg, which was never extracted — skipped", {
        source: source.name,
        id,
        sec,
      });
      continue;
    }
    await copyFile(frame.path, join(dir, `${sec}.jpg`));
    kept.push(sec);
  }
  return kept;
}

/**
 * Remove every kept frame of ONE video — the `/summaries` Delete's counterpart
 * to {@link keepReferencedFrames}. The id is charset-gated, so the path removed
 * is always `<root>/<source>/<id>` and never anything a document's url could
 * steer; an id that fails the gate removes nothing, WARNS (the module docblock
 * promises a reader or writer says so, and a delete that silently removed
 * nothing is the one outcome nothing else in the process would report) and
 * returns false. A missing directory is not an error (a transcript-only capture
 * kept none) and is not warned about. Returns whether a directory was there.
 */
export async function removeKeptFrames(
  source: FrameSource,
  id: string,
  root: string = framesRootDir(),
): Promise<boolean> {
  if (!isFrameId(source, id)) {
    log.warn("Not a {source} video id — no frames removed for {id}", { source: source.name, id });
    return false;
  }
  const dir = frameDirFor(source, id, root);
  let present: boolean;
  try {
    present = (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
  if (!present) return false;
  await rm(dir, { recursive: true, force: true });
  log.info("Removed the kept frames of {source} video {id}", { source: source.name, id });
  return true;
}

/**
 * Whether THIS SOURCE's half of the frames root holds anything at all. An
 * ABSENT directory is "no" (no capture of this source ever kept a frame); any
 * other read failure is "yes" with a warn, so a transient EMFILE/EACCES falls
 * through to the listing + removal rather than silently orphaning the frames of
 * a deleted document.
 *
 * Scoped to `<root>/<source>/` rather than the root: with two verticals sharing
 * it, a YouTube capture's kept frames would otherwise re-open the listing read
 * on every Vimeo delete.
 */
export async function framesRootHasEntries(
  source: FrameSource,
  root: string = framesRootDir(),
): Promise<boolean> {
  const dir = join(root, source.name);
  try {
    return (await readdir(dir)).length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    log.warn("Could not read the {source} frames dir {dir} ({code}) — assuming it has kept frames", {
      source: source.name,
      dir,
      code: (err as NodeJS.ErrnoException).code ?? "unknown",
    });
    return true;
  }
}

export interface RemoveFramesForDocumentDeps {
  /** Where kept frames live; default {@link framesRootDir}. */
  framesRoot?: string;
  /**
   * The video id behind a document id, when the fast path does not know it —
   * a huginn listing read in production. `null` when nothing resolves.
   */
  resolveVideoId: (documentId: string) => Promise<string | null>;
}

/**
 * Remove the kept frames of a DELETED document, for one source.
 *
 * Called from INSIDE a vertical's own single delete listener, never as a second
 * listener of its own: the Vimeo listener reads its recently-ingested map for
 * the video id and DELETES that entry first, so a second listener fanning out
 * in Set order would run the dedup one first, find nothing, and send every
 * delete down the fallback — orphaning the frames of any document huginn's
 * listing had already reindexed away.
 *
 * The fast path is therefore load-bearing: with a `knownId` nothing is looked
 * up at all. Without one, the frames dir is checked first (frames are off by
 * default, so most deletes have nothing to remove and must not cost a listing
 * read), then `resolveVideoId`. Best-effort throughout: a listing that is down
 * leaves the frames in place with a warn, and the document is gone either way.
 */
export async function removeKeptFramesForDocument(
  source: FrameSource,
  documentId: string,
  knownId: string | null,
  deps: RemoveFramesForDocumentDeps,
): Promise<void> {
  try {
    let id = knownId;
    if (id === null && !(await framesRootHasEntries(source, deps.framesRoot ?? framesRootDir()))) return;
    if (id === null) id = await deps.resolveVideoId(documentId);
    if (id === null) {
      log.info("{source} document {documentId} was deleted but no video id resolves for it — no frames to remove", {
        source: source.name,
        documentId,
      });
      return;
    }
    await removeKeptFrames(source, id, deps.framesRoot ?? framesRootDir());
  } catch (err) {
    log.warn("Removing the kept frames for deleted {source} document {documentId} failed: {error}", {
      source: source.name,
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 30 s + 3 s per frame — the whole-pass budget both extractors share.
 *
 * Generous for both shapes rather than derived from either — the earlier
 * "a segment fetch (~0.3 s) + one ffmpeg run" reading described only the Vimeo
 * path, and the FILE path does no fetching at all. Measured over 30 frames of a
 * 19-minute 720p video: 46 ms/frame cold and 44 ms warm through this module's
 * own extractor, and 63 ms/frame on a real 1280x720 capture. The Vimeo path
 * adds a ~370 KB segment fetch per NEW segment on top of the same ffmpeg run.
 * 3 s each therefore leaves both roughly fifty times their measured cost, which
 * is the point of a budget meant to fire only on a hang.
 */
export function framesTimeoutFor(frameCount: number): number {
  return 30_000 + 3_000 * Math.max(0, frameCount);
}

/** One frame out of `file` at `offsetSec`, scaled to at most `height`, as JPEG. */
export type GrabFrame = (file: string, offsetSec: number, outPath: string, height: number) => Promise<void>;

export interface ExtractFramesFromFileOptions {
  /** The tallest the frame may be; a shorter source is never upscaled. */
  height: number;
  /** Test seam for the frame grab; production spawns ffmpeg. */
  grabFrame?: GrabFrame;
  /** Whole-pass budget; default {@link framesTimeoutFor}. */
  timeoutMs?: number;
}

/**
 * One frame per cadence tick out of a LOCAL video file — the shape a vertical
 * that downloads the whole video uses, against Vimeo's per-segment shape.
 *
 * The seek is ABSOLUTE (the file starts at t=0), and fast: `-ss` before `-i` on
 * a local file seeks by index rather than decoding forward. A failure on ONE
 * frame fails the pass — a summary that quotes slide 23 but never saw slide 24
 * is a partial record presented as complete, and the caller degrades the WHOLE
 * capture to transcript-only with a warn, the TikTok precedent.
 *
 * Every produced path is `<outDir>/<integer>.jpg`, which is what
 * {@link FRAME_FILE_RE} accepts and {@link keepReferencedFrames} resolves; the
 * ticks are distinct integers by construction, so no two frames collide.
 */
export async function extractCadenceFramesFromFile(
  file: string,
  durationSec: number,
  outDir: string,
  opts: ExtractFramesFromFileOptions,
): Promise<CaptureFrame[]> {
  const times = cadenceTimes(durationSec);
  if (times.length === 0) return [];
  const grab = opts.grabFrame ?? ffmpegGrabFrame;
  const timeoutMs = opts.timeoutMs ?? framesTimeoutFor(times.length);
  const deadline = Date.now() + timeoutMs;
  await mkdir(outDir, { recursive: true });
  const frames: CaptureFrame[] = [];
  for (const t of times) {
    if (Date.now() >= deadline) {
      throw new Error(`Frame extraction timed out after ${timeoutMs}ms (${frames.length}/${times.length} frames)`);
    }
    const out = join(outDir, `${t}.jpg`);
    await grab(file, t, out, opts.height);
    frames.push({ path: out, tSeconds: t });
  }
  log.info("Extracted {n} cadence frames from {file}", { n: frames.length, file });
  return frames;
}

/**
 * The ffmpeg argv for one frame grab. Pure and exported so the argv itself is
 * asserted rather than an ffmpeg run.
 *
 * `min(<height>\,ih)` — the comma ESCAPED, because a bare one separates filters
 * in a filtergraph — is what stops a shorter source being upscaled: a 360p
 * rendition scaled to 720 is the same picture with twice the bytes and twice
 * the image tokens. `-ss` before `-i` is the fast seek.
 *
 * Two things it refuses to build, both because ffmpeg would accept them:
 * a height that is not a positive integer becomes `min(NaN\,ih)`, which is not
 * a parse error but a filter that quietly yields nothing, one frame at a time;
 * and a RELATIVE input path is resolved, so a file named `-crf.mp4` reaches
 * ffmpeg as the input rather than as an option. Neither is reachable from
 * today's two callers (both pass a constant height and a path they joined
 * themselves) — this is the argv builder, and the argv is where it is checkable.
 */
export function ffmpegFrameArgs(file: string, offsetSec: number, outPath: string, height: number): string[] {
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`Frame height must be a positive integer, got ${height}`);
  }
  return [
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-ss",
    offsetSec.toFixed(2),
    "-i",
    resolve(file),
    "-frames:v",
    "1",
    "-vf",
    `scale=-2:min(${height}\\,ih),format=yuvj420p`,
    "-q:v",
    "3",
    outPath,
  ];
}

/**
 * Wait for a spawned process, killing it and REJECTING if it runs past `ms` —
 * `runProc`'s shape in `src/video/media.ts`, over the minimum a fake process
 * needs so the timeout is drivable by a unit test.
 *
 * It rejects rather than letting the kill surface as an exit code, which is the
 * whole point: a killed ffmpeg exits 143, and the caller reported that as
 * `ffmpeg frame grab failed (exit 143)` — a crash, when what happened was a
 * hang. Naming the budget is also what makes the log say which budget to raise.
 */
export async function raceKill<T>(
  proc: { readonly exited: Promise<T>; kill: () => void },
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([proc.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One frame at `offsetSec` into `file`, scaled to at most `height`, as JPEG. */
export const ffmpegGrabFrame: GrabFrame = async (file, offsetSec, outPath, height) => {
  const proc = Bun.spawn(ffmpegFrameArgs(file, offsetSec, outPath, height), {
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
  });
  // The drain STARTS before the exit is awaited (awaiting `exited` behind a
  // full stderr pipe deadlocks — the `runProc` fix), and it can never reject
  // this call on its own: a killed process's partial stderr is not the failure
  // being reported.
  const stderrText = new Response(proc.stderr).text().catch(() => "");
  const exitCode = await raceKill(proc, FRAME_FFMPEG_TIMEOUT_MS, "ffmpeg frame grab");
  if (exitCode !== 0) {
    throw new Error(`ffmpeg frame grab failed (exit ${exitCode}): ${(await stderrText).slice(-300)}`);
  }
  if (!(await Bun.file(outPath).exists())) {
    throw new Error(`ffmpeg wrote no frame at ${offsetSec.toFixed(2)}s of ${file}`);
  }
};

/** Where the Vimeo vertical kept frames before the seam. */
export const LEGACY_VIMEO_FRAMES_DIRNAME = "vimeo-frames";

export type FramesRootMigration =
  /** Move the old root in: it is there and its new place is not. */
  | "move"
  /** Nothing to do: no old root. */
  | "nothing"
  /** Both exist, or this profile does not migrate — leave both alone, loudly. */
  | "refuse";

/**
 * Whether this serving profile migrates at all. Its own function because
 * {@link migrateLegacyVimeoFramesRoot} asks it BEFORE it stats anything, so
 * that "nothing under `$HOME` is touched on a pod" is literally true rather
 * than true of the writes only; {@link decideFramesRootMigration} asks the same
 * question as its first branch, and a test pins the two answers to each other.
 */
export function framesRootMigrationRuns(profile: string): boolean {
  return profile !== "nais";
}

/**
 * Whether the one-time `~/.muninn/vimeo-frames` → `~/.muninn/frames/vimeo`
 * rename should run. Pure, so the states are pinned without a filesystem.
 *
 * Refusing when BOTH exist is the point: merging two roots is a decision this
 * has no basis for, and the alias serves the new one — so a warn naming both
 * beats a silent pick. On `nais` the capture verticals are not registered at
 * all, so there is nothing to migrate and nothing to write under `$HOME`.
 *
 * `legacyIsSymlink` is a fact of its own, and it is neither `oldExists` nor
 * "nothing to do": the probe is `lstat`, so a symlink is never a directory to
 * it — and `rename(2)` moves the LINK, which would leave a symlink AT the
 * served path pointing outside the root. The route's realpath containment then
 * 404s every kept frame while the log says "Moved".
 */
export function decideFramesRootMigration(input: {
  oldExists: boolean;
  newExists: boolean;
  legacyIsSymlink: boolean;
  profile: string;
}): FramesRootMigration {
  if (!framesRootMigrationRuns(input.profile)) return "refuse";
  if (input.legacyIsSymlink) return "refuse";
  if (!input.oldExists) return "nothing";
  if (input.newExists) return "refuse";
  return "move";
}

/**
 * Run that rename ONCE, at startup — never at module load and never at route
 * registration.
 *
 * Where it is called from matters, but not for the reason first stated here:
 * unit tests never load `src/index.ts` at all, while an e2e-spawned server DOES
 * run it, under the developer's real `$HOME`. What makes that safe is that the
 * move is idempotent and a no-op once done — the first run after this ships
 * moves the old root, and every run after that finds nothing to move. (The
 * route factory's `framesRoot` is a separate matter: it keeps a test's READS
 * and a delete's REMOVALS off the real root, and production has no override.)
 *
 * A no-op unless the OLD root exists and its new place does not, so a machine
 * that never ran the Vimeo vertical touches nothing. Log-and-continue on any
 * error: kept frames are a cache of pictures, and no capture may be blocked by
 * a failed move. Stated: rolling back to pre-seam code strands the frames under
 * the new name.
 */
export async function migrateLegacyVimeoFramesRoot(
  profile: string,
  opts: { legacyRoot?: string; framesRoot?: string } = {},
): Promise<FramesRootMigration> {
  const legacyRoot = opts.legacyRoot ?? join(homedir(), ".muninn", LEGACY_VIMEO_FRAMES_DIRNAME);
  const framesRoot = opts.framesRoot ?? framesRootDir();
  const target = join(framesRoot, VIMEO_FRAME_SOURCE.name);
  // The profile is asked FIRST, before either probe: on a pod nothing under
  // `$HOME` is touched at all, not even a stat. `decideFramesRootMigration`
  // answers "refuse" for such a profile whatever the probes would have said,
  // and a test pins that parity.
  if (!framesRootMigrationRuns(profile)) return "refuse";
  const [legacy, targetProbe] = await Promise.all([probeRoot(legacyRoot), probeRoot(target)]);
  // Anything already at the target — a directory, a link, a plain file —
  // means "taken": `rename` must never land on top of something this has no
  // basis to merge, and a plain file would fail it with ENOTDIR and the
  // generic warn instead of the remedy the refuse branch names.
  const newExists = targetProbe.exists;
  const decision = decideFramesRootMigration({
    oldExists: legacy.isDir,
    newExists,
    legacyIsSymlink: legacy.isSymlink,
    profile,
  });
  if (decision === "move") {
    try {
      await mkdir(framesRoot, { recursive: true });
      await rename(legacyRoot, target);
      log.info("Moved the kept Vimeo frames from {legacyRoot} to {target}", { legacyRoot, target });
    } catch (err) {
      log.warn("Could not move the kept Vimeo frames from {legacyRoot} to {target}: {error}", {
        legacyRoot,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (decision === "refuse" && legacy.isSymlink) {
    log.warn(
      "{legacyRoot} is a symlink — leaving it alone; renaming it would move the LINK to {target} and every kept " +
        "frame would then 404, so copy its contents there by hand and remove the link",
      { legacyRoot, target },
    );
  } else if (decision === "refuse" && legacy.isDir && targetProbe.servesDir) {
    log.warn(
      "Both {legacyRoot} and {target} exist — leaving both alone; the alias serves {target}, so move or remove " +
        "{legacyRoot} by hand if it still holds frames a summary quotes",
      { legacyRoot, target },
    );
  } else if (decision === "refuse" && legacy.isDir && newExists) {
    // The target exists but does not resolve to a directory — a plain file,
    // a dangling symlink, or a symlink to a non-directory — so the route
    // serves NOTHING there (a symlink that resolves to a directory is served,
    // the route resolves both sides, and takes the "both exist" branch above).
    // The "both exist" remedy — which tells the operator the target is served
    // and the legacy root is disposable — would have them delete the only
    // real frames. The legacy root is the one to keep; the target is the one
    // to clear.
    log.warn(
      "{target} exists but is not a directory ({kind}) — leaving {legacyRoot} alone, it still holds the kept " +
        "frames and nothing is served until {target} is removed by hand and the next start moves them",
      { legacyRoot, target, kind: targetProbe.isSymlink ? "symlink" : "file" },
    );
  }
  return decision;
}

/**
 * What is at this path. `isDir`/`isSymlink` come from `lstat` — WITHOUT
 * following a link, because `rename` moves the link rather than the tree —
 * and `servesDir` is what the ROUTE would see: a directory, or a symlink that
 * `stat`s to one (the route's containment `realpath`s both sides, so such a
 * link serves normally). A dangling symlink, a symlink to a non-directory and
 * a plain file exist without serving.
 */
async function probeRoot(
  dir: string,
): Promise<{ isDir: boolean; isSymlink: boolean; exists: boolean; servesDir: boolean }> {
  // Any `lstat` failure reads as absent — ENOENT is the expected one, and an
  // EACCES on an unreadable `~/.muninn/frames` then decides "move", whose
  // `rename` fails under the generic "Could not move" warn. Accepted: an
  // unreadable home is not a state this can repair or name better.
  try {
    const st = await lstat(dir);
    const isDir = st.isDirectory();
    const isSymlink = st.isSymbolicLink();
    let servesDir = isDir;
    if (isSymlink) {
      try {
        servesDir = (await stat(dir)).isDirectory();
      } catch {
        servesDir = false;
      }
    }
    return { isDir, isSymlink, exists: true, servesDir };
  } catch {
    return { isDir: false, isSymlink: false, exists: false, servesDir: false };
  }
}
