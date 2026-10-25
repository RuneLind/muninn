/**
 * The YouTube vertical's ONE yt-dlp probe: the six shared metadata fields plus
 * `description` (plan D13). Both capture paths run it: a frames-on capture
 * before its download (the duration sizes it), a frames-off capture beside its
 * transcript fetch (a ~3 s metadata call, 10 s bound, for the description's
 * links). `null` on every failure, with one warn, never a throw: a capture
 * without a probe is today's capture.
 *
 * `-O` with a field list, never `--dump-json`: the full info JSON measured
 * 11.7 MB on one video, past `runProc`'s 8 MB cap. A YouTube description is at
 * most 5,000 characters, so one more field keeps the line small.
 */

import { getLog } from "../logging.ts";
import { runProc } from "../utils/run-proc.ts";
import {
  PROBE_TIMEOUT_MS,
  YTDLP_ISOLATION_ARGS,
  parseYtDlpRecord,
  ytDlpInfoFromRecord,
  ytDlpInfoTemplate,
  type YtDlpInfo,
} from "../video/media.ts";

const log = getLog("youtube", "probe");

/** The probe's answer: the shared fields, plus the description where yt-dlp gave one. */
export interface YouTubeProbe extends YtDlpInfo {
  readonly description?: string;
}

/** The six shared fields plus `description`, as one JSON line. */
export const YOUTUBE_PROBE_TEMPLATE = ytDlpInfoTemplate(["description"]);

/** The frames-off probe's budget: it runs beside the transcript fetch, not before it. */
export const YOUTUBE_FRAMES_OFF_PROBE_TIMEOUT_MS = 10_000;

export function youtubeProbeArgs(url: string): string[] {
  return ["yt-dlp", ...YTDLP_ISOLATION_ARGS, "-O", YOUTUBE_PROBE_TEMPLATE, "--skip-download", "--no-playlist", url];
}

/** One probe line, parsed: `parseYtDlpJson`'s fields plus a string `description`. */
export function parseYouTubeProbe(line: string): YouTubeProbe | null {
  const rec = parseYtDlpRecord(line);
  if (rec === null) return null;
  const info = ytDlpInfoFromRecord(rec);
  const { description } = rec;
  return typeof description === "string" && description.trim() !== "" ? { ...info, description } : info;
}

/** Set once a probe found no `yt-dlp` on PATH: warned once, silent afterwards. */
let missingBinaryWarned = false;

/** Test seam: forget that the missing-binary warning was given. */
export function resetMissingYtDlpWarning(): void {
  missingBinaryWarned = false;
}

export async function probeYouTubeVideo(
  url: string,
  opts: { timeoutMs?: number; run?: typeof runProc } = {},
): Promise<YouTubeProbe | null> {
  const run = opts.run ?? runProc;
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    ({ stdout, stderr, exitCode } = await run(
      youtubeProbeArgs(url),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      "yt-dlp probe",
      // runProc's own timeout ERROR stays quiet: the rejection's message
      // («yt-dlp probe timed out after …») reaches the one warn below.
      { processGroup: true, quietTimeout: true },
    ));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") {
      // The Docker image ships no yt-dlp: one line per process says so, and
      // every later capture degrades without repeating it.
      if (!missingBinaryWarned) {
        missingBinaryWarned = true;
        log.warn("yt-dlp is not on PATH — YouTube captures run without the video description (warned once)");
      }
      return null;
    }
    log.warn("yt-dlp probe of {url} failed: {error}", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (exitCode !== 0) {
    log.warn("yt-dlp probe of {url} exited {exitCode}: {stderr}", { url, exitCode, stderr: stderr.slice(-300) });
    return null;
  }
  for (const line of stdout.split("\n")) {
    const parsed = parseYouTubeProbe(line);
    if (parsed) return parsed;
  }
  log.warn("yt-dlp probe of {url} produced no parseable metadata JSON", { url });
  return null;
}
