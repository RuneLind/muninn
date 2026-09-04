/**
 * Acceptance for ONE property of the TikTok + YouTube + Vimeo capture POST
 * routes: a job row is created only on the path that will actually run a
 * capture.
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
 * Vimeo has four early returns rather than two, because it fetches oEmbed
 * FIRST: a not-public video, a video past the 3h cap and an already-captured
 * url all refuse before a job exists, and each case asserts the mocked
 * summarizer was never called (the harvester launches a Chromium, so "no job"
 * alone would not say the expensive half was skipped).
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains) and MUST stay that way: `mock.module` here replaces `bots/config.ts`,
 * which a large share of the suite imports transitively — mocking it inside a
 * shared chunk breaks export resolution in unrelated files.
 */

import { test, expect, describe, mock, beforeEach, beforeAll, afterAll } from "bun:test";
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
// what the real route does on a failed fetch. The Vimeo cases below need the
// OTHER answer too (a listing containing the canonical url), so the throw is the
// DEFAULT of a settable impl rather than the whole mock.
let knowledgeApiImpl: (baseUrl: string, path: string) => Promise<unknown> = async () => {
  throw new Error("no knowledge api in this test");
};
const realKnowledgeApi = await import("../../ai/knowledge-api-client.ts");
mock.module("../../ai/knowledge-api-client.ts", () => ({
  ...realKnowledgeApi,
  fetchKnowledgeApi: (baseUrl: string, path: string) => knowledgeApiImpl(baseUrl, path),
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

// The Vimeo route calls oEmbed BEFORE it creates a job — that ordering is the
// whole point of the cases below, so the metadata is a settable stub rather
// than a live HTTP call. `isNotPublic` stays real (it is the route's branch).
type OembedAnswer =
  | { title: string; author: string; durationSec: number; uploadDate: string; thumbnailUrl: string }
  | { notPublic: true; status: number };
let oembedAnswer: OembedAnswer = {
  title: "Trust but verify",
  author: "JavaZone",
  durationSec: 3180,
  uploadDate: "2026-08-20 09:33:04",
  thumbnailUrl: "https://i.vimeocdn.com/x.jpg",
};
let oembedThrows: Error | null = null;
let oembedCalls = 0;
const realOembed = await import("../../vimeo/oembed.ts");
mock.module("../../vimeo/oembed.ts", () => ({
  ...realOembed,
  fetchVimeoOembed: async () => {
    oembedCalls++;
    if (oembedThrows) throw oembedThrows;
    return oembedAnswer;
  },
}));

// The harvester stands in for the browser half: acceptance 4/5 require that a
// duplicate / not-public / over-cap paste never reaches it AT ALL.
// The spread keeps `VIMEO_MAX_DURATION_SEC` real — the route imports the cap
// from here, and a mock that dropped it would make the 413 case assert against
// `undefined > x`, i.e. never fire.
let vimeoSummarizeCalls = 0;
const realVimeoSummarizer = await import("../../vimeo/summarizer.ts");
mock.module("../../vimeo/summarizer.ts", () => ({
  ...realVimeoSummarizer,
  summarizeVimeo: async () => {
    vimeoSummarizeCalls++;
  },
}));

const { registerTikTokRoutes } = await import("./tiktok-routes.ts");
const { registerYouTubeRoutes } = await import("./youtube-routes.ts");
const { registerVimeoRoutes } = await import("./vimeo-routes.ts");
const ttState = await import("../../tiktok/state.ts");
const ytState = await import("../../youtube/state.ts");
const vmState = await import("../../vimeo/state.ts");

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

function vmApp(): Hono {
  const app = new Hono();
  registerVimeoRoutes(app, config);
  return app;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Make the `yt-dlp` pre-flight succeed, for the whole file.
 *
 * The TikTok handler's FIRST pre-flight is `Bun.which("yt-dlp")` and it 500s when
 * the binary is absent — before the bot resolution and the extra-dirs check these
 * tests are actually about. So all three TikTok cases silently asserted "the
 * developer has yt-dlp installed", and on a CI runner, which does not, they failed
 * with a 500 that had nothing to do with job ordering.
 *
 * Patching `Bun.which` rather than putting a stub on PATH: **`Bun.which` does not
 * see `process.env.PATH` mutations** — it resolves against the PATH snapshot taken
 * at process start, so the usual temp-dir-on-PATH trick is INERT here (measured;
 * `Bun.spawn` does honour a mutated env, which is why the same trick works in
 * `src/scheduler/executor.test.ts`). Only `yt-dlp` is answered; every other lookup
 * falls through to the real implementation, and the file already runs in its own
 * `bun test` process, so the patch cannot reach another file.
 *
 * A stub, not `apt install yt-dlp` in the workflow: this is a unit test of route
 * ORDERING and should not need a video downloader. Nothing here runs the binary.
 */
const realWhich = Bun.which;
beforeAll(() => {
  (Bun as { which: typeof Bun.which }).which = ((cmd: string, opts?: { PATH?: string; cwd?: string }) =>
    cmd === "yt-dlp" ? "/stub/bin/yt-dlp" : realWhich(cmd, opts)) as typeof Bun.which;
});
afterAll(() => {
  (Bun as { which: typeof Bun.which }).which = realWhich;
});

beforeEach(() => {
  botsResult = [cliBot];
  summarizerBot = cliBot;
  tiktokSummarizeCalls = 0;
  youtubeSummarizeCalls = 0;
  vimeoSummarizeCalls = 0;
  oembedCalls = 0;
  oembedThrows = null;
  oembedAnswer = {
    title: "Trust but verify",
    author: "JavaZone",
    durationSec: 3180,
    uploadDate: "2026-08-20 09:33:04",
    thumbnailUrl: "https://i.vimeocdn.com/x.jpg",
  };
  knowledgeApiImpl = async () => {
    throw new Error("no knowledge api in this test");
  };
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


describe("Vimeo capture POST — nothing is created until a capture will run", () => {
  const VIMEO_URL = "https://vimeo.com/1223358361";
  const CANONICAL = "https://vimeo.com/1223358361";

  /** A huginn listing that already holds this video's canonical url. */
  function listingWithDuplicate() {
    knowledgeApiImpl = async () => ({
      documents: [
        { id: "ai/general/Something else.md", url: "https://vimeo.com/999" },
        { id: "ai/rag/Trust but verify.md", url: CANONICAL },
      ],
    });
  }

  test("a non-Vimeo url 400s before oEmbed is even asked", async () => {
    const before = vmState.getRecentJobs().length;
    const res = await post(vmApp(), "/api/vimeo/summarize", {
      url: "https://youtube.com/watch?v=abc",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Not a Vimeo video URL");
    expect(oembedCalls).toBe(0);
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a missing url 400s before anything else", async () => {
    const before = vmState.getRecentJobs().length;
    const res = await post(vmApp(), "/api/vimeo/summarize", { title: "no url" });

    expect(res.status).toBe(400);
    expect(oembedCalls).toBe(0);
    expect(vmState.getRecentJobs().length).toBe(before);
  });

  // Acceptance 5: a not-public paste creates NO job and never reaches the harvester.
  test("a private/deleted video 422s not_public and leaves NO job behind", async () => {
    oembedAnswer = { notPublic: true, status: 404 };
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: "https://vimeo.com/1" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_public", status: 404 });
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a video over the 3h cap 413s and leaves NO job behind", async () => {
    oembedAnswer = { ...(oembedAnswer as { title: string } & Record<string, unknown>), durationSec: 10_801 } as typeof oembedAnswer;
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; durationSec: number; maxSec: number };
    expect(body.error).toBe("too_long");
    expect(body.durationSec).toBe(10_801);
    expect(body.maxSec).toBe(realVimeoSummarizer.VIMEO_MAX_DURATION_SEC);
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a video EXACTLY at the cap is accepted", async () => {
    oembedAnswer = { ...(oembedAnswer as Record<string, unknown>), durationSec: 10_800 } as typeof oembedAnswer;
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(200);
    expect(vimeoSummarizeCalls).toBe(1);
  });

  // Acceptance 4: a duplicate answers a shape with no job_id, and the harvester
  // call count is 0.
  test("an already-captured url answers duplicate with NO job_id and NO harvest", async () => {
    listingWithDuplicate();
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.duplicate).toBe(true);
    expect(body.document_id).toBe("ai/rag/Trust but verify.md");
    expect(body.existing_url).toBe(CANONICAL);
    expect(body.job_id).toBeUndefined();
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("the dedup key is the CANONICAL url — an unlisted-hash paste still matches", async () => {
    listingWithDuplicate();
    const res = await post(vmApp(), "/api/vimeo/summarize", {
      url: "https://vimeo.com/1223358361/abc1234567",
    });

    expect(((await res.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("an unreachable huginn degrades to 'not a duplicate' and the capture runs", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { job_id?: string }).job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("no summarizer bot 500s and leaves NO job behind", async () => {
    summarizerBot = null;
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "No bots configured" });
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("an oEmbed transport failure 502s and leaves NO job behind", async () => {
    oembedThrows = new Error("Vimeo oEmbed timed out after 10000ms");
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("oembed_failed");
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("the happy path creates ONE job whose title comes from oEmbed", async () => {
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { job_id: string; dashboard_url: string };
    expect(body.dashboard_url).toContain("source=vimeo");
    expect(vmState.getRecentJobs().length).toBe(before + 1);
    const job = vmState.getJob(body.job_id)!;
    expect(job.title).toBe("Trust but verify");
    expect(job.url).toBe(CANONICAL);
    expect(job.videoId).toBe("1223358361");
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("a title-less oEmbed answer falls back to the canonical url, never an empty title", async () => {
    // huginn derives the document FILENAME from the title; "" would collide
    // with every other title-less capture.
    oembedAnswer = { ...(oembedAnswer as Record<string, unknown>), title: "" } as typeof oembedAnswer;
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    const body = (await res.json()) as { job_id: string };
    expect(vmState.getJob(body.job_id)!.title).toBe(CANONICAL);
  });

  test("the summarize entry registers NO CORS preflight", async () => {
    // Deliberate: no Chrome extension for this vertical, and a cross-origin
    // summarize entry is a way for any page to spend the operator's budget.
    const res = await vmApp().request("/api/vimeo/summarize", { method: "OPTIONS" });
    expect(res.status).toBe(404);
  });
});
