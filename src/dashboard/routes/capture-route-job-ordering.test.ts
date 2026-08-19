/**
 * Acceptance for ONE property of the TikTok + YouTube capture POST routes: a
 * job row is created only on the path that will actually run a capture.
 *
 * What only this file can see: both handlers used to call `createJob` ABOVE
 * their `resolveSummarizerBot` 500 and (TikTok) their `supportsExtraDirs` 503.
 * A job created above an early return is never settled — no `failJob`, no
 * terminal event — so it sits in the store until the sweeper takes it, and
 * because `getRecentJobs` sorts by `createdAt` desc it sits at the TOP of
 * /summaries with a "running" /agents card the whole time. That window is now
 * the in-flight grace (12h), not the 1h terminal TTL, so the ordering stopped
 * being cosmetic. The concrete trigger is ordinary config: point
 * SUMMARIZER_BOT at a `copilot-sdk` bot and every TikTok click 503s.
 *
 * The response bodies are asserted alongside, because "no job created" is also
 * satisfiable by breaking the route — the point is that the 200 path is
 * unchanged while the early returns leak nothing.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains) and MUST stay that way: `mock.module` here replaces `bots/config.ts`,
 * which a large share of the suite imports transitively — mocking it inside a
 * shared chunk breaks export resolution in unrelated files.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";

// --- Mocks: everything the handlers reach for that isn't the ordering itself.

let botsResult: Array<Record<string, unknown>> = [];
let summarizerBot: Record<string, unknown> | null = null;

const realBots = await import("../../bots/config.ts");
mock.module("../../bots/config.ts", () => ({
  ...realBots,
  discoverAllBots: () => botsResult,
  resolveSummarizerBot: () => summarizerBot,
}));

// No huginn: the dedup pre-check must degrade to "not a duplicate", which is
// what the real route does on a failed fetch.
const realKnowledgeApi = await import("../../ai/knowledge-api-client.ts");
mock.module("../../ai/knowledge-api-client.ts", () => ({
  ...realKnowledgeApi,
  fetchKnowledgeApi: async () => {
    throw new Error("no knowledge api in this test");
  },
}));

let tiktokSummarizeCalls = 0;
mock.module("../../tiktok/summarizer.ts", () => ({
  summarizeTikTok: async () => {
    tiktokSummarizeCalls++;
  },
}));

let youtubeSummarizeCalls = 0;
mock.module("../../youtube/summarizer.ts", () => ({
  summarizeVideo: async () => {
    youtubeSummarizeCalls++;
  },
}));

const { registerTikTokRoutes } = await import("./tiktok-routes.ts");
const { registerYouTubeRoutes } = await import("./youtube-routes.ts");
const ttState = await import("../../tiktok/state.ts");
const ytState = await import("../../youtube/state.ts");

const config = {
  knowledgeApiUrl: "http://127.0.0.1:1",
  claudeTimeoutMs: 120_000,
} as unknown as Config;

/** A bot whose connector CAN grant --add-dir (TikTok's 503 pre-flight passes). */
const cliBot = { name: "jarvis", connector: "claude-cli", dir: "/tmp/jarvis" };
/** A bot whose connector cannot — the ordinary misconfiguration behind the 503. */
const copilotBot = { name: "melosys", connector: "copilot-sdk", dir: "/tmp/melosys" };

function ttApp(): Hono {
  const app = new Hono();
  registerTikTokRoutes(app, config);
  return app;
}

function ytApp(): Hono {
  const app = new Hono();
  registerYouTubeRoutes(app, config);
  return app;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  botsResult = [cliBot];
  summarizerBot = cliBot;
  tiktokSummarizeCalls = 0;
  youtubeSummarizeCalls = 0;
});

describe("TikTok capture POST — a job exists only when a capture will run", () => {
  test("no summarizer bot 500s and leaves NO job behind", async () => {
    summarizerBot = null;
    const before = ttState.getRecentJobs().length;

    const res = await post(ttApp(), "/api/tiktok/summarize", {
      url: "https://www.tiktok.com/@coolcoder/video/7523456789",
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "No bots configured" });
    expect(ttState.getRecentJobs().length).toBe(before);
    expect(tiktokSummarizeCalls).toBe(0);
  });

  test("a connector without extra-dirs 503s and leaves NO job behind", async () => {
    // The live trigger: SUMMARIZER_BOT points at a copilot-sdk bot, so every
    // capture click fails the pre-flight. Before the reorder each click left a
    // pending card pinned to the top of /summaries.
    summarizerBot = copilotBot;
    const before = ttState.getRecentJobs().length;

    const res = await post(ttApp(), "/api/tiktok/summarize", {
      url: "https://www.tiktok.com/@coolcoder/video/7523456789",
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("no extra-dirs support");
    expect(ttState.getRecentJobs().length).toBe(before);
    expect(tiktokSummarizeCalls).toBe(0);
  });

  test("the happy path is unchanged: one job, and the capture starts", async () => {
    const before = ttState.getRecentJobs().length;

    const res = await post(ttApp(), "/api/tiktok/summarize", {
      url: "https://www.tiktok.com/@coolcoder/video/7523456789",
      title: "My TikTok",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { job_id: string; dashboard_url: string };
    expect(body.job_id).toBeTruthy();
    expect(body.dashboard_url).toContain("source=tiktok");
    expect(ttState.getRecentJobs().length).toBe(before + 1);
    expect(ttState.getJob(body.job_id)).toBeDefined();
    expect(tiktokSummarizeCalls).toBe(1);
  });

  test("a missing url 400s before anything else", async () => {
    const before = ttState.getRecentJobs().length;
    const res = await post(ttApp(), "/api/tiktok/summarize", { title: "no url" });

    expect(res.status).toBe(400);
    expect(ttState.getRecentJobs().length).toBe(before);
  });
});

describe("YouTube capture POST — a job exists only when a capture will run", () => {
  test("no summarizer bot 500s and leaves NO job behind", async () => {
    summarizerBot = null;
    const before = ytState.getRecentJobs().length;

    const res = await post(ytApp(), "/api/youtube/summarize", {
      url: "https://www.youtube.com/watch?v=abc123",
      video_id: "abc123",
    });

    expect(res.status).toBe(500);
    expect(ytState.getRecentJobs().length).toBe(before);
    expect(youtubeSummarizeCalls).toBe(0);
  });

  test("the happy path is unchanged: one job, and the capture starts", async () => {
    const before = ytState.getRecentJobs().length;

    const res = await post(ytApp(), "/api/youtube/summarize", {
      url: "https://www.youtube.com/watch?v=abc123",
      video_id: "abc123",
      title: "My video",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { job_id: string };
    expect(ytState.getJob(body.job_id)).toBeDefined();
    expect(ytState.getRecentJobs().length).toBe(before + 1);
    expect(youtubeSummarizeCalls).toBe(1);
  });
});
