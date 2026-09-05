/**
 * The Whisper fallback (v2 PR 5), offline: the download is driven through
 * `fetchImpl` against the committed manifest fixture, the two spawns through
 * the `run` seam, and whisper's `.vtt` through `readVtt`.
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVimeoManifest, VIMEO_MEDIA_HOST, type VimeoManifest } from "./media.ts";
import {
  audioDecodeTimeoutFor,
  isEnglishOnlyModel,
  parseDetectedLanguage,
  transcribeOpusRendition,
  VimeoTranscriptionError,
  whisperTimeoutFor,
  whisperUnavailableReason,
  UNDETERMINED_LANG,
  WHISPER_CAPTION_KIND,
} from "./whisper.ts";

const FIXTURE_RAW = JSON.parse(readFileSync(new URL("./fixtures/manifest-placeholder.json", import.meta.url).pathname, "utf8"));
const MANIFEST_URL = `https://${VIMEO_MEDIA_HOST}/exp=0~acl=placeholder~hmac=placeholder/00000000-0000-4000-8000-000000000000/psid=placeholder/v2/playlist/av/primary/prot/placeholder/playlist.json?omit=av1-hevc&pathsig=placeholder`;
const fixture = (): VimeoManifest => parseVimeoManifest(FIXTURE_RAW);

const WHISPER_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n Hei og velkommen.\n";
const STDERR_NO = "whisper_init_from_file_with_params_no_state: loading model\nwhisper_full_with_state: auto-detected language: no (p = 0.876772)\n";

let warns: LogRecord[] = [];
beforeAll(async () => {
  await configure({
    sinks: { capture: (r: LogRecord) => { if (r.level === "warning") warns.push(r); } },
    loggers: [
      { category: ["muninn", "vimeo", "whisper"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
});

/** A `fetch` answering every segment with `size` bytes (the fixture's declared size + the CDN's extra byte). */
function cdnFetch(m: VimeoManifest) {
  const rep = m.audio.find((r) => r.codecs === "opus")!;
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const range = Number(new URL(url).searchParams.get("range"));
    const seg = rep.segments[range]!;
    return new Response(new Uint8Array(new ArrayBuffer(seg.size + 1)), { status: 200, headers: { "content-type": "video/mp4" } });
  }) as unknown as typeof fetch;
  return { impl, urls, rep };
}

interface Spawn { cmd: string[]; timeoutMs: number; label: string }

/** A `run` seam that records spawns and answers each binary as told. */
function fakeRun(answers: { ffmpeg?: { exitCode: number; stderr?: string }; whisper?: { exitCode: number; stderr?: string } } = {}) {
  const spawns: Spawn[] = [];
  const run = async (cmd: string[], timeoutMs: number, label: string) => {
    spawns.push({ cmd, timeoutMs, label });
    const a = cmd[0] === "ffmpeg" ? answers.ffmpeg : answers.whisper;
    return { stdout: "", stderr: a?.stderr ?? (cmd[0] === "whisper-cli" ? STDERR_NO : ""), exitCode: a?.exitCode ?? 0 };
  };
  return { run, spawns };
}

function workDir() {
  return mkdtempSync(join(tmpdir(), "vimeo-whisper-"));
}

