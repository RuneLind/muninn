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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { CaptureFrame } from "../summaries/frames.ts";
import type { DownloadOptions, DownloadResult, YtDlpInfo } from "../video/media.ts";

const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

let claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
let lastPrompt: string | undefined;
let lastSystemPrompt: string | undefined;
let lastExtraDirs: string[] | undefined;
let lastThinking: number | undefined;
let lastTimeoutMs: number | undefined;
/** Whatever the one-shot wants to check about the world at the moment it runs. */
let atModelCall: (() => void) | null = null;

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    _b: unknown,
    opts?: {
      systemPrompt?: string;
      thinkingMaxTokens?: number;
      extraDirs?: string[];
      timeoutMs?: number;
      onProgress?: (e: { type: string; text: string }) => void;
    },
  ) => {
    lastPrompt = prompt;
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
  capabilitiesForConnectorType: () => ({
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

const { summarizeVideo } = await import("./summarizer.ts");
const { createJob, getJob } = await import("./state.ts");
const { YOUTUBE_FRAME_HEIGHT, YOUTUBE_FRAME_FORMAT_SELECTOR } = await import("./frames.ts");

// --- a real huginn on loopback ---------------------------------------------

/** Every transcript URL the job asked for, in order — path + query. */
let transcriptRequests: string[] = [];
/** Every ingest body the job posted, in order. */
let ingestBodies: Array<Record<string, unknown>> = [];
/** The transcript the stub answers with, and the status it answers under. */
let transcriptBody: { transcript?: string } = {};
let transcriptStatus = 200;

const huginn = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/youtube/transcript/")) {
      transcriptRequests.push(u.pathname + u.search);
      if (transcriptStatus !== 200) return new Response("nope", { status: transcriptStatus });
      return Response.json(transcriptBody);
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
let downloadCalls: Array<{ url: string; workDir: string; opts: DownloadOptions }> = [];
let downloadThrows: Error | null = null;
let extractCalls: Array<{ file: string; durationSec: number; outDir: string }> = [];
let extractThrows: Error | null = null;
/** The seconds the fake extractor produces frames at. */
let extractTicks: number[] = [30, 600, 1170];
/** Where kept frames land — a throwaway root, never the developer's `~/.muninn`. */
let framesRoot = "";
/** The path of the "downloaded video", so a case can check when it was unlinked. */
let lastVideoPath = "";

function deps() {
  return {
    probeVideoInfo: async (url: string) => {
      probeCalls.push(url);
      return probeAnswer;
    },
    downloadVideo: async (url: string, workDir: string, opts: DownloadOptions): Promise<DownloadResult> => {
      downloadCalls.push({ url, workDir, opts });
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
        writeFileSync(path, `jpeg-${t}`);
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
  downloadCalls = [];
  extractCalls = [];
  downloadThrows = null;
  extractThrows = null;
  extractTicks = [30, 600, 1170];
  probeAnswer = { id: VIDEO_ID, title: "A talk", duration: 1200, uploader: "conf" };
  connectorSupportsExtraDirs = true;
  transcriptStatus = 200;
  transcriptBody = { transcript: "### [00:00:00]\nhello there\n\n### [00:02:00]\nmore words" };
  claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
  lastPrompt = undefined;
  lastSystemPrompt = undefined;
  lastExtraDirs = undefined;
  lastThinking = undefined;
  lastTimeoutMs = undefined;
  atModelCall = null;
  framesRoot = tmpRoot("yt-frames-root-");
});

/** Run one capture and hand back its job id. */
async function run(opts: { frames?: boolean; onIngested?: (v: string, d: string) => void } = {}) {
  const jobId = createJob(VIDEO_ID, "A talk", WATCH_URL);
  await summarizeVideo(jobId, VIDEO_ID, "A talk", WATCH_URL, config, bot, {
    ...(opts.frames !== undefined ? { frames: opts.frames } : {}),
    ...(opts.onIngested ? { onIngested: opts.onIngested } : {}),
    deps: deps(),
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
      "https://evil.test/whatever",
      config,
      bot,
      { frames: true, deps: deps() },
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
    // The height is the seam's, applied by the production dep; assert the
    // constant the module publishes so a change to it is visible here.
    expect(YOUTUBE_FRAME_HEIGHT).toBe(720);
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
    await summarizeVideo(jobId, VIDEO_ID, "A talk", WATCH_URL, config, bot, {
      frames: true,
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
