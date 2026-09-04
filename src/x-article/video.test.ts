import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "../summaries/summarizer-shared.ts";

// --- Module mocks (registered before the dynamic import below) ---
// Same pattern as the TikTok summarizer test: the media pipeline and the Claude
// call are mocked so the orchestration runs without any real subprocess.

const SLOT_URL = "https://x.com/coolcoder/status/2081279674966044799/video/1";
const BARE_STATUS_URL = "https://x.com/coolcoder/status/2081279674966044799";

let transcript = "Elon lays out the AI timeline.";
let framesResult: Array<{ path: string; tSeconds: number }> = [];
let extractShouldThrow = false;
let downloadCalls: Array<{ url: string; workDir: string; opts?: { maxDurationSeconds?: number; timeoutMs?: number } }> = [];
let transcribeCalls: Array<{ opts?: { whisperTimeoutMs?: number; audioTimeoutMs?: number } }> = [];
let extractOpts: { durationSeconds?: number; frameTimeoutMs?: number } | undefined;
let summarizeTimeoutArgs: { frameCount: number; floorMs: number } | undefined;

let claudeResult =
  "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Timeline\n- point about the on-screen chart";
let executorCalls = 0;
let lastPrompt = "";
let lastSystemPrompt = "";
let lastOpts: { systemPrompt?: string; timeoutMs?: number; extraDirs?: string[] } | undefined;

let ingestOk = true;
let ingestPayload: Record<string, unknown> | undefined;

mock.module("../video/media.ts", () => ({
  downloadVideo: async (
    url: string,
    workDir: string,
    opts?: { maxDurationSeconds?: number; timeoutMs?: number },
  ) => {
    downloadCalls.push({ url, workDir, opts });
    return {
      videoPath: join(workDir, "video.mp4"),
      id: "2081276996567326720",
      title: "yt-dlp title",
      duration: 636,
      uploader: "coolcoder",
      // yt-dlp's webpage_url keeps the /video/1 media-slot suffix.
      canonicalUrl: SLOT_URL,
    };
  },
  transcribeVideo: async (
    _videoPath: string,
    _config: unknown,
    opts?: { whisperTimeoutMs?: number; audioTimeoutMs?: number },
  ) => {
    transcribeCalls.push({ opts });
    return transcript;
  },
  // Spy, not a copy of the real formula: a duplicated formula here would let
  // media.ts's rate change while both suites stayed green, and it is the
  // ARGUMENTS (does the call site pass the real frame count?) that this file
  // is in a position to prove. The sentinel is >600_000 so the floor
  // assertions elsewhere still mean what they say.
  summarizeTimeoutFor: (frameCount: number, floorMs: number) => {
    summarizeTimeoutArgs = { frameCount, floorMs };
    return 1_234_000;
  },
  extractKeyframes: async (
    _videoPath: string,
    workDir: string,
    opts?: { durationSeconds?: number; frameTimeoutMs?: number },
  ) => {
    extractOpts = opts;
    if (extractShouldThrow) throw new Error("ffmpeg keyframe extraction failed");
    return framesResult.map((f) => ({ ...f, path: join(workDir, f.path) }));
  },
  // Real implementations (pure URL parsing) — inline mirrors to keep the mock
  // self-contained without importing the mocked-out module.
  extractXStatusId: (url: string) => url.match(/\/status\/(\d+)/)?.[1] ?? null,
  canonicalXStatusUrl: (url: string) =>
    url.match(/^(https?:\/\/[^/]+\/[^/]+\/status\/\d+)/)?.[1] ?? null,
}));

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    _botConfig: BotConfig,
    opts?: { systemPrompt?: string; timeoutMs?: number; extraDirs?: string[]; onProgress?: (e: { type: string; text: string }) => void },
  ) => {
    executorCalls++;
    lastPrompt = prompt;
    lastSystemPrompt = opts?.systemPrompt ?? "";
    lastOpts = opts;
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  connectorCapabilities: (b: { connector?: string }) => {
    const isClaude = (b.connector ?? "claude-cli") === "claude-cli" || b.connector === "claude-sdk";
    return { supportsExtraDirs: isClaude, supportsThinkingBudget: isClaude };
  },
}));

let sourceDraftCalls: Array<{ input: Record<string, unknown> }> = [];
let ingestFilePath: string | undefined;
mock.module("../gardener/source-drafter-run.ts", () => ({
  triggerSourceDraftFromCapture: (_bot: unknown, input: Record<string, unknown>) => {
    sourceDraftCalls.push({ input });
  },
}));

const originalFetch = globalThis.fetch;
function installFetchMock() {
  // @ts-expect-error — minimal Response stand-in is enough for the summarizer.
  globalThis.fetch = async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/x-articles/ingest")) {
      ingestPayload = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: ingestOk,
        status: ingestOk ? 200 : 500,
        json: async () => ({ similar: [], ...(ingestFilePath ? { file_path: ingestFilePath } : {}) }),
        text: async () => "{}",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
}

