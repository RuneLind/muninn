/**
 * The no-captions fallback (v2 PR 5): a talk Vimeo has no caption track for is
 * transcribed from its own audio.
 *
 * Opus rendition (the media seam, `media.ts`) → ONE fMP4 → ffmpeg to 16 kHz
 * mono WAV → `whisper-cli -l auto -ovtt` → a WebVTT file that goes through the
 * SAME `vttToSegments` windowing a harvested caption track does, so the
 * transcript that reaches the prompt and the document is byte-for-byte the
 * shape the retrieval side already indexes (`### [HH:MM:SS]` per window).
 *
 * Measured 2026-09-05 on the mini (M4, `ggml-small.bin`): two minutes of a
 * Norwegian lightning talk — 20 Opus segments, 1.5 MB — downloaded in 0.6 s,
 * decoded in 0.2 s and transcribed in 7 s, language auto-detected `no`
 * (p = 0.88). A 53-minute talk is ~40 MB of Opus at the manifest's 101 kbps,
 * well inside `VIMEO_RENDITION_MAX_BYTES`.
 *
 * Whisper's stdout is NOT parsed: `-ovtt -of <base>` writes `<base>.vtt`, and
 * reading the file keeps whisper's own cue timing rather than re-deriving it
 * from the bracketed console lines. The detected language is the one thing
 * read off stderr (`auto-detected language: no (p = …)`), because it is
 * printed nowhere else.
 *
 * Everything runs inside the job's work dir, which the summarizer removes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLog } from "../logging.ts";
import { runProc, type ProcResult } from "../video/media.ts";
import {
  chooseRepresentation,
  downloadRendition,
  renditionTimeoutFor,
  type VimeoManifest,
} from "./media.ts";

const log = getLog("vimeo", "whisper");

/** The document's `caption_kind` for a Whisper transcript — beside `manual`, `auto`, `stub`. */
export const WHISPER_CAPTION_KIND = "whisper";

/** `caption_lang` when whisper printed no detection line and the model is multilingual. */
export const UNDETERMINED_LANG = "und";

/**
 * The transcription clock: 1 s of budget per second of talk, floor 2 min —
 * the TikTok/X-video rule verbatim. Measured 17× real time with `small` on an
 * M4, so this leaves room for `medium` on a slower machine.
 */
export function whisperTimeoutFor(durationSec: number): number {
  return Math.max(120_000, Math.round(Math.max(0, durationSec) * 1000));
}

/** The decode clock: 0.2 s per second of talk, floor 1 min — the TikTok rule (measured ~600× real time). */
export function audioDecodeTimeoutFor(durationSec: number): number {
  return Math.max(60_000, Math.round(Math.max(0, durationSec) * 200));
}

/**
 * `ggml-base.en.bin`, `ggml-small.en.bin`: whisper.cpp's English-only models,
 * named by the `.en` before the extension. Such a model ignores `-l auto`
 * ("model is not multilingual") and transcribes Norwegian speech as English
 * noise, so the caller warns and records `en` rather than trusting a detection
 * that never ran.
 */
export function isEnglishOnlyModel(modelPath: string): boolean {
  return /\.en(\.[A-Za-z0-9]+)?$/.test(modelPath);
}

/** The language whisper announced on stderr, or `null` when it did not. */
export function parseDetectedLanguage(stderr: string): string | null {
  const m = /auto-detected language:\s*([a-z]{2,3})\b/i.exec(stderr);
  return m ? m[1]!.toLowerCase() : null;
}

/** The machine cannot transcribe: a binary or the model is missing. A job ERROR with its own code. */
export class VimeoWhisperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VimeoWhisperUnavailableError";
  }
}

/** A step of the pipeline failed on THIS video (download, decode, whisper exit). */
export class VimeoTranscriptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VimeoTranscriptionError";
  }
}

export interface WhisperAvailabilityProbe {
  which?: (binary: string) => string | null;
  exists?: (path: string) => boolean;
}

/**
 * `null` when the machine can run the fallback; otherwise one sentence naming
 * what is missing. Checked BEFORE the download — 40 MB of audio for a machine
 * with no whisper is the wrong order.
 */
export function whisperUnavailableReason(modelPath: string, probe: WhisperAvailabilityProbe = {}): string | null {
  const which = probe.which ?? ((b: string) => Bun.which(b));
  const exists = probe.exists ?? existsSync;
  const missing: string[] = [];
  if (!which("ffmpeg")) missing.push("ffmpeg is not on PATH");
  if (!which("whisper-cli")) missing.push("whisper-cli is not on PATH (brew install whisper-cpp)");
  if (!exists(modelPath)) missing.push(`whisper model ${modelPath} does not exist (set VIMEO_WHISPER_MODEL_PATH)`);
  return missing.length === 0 ? null : missing.join("; ");
}

