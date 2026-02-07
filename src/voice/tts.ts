import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";

const MAX_TTS_CHARS = 4000;

export async function synthesizeVoice(text: string): Promise<Uint8Array> {
  const id = crypto.randomUUID();
  const textPath = join(tmpdir(), `jarvis-${id}.txt`);
  const aiffPath = join(tmpdir(), `jarvis-${id}.aiff`);
  const oggPath = join(tmpdir(), `jarvis-${id}-out.ogg`);

  try {
    // Truncate for practical TTS limits
    const truncated = text.length > MAX_TTS_CHARS
      ? text.slice(0, MAX_TTS_CHARS) + "..."
      : text;

    // Write text to file (avoids shell argument length limits)
    await Bun.write(textPath, truncated);

    // macOS say: text file → AIFF
    const say = Bun.spawn(
      ["say", "-o", aiffPath, "-f", textPath],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );
    const sayExit = await say.exited;
    if (sayExit !== 0) {
      const stderr = await new Response(say.stderr).text();
      throw new Error(`say failed (exit ${sayExit}): ${stderr}`);
    }

    // Convert AIFF → OGG/Opus for Telegram
    const ffmpeg = Bun.spawn(
      [
        "ffmpeg", "-i", aiffPath,
        "-c:a", "libopus", "-b:a", "64k",
        "-y", oggPath,
      ],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );
    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed (exit ${ffmpegExit}): ${stderr}`);
    }

    // Read the OGG buffer
    const oggFile = Bun.file(oggPath);
    return new Uint8Array(await oggFile.arrayBuffer());
  } finally {
    await Promise.all([
      unlink(textPath).catch(() => {}),
      unlink(aiffPath).catch(() => {}),
      unlink(oggPath).catch(() => {}),
    ]);
  }
}