const { summarizeXVideo } = await import("./video.ts");
const { createJob, getJob } = await import("./state.ts");

const config = {
  knowledgeApiUrl: "http://kb.test",
  claudeTimeoutMs: 120_000,
} as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

beforeEach(() => {
  summarizeTimeoutArgs = undefined;
  transcript = "Elon lays out the AI timeline.";
  framesResult = [
    { path: "frame_001.jpg", tSeconds: 4 },
    { path: "frame_002.jpg", tSeconds: 12 },
  ];
  extractShouldThrow = false;
  downloadCalls = [];
  transcribeCalls = [];
  extractOpts = undefined;
  claudeResult =
    "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Timeline\n- point about the on-screen chart";
  executorCalls = 0;
  lastPrompt = "";
  lastSystemPrompt = "";
  lastOpts = undefined;
  ingestOk = true;
  ingestPayload = undefined;
  ingestFilePath = undefined;
  sourceDraftCalls = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("happy path: completes the job and ingests under the BARE status URL", async () => {
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.category).toBe("ai/claude-code");
  expect(job.summary).toContain("### Timeline");
  // Stream hygiene: the frame-reading chatter is replaced by the parsed summary.
  expect(job.text).toBe(job.summary!);

  // Prompt carries transcript + t=M:SS frame list.
  expect(lastPrompt).toContain("Elon lays out the AI timeline.");
  expect(lastPrompt).toContain("t=0:04");
  expect(lastPrompt).toContain("frame_001.jpg");
  expect(lastSystemPrompt).toContain("X/Twitter video");

  // Ingest keys on the bare status URL (no /video/1 media-slot suffix).
  expect(ingestPayload).toBeDefined();
  expect(ingestPayload!.url).toBe(BARE_STATUS_URL);
  expect(ingestPayload!.author).toBe("coolcoder");
  expect(ingestPayload!.category).toBe("ai/claude-code");
});

test("passes the 3-hour duration cap and duration-scaled timeouts to the media pipeline", async () => {
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  expect(downloadCalls[0]!.opts?.maxDurationSeconds).toBe(10800);
  expect(downloadCalls[0]!.opts?.timeoutMs).toBe(600_000);
  // 636s video ⇒ whisper/ffmpeg timeouts scale past the short-clip defaults.
  expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(636_000);
  expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(127_200);
  expect(extractOpts?.durationSeconds).toBe(636);
  expect(extractOpts?.frameTimeoutMs).toBe(318_000);
});

test("passes the work dir as extraDirs and raises the timeout to >=600s", async () => {
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  const workDir = join(tmpdir(), `muninn-x-video-${jobId}`);
  expect(lastOpts!.extraDirs).toEqual([workDir]);
  expect(downloadCalls[0]!.workDir).toBe(workDir);
  expect(lastOpts!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  // Computed from the real frame count, not a constant.
  expect(summarizeTimeoutArgs).toEqual({
    frameCount: framesResult.length,
    floorMs: 120_000,
  });
});

test("keyframe-extraction failure degrades to a transcript-only summary, not a failed job", async () => {
  extractShouldThrow = true;
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(executorCalls).toBe(1);
  expect(lastPrompt).not.toContain("Keyframes");
});

test("empty transcript with failed frame extraction fails the job", async () => {
  transcript = "";
  extractShouldThrow = true;
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(job.error).toContain("no keyframes");
  expect(executorCalls).toBe(0);
});

test("fires the source-draft trigger against the x-articles collection with the bare status URL", async () => {
  ingestFilePath = "ai/claude-code/My X video.md";
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input).toMatchObject({
    collection: "x-articles",
    docId: "ai/claude-code/My X video.md",
    url: BARE_STATUS_URL,
    category: "ai/claude-code",
  });
});

// The video verticals interpolate SUMMARY_STRUCTURE_BULLETS into their own
// numbered prompt instead of calling buildSummarySystemPrompt, so nothing in
// src/summaries/ can see whether they still carry the shared rules — a review
// proved that decoupling this file from the array left the whole capture suite
// green. This drives the REAL summarizer and asserts on the system prompt it
// hands the executor, so an inlined or forked bullet list fails here.
test("the system prompt carries the shared structure rules, incl. the verbatim-artifact one", async () => {
  const jobId = createJob("2081279674966044799", "My X video", SLOT_URL, "");
  await summarizeXVideo(jobId, SLOT_URL, "My X video", config, bot);

  // The whole interpolated block — separator and indent included, not bullet by
  // bullet. A per-bullet toContain() survives a changed join: verified, swapping
  // `.join("\n   ")` for `.join("\n")` kept both files green while breaking the
  // bullets out of the prompt's numbered step 5.
  expect(lastSystemPrompt).toContain(`   ${SUMMARY_STRUCTURE_BULLETS.join("\n   ")}`);
  // Named explicitly: an X video that reads a prompt out loud is the case the
  // verbatim rule exists for, and this vertical also sees on-screen text.
  expect(lastSystemPrompt).toContain("reproduce it VERBATIM inside a fenced code block");
});