export interface TranscribeRenditionInput {
  manifestUrl: string;
  manifest: VimeoManifest;
  durationSec: number;
  workDir: string;
}

export interface TranscribeRenditionOptions {
  /** Absolute or cwd-relative path of the ggml model. */
  modelPath: string;
  /** Test seam for the segment fetches. */
  fetchImpl?: typeof fetch;
  /** Test seam for the two spawns; production is `runProc`. */
  run?: (cmd: string[], timeoutMs: number, label: string) => Promise<ProcResult>;
  /** Test seam for reading whisper's `.vtt`; production is `Bun.file().text()`. */
  readVtt?: (path: string) => Promise<string>;
  /** Told when the download is done and the transcription starts. */
  onTranscribing?: () => void;
}

export interface WhisperTranscript {
  /** The WebVTT whisper wrote — feed it to `vttToSegments`. */
  vtt: string;
  /** whisper's detected language (`no`, `en`, …), `en` on an English-only model, `und` when unannounced. */
  lang: string;
  /** Bytes of audio downloaded, init segment included. */
  audioBytes: number;
}

/**
 * Download the whole Opus rendition and transcribe it.
 *
 * Throws {@link VimeoTranscriptionError} on any step failing — the caller
 * fails the JOB with a stable code, never a crash. Availability is the
 * caller's pre-flight ({@link whisperUnavailableReason}); this function
 * assumes the binaries exist and lets a missing one surface as a spawn error.
 */
export async function transcribeOpusRendition(
  input: TranscribeRenditionInput,
  opts: TranscribeRenditionOptions,
): Promise<WhisperTranscript> {
  const rep = chooseRepresentation(input.manifest, { kind: "audio", codec: "opus" });
  if (!rep) throw new VimeoTranscriptionError("Vimeo manifest has no audio rendition");
  const run = opts.run ?? runProc;
  const readVtt = opts.readVtt ?? ((p: string) => Bun.file(p).text());

  const audioPath = join(input.workDir, "audio.mp4");
  const wavPath = join(input.workDir, "audio.wav");
  const vttBase = join(input.workDir, "whisper");

  const indices = rep.segments.map((_, i) => i);
  let audioBytes: number;
  try {
    const file = await downloadRendition(input.manifestUrl, input.manifest, rep, indices, audioPath, {
      timeoutMs: renditionTimeoutFor(indices.length),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    audioBytes = file.bytes;
  } catch (err) {
    throw new VimeoTranscriptionError(
      `Audio download failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  log.info("Downloaded {rep} ({codecs}, {kbps} kbps): {segments} segments, {bytes} bytes", {
    rep: rep.id,
    codecs: rep.codecs,
    kbps: Math.round(rep.avgBitrate / 1000),
    segments: indices.length,
    bytes: audioBytes,
  });
  opts.onTranscribing?.();

  const ffmpeg = await run(
    ["ffmpeg", "-v", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", "-y", wavPath],
    audioDecodeTimeoutFor(input.durationSec),
    "ffmpeg audio decode",
  );
  if (ffmpeg.exitCode !== 0) {
    throw new VimeoTranscriptionError(`ffmpeg audio decode failed (exit ${ffmpeg.exitCode}): ${ffmpeg.stderr.slice(-500)}`);
  }

  const englishOnly = isEnglishOnlyModel(opts.modelPath);
  if (englishOnly) {
    log.warn(
      "Whisper model {model} is English-only: a non-English talk will be mis-transcribed — set VIMEO_WHISPER_MODEL_PATH to a multilingual model (ggml-small.bin)",
      { model: opts.modelPath },
    );
  }
  const whisper = await run(
    // `-l auto` on a multilingual model detects; an English-only model ignores it.
    ["whisper-cli", "--model", opts.modelPath, "-l", "auto", "-ovtt", "-of", vttBase, wavPath],
    whisperTimeoutFor(input.durationSec),
    "whisper-cli",
  );
  if (whisper.exitCode !== 0) {
    throw new VimeoTranscriptionError(`whisper-cli failed (exit ${whisper.exitCode}): ${whisper.stderr.slice(-500)}`);
  }
  let vtt: string;
  try {
    vtt = await readVtt(`${vttBase}.vtt`);
  } catch (err) {
    throw new VimeoTranscriptionError(
      `whisper-cli exited 0 but wrote no ${vttBase}.vtt: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const lang = englishOnly ? "en" : (parseDetectedLanguage(whisper.stderr) ?? UNDETERMINED_LANG);
  log.info("Transcribed {sec}s of audio: language {lang}, {chars} chars of VTT", {
    sec: Math.round(input.durationSec),
    lang,
    chars: vtt.length,
  });
  return { vtt, lang, audioBytes };
}
