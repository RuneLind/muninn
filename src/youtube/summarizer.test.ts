/**
 * The YouTube capture job itself — the frames path and the transcript-only one.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains) and MUST stay that way: `mock.module` here replaces `../ai/one-shot.ts`
 * and `../gardener/source-drafter-run.ts`, which a large share of the suite
 * imports transitively — mocking them inside a shared chunk breaks export
 * resolution in unrelated files. `src/test/mock-isolation.test.ts` pins it.
 *
 * huginn is a REAL local `Bun.serve`, not a mock: the two things this file has
 * to see about the transcript half — the exact URL the job asks for
 * (`?timestamps=1` or not) and the exact body it posts to the ingest — are both
 * on the wire, and a `fetchImpl` seam would be a second implementation of the
 * thing under test. yt-dlp and ffmpeg are injected (`deps`); nothing here
 * downloads or decodes anything.
 */
import { test, expect, describe, beforeEach, beforeAll, afterAll, mock } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { CaptureFrame } from "../summaries/frames.ts";
import type { VisualDetail } from "../summaries/visual-detail.ts";
import type { DownloadOptions, DownloadResult, YtDlpInfo } from "../video/media.ts";

const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

let claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
let lastPrompt: string | undefined;
let lastSystemPrompt: string | undefined;
let lastExtraDirs: string[] | undefined;
let lastThinking: number | undefined;
/** The bot config the model call ran with — the KIND may have swapped its model. */
let lastBotConfig: { model?: string; thinkingMaxTokens?: number } | undefined;
let lastTimeoutMs: number | undefined;
/** Whatever the one-shot wants to check about the world at the moment it runs. */
let atModelCall: (() => void) | null = null;

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    botConfig: { model?: string; thinkingMaxTokens?: number },
    opts?: {
      systemPrompt?: string;
      thinkingMaxTokens?: number;
      extraDirs?: string[];
      timeoutMs?: number;
      onProgress?: (e: { type: string; text: string }) => void;
    },
  ) => {
    lastPrompt = prompt;
    lastBotConfig = botConfig;
    lastSystemPrompt = opts?.systemPrompt;
    lastExtraDirs = opts?.extraDirs;
    lastThinking = opts?.thinkingMaxTokens;
    lastTimeoutMs = opts?.timeoutMs;
    atModelCall?.();
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  connectorCapabilities: () => ({
    supportsExtraDirs: connectorSupportsExtraDirs,
    supportsThinkingBudget: true,
    supportsWebTools: true,
  }),
}));
/** The one capability this file flips — the summarizer's second-line frames check. */
let connectorSupportsExtraDirs = true;

let sourceDraftCalls: Array<Record<string, unknown>> = [];
mock.module("../gardener/source-drafter-run.ts", () => ({
  triggerSourceDraftFromCapture: (_bot: unknown, input: Record<string, unknown>) => {
    sourceDraftCalls.push(input);
  },
}));

/**
 * The attributes the `claude` span was STARTED with.
 *
 * `extraTraceAttrs` is the only channel that carries the kind and the effective
 * thinking budget onto the trace, and it reaches the span through
 * `runCaptureOneShot` → `tracedOneShot` → `tracer.start`. Patching the real
 * prototype rather than mocking a module keeps the whole chain under test — the
 * mocked `executeOneShot` below is downstream of it and never sees these — and
 * this file already runs in a process of its own (its `mock.module` calls), so
 * the patch cannot reach another suite.
 */
let lastClaudeSpanAttrs: Record<string, unknown> | undefined;
const { Tracer } = await import("../tracing/tracer.ts");
const realTracerStart = Tracer.prototype.start;
Tracer.prototype.start = function patchedStart(
  this: InstanceType<typeof Tracer>,
  label: string,
  attributes?: Record<string, unknown>,
) {
  if (label === "claude") lastClaudeSpanAttrs = attributes;
  return realTracerStart.call(this, label, attributes);
};

const { summarizeVideo } = await import("./summarizer.ts");
const { createJob, getJob } = await import("./state.ts");
const { YOUTUBE_FRAME_FORMAT_SELECTOR } = await import("./frames.ts");
const {
  CAPTURE_DEEP_MODEL,
  SHIPPED_CAPTURE_PRESETS,
  findCapturePreset,
  resolveCapturePresets,
} = await import("../summaries/presets.ts");
type CapturePreset = (typeof SHIPPED_CAPTURE_PRESETS)[number];

/** The kind every case runs under unless it names another. */
const STANDARD_PRESET = findCapturePreset(SHIPPED_CAPTURE_PRESETS, "standard")!;

// --- a real huginn on loopback ---------------------------------------------

/** Every transcript URL the job asked for, in order — path + query. */
let transcriptRequests: string[] = [];
/** Every ingest body the job posted, in order. */
let ingestBodies: Array<Record<string, unknown>> = [];
/** The transcript the stub answers with, and the status it answers under. */
let transcriptBody: { transcript?: string } = {};
let transcriptStatus = 200;
/**
 * Whether this huginn is a post-#129 one.
 *
 * `true` — the shipped endpoint: it ECHOES `timestamps: true` when it windowed
 * the transcript. `false` — a pre-#129 huginn (the one on 127.0.0.1:8321 as
 * this lands): it ignores the parameter entirely and answers a plain transcript
 * with no `timestamps` key, which is exactly the case where asking for windows
 * and getting none must not put a `### [HH:MM:SS]` rider on the prompt.
 */
let huginnEchoesTimestamps = true;

