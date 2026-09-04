import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "../summaries/summarizer-shared.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The media pipeline (yt-dlp / whisper / ffmpeg) and the Claude call are mocked
// so the orchestration runs without any real subprocess. Behaviour is driven by
// the mutable vars below, reset to a happy-path default in beforeEach.

const CANONICAL_URL = "https://www.tiktok.com/@coolcoder/video/7523456789";
const SHORT_URL = "https://vm.tiktok.com/ZMabcdef/";

let transcript = "We ship a new CLI feature today.";
let framesResult: Array<{ path: string; tSeconds: number }> = [];
let extractShouldThrow = false;
let downloadCalls: Array<{
  url: string;
  workDir: string;
  opts?: { maxDurationSeconds?: number; timeoutMs?: number };
}> = [];
let extractCalls = 0;
let summarizeTimeoutArgs: { frameCount: number; floorMs: number } | undefined;
let extractOpts: { durationSeconds?: number; frameTimeoutMs?: number } | undefined;
let transcribeCalls: Array<{ opts?: { whisperTimeoutMs?: number; audioTimeoutMs?: number } }> = [];
// yt-dlp-reported duration, mutable so a long-form upload can be simulated.
let videoDuration = 45;

// Claude response (CATEGORY/SUMMARY envelope) + captured call.
let claudeResult =
  "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point about the on-screen diagram";
let executorCalls = 0;
let lastPrompt = "";
let lastSystemPrompt = "";
let lastBotConfig: BotConfig | undefined;
let lastOpts: { systemPrompt?: string; timeoutMs?: number; extraDirs?: string[] } | undefined;

// Ingest behaviour (global fetch) + captured payload.
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
      id: "7523456789",
      title: "yt-dlp title",
      duration: videoDuration,
      uploader: "coolcoder",
      canonicalUrl: CANONICAL_URL,
    };
  },
  transcribeVideo: async (
    _videoPath: string,
    _c: unknown,
    opts?: { whisperTimeoutMs?: number; audioTimeoutMs?: number },
  ) => {
    transcribeCalls.push({ opts });
    return transcript;
  },
  extractKeyframes: async (
    _videoPath: string,
    workDir: string,
    opts?: { durationSeconds?: number; frameTimeoutMs?: number },
  ) => {
    extractCalls++;
    extractOpts = opts;
    if (extractShouldThrow) throw new Error("ffmpeg keyframe extraction failed");
    return framesResult.map((f) => ({ ...f, path: join(workDir, f.path) }));
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
  extractTikTokVideoId: (url: string) => url.match(/\/video\/(\d+)/)?.[1] ?? null,
}));

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    botConfig: BotConfig,
    opts?: { systemPrompt?: string; timeoutMs?: number; extraDirs?: string[]; onProgress?: (e: { type: string; text: string }) => void },
  ) => {
    executorCalls++;
    lastPrompt = prompt;
    lastSystemPrompt = opts?.systemPrompt ?? "";
    lastBotConfig = botConfig;
    lastOpts = opts;
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  // summarizer-shared imports this too (the thinking-budget capability gate) —
  // mirror the real rule rather than hardcoding, so the mock can't drift.
  connectorCapabilities: (b: { connector?: string }) => {
    const isClaude = (b.connector ?? "claude-cli") === "claude-cli" || b.connector === "claude-sdk";
    return { supportsExtraDirs: isClaude, supportsThinkingBudget: isClaude };
  },
}));

