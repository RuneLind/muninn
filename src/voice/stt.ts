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
    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed (exit ${ffmpegExit}): ${stderr}`);
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
    const [whisperStdout, whisperExit] = await Promise.all([
      new Response(whisper.stdout).text(),
      whisper.exited,
    ]);
    if (whisperExit !== 0) {
      const stderr = await new Response(whisper.stderr).text();
      throw new Error(`whisper-cli failed (exit ${whisperExit}): ${stderr}`);
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