const huginn = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/youtube/transcript/")) {
      transcriptRequests.push(u.pathname + u.search);
      if (transcriptStatus !== 200) return new Response("nope", { status: transcriptStatus });
      const windowed = huginnEchoesTimestamps && u.searchParams.get("timestamps") === "1";
      return Response.json(windowed ? { ...transcriptBody, timestamps: true } : transcriptBody);
    }
    if (u.pathname === "/api/youtube/ingest") {
      ingestBodies.push((await req.json()) as Record<string, unknown>);
      return Response.json({ file_path: "ai/rag/A talk.md", similar: [] });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => huginn.stop(true));

const config = {
  knowledgeApiUrl: `http://127.0.0.1:${huginn.port}`,
  claudeTimeoutMs: 120_000,
} as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

// --- the yt-dlp / ffmpeg seams ---------------------------------------------

const tmpDirs: string[] = [];
function tmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

let probeAnswer: YtDlpInfo | null = { id: VIDEO_ID, title: "A talk", duration: 1200, uploader: "conf" };
let probeCalls: string[] = [];
/** Whatever a case wants to know about the world at the moment the probe runs. */
let atProbe: (() => void) | null = null;
let downloadCalls: Array<{ url: string; workDir: string; opts: DownloadOptions }> = [];
/** Same, for the download — the work dir has to exist by then. */
let atDownload: ((workDir: string) => void) | null = null;
/** Held open by the concurrency case: a download parks here until it is released. */
let downloadGate: Promise<void> | null = null;
/** `download:start` / `download:end` in order, so an overlap is visible as interleaving. */
let downloadTrace: string[] = [];
let downloadThrows: Error | null = null;
let extractCalls: Array<{ file: string; durationSec: number; outDir: string }> = [];
let extractThrows: Error | null = null;
/** The seconds the fake extractor produces frames at. */
let extractTicks: number[] = [30, 600, 1170];
/**
 * Ticks the extractor REPORTS but writes no file for — the only way to reach
 * `keepReferencedFrames`' copy failure, which is what the stored text has to be
 * repaired against (a reference to a picture the route will 404).
 */
let missingFrameFiles: number[] = [];
/** Where kept frames land — a throwaway root, never the developer's `~/.muninn`. */
let framesRoot = "";
/** The path of the "downloaded video", so a case can check when it was unlinked. */
let lastVideoPath = "";

function deps() {
  return {
    probeVideoInfo: async (url: string) => {
      probeCalls.push(url);
      atProbe?.();
      return probeAnswer;
    },
    downloadVideo: async (url: string, workDir: string, opts: DownloadOptions): Promise<DownloadResult> => {
      downloadCalls.push({ url, workDir, opts });
      atDownload?.(workDir);
      downloadTrace.push(`start:${url}`);
      if (downloadGate) await downloadGate;
      downloadTrace.push(`end:${url}`);
      if (downloadThrows) throw downloadThrows;
      mkdirSync(workDir, { recursive: true });
      lastVideoPath = join(workDir, "video.mp4");
      writeFileSync(lastVideoPath, "not really an mp4");
      return {
        videoPath: lastVideoPath,
        id: VIDEO_ID,
        title: "A talk",
        duration: 1200,
        uploader: "conf",
        canonicalUrl: WATCH_URL,
      };
    },
    extractFrames: async (input: { file: string; durationSec: number; outDir: string }): Promise<CaptureFrame[]> => {
      extractCalls.push(input);
      if (extractThrows) throw extractThrows;
      mkdirSync(input.outDir, { recursive: true });
      return extractTicks.map((t) => {
        const path = join(input.outDir, `${t}.jpg`);
        if (!missingFrameFiles.includes(t)) writeFileSync(path, `jpeg-${t}`);
        return { path, tSeconds: t };
      });
    },
    framesRoot,
  };
}

// --- logs -------------------------------------------------------------------

let logs: LogRecord[] = [];
beforeAll(async () => {
  await configure({
    sinks: { capture: (r: LogRecord) => logs.push(r) },
    loggers: [{ category: ["muninn"], lowestLevel: "debug", sinks: ["capture"] }],
    reset: true,
  });
});
function logged(level: LogRecord["level"], needle: string): boolean {
  return logs.some((r) => r.level === level && String(r.message.join("")).includes(needle));
}

beforeEach(() => {
  logs = [];
  transcriptRequests = [];
  ingestBodies = [];
  sourceDraftCalls = [];
  probeCalls = [];
  atProbe = null;
  atDownload = null;
  downloadGate = null;
  downloadTrace = [];
  downloadCalls = [];
  extractCalls = [];
  downloadThrows = null;
  huginnEchoesTimestamps = true;
  extractThrows = null;
  extractTicks = [30, 600, 1170];
  missingFrameFiles = [];
  probeAnswer = { id: VIDEO_ID, title: "A talk", duration: 1200, uploader: "conf" };
  connectorSupportsExtraDirs = true;
  transcriptStatus = 200;
  transcriptBody = { transcript: "### [00:00:00]\nhello there\n\n### [00:02:00]\nmore words" };
  claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
  lastPrompt = undefined;
  lastSystemPrompt = undefined;
  lastExtraDirs = undefined;
  lastThinking = undefined;
  lastBotConfig = undefined;
  lastTimeoutMs = undefined;
  atModelCall = null;
  lastClaudeSpanAttrs = undefined;
  framesRoot = tmpRoot("yt-frames-root-");
});

