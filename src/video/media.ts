import { join, dirname } from "node:path";
import { unlink } from "node:fs/promises";
import { Glob } from "bun";
import type { Config } from "../config.ts";
import { getLog } from "../logging.ts";

const log = getLog("video", "media");

// Per-step process timeouts. yt-dlp does network I/O against an anti-bot-happy
// host and whisper/ffmpeg can stall, so every spawn is bounded (stt.ts has no
// timeout, which is fine for short voice clips but not for a downloader).
const DOWNLOAD_TIMEOUT_MS = 120_000;
const WHISPER_TIMEOUT_MS = 120_000;
const FFMPEG_AUDIO_TIMEOUT_MS = 60_000;
const FRAMES_TIMEOUT_MS = 60_000;

// yt-dlp aborts a download whose match-filter fails with this exit code (from
// --break-match-filters). We map it to a clear "too long" job error.
const YTDLP_BREAK_EXIT_CODE = 101;

/**
 * yt-dlp format selector. Two traps, both measured on TikTok 7646424593388883214
 * (a 353s narrated video our pipeline reported as having no audio):
 *
 *  1. `height` is the LONG edge, so a portrait "540p/720p/1080p" TikTok reports
 *     height 1024/1280/1920. The old `mp4[height<=720]` therefore matched ZERO
 *     formats on every portrait video and silently fell through to `best`.
 *  2. TikTok's `bytevc1_*` (h265) formats advertise `acodec=aac` but download as
 *     video-only. `best` picked `bytevc1_1080p` — hence "no audio". The `h264_*`
 *     formats at the same resolutions carry a real aac track.
 *
 * Hence the tiers. Prefer h264, the only codec family here that reliably muxes
 * audio, matched by regex because the spelling is host-dependent: TikTok reports a
 * bare `h264`, YouTube an `avc1.42001E`-style profile string. A plain `^=avc1`
 * matches nothing on TikTok and re-picks bytevc1_1080p (measured).
 *
 * The codec tiers cannot be the whole story, because X reports `vcodec: unknown`
 * on its muxed `http-*` formats — both h264 tiers are inert there, so X needs a
 * capped any-codec tier to fall into. Without one it lands on the uncapped tail:
 * a real 636s X video went 173 MB -> 824 MB, which does not finish inside
 * DOWNLOAD_TIMEOUT_MS.
 *
 * Capping BOTH width and height is what makes "roughly 720p" orientation-agnostic:
 * portrait 720x1280 and landscape 1280x720 pass, 1080x1920 and 1920x1080 do not.
 * The uncapped h264 tier is the deliberate size-for-audio trade on hosts whose only
 * h264 rung is larger; `bv*+ba` is a last resort for split-stream (DASH/HLS) hosts,
 * where every pre-merged tier — including the old `best` — finds nothing at all.
 */
export const YTDLP_FORMAT_SELECTOR =
  "b[vcodec~='^(avc1|h264)'][width<=1280][height<=1280]" +
  "/b[width<=1280][height<=1280]" +
  "/b[vcodec~='^(avc1|h264)']" +
  "/b" +
  "/bv*+ba";

export interface YtDlpInfo {
  id: string;
  title: string;
  duration: number;
  uploader: string;
  webpageUrl?: string;
}

export interface DownloadResult {
  videoPath: string;
  id: string;
  title: string;
  duration: number;
  uploader: string;
  canonicalUrl: string;
}

export interface Keyframe {
  path: string;
  tSeconds: number;
}

export interface KeyframeOptions {
  /** Video duration in seconds — drives the frame budget and the uniform
   * sampling fallback. Pass the value from downloadVideo. */
  durationSeconds?: number;
  /** Override the computed frame budget (still hard-capped at
   *  {@link FRAME_BUDGET_MAX}). */
  maxFrames?: number;
  /** Override the per-pass ffmpeg timeout — longer videos need more than the
   * 60s default to decode for scene detection. */
  frameTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no I/O)
// ---------------------------------------------------------------------------

/**
 * Extract the numeric TikTok video id from a canonical URL. Returns null for
 * photo-mode URLs (`/photo/<id>`), short links (`vm.tiktok.com`, `vt.tiktok.com`
 * — resolution happens elsewhere), and anything without a `/video/<id>` segment.
 * TikTok-host-gated: an X status URL also ends in `/video/1` (the tweet's media
 * slot index, not an id), so a bare `/video/(\d+)` match would misfire on it.
 */
export function extractTikTokVideoId(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith("tiktok.com")) return null;
  } catch {
    return null;
  }
  const match = url.match(/\/video\/(\d+)/);
  return match ? match[1]! : null;
}

