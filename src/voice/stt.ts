import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import type { Config } from "../config.ts";

export async function transcribeVoice(
  oggBuffer: Uint8Array,
  config: Config,
): Promise<string> {
  const id = crypto.randomUUID();
  const oggPath = join(tmpdir(), `jarvis-${id}.ogg`);
  const wavPath = join(tmpdir(), `jarvis-${id}.wav`);

  try {
    // Write OGG to temp file
    await Bun.write(oggPath, oggBuffer);

    // Convert OGG/Opus → 16kHz mono WAV (whisper-cli can't handle Telegram's OGG/Opus)
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-i", oggPath, "-ar", "16000", "-ac", "1", "-y", wavPath],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );
    // Drain stderr concurrently with exit — awaiting `exited` first can deadlock
    // if ffmpeg fills the stderr pipe buffer before exiting (same as the whisper
    // call below).
    const [ffmpegStderr, ffmpegExit] = await Promise.all([
      new Response(ffmpeg.stderr).text(),
      ffmpeg.exited,
    ]);
    if (ffmpegExit !== 0) {
      throw new Error(`ffmpeg failed (exit ${ffmpegExit}): ${ffmpegStderr}`);
    }

    // Transcribe WAV → text
    const whisper = Bun.spawn(
      [
        "whisper-cli",
        "--model", config.whisperModelPath,
        "--no-timestamps",
        wavPath,
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    // Drain stdout AND stderr concurrently with exit — whisper-cli is verbose on
    // stderr (ggml init, BLAS info, progress dots) and can fill the stderr pipe
    // buffer before exiting, deadlocking the same way ffmpeg above would have.
    const [whisperStdout, whisperStderr, whisperExit] = await Promise.all([
      new Response(whisper.stdout).text(),
      new Response(whisper.stderr).text(),
      whisper.exited,
    ]);
    if (whisperExit !== 0) {
      throw new Error(`whisper-cli failed (exit ${whisperExit}): ${whisperStderr}`);
    }

    // Clean up whisper artifacts and whitespace
    const text = whisperStdout
      .replace(/\[BLANK_AUDIO\]/g, "")
      .replace(/\[.*?\]/g, "")
      .trim();

    if (!text) {
      throw new Error("Could not detect any speech in the audio");
    }

    return text;
  } finally {
    await Promise.all([
      unlink(oggPath).catch(() => {}),
      unlink(wavPath).catch(() => {}),
    ]);
  }
}