/** Run one capture and hand back its job id. */
async function run(
  opts: {
    frames?: boolean;
    preset?: CapturePreset;
    sourceDraft?: boolean;
    botConfig?: BotConfig;
    visualDetail?: VisualDetail;
    onIngested?: (v: string, d: string) => void;
  } = {},
) {
  const jobId = createJob(VIDEO_ID, "A talk", WATCH_URL);
  await summarizeVideo(jobId, VIDEO_ID, "A talk", config, opts.botConfig ?? bot, {
    ...(opts.frames !== undefined ? { frames: opts.frames } : {}),
    // Deliberately ABSENT unless a case names one: the summarizer's own default
    // is the named `DEFAULT_VISUAL_DETAIL`, and a helper that always passed a
    // value would hide a default that moved.
    ...(opts.visualDetail !== undefined ? { visualDetail: opts.visualDetail } : {}),
    // REQUIRED on the options now (the Vimeo precedent): a caller that names no
    // kind is a compile error rather than a positional pick out of the shipped
    // array, so this helper names `standard` explicitly.
    preset: opts.preset ?? STANDARD_PRESET,
    ...(opts.onIngested ? { onIngested: opts.onIngested } : {}),
    deps: {
      ...deps(),
      ...(opts.sourceDraft !== undefined ? { sourceDraft: opts.sourceDraft } : {}),
    },
  });
  return jobId;
}

describe("frames off — the capture that shipped before this PR", () => {
  test("no probe, no download, plain transcript URL, byte-identical prompt", async () => {
    const jobId = await run();

    expect(probeCalls).toEqual([]);
    expect(downloadCalls).toEqual([]);
    expect(transcriptRequests).toEqual([`/api/youtube/transcript/${VIDEO_ID}`]);
    // The frame list contributes nothing and the windowed-transcript rider is
    // absent, so the prompt pair is what it always was.
    expect(lastPrompt).toBe(transcriptBody.transcript);
    expect(lastSystemPrompt).not.toContain("### [HH:MM:SS]");
    expect(lastExtraDirs).toBeUndefined();
    expect(getJob(jobId)?.status).toBe("complete");
  });

  test("the ingest body carries NO transcript section", async () => {
    await run();
    expect(ingestBodies).toHaveLength(1);
    expect(ingestBodies[0]!.summary).toBe("### Heading\n- point");
    expect(String(ingestBodies[0]!.summary)).not.toContain("## Transcript");
  });

  test("the capture keeps the shared 8k thinking cap", async () => {
    await run();
    expect(lastThinking).toBe(8000);
  });
});

describe("frames on", () => {
  test("the probe target is derived from the VIDEO ID, never from the caller's url", async () => {
    // The route is CORS-`*` with MUNINN_AUTH=off, so a client-supplied url
    // reaching yt-dlp would let any page spawn it against an arbitrary host.
    await summarizeVideo(
      createJob(VIDEO_ID, "A talk", "https://evil.test/whatever"),
      VIDEO_ID,
      "A talk",
      config,
      bot,
      { frames: true, preset: STANDARD_PRESET, deps: deps() },
    );
    expect(probeCalls).toEqual([WATCH_URL]);
    expect(downloadCalls.map((d) => d.url)).toEqual([WATCH_URL]);
  });

  test("the transcript is asked for WINDOWED and the system prompt says so", async () => {
    await run({ frames: true });
    expect(transcriptRequests).toEqual([`/api/youtube/transcript/${VIDEO_ID}?timestamps=1`]);
    expect(lastSystemPrompt).toContain("### [HH:MM:SS]");
  });

  test("the download is video-only, capped, and budgeted from the probed duration", async () => {
    await run({ frames: true });
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]!.opts.format).toBe(YOUTUBE_FRAME_FORMAT_SELECTOR);
    expect(downloadCalls[0]!.opts.maxDurationSeconds).toBe(10_800);
    // 1200 s × 300 ms, above the 300 s floor.
    expect(downloadCalls[0]!.opts.timeoutMs).toBe(360_000);
  });

  test("the frames go in a subdir of the work dir, at the frame height", async () => {
    await run({ frames: true });
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]!.durationSec).toBe(1200);
    expect(extractCalls[0]!.outDir).toBe(join(downloadCalls[0]!.workDir, "frames"));
    // The height itself is the SEAM's constant (`CAPTURE_FRAME_HEIGHT`), pinned
    // in `src/summaries/frames.test.ts` — this vertical no longer keeps a
    // second copy of it to assert against.
  });

  test("the work dir EXISTS by the time the download is handed it", async () => {
    // yt-dlp creates the `-o` directory itself, so this is not load-bearing for
    // the download — it is for everything after: the extractor writes into
    // `<workDir>/frames` and the model is handed `workDir` as `--add-dir`. The
    // sibling verticals all mkdir first.
    let existed: boolean | null = null as boolean | null;
    atDownload = (workDir) => { existed = existsSync(workDir); };
    await run({ frames: true });
    expect(existed).toBe(true);
  });

  test("the video file is gone BEFORE the model call, and the work dir is the extraDir", async () => {
    // `boolean | null` rather than an inferred `null`: the whole point is the
    // assignment inside the callback, and a `null`-typed binding makes
    // `toBe(false)` a compile error rather than a check.
    let existedAtModelCall: boolean | null = null as boolean | null;
    atModelCall = () => {
      existedAtModelCall = existsSync(lastVideoPath);
    };
    await run({ frames: true });
    // It must not sit through a ten-minute turn inside the directory the model
    // is handed as `--add-dir`.
    expect(existedAtModelCall).toBe(false);
    expect(lastExtraDirs).toEqual([downloadCalls[0]!.workDir]);
  });

  test("the frame list is on the prompt and the thinking cap is lifted", async () => {
    await run({ frames: true });
    expect(lastPrompt!.startsWith(transcriptBody.transcript!)).toBe(true);
    expect(lastPrompt).toContain(`/api/frames/youtube/${VIDEO_ID}/`);
    expect(lastPrompt).toContain("t=00:00:30");
    // TikTok's opt-out: frame reading IS the reasoning.
    expect(lastThinking).toBeUndefined();
    // 3 frames is under the 30-frame knee, so the floor binds.
    expect(lastTimeoutMs).toBe(600_000);
  });

  test("the summarize budget SCALES with the frame count past the 30-frame knee", async () => {
    // A bare constant here would hold a 60-frame session to a budget sized for
    // a 25-frame one: every extra frame is another image Read in the same
    // multi-turn session. 40 frames ⇒ 600 s + 10 × 24 s.
    extractTicks = Array.from({ length: 40 }, (_, i) => i * 30);
    await run({ frames: true });
    expect(lastTimeoutMs).toBe(600_000 + 10 * 24_000);
  });

  test("only the QUOTED frames are kept, under the injected root", async () => {
    claudeResult =
      "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n" +
      `![Slide at 00:10:00](/api/frames/youtube/${VIDEO_ID}/600.jpg)\n- point`;
    await run({ frames: true });
    expect(existsSync(join(framesRoot, "youtube", VIDEO_ID, "600.jpg"))).toBe(true);
    expect(existsSync(join(framesRoot, "youtube", VIDEO_ID, "30.jpg"))).toBe(false);
  });

  test("the work dir is removed when the job is done", async () => {
    await run({ frames: true });
    expect(existsSync(downloadCalls[0]!.workDir)).toBe(false);
  });

  test("the ingest body carries `## Transcript`, and nothing else does", async () => {
    const jobId = await run({ frames: true });
    const summary = String(ingestBodies[0]!.summary);
    expect(summary).toContain("\n## Transcript\n");
    expect(summary).toContain("### [00:02:00]");
    // The job's own summary, the card's text and the source-page draft all get
    // the summary ALONE — a patched one would put the transcript on the shelf
    // card and into the drafter's prompt.
    expect(getJob(jobId)?.summary).toBe("### Heading\n- point");
    expect(sourceDraftCalls).toHaveLength(1);
    expect(sourceDraftCalls[0]!.body).toBe("### Heading\n- point");
  });

  test("onIngested fires with huginn's doc id, BEFORE the job completes", async () => {
    const seen: Array<[string, string, string | undefined]> = [];
    const jobId = createJob(VIDEO_ID, "A talk", WATCH_URL);
    await summarizeVideo(jobId, VIDEO_ID, "A talk", config, bot, {
      frames: true,
      preset: STANDARD_PRESET,
      // A re-POST racing the terminal job event must find the claim already
      // written, so the hook runs while the job is still `ingesting`.
      onIngested: (v, d) => seen.push([v, d, getJob(jobId)?.status]),
      deps: deps(),
    });
    expect(seen).toEqual([[VIDEO_ID, "ai/rag/A talk.md", "ingesting"]]);
  });
});