/**
 * Extract the numeric status id from an X/Twitter URL (`/status/<id>`, with or
 * without a trailing `/video/N` media-slot suffix). Null for non-X hosts.
 */
export function extractXStatusId(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com") return null;
  } catch {
    return null;
  }
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1]! : null;
}

/**
 * Canonical bare status URL for an X video — strips the `/video/N` media-slot
 * suffix (and query/fragment) so dedup and ingest key on the tweet itself.
 * Returns null when the URL carries no `/status/<id>`.
 */
export function canonicalXStatusUrl(url: string): string | null {
  const id = extractXStatusId(url);
  if (!id) return null;
  const match = url.match(/^(https?:\/\/[^/]+\/[^/]+\/status\/\d+)/);
  return match ? match[1]! : null;
}

/**
 * Frame budget for a given video length: ~15 frames for clips up to a minute,
 * ~25 up to three minutes, 30 up to ten. Past that the budget grows with the
 * clip instead of staying flat, because a flat 30 is not a budget on long
 * video, it is a spacing collapse: the old ceiling sampled a 60-min tutorial
 * once per 120s and a 3h X workshop once per 360s, so every on-screen code or
 * slide transition fell between frames while the capture still reported
 * success. Above ten minutes we hold ~40s spacing up to a hard 60.
 *
 * FRAME_BUDGET_MAX is where token spend stops being free: a 512px-wide portrait frame is
 * ~620 tokens (a 512x910 JPEG at w*h/750), so 60 of them is ~37k tokens of
 * images before the transcript — and each one also costs a Read round-trip in
 * a multi-turn session. Landscape frames are ~3x cheaper, so the ceiling is
 * sized against the expensive orientation, which is the TikTok one.
 */
/**
 * Summarize-call timeout for a frame-reading capture: a 600s floor, plus ~20s
 * per frame past 30. The floor came from a live 72s/25-frame run that blew
 * through 300s on a slow bot (opus + thinking); the per-frame term exists
 * because {@link frameBudgetFor} now hands long videos up to
 * {@link FRAME_BUDGET_MAX} frames, and every extra frame is another image read
 * in the same multi-turn session. Nothing blocks on these jobs.
 */
export function summarizeTimeoutFor(frameCount: number, floorMs: number): number {
  const extra = Math.max(0, frameCount - 30) * 20_000;
  return Math.max(floorMs, 600_000 + extra);
}

/** Hard ceiling on frames per capture, shared by {@link frameBudgetFor} and the
 *  maxFrames override in {@link extractKeyframes} — one constant, because two
 *  literals is how the budget silently stopped growing. */
export const FRAME_BUDGET_MAX = 60;
/** Budget used when the caller passes neither a duration nor maxFrames. */
export const FRAME_BUDGET_DEFAULT = 30;

export function frameBudgetFor(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 60) return 15;
  if (durationSeconds <= 180) return 25;
  if (durationSeconds <= 600) return 30;
  return Math.min(FRAME_BUDGET_MAX, Math.max(30, Math.ceil(durationSeconds / 40)));
}

/**
 * Parse a single yt-dlp `--print-json` line into the fields we need. Returns
 * null for non-JSON lines (yt-dlp interleaves progress/warnings on stdout) or
 * objects missing an `id`, so callers can scan every line for the first hit.
 */
export function parseYtDlpJson(line: string): YtDlpInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.id === null || rec.id === undefined) return null;
  return {
    id: String(rec.id),
    title: typeof rec.title === "string" ? rec.title : "",
    duration: typeof rec.duration === "number" ? rec.duration : 0,
    uploader: typeof rec.uploader === "string" ? rec.uploader : "",
    webpageUrl: typeof rec.webpage_url === "string" ? rec.webpage_url : undefined,
  };
}

/**
 * Parse per-frame timestamps out of ffmpeg's `showinfo` filter stderr. Each
 * emitted frame produces a line containing `pts_time:<seconds>`; the order
 * matches the order frames are written to disk.
 */
export function parseShowinfoTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const re = /pts_time:(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number.parseFloat(m[1]!);
    // Clamp tiny negative PTS (container quirks) to 0 rather than misreporting.
    if (Number.isFinite(t)) timestamps.push(Math.max(0, t));
  }
  return timestamps;
}

/** Build the canonical TikTok video URL from an uploader handle and id. */
function buildCanonicalUrl(info: YtDlpInfo): string {
  if (info.webpageUrl) return info.webpageUrl;
  const handle = info.uploader.replace(/^@/, "");
  return `https://www.tiktok.com/@${handle}/video/${info.id}`;
}

