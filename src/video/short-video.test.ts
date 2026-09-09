/**
 * The SHORT-VIDEO capture job, driven end to end with the media pipeline and the
 * Claude call mocked out — both verticals, one file.
 *
 * It is the merge of `src/tiktok/summarizer.test.ts` and
 * `src/x-article/video.test.ts`, which were twins of the twins they tested. What
 * the two suites AGREED on is a loop over both specs below (the happy path, the
 * degrade paths, the builders, the extraDirs/timeout pass-through); what they
 * DISAGREED on stays per-vertical, because those disagreements are the whole
 * content of a spec: the duration cap, the canonical url, the ingest endpoint
 * and collection, the work-dir name.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test` and
 * `test:handlers` chains) and MUST stay that way — `mock.module` here replaces
 * `./media.ts` and `../ai/one-shot.ts`, both of which a large share of the suite
 * imports transitively.
 */

import { test, expect, beforeEach, afterEach, afterAll, mock, describe } from "bun:test";
import { configure, reset as resetLogging, type LogRecord } from "@logtape/logtape";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "../summaries/summarizer-shared.ts";
import { SHIPPED_CAPTURE_PRESETS, type CapturePreset } from "../summaries/presets.ts";
import { SHORT_VIDEO_THINKING } from "./short-video-kinds.ts";

// --- Module mocks (registered before the dynamic imports below) ---
// The media pipeline (yt-dlp / whisper / ffmpeg) and the Claude call are mocked
// so the orchestration runs without any real subprocess. Behaviour is driven by
// the mutable vars below, reset to a happy-path default in beforeEach.

const TT_CANONICAL_URL = "https://www.tiktok.com/@coolcoder/video/7523456789";
const TT_SHORT_URL = "https://vm.tiktok.com/ZMabcdef/";
const X_SLOT_URL = "https://x.com/coolcoder/status/2081279674966044799/video/1";
const X_BARE_STATUS_URL = "https://x.com/coolcoder/status/2081279674966044799";

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
/** What the mocked download reports — set per vertical by `capture()`. */
let dlCanonicalUrl = TT_CANONICAL_URL;
let dlId = "7523456789";

// Claude response (CATEGORY/SUMMARY envelope) + captured call.
let claudeResult =
  "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point about the on-screen diagram";
let executorCalls = 0;
let lastPrompt = "";
let lastSystemPrompt = "";
let lastBotConfig: BotConfig | undefined;
let lastOpts:
  | {
      systemPrompt?: string;
      timeoutMs?: number;
      extraDirs?: string[];
      thinkingMaxTokens?: number | null;
    }
  | undefined;

// Ingest behaviour (global fetch) + captured payload.
let ingestOk = true;
let ingestPayload: Record<string, unknown> | undefined;
let ingestPath: string | undefined;

/**
 * The REAL media module, imported before the mock replaces it, so the pure URL
 * helpers below are the SHIPPED ones rather than mirrors of them.
 *
 * A mirror owes the original nothing: this file's `extractTikTokVideoId`
 * stand-in was `url.match(/\/video\/(\d+)/)` with no host gate, which answers
 * `"1"` for X's `/status/<id>/video/1` media-slot URL where the shipped helper —
 * host-gated exactly because of that collision — answers null. The three
 * subprocess calls stay mocked (they spawn yt-dlp, whisper and ffmpeg) and
 * `summarizeTimeoutFor` stays a spy; the URL PARSING does not, because parsing
 * is what these two specs' `canonicalUrl`/`idFor` fields are made of.
 */
const realMedia = await import("./media.ts");