describe("every frames failure degrades to a transcript-only capture", () => {
  test("a probe that says nothing: no download, PLAIN transcript, warn", async () => {
    probeAnswer = null;
    const jobId = await run({ frames: true });
    expect(downloadCalls).toEqual([]);
    expect(transcriptRequests).toEqual([`/api/youtube/transcript/${VIDEO_ID}`]);
    expect(logged("warning", "slides skipped")).toBe(true);
    expect(getJob(jobId)?.status).toBe("complete");
  });

  test("a live stream (duration 0) is duration_unknown, not a short clip", async () => {
    probeAnswer = { id: VIDEO_ID, title: "live", duration: 0, uploader: "conf" };
    await run({ frames: true });
    expect(downloadCalls).toEqual([]);
    expect(logs.some((r) => r.properties?.reason === "duration_unknown")).toBe(true);
  });

  test("a video under a minute skips the download entirely", async () => {
    probeAnswer = { id: VIDEO_ID, title: "clip", duration: 42, uploader: "conf" };
    await run({ frames: true });
    expect(downloadCalls).toEqual([]);
    expect(logs.some((r) => r.properties?.reason === "too_short")).toBe(true);
  });

  test("a connector that cannot read files is refused in the job too", async () => {
    // The route 503s first; this is the second line, and without it the job
    // would spend a download and an ffmpeg pass on images nothing can open.
    connectorSupportsExtraDirs = false;
    await run({ frames: true });
    expect(probeCalls).toHaveLength(1);
    expect(downloadCalls).toEqual([]);
    expect(logs.some((r) => r.properties?.reason === "unsupported")).toBe(true);
  });

  test("yt-dlp failing mid-download is a warn plus a complete job", async () => {
    downloadThrows = new Error("yt-dlp failed (exit 1). The site may have changed");
    const jobId = await run({ frames: true });
    expect(getJob(jobId)?.status).toBe("complete");
    expect(logged("warning", "frames failed")).toBe(true);
    expect(lastExtraDirs).toBeUndefined();
    expect(lastThinking).toBe(8000);
  });

  test("ffmpeg failing leaves the video unlinked and the capture standing", async () => {
    extractThrows = new Error("ffmpeg frame grab failed (exit 1)");
    const jobId = await run({ frames: true });
    expect(getJob(jobId)?.status).toBe("complete");
    expect(existsSync(lastVideoPath)).toBe(false);
    expect(logged("warning", "frames failed")).toBe(true);
  });

  test("a failed frames pass KEEPS the windowed transcript it already fetched", async () => {
    extractThrows = new Error("ffmpeg frame grab failed (exit 1)");
    await run({ frames: true });
    // Re-fetching the plain form to undo the decision would be a second
    // round-trip for a worse document; the transcript section still lands.
    expect(transcriptRequests).toEqual([`/api/youtube/transcript/${VIDEO_ID}?timestamps=1`]);
    expect(String(ingestBodies[0]!.summary)).toContain("## Transcript");
  });
});