/**
 * Thin an ordered list down to at most `max` items, keeping the endpoints and
 * spacing the rest evenly. Used when scene detection produces more frames than
 * the budget allows.
 */
function thinEvenly<T>(items: T[], max: number): T[] {
  if (max <= 0) return [];
  if (items.length <= max) return items;
  if (max === 1) return [items[0]!];
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (items.length - 1)) / (max - 1));
    out.push(items[idx]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spawn helper — concurrent stdout/stderr/exit drain + hard timeout
// ---------------------------------------------------------------------------

interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a process, draining stdout AND stderr concurrently with exit (awaiting
 * `exited` first can deadlock if the pipe buffer fills — same fix as stt.ts),
 * and kill it if it runs past `timeoutMs` (mirrors executor.ts's timeout).
 */
async function runProc(
  cmd: string[],
  timeoutMs: number,
  label: string,
): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("{label} timed out after {timeoutMs}ms — killing PID {pid}", {
        label,
        timeoutMs,
        pid: proc.pid,
      });
      proc.kill();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<ProcResult> => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

/**
 * Glob `<dir>/<pattern>` and return absolute paths in natural (numeric-aware)
 * order — a plain lexical sort would put frame_1000.jpg before frame_999.jpg
 * once ffmpeg overflows the %03d padding, misaligning frames with their
 * showinfo timestamps.
 */
async function globAbsolute(dir: string, pattern: string): Promise<string[]> {
  const glob = new Glob(pattern);
  const matches: string[] = [];
  for await (const p of glob.scan({ cwd: dir, absolute: true })) {
    matches.push(p);
  }
  matches.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return matches;
}

// ---------------------------------------------------------------------------
// 1. Download
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  /** Pre-download duration cap in seconds (yt-dlp match-filter). Required, with
   * no default: every vertical's cap is a per-host judgement (TikTok 60 min, X
   * 3 h) and a shared default is only ever wrong for the next caller — the
   * TikTok vertical silently inherited the old 600s one for a year. */
  maxDurationSeconds: number;
  /** Override the yt-dlp process timeout — hour-plus videos (X workshops) are
   * gigabyte-scale downloads that outrun the 120s short-clip default. */
  timeoutMs?: number;
}

/**
 * Download a video with yt-dlp into `workDir` (TikTok, X, or any yt-dlp-supported
 * host). Rejects videos longer than the duration cap pre-download (exit 101).
 * Returns the resolved on-disk path plus metadata from the `--print-json` output.
 */
export async function downloadVideo(
  url: string,
  workDir: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const maxDuration = opts.maxDurationSeconds;
  const outputTemplate = join(workDir, "video.%(ext)s");
  const args = [
    "yt-dlp",
    "-f",
    YTDLP_FORMAT_SELECTOR,
    "--no-playlist",
    "-o",
    outputTemplate,
    "--print-json",
    "--break-match-filters",
    `duration <= ${maxDuration}`,
    url,
  ];

  const { stdout, stderr, exitCode } = await runProc(
    args,
    opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    "yt-dlp download",
  );

  if (exitCode === YTDLP_BREAK_EXIT_CODE) {
    throw new Error(`video too long (max ${Math.round(maxDuration / 60)} min)`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `yt-dlp failed (exit ${exitCode}). The site may have changed — try 'brew upgrade yt-dlp'.\n${stderr.slice(-500)}`,
    );
  }

  // Parse the info JSON from stdout (yt-dlp can interleave other lines).
  let info: YtDlpInfo | null = null;
  for (const line of stdout.split("\n")) {
    const parsed = parseYtDlpJson(line);
    if (parsed) {
      info = parsed;
      break;
    }
  }
  if (!info) {
    throw new Error(`yt-dlp produced no parseable metadata JSON:\n${stdout.slice(0, 500)}`);
  }

  // Resolve the actual file by globbing — don't trust `_filename` from the JSON
  // (can be a pre-remux name; the `best` fallback can yield a non-mp4 container).
  // Prefer known video containers over a junk-suffix denylist, so intermediate
  // artifacts (`.part`, `.ytdl`, info `.json`, thumbnails) can't be picked up.
  const candidates = await globAbsolute(workDir, "video.*");
  const videoExts = [".mp4", ".webm", ".mkv", ".mov", ".m4v", ".flv", ".ts", ".avi"];
  const videoPath =
    candidates.find((p) => videoExts.some((ext) => p.toLowerCase().endsWith(ext))) ??
    candidates.find(
      (p) => !p.endsWith(".part") && !p.endsWith(".json") && !p.endsWith(".ytdl"),
    );
  if (!videoPath) {
    throw new Error(
      `yt-dlp reported success but no video file was found in ${workDir}`,
    );
  }

  log.info("Downloaded video {id} ({duration}s) to {videoPath}", {
    id: info.id,
    duration: info.duration,
    videoPath,
  });

  return {
    videoPath,
    id: info.id,
    title: info.title,
    duration: info.duration,
    uploader: info.uploader,
    canonicalUrl: buildCanonicalUrl(info),
  };
}

// ---------------------------------------------------------------------------
// 2. Transcribe
// ---------------------------------------------------------------------------

/**
 * Extract 16 kHz mono audio from `videoPath` and transcribe it with whisper-cli.
 * Unlike stt.ts, an empty transcript is NOT an error — music-only TikToks are
 * common, so we return "" and let the summary lean on the frames.
 */
export interface TranscribeOptions {
  /** Override the whisper-cli timeout — longer videos (X allows hours vs
   * TikTok's 60 min) need more than the 120s default. */
  whisperTimeoutMs?: number;
  /** Override the ffmpeg audio-extraction timeout — decoding an hour-plus
   * video's audio track outruns the 60s short-clip default. */
  audioTimeoutMs?: number;
}

export async function transcribeVideo(
  videoPath: string,
  config: Config,
  opts: TranscribeOptions = {},
): Promise<string> {
  const workDir = dirname(videoPath);
  const wavPath = join(workDir, "audio.wav");

  // TikTok sometimes serves a video-only file even when yt-dlp's format
  // metadata claims an aac track, so probe before extracting: no audio stream
  // means "no speech" (same contract as an empty transcript), not an error.
  // The probe fails open — a missing/broken ffprobe just falls through to the
  // ffmpeg extraction, which worked without ffprobe before this check existed.
  try {
    const probe = await runProc(
      ["ffprobe", "-v", "error", "-select_streams", "a",
       "-show_entries", "stream=codec_type", "-of", "csv=p=0", videoPath],
      FFMPEG_AUDIO_TIMEOUT_MS,
      "ffprobe audio probe",
    );
    if (probe.exitCode === 0 && probe.stdout.trim() === "") {
      // Warn, not info: a genuinely silent clip and a format-selection bug that
      // threw the narration away look identical from here, and the second kind
      // hid for months at info level. Name the video codec — `hevc` is the tell
      // that the selector landed on a bytevc1 format again (see
      // VIDEO_FORMAT_SELECTOR).
      const vcodec = await runProc(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", videoPath],
        FFMPEG_AUDIO_TIMEOUT_MS,
        "ffprobe video codec probe",
      ).then((r) => r.stdout.trim() || "unknown").catch(() => "unknown");
      log.warn(
        "No audio stream in {videoPath} (video codec {vcodec}) — summary will rely on frames",
        { videoPath, vcodec },
      );
      return "";
    }
  } catch (err) {
    log.warn("ffprobe audio probe failed — proceeding with extraction: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Convert to 16kHz mono WAV (whisper-cli's required input format).
  const ffmpeg = await runProc(
    ["ffmpeg", "-i", videoPath, "-ar", "16000", "-ac", "1", "-y", wavPath],
    opts.audioTimeoutMs ?? FFMPEG_AUDIO_TIMEOUT_MS,
    "ffmpeg audio extract",
  );
  if (ffmpeg.exitCode !== 0) {
    // Slice the tail — ffmpeg prints its version banner first, so the head of
    // stderr never contains the actual error.
    throw new Error(
      `ffmpeg audio extraction failed (exit ${ffmpeg.exitCode}): ${ffmpeg.stderr.slice(-500)}`,
    );
  }

  const whisper = await runProc(
    [
      "whisper-cli",
      "--model",
      config.tiktokWhisperModelPath,
      "--no-timestamps",
      wavPath,
    ],
    opts.whisperTimeoutMs ?? WHISPER_TIMEOUT_MS,
    "whisper-cli",
  );
  if (whisper.exitCode !== 0) {
    throw new Error(
      `whisper-cli failed (exit ${whisper.exitCode}): ${whisper.stderr.slice(-500)}`,
    );
  }

  const text = whisper.stdout
    .replace(/\[BLANK_AUDIO\]/g, "")
    .replace(/\[.*?\]/g, "")
    .trim();

  if (!text) {
    log.info("No speech detected in {videoPath} — summary will rely on frames", {
      videoPath,
    });
  }

  return text;
}

// ---------------------------------------------------------------------------
// 3. Keyframes
// ---------------------------------------------------------------------------

// Shared tail of both keyframe filtergraphs (scene detection + uniform
// fallback). format=yuvj420p converts to full-range: ffmpeg 8's mjpeg encoder
// rejects limited-range YUV (common in TikTok HEVC downloads) when an explicit
// filtergraph suppresses the automatic range conversion.
const FRAME_VF_TAIL = "scale=512:-1,format=yuvj420p,showinfo";

/**
 * Run ffmpeg with the given video filter (which must include `showinfo`),
 * writing `frame_%03d.jpg` into `workDir`. Returns the written frame files
 * aligned with the timestamps parsed from showinfo's stderr.
 */
async function runFrameExtraction(
  videoPath: string,
  workDir: string,
  vf: string,
  timeoutMs: number = FRAMES_TIMEOUT_MS,
): Promise<Keyframe[]> {
  // Remove any frames from a previous pass so the glob only sees this run's.
  for (const stale of await globAbsolute(workDir, "frame_*.jpg")) {
    await unlink(stale).catch(() => {});
  }

  const { exitCode, stderr } = await runProc(
    [
      "ffmpeg",
      "-i",
      videoPath,
      "-vf",
      vf,
      "-vsync",
      "vfr",
      join(workDir, "frame_%03d.jpg"),
    ],
    timeoutMs,
    "ffmpeg keyframes",
  );
  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg keyframe extraction failed (exit ${exitCode}): ${stderr.slice(-500)}`,
    );
  }

  const files = await globAbsolute(workDir, "frame_*.jpg");
  const timestamps = parseShowinfoTimestamps(stderr);
  if (timestamps.length !== files.length) {
    // An unparseable pts_time (e.g. "nan"/"N/A") shifts the index alignment —
    // surface it instead of silently attaching wrong timestamps.
    log.warn("showinfo produced {nTs} timestamps for {nFiles} frames — some tSeconds may be approximate", {
      nTs: timestamps.length,
      nFiles: files.length,
    });
  }

  return files.map((path, i) => ({
    path,
    // showinfo emits one pts_time per written frame in order; if parsing came up
    // short for some frame, fall back to the previous timestamp (or 0).
    tSeconds: timestamps[i] ?? timestamps[timestamps.length - 1] ?? 0,
  }));
}

/**
 * Extract representative keyframes from a video. Prefers scene-change detection
 * (one frame per visual cut — ideal for diagrams/slides); if that yields fewer
 * than 4 frames (single-shot talking head, static slideshow) it falls back to
 * uniform sampling across the clip. The result is thinned evenly to the frame
 * budget for the video's duration.
 */
export async function extractKeyframes(
  videoPath: string,
  workDir: string,
  opts: KeyframeOptions = {},
): Promise<Keyframe[]> {
  // Clamp to [1, FRAME_BUDGET_MAX]: the hard cap the doc promises for maxFrames
  // overrides, and a floor so a 0/negative override can't produce fps=0 (ffmpeg
  // error) or an empty thinEvenly result. The ceiling is the SAME constant
  // frameBudgetFor tops out at — when it was a separate literal 30 here, raising
  // the budget function was inert: measured on a 62-min video, budget 60 in and
  // 30 frames out at 124s spacing, exactly the collapse the raise was fixing.
  const budget = Math.min(
    FRAME_BUDGET_MAX,
    Math.max(
      1,
      opts.maxFrames ??
        (opts.durationSeconds !== undefined
          ? frameBudgetFor(opts.durationSeconds)
          : FRAME_BUDGET_DEFAULT),
    ),
  );

  // Scene-change detection at threshold 0.3 (borrowed from claude-watch).
  let frames = await runFrameExtraction(
    videoPath,
    workDir,
    `select='gt(scene,0.3)',${FRAME_VF_TAIL}`,
    opts.frameTimeoutMs,
  );

  if (frames.length < 4) {
    if (opts.durationSeconds && opts.durationSeconds > 0) {
      // Uniform sampling: `budget` frames spread across the whole clip.
      log.info(
        "Scene detection yielded {n} frames — falling back to uniform sampling",
        { n: frames.length },
      );
      const fps = budget / opts.durationSeconds;
      frames = await runFrameExtraction(
        videoPath,
        workDir,
        `fps=${fps},${FRAME_VF_TAIL}`,
        opts.frameTimeoutMs,
      );
    } else {
      log.warn(
        "Scene detection yielded {n} frames and no duration for uniform fallback",
        { n: frames.length },
      );
    }
  }

  const thinned = thinEvenly(frames, budget);
  log.info("Extracted {n} keyframes (budget {budget})", {
    n: thinned.length,
    budget,
  });
  return thinned;
}