describe("the pure rules", () => {
  test("timeouts follow the TikTok clocks: 1 s/s floor 2 min for whisper, 0.2 s/s floor 1 min for the decode", () => {
    expect(whisperTimeoutFor(60)).toBe(120_000);
    expect(whisperTimeoutFor(3180)).toBe(3_180_000);
    expect(whisperTimeoutFor(-5)).toBe(120_000);
    expect(audioDecodeTimeoutFor(60)).toBe(60_000);
    expect(audioDecodeTimeoutFor(3180)).toBe(636_000);
  });

  test("English-only models are the `.en` ones, by name", () => {
    expect(isEnglishOnlyModel("./models/ggml-base.en.bin")).toBe(true);
    expect(isEnglishOnlyModel("/x/ggml-small.en.bin")).toBe(true);
    expect(isEnglishOnlyModel("/x/ggml-small.bin")).toBe(false);
    expect(isEnglishOnlyModel("/x/ggml-medium-q5_0.bin")).toBe(false);
    // `.en` must be the extension-adjacent token, not a substring of the name.
    expect(isEnglishOnlyModel("/x/ggml-tiny-en-fr.bin")).toBe(false);
    expect(isEnglishOnlyModel("/en/ggml-small.bin")).toBe(false);
  });

  test("the detected language is read off whisper's stderr line, lowercased; absent ⇒ null", () => {
    expect(parseDetectedLanguage(STDERR_NO)).toBe("no");
    expect(parseDetectedLanguage("whisper_full_with_state: auto-detected language: EN (p = 0.5)")).toBe("en");
    expect(parseDetectedLanguage("whisper_full_with_state: auto-detected language: nn\n")).toBe("nn");
    expect(parseDetectedLanguage("loading model\n")).toBeNull();
    expect(parseDetectedLanguage("")).toBeNull();
  });

  test("the document's caption_kind for this path is `whisper`, distinct from manual/auto/stub", () => {
    expect(WHISPER_CAPTION_KIND).toBe("whisper");
    expect(["manual", "auto", "stub"]).not.toContain(WHISPER_CAPTION_KIND);
  });
});

describe("whisperUnavailableReason — the pre-flight", () => {
  const all = { which: () => "/bin/x", exists: () => true };
  test("null when ffmpeg, whisper-cli and the model are all present", () => {
    expect(whisperUnavailableReason("/m/ggml-small.bin", all)).toBeNull();
  });
  test("names each missing piece, whisper-cli with its brew line, the model with its variable", () => {
    const r = whisperUnavailableReason("/m/ggml-small.bin", { which: (b) => (b === "ffmpeg" ? "/bin/ffmpeg" : null), exists: () => false })!;
    expect(r).toContain("whisper-cli is not on PATH (brew install whisper-cpp)");
    expect(r).toContain("/m/ggml-small.bin does not exist (set VIMEO_WHISPER_MODEL_PATH)");
    expect(r).not.toContain("ffmpeg is not");
    expect(whisperUnavailableReason("/m/x.bin", { which: () => null, exists: () => true })).toContain("ffmpeg is not on PATH");
  });
  test("the default probes read PATH and the filesystem (a model path that does not exist is refused)", () => {
    const r = whisperUnavailableReason("/definitely/not/here/ggml.bin");
    expect(r).toContain("/definitely/not/here/ggml.bin does not exist");
  });
});