describe("what is WINDOWED is what huginn ANSWERED, not what we asked for", () => {
  test("`timestamps: true` on the response ⇒ the rider and the `## Transcript` section", async () => {
    await run({ frames: true });
    expect(transcriptRequests).toEqual([`/api/youtube/transcript/${VIDEO_ID}?timestamps=1`]);
    expect(lastSystemPrompt).toContain("### [HH:MM:SS]");
    expect(String(ingestBodies[0]!.summary)).toContain("\n## Transcript\n");
  });

  test("a pre-#129 huginn ignores the parameter — no rider and no section, frames or not", async () => {
    // The endpoint that ignores `?timestamps=1` answers a PLAIN transcript with
    // no `timestamps` key (127.0.0.1:8321 as this lands). Deriving "windowed"
    // from our own frames decision then puts a `### [HH:MM:SS]` rider on a
    // prompt whose transcript has no headings at all, and files a flat wall of
    // text under `## Transcript` as if it were windowed.
    huginnEchoesTimestamps = false;
    const jobId = await run({ frames: true });

    expect(transcriptRequests).toEqual([`/api/youtube/transcript/${VIDEO_ID}?timestamps=1`]);
    expect(lastSystemPrompt).not.toContain("### [HH:MM:SS]");
    expect(String(ingestBodies[0]!.summary)).not.toContain("## Transcript");
    // Everything else about the capture is unchanged: frames still ran.
    expect(downloadCalls).toHaveLength(1);
    expect(lastExtraDirs).toEqual([downloadCalls[0]!.workDir]);
    expect(getJob(jobId)?.status).toBe("complete");
  });

  test("a frames pass that FAILED keeps the section and the rider it was answered with", async () => {
    // The transcript is windowed whether or not frames were produced, so the
    // document keeps its clock; what goes away is the slides.
    extractThrows = new Error("ffmpeg frame grab failed (exit 1)");
    await run({ frames: true });

    expect(lastSystemPrompt).toContain("### [HH:MM:SS]");
    const summary = String(ingestBodies[0]!.summary);
    expect(summary).toContain("\n## Transcript\n");
    expect(summary).not.toContain("![");
    expect(lastPrompt).not.toContain("/api/frames/youtube/");
  });
});

describe("the URL on the document is built from the VIDEO ID", () => {
  const OTHER = "https://www.youtube.com/watch?v=abcdefghijk";

  test("the ingest body, the prompt and the source draft all carry the canonical watch URL", async () => {
    // The capture takes no url at all: everything that names this video is
    // built from the id the route validated, so a POST naming video X with a
    // url for video Y cannot put Y's address on X's document (which then made
    // every later capture of Y a `duplicate` of X).
    const jobId = createJob(VIDEO_ID, "A talk", OTHER);
    await summarizeVideo(jobId, VIDEO_ID, "A talk", config, bot, { preset: STANDARD_PRESET, deps: deps() });

    expect(ingestBodies[0]!.url).toBe(WATCH_URL);
    expect(lastSystemPrompt).toContain(`Video URL: ${WATCH_URL}`);
    expect(lastSystemPrompt).not.toContain(OTHER);
    expect(sourceDraftCalls[0]!.url).toBe(WATCH_URL);
  });
});

describe("the job card moves before the expensive half", () => {
  test("the status has left `pending` by the time the probe runs", async () => {
    // The probe is a yt-dlp spawn (~3 s) and the download is minutes; a card
    // sitting at "pending" through both reads as a stuck job.
    let statusAtProbe: string | undefined;
    let jobId = "";
    atProbe = () => { statusAtProbe = getJob(jobId)?.status; };
    jobId = createJob(VIDEO_ID, "A talk", WATCH_URL);
    await summarizeVideo(jobId, VIDEO_ID, "A talk", config, bot, {
      frames: true,
      preset: STANDARD_PRESET,
      deps: deps(),
    });
    expect(statusAtProbe).toBe("fetching_transcript");
  });
});

describe("the yt-dlp/ffmpeg half is serialized process-wide", () => {
  test("two captures of DIFFERENT videos do not download at the same time", async () => {
    // N distinct-id POSTs are N legitimate captures, but they must not be N
    // concurrent yt-dlp downloads and ffmpeg passes on a laptop also running
    // the dev server, the bots and huginn (the Vimeo harvest precedent).
    let release!: () => void;
    downloadGate = new Promise<void>((r) => { release = r; });
    const OTHER_ID = "abcdefghijk";

    const first = summarizeVideo(createJob(VIDEO_ID, "A", WATCH_URL), VIDEO_ID, "A", config, bot, {
      frames: true,
      preset: STANDARD_PRESET,
      deps: deps(),
    });
    const second = summarizeVideo(
      createJob(OTHER_ID, "B", `https://www.youtube.com/watch?v=${OTHER_ID}`),
      OTHER_ID,
      "B",
      config,
      bot,
      { frames: true, preset: STANDARD_PRESET, deps: deps() },
    );

    // Let both reach their download step, then release the first.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(downloadTrace.filter((t) => t.startsWith("start:"))).toHaveLength(1);
    release();
    downloadGate = null;
    await Promise.all([first, second]);

    // Serial: each download ends before the next begins.
    expect(downloadTrace).toEqual([
      `start:${WATCH_URL}`,
      `end:${WATCH_URL}`,
      `start:https://www.youtube.com/watch?v=${OTHER_ID}`,
      `end:https://www.youtube.com/watch?v=${OTHER_ID}`,
    ]);
    // Both captures still completed — a try-lock would have dropped one.
    expect(extractCalls).toHaveLength(2);
  });
});