// Source-page drafter trigger — spied, never run. Records the args so the tests
// assert the docId (fallback vs huginn file_path), category, and canonical url.
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
    if (url.includes("/api/tiktok/ingest")) {
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

const { summarizeTikTok } = await import("./summarizer.ts");
const { createJob, getJob } = await import("./state.ts");

const config = {
  knowledgeApiUrl: "http://kb.test",
  claudeTimeoutMs: 120_000,
} as unknown as Config;
const bot = {
  name: "jarvis",
  dir: "/tmp/bot",
  model: "sonnet",
  spawnArgs: ["--strict-mcp-config"],
} as unknown as BotConfig;

beforeEach(() => {
  transcript = "We ship a new CLI feature today.";
  framesResult = [
    { path: "frame_001.jpg", tSeconds: 4 },
    { path: "frame_002.jpg", tSeconds: 12 },
  ];
  extractShouldThrow = false;
  downloadCalls = [];
  extractCalls = 0;
  summarizeTimeoutArgs = undefined;
  extractOpts = undefined;
  transcribeCalls = [];
  videoDuration = 45;
  claudeResult =
    "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point about the on-screen diagram";
  executorCalls = 0;
  lastPrompt = "";
  lastSystemPrompt = "";
  lastBotConfig = undefined;
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

test("happy path: transcript + frames complete the job with the parsed summary and canonical-URL ingest", async () => {
  const jobId = createJob("7523456789", "My TikTok", SHORT_URL);
  await summarizeTikTok(jobId, SHORT_URL, "My TikTok", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.category).toBe("ai/claude-code");
  expect(job.summary).toContain("### Heading");
  // Stream hygiene: job.text is replaced with the parsed summary (no envelope).
  expect(job.text).toBe(job.summary!);

  // The user prompt carries the transcript and the t=M:SS frame list.
  expect(lastPrompt).toContain("We ship a new CLI feature today.");
  expect(lastPrompt).toContain("t=0:04");
  expect(lastPrompt).toContain("frame_001.jpg");

  // Ingest uses the yt-dlp-resolved canonical URL (never the raw short link)
  // and the uploader as author.
  expect(ingestPayload).toBeDefined();
  expect(ingestPayload!.url).toBe(CANONICAL_URL);
  expect(ingestPayload!.author).toBe("coolcoder");
  expect(ingestPayload!.title).toBe("My TikTok");
  expect(ingestPayload!.category).toBe("ai/claude-code");
});

test("fires the source-draft trigger with the huginn file_path docId, category, and canonical url", async () => {
  ingestFilePath = "ai/claude-code/My TikTok.md";
  const jobId = createJob("7523456789", "My TikTok", SHORT_URL);
  await summarizeTikTok(jobId, SHORT_URL, "My TikTok", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input).toMatchObject({
    collection: "tiktok-summaries",
    docId: "ai/claude-code/My TikTok.md",
    url: CANONICAL_URL,
    category: "ai/claude-code",
  });
});

test("source-draft trigger falls back to the videoId when ingest returns no file_path", async () => {
  // ingestFilePath undefined ⇒ ingest returns no file_path ⇒ fallback to dl.id.
  const jobId = createJob("7523456789", "My TikTok", SHORT_URL);
  await summarizeTikTok(jobId, SHORT_URL, "My TikTok", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input.docId).toBe("7523456789");
});

test("keyframe-extraction failure degrades to a transcript-only summary, not a failed job", async () => {
  extractShouldThrow = true;
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(executorCalls).toBe(1);
  // No frame list in the prompt — transcript only.
  expect(lastPrompt).toContain("We ship a new CLI feature today.");
  expect(lastPrompt).not.toContain("Keyframes");
});

test("empty transcript with frames disabled fails the job (nothing to summarize)", async () => {
  transcript = "";
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot, { frames: false });

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(job.error).toContain("frames are disabled");
  expect(executorCalls).toBe(0);
  expect(extractCalls).toBe(0);
  expect(ingestPayload).toBeUndefined();
});

test("empty transcript with failed frame extraction fails the job (nothing to summarize)", async () => {
  transcript = "";
  extractShouldThrow = true;
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(job.error).toContain("no keyframes");
  expect(executorCalls).toBe(0);
});

test("empty transcript with frames present summarizes from the frames", async () => {
  transcript = "";
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(lastPrompt).toContain("No speech detected");
  expect(lastPrompt).toContain("frame_001.jpg");
});

test("passes the 60-min duration cap and duration-scaled timeouts to the media pipeline", async () => {
  // 10:19 — the length that used to fail the whole capture on the 10-min default.
  videoDuration = 619;
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  expect(downloadCalls[0]!.opts?.maxDurationSeconds).toBe(3600);
  expect(downloadCalls[0]!.opts?.timeoutMs).toBe(600_000);
  // Raising the cap alone just moves the failure to whisper/ffmpeg.
  expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(619_000);
  expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(123_800);
  expect(extractOpts?.durationSeconds).toBe(619);
  expect(extractOpts?.frameTimeoutMs).toBe(309_500);
});

test("short clips keep the short-clip timeout floors", async () => {
  // The default 45s mock: every Math.max floor is the active branch here, which
  // is the ordinary TikTok and the one the scaling must not shrink.
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(120_000);
  expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(60_000);
  expect(extractOpts?.frameTimeoutMs).toBe(60_000);
});

test("a clip at the cap itself scales every budget off its duration", async () => {
  videoDuration = 3600;
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  expect(downloadCalls[0]!.opts?.maxDurationSeconds).toBe(3600);
  expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(3_600_000);
  expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(720_000);
  expect(extractOpts?.frameTimeoutMs).toBe(1_800_000);
});

test("passes the work dir as extraDirs and raises the timeout to >=600s", async () => {
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  expect(lastOpts).toBeDefined();
  // The tmp work dir is handed to executeOneShot as extraDirs (→ CLI --add-dir).
  const workDir = join(tmpdir(), `muninn-tiktok-${jobId}`);
  expect(lastOpts!.extraDirs).toEqual([workDir]);
  expect(downloadCalls[0]!.workDir).toBe(workDir);
  expect(lastOpts!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  // The summarize budget is computed from the REAL frame count (2 here), not a
  // constant — that pass-through is the whole behavioral content of the call.
  expect(summarizeTimeoutArgs).toEqual({ frameCount: 2, floorMs: 120_000 });
  // The caller's bot config is passed through untouched — executeOneShot clones
  // internally, the summarizer no longer mutates or clones it itself.
  expect(lastBotConfig).toBe(bot);
  expect(bot.spawnArgs).toEqual(["--strict-mcp-config"]);
  expect(bot.timeoutMs).toBeUndefined();
});

// The video verticals interpolate SUMMARY_STRUCTURE_BULLETS into their own
// numbered prompt instead of calling buildSummarySystemPrompt, so nothing in
// src/summaries/ can see whether they still carry the shared rules — a review
// proved that decoupling this file from the array left the whole capture suite
// green. This drives the REAL summarizer and asserts on the prompt it hands the
// executor.
//
// What it catches, measured rather than assumed: decoupling-with-drift, a
// changed join separator or indent, relocation to another numbered step,
// renumbering, and text inserted between the heading and the block. What it
// CANNOT catch, because both sides read the same imported array: a byte-
// identical fork of the list into a local const (green until someone later
// edits the shared array), a second copy of the block, and anything appended
// after it — including a line negating every bullet above.
test("the system prompt carries the shared structure rules, incl. the verbatim-artifact one", async () => {
  const jobId = createJob("7523456789", "My TikTok", SHORT_URL);
  await summarizeTikTok(jobId, SHORT_URL, "My TikTok", config, bot);

  // The whole interpolated block — separator and indent included, not bullet by
  // bullet. A per-bullet toContain() survives a changed join: verified, swapping
  // `.join("\n   ")` for `.join("\n")` kept both files green while breaking the
  // bullets out of the prompt's numbered step 5.
  // Anchored on the numbered step that introduces it, not just the indent: a
  // bare `toContain(indent + join)` matches an indented block ANYWHERE, so
  // relocating the whole interpolation into another step kept both files green.
  expect(lastSystemPrompt).toContain(
    `5. Then write a structured summary with:\n   ${SUMMARY_STRUCTURE_BULLETS.join("\n   ")}`,
  );
  // Named explicitly: a TikTok that reads a prompt out loud is the case the
  // verbatim rule exists for, and this vertical also sees on-screen text.
  expect(lastSystemPrompt).toContain("reproduce it VERBATIM inside a fenced code block");
});