mock.module("./media.ts", () => ({
  ...realMedia,
  downloadVideo: async (
    url: string,
    workDir: string,
    opts?: { maxDurationSeconds?: number; timeoutMs?: number },
  ) => {
    downloadCalls.push({ url, workDir, opts });
    return {
      videoPath: join(workDir, "video.mp4"),
      id: dlId,
      title: "yt-dlp title",
      duration: videoDuration,
      uploader: "coolcoder",
      canonicalUrl: dlCanonicalUrl,
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
}));

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    botConfig: BotConfig,
    opts?: {
      systemPrompt?: string;
      timeoutMs?: number;
      extraDirs?: string[];
      thinkingMaxTokens?: number | null;
      onProgress?: (e: { type: string; text: string }) => void;
    },
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

/**
 * The capture seam, DELEGATING — the real `runCaptureOneShot` still runs, so the
 * thinking-cap gate, the `extraDirs` pass-through and the trace root are the
 * shipped ones; the wrapper only records the options it was handed.
 *
 * It exists for ONE field: `source`, which is what stamps `capture:<id>` on the
 * trace root and the `source` attribute on the model span, and which nothing
 * else in this file can see. Mutating `source: spec.id` to the literal
 * `"tiktok"` survived all 44 cases — so the X vertical's traces could have been
 * filed under the neighbour's name with no test to say so.
 */
let lastCaptureSource: string | undefined;
/** What the job asked the seam for, before the seam's own inherit rule. */
let lastCaptureThinking: number | null | undefined;
const realShared = await import("../summaries/summarizer-shared.ts");
// The real function is captured into a CONST here, not read off `realShared`
// inside the wrapper: `mock.module` rewrites the live namespace object, so
// `realShared.runCaptureOneShot` becomes the wrapper itself and the delegation
// is an infinite recursion (measured — the file hung rather than failing).
const realRunCaptureOneShot = realShared.runCaptureOneShot;
mock.module("../summaries/summarizer-shared.ts", () => ({
  ...realShared,
  runCaptureOneShot: (opts: Parameters<typeof realRunCaptureOneShot>[0]) => {
    lastCaptureSource = opts.source;
    lastCaptureThinking = opts.thinkingMaxTokens;
    return realRunCaptureOneShot(opts);
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
    if (url.includes("/ingest")) {
      ingestPath = new URL(url).pathname;
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

const { summarizeShortVideo } = await import("./short-video.ts");
const { buildShortVideoSystemPrompt, buildShortVideoUserPrompt } = await import(
  "./short-video-prompt.ts"
);
const { TIKTOK_SPEC, summarizeTikTok } = await import("../tiktok/summarizer.ts");
const { X_VIDEO_SPEC, summarizeXVideo } = await import("../x-article/video.ts");
const ttState = await import("../tiktok/state.ts");
const xaState = await import("../x-article/state.ts");

const STANDARD = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "standard")!;
const DEEP = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "deep")!;
const TALK_NOTES = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "talk-notes")!;

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

/**
 * The two verticals as the loop below drives them: how a job is created in that
 * vertical's own store, which url is posted, and what the run is expected to key
 * everything on.
 */
const VERTICALS = [
  {
    name: "tiktok",
    spec: TIKTOK_SPEC,
    run: summarizeTikTok,
    createJob: (title: string, url: string) => ttState.createJob("7523456789", title, url),
    getJob: ttState.getJob,
    dlId: "7523456789",
    // yt-dlp's id IS what this vertical logs.
    loggedId: "7523456789",
    traceSource: "tiktok",
    idLogKey: "videoId",
    absentIdLogKey: "statusId",
    dlCanonicalUrl: TT_CANONICAL_URL,
    submitUrl: TT_SHORT_URL,
    canonicalUrl: TT_CANONICAL_URL,
    title: "My TikTok",
    ingestPath: "/api/tiktok/ingest",
    collection: "tiktok-summaries",
    workDirPrefix: "muninn-tiktok-",
    maxDurationSeconds: 3600,
  },
  {
    name: "x-video",
    spec: X_VIDEO_SPEC,
    run: summarizeXVideo,
    createJob: (title: string, url: string) =>
      xaState.createJob("2081279674966044799", title, url, ""),
    getJob: xaState.getJob,
    dlId: "2081276996567326720",
    // NOT yt-dlp's id: this vertical logs the STATUS id parsed out of the bare
    // url, and the fixture makes the two different numbers on purpose.
    loggedId: "2081279674966044799",
    traceSource: "x-video",
    // The key this vertical shipped with, before the merge — see the assertion.
    idLogKey: "statusId",
    absentIdLogKey: "videoId",
    // yt-dlp's webpage_url keeps the /video/1 media-slot suffix.
    dlCanonicalUrl: X_SLOT_URL,
    submitUrl: X_SLOT_URL,
    canonicalUrl: X_BARE_STATUS_URL,
    title: "My X video",
    ingestPath: "/api/x-articles/ingest",
    collection: "x-articles",
    workDirPrefix: "muninn-x-video-",
    maxDurationSeconds: 10800,
  },
] as const;

/**
 * Records every log line the job writes, so the completion record — the one
 * thing the tail does NOT own and a re-run must therefore write itself — is
 * observable. Configured per test with `reset: true`, the
 * `src/summaries/frames.test.ts` shape.
 */
let logs: LogRecord[] = [];
afterAll(async () => {
  await resetLogging();
});

beforeEach(async () => {
  logs = [];
  await configure({
    sinks: { capture: (r: LogRecord) => logs.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
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
  dlCanonicalUrl = TT_CANONICAL_URL;
  dlId = "7523456789";
  claudeResult =
    "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point about the on-screen diagram";
  executorCalls = 0;
  lastPrompt = "";
  lastSystemPrompt = "";
  lastBotConfig = undefined;
  lastOpts = undefined;
  ingestOk = true;
  ingestPayload = undefined;
  ingestPath = undefined;
  ingestFilePath = undefined;
  sourceDraftCalls = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const v of VERTICALS) {
  describe(v.name, () => {
    /** Point the mocked download at THIS vertical's answers, then run it. */
    async function capture(
      title: string = v.title,
      url: string = v.submitUrl,
      opts: { frames?: boolean; preset?: CapturePreset } = {},
    ): Promise<string> {
      dlCanonicalUrl = v.dlCanonicalUrl;
      dlId = v.dlId;
      const jobId = v.createJob(title, url);
      // `preset` is REQUIRED at the seam — the route always resolves one — so
      // the helper names the default rather than the summarizer inventing it.
      await v.run(jobId, url, title, config, bot, { preset: STANDARD, ...opts });
      return jobId;
    }

    test("happy path: completes the job and ingests under the canonical URL", async () => {
      const jobId = await capture();

      const job = v.getJob(jobId)!;
      expect(job.status).toBe("complete");
      expect(job.category).toBe("ai/claude-code");
      expect(job.summary).toContain("### Heading");
      // Stream hygiene: job.text is replaced with the parsed summary (no envelope).
      expect(job.text).toBe(job.summary!);

      // The user prompt carries the transcript and the t=M:SS frame list.
      expect(lastPrompt).toContain("We ship a new CLI feature today.");
      expect(lastPrompt).toContain("t=0:04");
      expect(lastPrompt).toContain("frame_001.jpg");

      // The ingest keys on the vertical's canonical URL — never the raw short
      // link, never the `/video/1` media-slot spelling — and on its endpoint.
      expect(ingestPath).toBe(v.ingestPath);
      expect(ingestPayload!.url).toBe(v.canonicalUrl);
      expect(ingestPayload!.author).toBe("coolcoder");
      expect(ingestPayload!.title).toBe(v.title);
      expect(ingestPayload!.category).toBe("ai/claude-code");
    });

    test("the ingest body carries the summary KIND, `standard` included", async () => {
      await capture();
      expect(ingestPayload!.summary_kind).toBe("standard");
      await capture(v.title, v.submitUrl, { preset: DEEP });
      expect(ingestPayload!.summary_kind).toBe("deep");
    });

    test("the whisper transcript is appended under `## Transcript`, FLAT", async () => {
      // The flat capper, not the windowed one: whisper's answer has no `\n\n`
      // windows, and the window capper's "no head past the first line" rule
      // would throw a one-paragraph transcript away at the cap.
      transcript = "One unbroken paragraph of speech with no window headings at all.";
      await capture();
      const body = String(ingestPayload!.summary);
      expect(body).toContain("\n\n## Transcript\n\n");
      expect(body.endsWith(`${transcript}\n`)).toBe(true);
      // Only the INGEST body: the card and the source draft get the summary alone.
      expect(String(sourceDraftCalls[0]!.input.body)).not.toContain("## Transcript");
    });

    /**
     * The capper the flat path takes, at the ONLY budget where the two differ.
     *
     * Under the 2 MiB cap both cappers return the transcript untouched, so a
     * `windowed: true` here is invisible on any ordinary fixture — measured: the
     * mutation survived until this case existed. Over the cap the window capper
     * has no head to show for a paragraph whose only newline is past the budget
     * and answers with the truncation note ALONE, which would store a 2 MiB
     * transcript as one apologetic line.
     */
    test("an OVER-CAP whisper transcript keeps a head, not the truncation note alone", async () => {
      transcript = `${"word ".repeat(500_000)}end.\n`;
      await capture();
      const body = String(ingestPayload!.summary);
      const section = body.slice(body.indexOf("## Transcript\n\n") + "## Transcript\n\n".length);
      expect(section.startsWith("word word word")).toBe(true);
      expect(section).toContain("transcript truncated");
      // What the WINDOWED capper would have produced instead.
      expect(section.trimEnd()).not.toBe("_(transcript truncated — the talk continues past this point.)_");
    });

    test("a speechless clip files no transcript section at all", async () => {
      transcript = "";
      await capture();
      expect(String(ingestPayload!.summary)).not.toContain("## Transcript");
    });

    test("fires the source-draft trigger with the huginn file_path docId and canonical url", async () => {
      ingestFilePath = `ai/claude-code/${v.title}.md`;
      await capture();

      expect(sourceDraftCalls).toHaveLength(1);
      expect(sourceDraftCalls[0]!.input).toMatchObject({
        collection: v.collection,
        docId: `ai/claude-code/${v.title}.md`,
        url: v.canonicalUrl,
        category: "ai/claude-code",
      });
    });

    test("source-draft trigger falls back to the videoId when ingest returns no file_path", async () => {
      await capture();
      expect(sourceDraftCalls[0]!.input.docId).toBe(v.dlId);
    });

    test("keyframe-extraction failure degrades to a transcript-only summary, not a failed job", async () => {
      extractShouldThrow = true;
      const jobId = await capture(v.title, v.canonicalUrl);

      expect(v.getJob(jobId)!.status).toBe("complete");
      expect(executorCalls).toBe(1);
      expect(lastPrompt).toContain("We ship a new CLI feature today.");
      expect(lastPrompt).not.toContain("Keyframes");
      // The SYSTEM prompt degrades with it. This is the path the two candidate
      // spellings of the axis disagree on: `framesEnabled` is still true here,
      // and only the frame LIST knows there is nothing to read.
      expect(lastSystemPrompt).toBe(
        buildShortVideoSystemPrompt(v.spec, {
          preset: STANDARD,
          title: v.title,
          url: v.canonicalUrl,
          author: "coolcoder",
          frames: false,
        }),
      );
    });

    /**
     * The `frames` AXIS, at the only caller that has one.
     *
     * `frames: false` is not a prompt-module curiosity: the route sends it, and
     * the job reaches the model call with an empty frame list. Asserting the
     * builder's zero-frame answer here — rather than a substring of it — is what
     * pins the axis to the RUN: the prompt module's own suite proves the two
     * forms differ, and only this file can prove which one a capture sends.
     */
    test("a frames-off capture sends the ZERO-frame system prompt and a transcript-only user prompt", async () => {
      const jobId = await capture(v.title, v.canonicalUrl, { frames: false });

      expect(v.getJob(jobId)!.status).toBe("complete");
      expect(extractCalls).toBe(0);
      expect(lastSystemPrompt).toBe(
        buildShortVideoSystemPrompt(v.spec, {
          preset: STANDARD,
          title: v.title,
          url: v.canonicalUrl,
          author: "coolcoder",
          frames: false,
        }),
      );
      // The frames-PRESENT form is what shipped here, so name it: an equality
      // against the builder alone would pass on a run that sent either.
      expect(lastSystemPrompt).not.toBe(
        buildShortVideoSystemPrompt(v.spec, {
          preset: STANDARD,
          title: v.title,
          url: v.canonicalUrl,
          author: "coolcoder",
        }),
      );
      expect(lastPrompt).toBe(buildShortVideoUserPrompt({ transcript, frames: [] }));
    });

    test("empty transcript with frames disabled fails the job (nothing to summarize)", async () => {
      transcript = "";
      const jobId = await capture(v.title, v.canonicalUrl, { frames: false });

      const job = v.getJob(jobId)!;
      expect(job.status).toBe("error");
      expect(job.error).toContain("frames are disabled");
      expect(executorCalls).toBe(0);
      expect(extractCalls).toBe(0);
      expect(ingestPayload).toBeUndefined();
    });

    test("empty transcript with failed frame extraction fails the job", async () => {
      transcript = "";
      extractShouldThrow = true;
      const jobId = await capture(v.title, v.canonicalUrl);

      const job = v.getJob(jobId)!;
      expect(job.status).toBe("error");
      expect(job.error).toContain("no keyframes");
      expect(executorCalls).toBe(0);
    });

    test("empty transcript with frames present summarizes from the frames", async () => {
      transcript = "";
      const jobId = await capture(v.title, v.canonicalUrl);

      expect(v.getJob(jobId)!.status).toBe("complete");
      expect(lastPrompt).toContain("No speech detected");
      expect(lastPrompt).toContain("frame_001.jpg");
    });

    test("passes THIS vertical's duration cap and duration-scaled timeouts", async () => {
      // 10:19 — the length that used to fail a TikTok capture on the 10-min default.
      videoDuration = 619;
      await capture(v.title, v.canonicalUrl);

      expect(downloadCalls[0]!.opts?.maxDurationSeconds).toBe(v.maxDurationSeconds);
      expect(downloadCalls[0]!.opts?.timeoutMs).toBe(600_000);
      // Raising the cap alone just moves the failure to whisper/ffmpeg.
      expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(619_000);
      expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(123_800);
      expect(extractOpts?.durationSeconds).toBe(619);
      expect(extractOpts?.frameTimeoutMs).toBe(309_500);
    });

    test("short clips keep the short-clip timeout floors", async () => {
      // The default 45s mock: every Math.max floor is the active branch here,
      // which is the ordinary short video and the one the scaling must not shrink.
      await capture(v.title, v.canonicalUrl);

      expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(120_000);
      expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(60_000);
      expect(extractOpts?.frameTimeoutMs).toBe(60_000);
    });

    test("a clip at THIS vertical's cap scales every budget off its duration", async () => {
      videoDuration = v.maxDurationSeconds;
      await capture(v.title, v.canonicalUrl);

      expect(downloadCalls[0]!.opts?.maxDurationSeconds).toBe(v.maxDurationSeconds);
      expect(transcribeCalls[0]!.opts?.whisperTimeoutMs).toBe(v.maxDurationSeconds * 1000);
      expect(transcribeCalls[0]!.opts?.audioTimeoutMs).toBe(v.maxDurationSeconds * 200);
      expect(extractOpts?.frameTimeoutMs).toBe(v.maxDurationSeconds * 500);
    });

    test("passes the work dir as extraDirs and raises the timeout to >=600s", async () => {
      const jobId = await capture(v.title, v.canonicalUrl);

      expect(lastOpts).toBeDefined();
      // The tmp work dir is handed to executeOneShot as extraDirs (→ CLI --add-dir).
      const workDir = join(tmpdir(), `${v.workDirPrefix}${jobId}`);
      expect(lastOpts!.extraDirs).toEqual([workDir]);
      expect(downloadCalls[0]!.workDir).toBe(workDir);
      expect(lastOpts!.timeoutMs).toBeGreaterThanOrEqual(600_000);
      // The summarize budget is computed from the REAL frame count (2 here), not
      // a constant — that pass-through is the whole behavioral content of the call.
      expect(summarizeTimeoutArgs).toEqual({ frameCount: 2, floorMs: 120_000 });
      // The caller's bot config reaches the executor unchanged on a `standard`
      // capture, spawn args and all — the summarizer neither mutates nor clones it.
      expect(lastBotConfig).toEqual(bot);
      expect(bot.spawnArgs).toEqual(["--strict-mcp-config"]);
      expect(bot.timeoutMs).toBeUndefined();
    });

    /**
     * The kind drives the MODEL and only the model. The thinking budget is this
     * vertical's own `null` on every kind — reading the keyframes IS the
     * reasoning here, and the 8k knee was measured on a text-only transcript.
     *
     * `null` reaches the seam as "inherit", and the seam then OMITS the key, so
     * the bot's own budget is what the connector sees rather than a number.
     */
    test("every kind keeps the bot's own thinking budget; the kind drives the model", async () => {
      await capture();
      expect("thinkingMaxTokens" in lastOpts!).toBe(false);
      expect(lastBotConfig!.model).toBe("sonnet");
      // The budget the job ASKS for, before the seam's inherit rule — the same
      // constant `/summaries/prompts` builds its run chip from, so the page
      // cannot advertise a budget this call does not send.
      expect(lastCaptureThinking).toBe(SHORT_VIDEO_THINKING);

      await capture(v.title, v.submitUrl, { preset: DEEP });
      expect("thinkingMaxTokens" in lastOpts!).toBe(false);
      expect(lastBotConfig!.model).toBe("claude-opus-5");

      // `talk-notes` too, so the assertion is about the VERTICAL rather than
      // about the two kinds whose run options happen to differ.
      await capture(v.title, v.submitUrl, { preset: TALK_NOTES });
      expect("thinkingMaxTokens" in lastOpts!).toBe(false);
      expect(lastBotConfig!.model).toBe("sonnet");
    });

    /**
     * The trace root's own name. `capture:<source>` and the model span's
     * `source` attribute are the only place a capture says which vertical it
     * was, and `/traces` is filtered on it — so the X vertical filing under
     * `tiktok` would be invisible everywhere except the trace list.
     */
    test("the trace source is THIS spec's id", async () => {
      await capture();
      expect(lastCaptureSource).toBe(v.spec.id);
      expect(lastCaptureSource).toBe(v.traceSource);
    });

    // The short-video verticals used to interpolate SUMMARY_STRUCTURE_BULLETS
    // into a numbered prompt of their own; they take the shared envelope now,
    // with the frame rules in its `before` slot. The numbered step is still 5,
    // and this drives the REAL job and asserts on the prompt it hands the
    // executor.
    //
    // What it catches, measured rather than assumed: decoupling-with-drift, a
    // changed join separator or indent, relocation to another numbered step,
    // renumbering, and text inserted between the heading and the block. What it
    // CANNOT catch, because both sides read the same imported array: a
    // byte-identical fork of the list into a local const, a second copy of the
    // block, and anything appended after it.
    test("the system prompt carries the shared structure rules, incl. the verbatim-artifact one", async () => {
      await capture();

      expect(lastSystemPrompt).toContain(
        `5. Then write a structured summary with:\n   ${SUMMARY_STRUCTURE_BULLETS.join("\n   ")}`,
      );
      // Named explicitly: a short video that reads a prompt out loud is the case
      // the verbatim rule exists for, and these verticals also see on-screen text.
      expect(lastSystemPrompt).toContain("reproduce it VERBATIM inside a fenced code block");
    });

    /**
     * The run uses the BUILDERS — the pin the re-run and `/summaries/prompts`
     * stand on. The work dir the frame paths are under is the one the download
     * was handed, so the expectation is built from what the run really produced
     * rather than from a second guess at the temp-dir name.
     */
    test("the run sends exactly the builders' output, system and user", async () => {
      await capture();

      const workDir = downloadCalls[0]!.workDir;
      const frames = framesResult.map((f) => ({ path: join(workDir, f.path), tSeconds: f.tSeconds }));
      expect(lastSystemPrompt).toBe(
        buildShortVideoSystemPrompt(v.spec, {
          preset: STANDARD,
          title: v.title,
          url: v.canonicalUrl,
          author: "coolcoder",
        }),
      );
      expect(lastPrompt).toBe(buildShortVideoUserPrompt({ transcript, frames }));
      // The frame list is what makes the user prompt more than the transcript —
      // otherwise the assertion above would pass on a run that sent no frames.
      expect(lastPrompt).not.toBe(buildShortVideoUserPrompt({ transcript, frames: [] }));
    });

    /**
     * The completion record. It stays in the JOB rather than in the tail —
     * it reports on the whole capture (its kind, its frame count, its tokens) —
     * so a re-run has to write it itself, and nothing else observes it.
     *
     * The id it names is `spec.idFor`, which is the ONE place the two verticals
     * disagree about what "this video" is: TikTok takes yt-dlp's id, X takes the
     * STATUS id parsed out of the bare url, and on the X fixture those two are
     * different numbers on purpose.
     */
    test("the completion line names this vertical's own id, under its own KEY", async () => {
      await capture();
      const line = logs.find((r) => String(r.message).startsWith(`Summarized ${v.spec.noun} `));
      expect(line).toBeDefined();
      expect(line!.category).toEqual(["muninn", ...v.spec.logCategory]);
      // The KEY is the vertical's own: the JSONL sink is searched by field, and
      // `statusId: 2081…` is a saved query the X vertical shipped with. A merge
      // that renamed it to `videoId` would change what a search matches with no
      // other signal — so it is a spec field, and it is asserted as one.
      expect(line!.properties[v.spec.idLogKey]).toBe(v.loggedId);
      expect(Object.keys(line!.properties)).toContain(v.idLogKey);
      expect(Object.keys(line!.properties)).not.toContain(v.absentIdLogKey);
      expect(line!.properties).toMatchObject({
        category: "ai/claude-code",
        kind: "standard",
        frames: 2,
      });

      // A SECOND run with a different kind and a different frame count, so the
      // two numbers are read off the run rather than matching a constant: with
      // one fixture, `kind: "standard", frames: 2` hardcoded in the summarizer
      // would satisfy the assertion above.
      logs = [];
      framesResult = [{ path: "frame_001.jpg", tSeconds: 4 }];
      await capture(v.title, v.submitUrl, { preset: DEEP });
      const second = logs.find((r) => String(r.message).startsWith(`Summarized ${v.spec.noun} `));
      expect(second!.properties).toMatchObject({ kind: "deep", frames: 1 });
    });

    test("a speechless clip sends the builder's no-speech sentence, not an empty section", async () => {
      transcript = "";
      await capture();

      const workDir = downloadCalls[0]!.workDir;
      const frames = framesResult.map((f) => ({ path: join(workDir, f.path), tSeconds: f.tSeconds }));
      expect(lastPrompt).toBe(buildShortVideoUserPrompt({ transcript: "", frames }));
      expect(lastPrompt).toContain("No speech detected — summarize from the frames.");
    });
  });
}

describe("what the two specs do NOT share", () => {
  test("the X prompt is built on the BARE status url, never the media-slot one", async () => {
    dlCanonicalUrl = X_SLOT_URL;
    dlId = "2081276996567326720";
    const jobId = xaState.createJob("2081279674966044799", "My X video", X_SLOT_URL, "");
    await summarizeXVideo(jobId, X_SLOT_URL, "My X video", config, bot, { preset: STANDARD });

    expect(lastSystemPrompt).toBe(
      buildShortVideoSystemPrompt(X_VIDEO_SPEC, {
        preset: STANDARD,
        title: "My X video",
        url: X_BARE_STATUS_URL,
        author: "coolcoder",
      }),
    );
    // A prompt built from `dl.canonicalUrl` would say `/video/1` and disagree
    // with the document the capture writes.
    expect(lastSystemPrompt).not.toBe(
      buildShortVideoSystemPrompt(X_VIDEO_SPEC, {
        preset: STANDARD,
        title: "My X video",
        url: X_SLOT_URL,
        author: "coolcoder",
      }),
    );
    expect(lastSystemPrompt).toContain("X/Twitter video");
    expect(lastSystemPrompt).not.toContain("TikTok");
  });

  /**
   * The X spec's canonical url is a THREE-branch chain —
   * `canonicalXStatusUrl(dl.canonicalUrl) ?? canonicalXStatusUrl(submitted) ??
   * submitted` — and only the first branch had a fixture. Deleting either
   * fallback survived every other case in this file, so a yt-dlp answer that is
   * not a status URL (a short link it resolved elsewhere, an `i/broadcasts`
   * page, an error page it still reports a `webpage_url` for) would have keyed
   * the document on a url the shelf cannot dedup.
   *
   * The helpers are the REAL ones here, so "not a status URL" means what
   * `canonicalXStatusUrl` means by it, not what a mirror in this file does.
   */
  describe("the X canonical-url chain, branch by branch", () => {
    /** Run the X capture with a given yt-dlp answer and submitted url. */
    async function xCapture(dlUrl: string, submitted: string): Promise<void> {
      dlCanonicalUrl = dlUrl;
      dlId = "2081276996567326720";
      const jobId = xaState.createJob("2081279674966044799", "My X video", submitted, "");
      await summarizeXVideo(jobId, submitted, "My X video", config, bot, { preset: STANDARD });
    }

    test("branch 1: yt-dlp's answer IS a status url — the media-slot suffix is stripped", async () => {
      await xCapture(X_SLOT_URL, X_SLOT_URL);
      expect(ingestPayload!.url).toBe(X_BARE_STATUS_URL);
    });

    test("branch 2: yt-dlp's answer is not a status url — the SUBMITTED one is used", async () => {
      // `t.co` short links and `i/broadcasts` pages both reach yt-dlp; neither
      // carries `/status/<id>`, so `canonicalXStatusUrl` answers null for them.
      const dlUrl = "https://x.com/i/broadcasts/1YpKdgLzqBvGj";
      expect(realMedia.canonicalXStatusUrl(dlUrl)).toBeNull();
      await xCapture(dlUrl, X_SLOT_URL);
      expect(ingestPayload!.url).toBe(X_BARE_STATUS_URL);
    });

    test("branch 3: neither is a status url — the submitted url is kept verbatim", async () => {
      const submitted = "https://x.com/i/broadcasts/1YpKdgLzqBvGj";
      expect(realMedia.canonicalXStatusUrl(submitted)).toBeNull();
      await xCapture("https://x.com/i/status-less", submitted);
      // Verbatim: not null, not the yt-dlp answer, and not a rewritten form.
      expect(ingestPayload!.url).toBe(submitted);
      // …and the id falls back to yt-dlp's, since there is no status id to parse.
      expect(sourceDraftCalls[0]!.input.docId).toBe("2081276996567326720");
    });
  });

  test("the TikTok prompt names TikTok and its own frame clause", async () => {
    dlCanonicalUrl = TT_CANONICAL_URL;
    dlId = "7523456789";
    const jobId = ttState.createJob("7523456789", "My TikTok", TT_SHORT_URL);
    await summarizeTikTok(jobId, TT_SHORT_URL, "My TikTok", config, bot, { preset: STANDARD });

    expect(lastSystemPrompt).toContain("Summarize the following TikTok video");
    expect(lastSystemPrompt).toContain("TikToks often carry most of their information on screen");
    expect(lastSystemPrompt).not.toContain("X videos often carry");
  });

  test("the two specs differ in exactly the fields the merge kept apart", () => {
    // A cheap enumeration, because "one job, two specs" is only honest while
    // every remaining difference is DATA. A new divergence has to arrive here.
    const differing = (Object.keys(TIKTOK_SPEC) as Array<keyof typeof TIKTOK_SPEC>).filter(
      (k) => TIKTOK_SPEC[k] !== X_VIDEO_SPEC[k],
    );
    expect(differing.sort()).toEqual([
      "canonicalUrl",
      "collection",
      "frameClause",
      "id",
      "idFor",
      "idLogKey",
      "ingestPath",
      "logCategory",
      "maxDurationSeconds",
      "noun",
      "platform",
      "store",
      "visualWarning",
      "workDirPrefix",
    ]);
  });

  test("summarizeShortVideo is what both wrappers call", async () => {
    // The wrappers exist so the routes and their mocks are unchanged; the job
    // itself is the shared function, driven here with a spec directly.
    dlCanonicalUrl = TT_CANONICAL_URL;
    dlId = "7523456789";
    const jobId = ttState.createJob("7523456789", "Direct", TT_CANONICAL_URL);
    await summarizeShortVideo(TIKTOK_SPEC, jobId, TT_CANONICAL_URL, "Direct", config, bot, {
      preset: STANDARD,
    });
    expect(ttState.getJob(jobId)!.status).toBe("complete");
    expect(ingestPath).toBe("/api/tiktok/ingest");
  });

  /**
   * `preset` is REQUIRED, and the pin is a TYPE error rather than a runtime one
   * — `bunx tsc --noEmit` is what fails here, since `bun test` strips types.
   *
   * The rule is `src/youtube/summarizer.ts`' and `src/vimeo/summarizer.ts`':
   * a default resolved inside the job would read the SHIPPED preset set, which
   * silently ignores a bot's own `prompts/captureSummary.standard.md` override
   * — an override `/summaries/prompts` shows as present, over a capture that
   * never used it. The routes always resolve one (that is what their
   * `bad_kind` check is), so there is no caller for the default to serve.
   */
  test("the seam takes no preset-less call — a type error, not a silent default", () => {
    // @ts-expect-error — `preset` is required: omitting the options entirely.
    const noOpts = () => summarizeShortVideo(TIKTOK_SPEC, "j", "u", "t", config, bot);
    // @ts-expect-error — `preset` is required: options present, preset absent.
    const noPreset = () => summarizeShortVideo(TIKTOK_SPEC, "j", "u", "t", config, bot, { frames: false });
    // @ts-expect-error — and the same on both public wrappers.
    const noWrapperPreset = () => summarizeTikTok("j", "u", "t", config, bot, { frames: false });
    // @ts-expect-error
    const noXWrapperPreset = () => summarizeXVideo("j", "u", "t", config, bot, {});
    // The four are referenced so this is a compile-time case rather than dead
    // code a linter could drop; none of them is CALLED.
    expect([noOpts, noPreset, noWrapperPreset, noXWrapperPreset]).toHaveLength(4);
  });
});