describe("the transcript's own size is reported, not silently cut", () => {
  test("a transcript over the 2 MiB bound warns with both byte counts", async () => {
    // `capTranscriptWindows` returns `truncated` so a caller can say so; with
    // no consumer, a talk whose second half never reached the document was
    // invisible everywhere but in the stored file.
    const window = `### [00:00:00]\n${"x".repeat(500)}`;
    transcriptBody = { transcript: Array.from({ length: 5000 }, () => window).join("\n\n") };
    await run({ frames: true });

    expect(logged("warning", "transcript truncated")).toBe(true);
    const warn = logs.find((r) => r.level === "warning" && String(r.message.join("")).includes("transcript truncated"));
    expect(Number(warn!.properties.transcriptBytes)).toBeGreaterThan(2 * 1024 * 1024);
    expect(Number(warn!.properties.keptBytes)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("the ingest budget is sized from the body it is posting", async () => {
    // 15 s is a fine budget for a 6 KB summary and a coin flip for a 2 MiB one:
    // an ingest whose RESPONSE is dropped by the timeout leaves huginn holding
    // a document this process never learns the id of, which is exactly what the
    // reindex-window dedup map needs.
    const window = `### [00:00:00]\n${"x".repeat(500)}`;
    transcriptBody = { transcript: Array.from({ length: 2000 }, () => window).join("\n\n") };
    await run({ frames: true });

    const line = logs.find((r) => String(r.message.join("")).includes("Ingesting"));
    expect(line).toBeDefined();
    expect(Number(line!.properties.timeoutMs)).toBeGreaterThan(15_000);
  });
});

describe("the transcript half still fails the job", () => {
  test("a non-200 transcript fails the job and spends no model call", async () => {
    transcriptStatus = 503;
    const jobId = await run({ frames: true });
    expect(getJob(jobId)?.status).toBe("error");
    expect(ingestBodies).toEqual([]);
  });

  test("a transcript failure comes AFTER the probe but BEFORE the download", async () => {
    // The probe decides which transcript to ask for, so it must run first; the
    // download must not, or a dead transcript would still cost 90 MB.
    transcriptStatus = 404;
    await run({ frames: true });
    expect(probeCalls).toHaveLength(1);
    expect(downloadCalls).toEqual([]);
  });
});

describe("the VISUAL DETAIL policy", () => {
  /** A summary quoting the seconds named, through the route's own address shape. */
  function summaryQuoting(...secs: number[]): string {
    return (
      "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n\n" +
      secs.map((s) => `![Slide at 00:00:00](/api/frames/youtube/${VIDEO_ID}/${s}.jpg)`).join("\n\n") +
      "\n\n- point"
    );
  }

  const kept = (sec: number) => existsSync(join(framesRoot, "youtube", VIDEO_ID, `${sec}.jpg`));

  test("the default policy is `selected`, and its rubric is what the prompt carries", async () => {
    await run({ frames: true });
    // The revised inclusion rule, not the seam's default one: a speaker talking
    // through a chart is a reason to show the chart.
    expect(lastPrompt).toContain("explain, compare, verify or revisit");
    expect(lastPrompt).not.toContain("ADDS something the transcript did not say");
    // No appendix is offered under `selected`.
    expect(lastPrompt).not.toContain("## Visual reference");
    expect(lastPrompt).toContain("At most 8 distinct frames in the whole summary");
    expect(lastClaudeSpanAttrs?.visualDetail).toBe("selected");
  });

  test("`detailed` asks for the appendix and the higher total", async () => {
    await run({ frames: true, visualDetail: "detailed" });
    expect(lastPrompt).toContain("## Visual reference");
    expect(lastPrompt).toContain("8 frames inline and 20 distinct frames");
    expect(lastClaudeSpanAttrs?.visualDetail).toBe("detailed");
  });

  test("with slides OFF the policy reaches the trace and nothing else — the prompt is untouched", async () => {
    await run({ frames: false, visualDetail: "detailed" });
    expect(lastPrompt).toBe(transcriptBody.transcript);
    expect(lastPrompt).not.toContain("Slide frames");
    expect(lastClaudeSpanAttrs?.visualDetail).toBe("detailed");
  });

  test("a quoted frame that was never extracted is removed from EVERYTHING stored", async () => {
    // The failure this closes: only quoted frames are copied to the served root,
    // so a reference to a second nobody extracted is a broken image in the job
    // card, the ingested document, the wiki source draft and the export.
    claudeResult = summaryQuoting(600, 999);
    const jobId = await run({ frames: true });

    expect(getJob(jobId)!.summary).toContain("600.jpg");
    expect(getJob(jobId)!.summary).not.toContain("999.jpg");
    expect(String(ingestBodies[0]!.summary)).not.toContain("999.jpg");
    expect(String(sourceDraftCalls[0]!.body)).not.toContain("999.jpg");
    expect(kept(600)).toBe(true);
    expect(logged("warning", "will not serve")).toBe(true);
  });

  test("`selected` keeps at most eight, and only those eight are on disk", async () => {
    extractTicks = Array.from({ length: 12 }, (_, i) => (i + 1) * 30);
    claudeResult = summaryQuoting(...extractTicks);
    const jobId = await run({ frames: true });

    const stored = getJob(jobId)!.summary!;
    expect(stored.match(/\/api\/frames\//g)).toHaveLength(8);
    expect(kept(30)).toBe(true);
    // The ninth quote and everything after it went, so its file was never copied.
    expect(kept(270)).toBe(false);
    expect(kept(360)).toBe(false);
  });

  test("`detailed` keeps twenty, eight of them inline, with the appendix before `## Transcript`", async () => {
    const inline = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
    const appendix = Array.from({ length: 15 }, (_, i) => 200 + i * 10);
    extractTicks = [...inline, ...appendix];
    claudeResult =
      "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n\n" +
      inline.map((s) => `![Slide at 00:00:00](/api/frames/youtube/${VIDEO_ID}/${s}.jpg)`).join("\n\n") +
      "\n\n## Visual reference\n\n" +
      appendix
        .map((s) => `![Slide at 00:00:00](/api/frames/youtube/${VIDEO_ID}/${s}.jpg)\nWhy it is here.`)
        .join("\n\n");

    const jobId = await run({ frames: true, visualDetail: "detailed" });
    const stored = getJob(jobId)!.summary!;
    const [body, tail] = stored.split("## Visual reference") as [string, string];

    expect(stored.match(/\/api\/frames\//g)).toHaveLength(20);
    expect(body.match(/\/api\/frames\//g)).toHaveLength(8);
    expect(tail.match(/\/api\/frames\//g)).toHaveLength(12);

    // The plan's placement rule, measured on the body that was INGESTED — the
    // one place the appendix and the transcript are in the same string.
    const ingested = String(ingestBodies[0]!.summary);
    expect(ingested.indexOf("## Visual reference")).toBeGreaterThan(-1);
    expect(ingested.indexOf("## Visual reference")).toBeLessThan(ingested.indexOf("## Transcript"));
  });

  test("a frame the copy could NOT keep loses its reference — no promise of a 404", async () => {
    // The extractor reports the tick and writes no file, so `keepReferencedFrames`
    // throws mid-copy. The capture stands; the stored text must stop naming it.
    missingFrameFiles = [600];
    claudeResult = summaryQuoting(600);
    const jobId = await run({ frames: true });

    expect(getJob(jobId)!.status).toBe("complete");
    expect(getJob(jobId)!.summary).not.toContain("600.jpg");
    expect(String(ingestBodies[0]!.summary)).not.toContain("600.jpg");
    expect(logged("warning", "were not copied")).toBe(true);
  });

  test("one frame the copy could not keep costs its own reference and no other", async () => {
    // The failure that made this a per-file copy: one missing file threw, the
    // catch zeroed the kept list, and every OTHER reference was dropped from the
    // text while its JPEG stayed under the served root with nothing to serve it.
    missingFrameFiles = [600];
    claudeResult = summaryQuoting(30, 600, 1170);
    const jobId = await run({ frames: true });

    const stored = getJob(jobId)!.summary!;
    expect(stored).toContain("30.jpg");
    expect(stored).toContain("1170.jpg");
    expect(stored).not.toContain("600.jpg");
    // …and the served root holds exactly the two the text still names: a copied
    // JPEG with no reference left is an orphan nothing ever deletes.
    expect(readdirSync(join(framesRoot, "youtube", VIDEO_ID)).sort()).toEqual(["1170.jpg", "30.jpg"]);
  });

  test("the four frame counts are reported separately", async () => {
    extractTicks = Array.from({ length: 12 }, (_, i) => (i + 1) * 30);
    claudeResult = summaryQuoting(...extractTicks, 999);
    await run({ frames: true });

    const line = logs.find((r) => String(r.message.join("")).includes("frames extracted="));
    expect(line?.properties).toMatchObject({
      frames: 12, // shown to the model
      selected: 12, // chosen by it, 999 was never a frame
      referenced: 8, // survived the `selected` cap
      kept: 8, // copied to the served root
      // And WHICH ones it chose — the four the cap refused are the difference
      // between this list and what the stored text quotes.
      selectedSeconds: extractTicks.join(","),
    });
  });
});

describe("the summary KIND", () => {
  const standard = findCapturePreset(SHIPPED_CAPTURE_PRESETS, "standard")!;
  const deep = findCapturePreset(SHIPPED_CAPTURE_PRESETS, "deep")!;
  const talkNotes = findCapturePreset(SHIPPED_CAPTURE_PRESETS, "talk-notes")!;

  test("no preset is standard: the model, the budget and the prompt are today's", async () => {
    await run();
    expect(lastBotConfig?.model).toBe("sonnet");
    expect(lastThinking).toBe(8000);
    expect(lastSystemPrompt).toContain(standard.instruction.split("\n")[0]!);
    expect(ingestBodies[0]!.summary_kind).toBe("standard");
  });

  test("the system prompt is built from the PRESET's instruction", async () => {
    await run({ preset: talkNotes });
    // The kind's own structure is in the prompt and standard's opening bullet
    // is the shared one, so the discriminating string is the timeline section.
    expect(lastSystemPrompt).toContain("## Timeline");
    expect(lastSystemPrompt).toContain("### [HH:MM:SS] <what this section is about>");
    // The CATEGORY/SUMMARY envelope is NOT the preset's to change.
    expect(lastSystemPrompt).toContain("CATEGORY: <category>");
    expect(lastSystemPrompt).toContain("Video URL: " + WATCH_URL);
  });

  test("deep runs the opus constant and INHERITS the bot's thinking budget", async () => {
    await run({ preset: deep });
    expect(lastBotConfig?.model).toBe(CAPTURE_DEEP_MODEL);
    // "Full thinking" means no 8k capture override, not an infinite budget:
    // `thinkingMaxTokens` is not passed at all, so the connector uses the bot's.
    expect(lastThinking).toBeUndefined();
  });

  test("deep applies with slides ON as well — the frames path does not touch the model", async () => {
    await run({ preset: deep, frames: true });
    expect(lastBotConfig?.model).toBe(CAPTURE_DEEP_MODEL);
    expect(lastThinking).toBeUndefined();
    expect(lastExtraDirs).toHaveLength(1);
  });

  test("a FAILED frame pass resets neither the model nor the budget", async () => {
    // The failure this pins: `thinkingMaxTokens: null` used to be conditional on
    // `frames.length > 0` alone, so a yt-dlp or ffmpeg failure on a Deep capture
    // silently reapplied the 8k cap — a deep-stamped document written under the
    // capture cap, with only a warn to say so.
    extractThrows = new Error("ffmpeg died");
    const jobId = await run({ preset: deep, frames: true });

    expect(logged("warning", "frames failed")).toBe(true);
    expect(getJob(jobId)?.status).toBe("complete");
    expect(lastBotConfig?.model).toBe(CAPTURE_DEEP_MODEL);
    expect(lastThinking).toBeUndefined();
    expect(lastExtraDirs).toBeUndefined();
  });

  test("deep with slides SKIPPED (too short) keeps the model and the budget", async () => {
    probeAnswer = { id: VIDEO_ID, title: "A talk", duration: 30, uploader: "conf" };
    await run({ preset: deep, frames: true });

    expect(downloadCalls).toEqual([]);
    expect(lastBotConfig?.model).toBe(CAPTURE_DEEP_MODEL);
    expect(lastThinking).toBeUndefined();
  });

  test("standard with slides on still inherits the budget — today's rule, unchanged", async () => {
    await run({ frames: true });
    expect(lastBotConfig?.model).toBe("sonnet");
    expect(lastThinking).toBeUndefined();
  });

  test("standard with a FAILED frame pass falls back to the 8k cap", async () => {
    // The other side of the same rule: with no frames to read there is no
    // visual reasoning to protect, so a transcript-only standard capture keeps
    // the cap that buys back the first-token dead-air.
    extractThrows = new Error("ffmpeg died");
    await run({ frames: true });
    expect(lastThinking).toBe(8000);
  });

  test("the kind is stamped on the ingest body, for every kind including standard", async () => {
    await run({ preset: deep });
    expect(ingestBodies[0]!.summary_kind).toBe("deep");
    ingestBodies = [];
    await run({ preset: talkNotes });
    expect(ingestBodies[0]!.summary_kind).toBe("talk-notes");
  });

  test("the completion line names the kind, the OBSERVED model and the budget", async () => {
    // The observed model is the connector's own answer. This one-shot mock
    // returns no `model`, which must read as unknown rather than as the request
    // echoed back — the harness's `run.json` reads exactly this field.
    await run({ preset: deep });
    const line = logs.find((r) => String(r.message.join("")).includes("Summarized"));
    expect(line!.properties.summaryKind).toBe("deep");
    expect(line!.properties.model).toBe("unknown");
    expect(line!.properties.requestedModel).toBe(CAPTURE_DEEP_MODEL);
    expect(line!.properties.thinking).toBe("inherit:bot-default");
  });

  test("the kind and the budget reach the TRACE, not only the log line", async () => {
    // `extraTraceAttrs` is the only channel that puts these on the span, and
    // `/traces` is where a run is inspected after the fact. The log line was
    // pinned; the span was not.
    await run({ preset: deep });
    expect(lastClaudeSpanAttrs).toMatchObject({
      summaryKind: "deep",
      thinking: "inherit:bot-default",
      frames: "off",
    });

    lastClaudeSpanAttrs = undefined;
    await run({ preset: standard, frames: true });
    expect(lastClaudeSpanAttrs).toMatchObject({
      summaryKind: "standard",
      // Frames came out, so the cap is not applied here either — and the label
      // says which of the two reasons it was.
      thinking: "inherit:bot-default",
      frames: "on",
      frameCount: "3",
    });
  });

  test("a kind asking for opus on a connector that cannot NAME it warns and keeps the bot's model", async () => {
    // Defence only — the route's kind set drops `deep` on such a connector — so
    // this is reachable solely by a direct call with a hand-built preset.
    const local = { ...bot, connector: "openai-compat", model: "qwen3.5:35b" } as unknown as BotConfig;
    await run({ preset: deep, botConfig: local });

    expect(logged("warning", "asks for the opus model")).toBe(true);
    expect(lastBotConfig?.model).toBe("qwen3.5:35b");
    // …and neither resolver offers that combination in the first place.
    expect(resolveCapturePresets(undefined, "openai-compat").map((p) => p.id)).toEqual(["standard", "talk-notes"]);
  });

  test("the connector that can NAME opus but not honour the budget is the one this vertical drops", async () => {
    // Copilot carries `claude-opus-5` verbatim in its catalog, so the model half
    // of `deep` IS honoured there and no warn fires — but `supportsThinkingBudget`
    // is false, so the budget half is not. That combination is refused by the
    // route's kind set rather than run and stamped `deep`.
    expect(resolveCapturePresets(undefined, "copilot-sdk").map((p) => p.id))
      .toEqual(["standard", "deep", "talk-notes"]);
    expect(resolveCapturePresets(undefined, "copilot-sdk", { requireThinkingControl: true }).map((p) => p.id))
      .toEqual(["standard", "talk-notes"]);
  });

  test("the source drafter fires by default and is opt-out for the replay harness", async () => {
    await run({ preset: deep });
    expect(sourceDraftCalls).toHaveLength(1);

    sourceDraftCalls = [];
    const jobId = await run({ preset: deep, sourceDraft: false });
    expect(sourceDraftCalls).toEqual([]);
    // Everything before it still happened: the capture completed and ingested.
    expect(getJob(jobId)?.status).toBe("complete");
    expect(ingestBodies).toHaveLength(2);
  });
});