describe("transcribeOpusRendition", () => {
  test("downloads EVERY segment of the Opus rendition, decodes it, runs whisper with -l auto -ovtt, returns the VTT + detected language", async () => {
    const m = fixture();
    const { impl, urls, rep } = cdnFetch(m);
    const { run, spawns } = fakeRun();
    const dir = workDir();
    const reads: string[] = [];
    const order: string[] = [];
    const result = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 3180, workDir: dir },
      {
        modelPath: "/m/ggml-small.bin",
        fetchImpl: impl,
        run: async (cmd, t, l) => { order.push(cmd[0]!); return run(cmd, t, l); },
        readVtt: async (p) => { reads.push(p); return WHISPER_VTT; },
        onTranscribing: () => order.push("onTranscribing"),
      },
    );

    // The whole rendition, in order, one request per segment — the Opus one, not AAC.
    expect(urls.length).toBe(rep.segments.length);
    expect(urls.every((u) => u.includes("rep-audio-opus"))).toBe(true);
    expect(urls.map((u) => Number(new URL(u).searchParams.get("range")))).toEqual(rep.segments.map((_, i) => i));
    expect(existsSync(join(dir, "audio.mp4"))).toBe(true);
    expect(result.audioBytes).toBeGreaterThan(rep.segments.reduce((s, x) => s + x.size, 0));

    // Status hook fires AFTER the download and BEFORE the first spawn.
    expect(order).toEqual(["onTranscribing", "ffmpeg", "whisper-cli"]);

    const [ffmpeg, whisper] = spawns;
    expect(ffmpeg!.cmd).toEqual(["ffmpeg", "-v", "error", "-i", join(dir, "audio.mp4"), "-ar", "16000", "-ac", "1", "-y", join(dir, "audio.wav")]);
    expect(ffmpeg!.timeoutMs).toBe(audioDecodeTimeoutFor(3180));
    expect(whisper!.cmd).toEqual(["whisper-cli", "--model", "/m/ggml-small.bin", "-l", "auto", "-ovtt", "-of", join(dir, "whisper"), join(dir, "audio.wav")]);
    expect(whisper!.timeoutMs).toBe(whisperTimeoutFor(3180));
    expect(reads).toEqual([join(dir, "whisper.vtt")]);

    expect(result.vtt).toBe(WHISPER_VTT);
    expect(result.lang).toBe("no");
  });

  test("an English-only model warns and records `en` — whisper's detection never ran", async () => {
    warns = [];
    const m = fixture();
    const { run } = fakeRun({ whisper: { exitCode: 0, stderr: "whisper_model_load: model is not multilingual, ignoring language and translation options\n" } });
    const r = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: workDir() },
      { modelPath: "/m/ggml-base.en.bin", fetchImpl: cdnFetch(m).impl, run, readVtt: async () => WHISPER_VTT },
    );
    expect(r.lang).toBe("en");
    expect(warns.some((w) => String(w.message).includes("English-only"))).toBe(true);
  });

  test("a multilingual model whose stderr names no language records `und`, never a guess", async () => {
    const m = fixture();
    const { run } = fakeRun({ whisper: { exitCode: 0, stderr: "loading model\n" } });
    const r = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: workDir() },
      { modelPath: "/m/ggml-small.bin", fetchImpl: cdnFetch(m).impl, run, readVtt: async () => WHISPER_VTT },
    );
    expect(r.lang).toBe(UNDETERMINED_LANG);
  });

  test("a manifest with no audio rendition is a VimeoTranscriptionError before any request", async () => {
    const m: VimeoManifest = { ...fixture(), audio: [] };
    const { impl, urls } = cdnFetch(fixture());
    const { run, spawns } = fakeRun();
    await expect(
      transcribeOpusRendition({ manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: workDir() }, { modelPath: "/m/x.bin", fetchImpl: impl, run }),
    ).rejects.toBeInstanceOf(VimeoTranscriptionError);
    expect(urls).toEqual([]);
    expect(spawns).toEqual([]);
  });

  test("a failed download is wrapped as a VimeoTranscriptionError naming the download, with no spawn", async () => {
    const m = fixture();
    const impl = (async () => new Response("nope", { status: 403, headers: { "content-type": "video/mp4" } })) as unknown as typeof fetch;
    const { run, spawns } = fakeRun();
    const err = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: workDir() },
      { modelPath: "/m/x.bin", fetchImpl: impl, run },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(VimeoTranscriptionError);
    expect(err.message).toMatch(/^Audio download failed: /);
    expect(spawns).toEqual([]);
  });

  test("ffmpeg exiting non-zero fails with its stderr tail and whisper is never spawned", async () => {
    const m = fixture();
    const { run, spawns } = fakeRun({ ffmpeg: { exitCode: 1, stderr: "Invalid data found when processing input" } });
    const err = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: workDir() },
      { modelPath: "/m/x.bin", fetchImpl: cdnFetch(m).impl, run },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(VimeoTranscriptionError);
    expect(err.message).toContain("ffmpeg audio decode failed (exit 1): Invalid data");
    expect(spawns.map((s) => s.cmd[0])).toEqual(["ffmpeg"]);
  });

  test("whisper exiting non-zero fails with its stderr tail; exit 0 with no .vtt written fails naming the file", async () => {
    const m = fixture();
    const bad = fakeRun({ whisper: { exitCode: 2, stderr: "failed to initialize whisper context" } });
    const err = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: workDir() },
      { modelPath: "/m/x.bin", fetchImpl: cdnFetch(m).impl, run: bad.run },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(VimeoTranscriptionError);
    expect(err.message).toContain("whisper-cli failed (exit 2): failed to initialize");

    const dir = workDir();
    const good = fakeRun();
    // The production reader: the file was never written, so Bun.file().text() throws ENOENT.
    const err2 = await transcribeOpusRendition(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 60, workDir: dir },
      { modelPath: "/m/x.bin", fetchImpl: cdnFetch(m).impl, run: good.run },
    ).catch((e) => e);
    expect(err2).toBeInstanceOf(VimeoTranscriptionError);
    expect(err2.message).toContain(`wrote no ${join(dir, "whisper")}.vtt`);
  });
});
