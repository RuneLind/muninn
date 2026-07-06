import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The media pipeline (yt-dlp / whisper / ffmpeg) and the Claude call are mocked
// so the orchestration runs without any real subprocess. Behaviour is driven by
// the mutable vars below, reset to a happy-path default in beforeEach.

const CANONICAL_URL = "https://www.tiktok.com/@coolcoder/video/7523456789";
const SHORT_URL = "https://vm.tiktok.com/ZMabcdef/";

let transcript = "We ship a new CLI feature today.";
let framesResult: Array<{ path: string; tSeconds: number }> = [];
let extractShouldThrow = false;
let downloadCalls: Array<{ url: string; workDir: string }> = [];
let extractCalls = 0;

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

mock.module("./media.ts", () => ({
  downloadVideo: async (url: string, workDir: string) => {
    downloadCalls.push({ url, workDir });
    return {
      videoPath: join(workDir, "video.mp4"),
      id: "7523456789",
      title: "yt-dlp title",
      duration: 45,
      uploader: "coolcoder",
      canonicalUrl: CANONICAL_URL,
    };
  },
  transcribeVideo: async () => transcript,
  extractKeyframes: async (_videoPath: string, workDir: string) => {
    extractCalls++;
    if (extractShouldThrow) throw new Error("ffmpeg keyframe extraction failed");
    return framesResult.map((f) => ({ ...f, path: join(workDir, f.path) }));
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
        json: async () => ({ similar: [] }),
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
  claudeResult =
    "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point about the on-screen diagram";
  executorCalls = 0;
  lastPrompt = "";
  lastSystemPrompt = "";
  lastBotConfig = undefined;
  lastOpts = undefined;
  ingestOk = true;
  ingestPayload = undefined;
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

test("passes the work dir as extraDirs and raises the timeout to >=600s", async () => {
  const jobId = createJob("7523456789", "My TikTok", CANONICAL_URL);
  await summarizeTikTok(jobId, CANONICAL_URL, "My TikTok", config, bot);

  expect(lastOpts).toBeDefined();
  // The tmp work dir is handed to executeOneShot as extraDirs (→ CLI --add-dir).
  const workDir = join(tmpdir(), `muninn-tiktok-${jobId}`);
  expect(lastOpts!.extraDirs).toEqual([workDir]);
  expect(downloadCalls[0]!.workDir).toBe(workDir);
  expect(lastOpts!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  // The caller's bot config is passed through untouched — executeOneShot clones
  // internally, the summarizer no longer mutates or clones it itself.
  expect(lastBotConfig).toBe(bot);
  expect(bot.spawnArgs).toEqual(["--strict-mcp-config"]);
  expect(bot.timeoutMs).toBeUndefined();
});
