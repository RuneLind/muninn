import { join, dirname } from "node:path";
import { unlink } from "node:fs/promises";
import { Glob } from "bun";
import type { Config } from "../config.ts";
import { getLog } from "../logging.ts";

const log = getLog("tiktok", "media");

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
  /** Override the computed frame budget (still hard-capped at 30). */
  maxFrames?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no I/O)
// ---------------------------------------------------------------------------

/**
 * Extract the numeric TikTok video id from a canonical URL. Returns null for
 * photo-mode URLs (`/photo/<id>`), short links (`vm.tiktok.com`, `vt.tiktok.com`
 * — resolution happens elsewhere), and anything without a `/video/<id>` segment.
 */
export function extractTikTokVideoId(url: string): string | null {
  const match = url.match(/\/video\/(\d+)/);
  return match ? match[1]! : null;
}

/**
 * Frame budget for a given video length: ~15 frames for clips up to a minute,
 * ~25 up to three minutes, hard-capped at 30 for anything longer. Portrait
 * 512px JPEGs cost ~600+ tokens each plus a Read round-trip, so the cap bounds
 * both token spend and wall-clock time.
 */
export function frameBudgetFor(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 60) return 15;
  if (durationSeconds <= 180) return 25;
  return 30;
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

/**
 * Download a TikTok video with yt-dlp into `workDir`. Rejects videos longer
 * than 10 minutes pre-download (exit 101). Returns the resolved on-disk path
 * plus metadata from the `--print-json` output.
 */
export async function downloadVideo(
  url: string,
  workDir: string,
): Promise<DownloadResult> {
  const outputTemplate = join(workDir, "video.%(ext)s");
  const args = [
    "yt-dlp",
    "-f",
    "mp4[height<=720]/best",
    "--no-playlist",
    "-o",
    outputTemplate,
    "--print-json",
    "--break-match-filters",
    "duration <= 600",
    url,
  ];

  const { stdout, stderr, exitCode } = await runProc(
    args,
    DOWNLOAD_TIMEOUT_MS,
    "yt-dlp download",
  );

  if (exitCode === YTDLP_BREAK_EXIT_CODE) {
    throw new Error("video too long (max 10 min)");
  }
  if (exitCode !== 0) {
    throw new Error(
      `yt-dlp failed (exit ${exitCode}). TikTok may have changed — try 'brew upgrade yt-dlp'.\n${stderr.slice(0, 500)}`,
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

  log.info("Downloaded TikTok video {id} ({duration}s) to {videoPath}", {
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
export async function transcribeVideo(
  videoPath: string,
  config: Config,
): Promise<string> {
  const workDir = dirname(videoPath);
  const wavPath = join(workDir, "audio.wav");

  // Convert to 16kHz mono WAV (whisper-cli's required input format).
  const ffmpeg = await runProc(
    ["ffmpeg", "-i", videoPath, "-ar", "16000", "-ac", "1", "-y", wavPath],
    FFMPEG_AUDIO_TIMEOUT_MS,
    "ffmpeg audio extract",
  );
  if (ffmpeg.exitCode !== 0) {
    throw new Error(
      `ffmpeg audio extraction failed (exit ${ffmpeg.exitCode}): ${ffmpeg.stderr.slice(0, 500)}`,
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
    WHISPER_TIMEOUT_MS,
    "whisper-cli",
  );
  if (whisper.exitCode !== 0) {
    throw new Error(
      `whisper-cli failed (exit ${whisper.exitCode}): ${whisper.stderr.slice(0, 500)}`,
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

/**
 * Run ffmpeg with the given video filter (which must include `showinfo`),
 * writing `frame_%03d.jpg` into `workDir`. Returns the written frame files
 * aligned with the timestamps parsed from showinfo's stderr.
 */
async function runFrameExtraction(
  videoPath: string,
  workDir: string,
  vf: string,
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
    FRAMES_TIMEOUT_MS,
    "ffmpeg keyframes",
  );
  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg keyframe extraction failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
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
  // Clamp to [1, 30]: the hard cap the doc promises for maxFrames overrides,
  // and a floor so a 0/negative override can't produce fps=0 (ffmpeg error)
  // or an empty thinEvenly result.
  const budget = Math.min(
    30,
    Math.max(
      1,
      opts.maxFrames ??
        (opts.durationSeconds !== undefined
          ? frameBudgetFor(opts.durationSeconds)
          : 30),
    ),
  );

  // Scene-change detection at threshold 0.3 (borrowed from claude-watch).
  let frames = await runFrameExtraction(
    videoPath,
    workDir,
    "select='gt(scene,0.3)',scale=512:-1,showinfo",
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
        `fps=${fps},scale=512:-1,showinfo`,
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
