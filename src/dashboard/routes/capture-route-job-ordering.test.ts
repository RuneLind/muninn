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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/**
 * Held open by the in-flight cases below: the route's dedup claim lives exactly
 * as long as this promise, so a test that wants a SECOND POST to land while a
 * capture is running parks the first one here.
 */
let vimeoSummarizeGate: Promise<void> | null = null;
/**
 * What the capture REJECTS with, when a case wants the failure path.
 *
 * The real `summarizeVimeo` puts both terminal transitions inside itself and
 * does not rethrow, so this is the shape of a bug in it (or in the deps it
 * resolves) rather than an ordinary capture failure — which is exactly the path
 * the route's `.catch(…).finally(release)` exists for, and the one no case
 * covered: every other case here resolves.
 */
let vimeoSummarizeRejectsWith: unknown = null;
/**
 * The huginn doc id this capture "ingests", or null for a capture that never
 * reaches the ingest at all.
 *
 * The real `summarizeVimeo` calls the route's `onIngested` hook from inside its
 * `ingestSummary` success path, which is the ONLY moment the route can learn
 * that a document now exists — huginn's `/documents` listing is derived from
 * `index_document_mapping.json` and does not move until the background reindex
 * has run. Null keeps every pre-existing case byte-identical: no hook call, no
 * recently-ingested entry, so the claim-release cases still see a fresh capture.
 */
let vimeoIngestDocId: string | null = null;
/** The meta the LAST started capture was handed — the kind + language ride on it. */
let lastVimeoMeta: {
  videoId: string;
  preset?: { id: string };
  lang?: string;
  frames?: boolean;
  author?: string;
  thumbnailUrl?: string;
  uploadDate?: string;
  speaker?: string;
} | null = null;
const realVimeoSummarizer = await import("../../vimeo/summarizer.ts");
mock.module("../../vimeo/summarizer.ts", () => ({
  ...realVimeoSummarizer,
  summarizeVimeo: async (
    _jobId: string,
    meta: typeof lastVimeoMeta & object,
    _config: unknown,
    _botConfig: unknown,
    _deps: unknown,
    onIngested?: (videoId: string, documentId: string) => void,
  ) => {
    vimeoSummarizeCalls++;
    lastVimeoMeta = meta;
    if (vimeoSummarizeGate) await vimeoSummarizeGate;
    if (vimeoIngestDocId !== null) onIngested?.(meta.videoId, vimeoIngestDocId);
    if (vimeoSummarizeRejectsWith !== null) throw vimeoSummarizeRejectsWith;
  },
}));

const { registerTikTokRoutes } = await import("./tiktok-routes.ts");
const { registerYouTubeRoutes } = await import("./youtube-routes.ts");
const { registerVimeoRoutes } = await import("./vimeo-routes.ts");
const { notifySummaryDocumentDeleted } = await import("../../summaries/document-deleted.ts");
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

/**
 * The same app with an injected clock, for the recently-ingested map's TTL.
 *
 * A real 30-minute wait is not a test, and mutating the system clock is not one
 * either — the route reads `now()` once per decision, so a counter the case
 * advances is the whole seam.
 */
function vmAppAt(now: () => number): Hono {
  const app = new Hono();
  registerVimeoRoutes(app, config, { now });
  return app;
}

/**
 * NO microtask-drain helper between a POST and the next one, deliberately.
 *
 * The route's capture is fire-and-forget, so both the `onIngested` write and the
 * `.finally` claim release land in microtasks after the first POST resolves —
 * which reads like it needs a drain. It does not: the SECOND POST awaits its own
 * oEmbed fetch and (on the miss path) the huginn listing before it reads either
 * map, and those awaits drain the queue for free.
 *
 * Measured rather than reasoned: a `for (i < 10) await Promise.resolve()` drain
 * was written here first, then run at ZERO turns — all 34 cases still passed and
 * every mutant below still died. A wait that changes no outcome is not rigor,
 * it is a claim the file cannot back, so it is gone (the same finding retired
 * the two round-2 drains in the claim-release cases below).
 *
 * If a future change makes the second POST synchronous before its map reads,
 * these cases FAIL (an `in_flight` body, `vimeoSummarizeCalls` off by one) —
 * they do not silently pass.
 */
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
  lastVimeoMeta = null;
  vimeoSummarizeGate = null;
  vimeoSummarizeRejectsWith = null;
  vimeoIngestDocId = null;
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

  test("dedup resolves each listed url to its VIDEO ID — an unlisted-hash row matches", async () => {
    // The live collection already holds a row this route never wrote, so
    // "every writer posts the canonical url" is not true of the stored data.
    // Both of these address video 1223358361.
    knowledgeApiImpl = async () => ({
      documents: [{ id: "ai/rag/Unlisted.md", url: "https://vimeo.com/1223358361/abc1234567" }],
    });
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.duplicate).toBe(true);
    expect(body.document_id).toBe("ai/rag/Unlisted.md");
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("dedup matches a stored player.vimeo.com/video/<id> row too", async () => {
    knowledgeApiImpl = async () => ({
      documents: [{ id: "ai/rag/Embed.md", url: "https://player.vimeo.com/video/1223358361" }],
    });
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(((await res.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a listing row whose url is not a Vimeo video is not a duplicate", async () => {
    // `https://vimeo.com/` — a real row in the live collection. Resolving it
    // yields no id, and a row with no id must never match a capture.
    knowledgeApiImpl = async () => ({
      documents: [{ id: "ai/rag/Bare.md", url: "https://vimeo.com/" }, { id: "ai/x.md" }],
    });
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.duplicate).toBeUndefined();
    expect(body.job_id).toBeTruthy();
  });

  // Acceptance: oEmbed's duration is the ONLY length bound this vertical has.
  test("an oEmbed answer with no duration 422s duration_unknown and leaves NO job behind", async () => {
    // `toDurationSec` degrades a missing/non-numeric/negative duration to 0,
    // and 0 passes `> 10_800` unconditionally — so a metadata answer that never
    // said how long the video is used to start an unbounded capture.
    oembedAnswer = { ...(oembedAnswer as Record<string, unknown>), durationSec: 0 } as typeof oembedAnswer;
    const before = vmState.getRecentJobs().length;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "duration_unknown" });
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a not-public answer with no duration is still not_public, not duration_unknown", async () => {
    // The ORDER is pinned by the compiler, not by this case: `VimeoNotPublic`
    // has no `durationSec`, so hoisting the duration branch above `isNotPublic`
    // is a TS2339 (verified by mutation). This asserts the reachable behaviour —
    // a private video is never reported as a metadata gap.
    oembedAnswer = { notPublic: true, status: 403 };
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_public", status: 403 });
  });

  // Acceptance: check-then-act across the huginn lookup created TWO jobs, and
  // huginn suffixes `(2)` rather than overwriting — so the corpus kept a shadow
  // copy of the same talk.
  test("two POSTs of the same url 0 ms apart create ONE job; the second answers in_flight", async () => {
    let release!: () => void;
    vimeoSummarizeGate = new Promise<void>((resolve) => { release = resolve; });
    const app = vmApp();
    const before = vmState.getRecentJobs().length;

    const [resA, resB] = await Promise.all([
      post(app, "/api/vimeo/summarize", { url: VIMEO_URL }),
      post(app, "/api/vimeo/summarize", { url: VIMEO_URL }),
    ]);
    const bodies = [
      (await resA.json()) as Record<string, unknown>,
      (await resB.json()) as Record<string, unknown>,
    ];

    expect(vmState.getRecentJobs().length).toBe(before + 1);
    expect(vimeoSummarizeCalls).toBe(1);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const started = bodies.find((b) => !b.in_flight)!;
    const follower = bodies.find((b) => b.in_flight)!;
    expect(started.job_id).toBeTruthy();
    expect(follower.job_id).toBe(started.job_id);
    expect(follower.dashboard_url).toBe(`/summaries?source=vimeo&job=${String(started.job_id)}`);

    release();
    await Promise.resolve();
  });

  test("a DIFFERENT video is never held up by an in-flight capture", async () => {
    let release!: () => void;
    vimeoSummarizeGate = new Promise<void>((resolve) => { release = resolve; });
    const app = vmApp();

    const first = await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });
    const second = await post(app, "/api/vimeo/summarize", { url: "https://vimeo.com/1223642971" });

    expect(((await first.json()) as Record<string, unknown>).in_flight).toBeUndefined();
    expect(((await second.json()) as Record<string, unknown>).in_flight).toBeUndefined();
    expect(vimeoSummarizeCalls).toBe(2);

    release();
    await Promise.resolve();
  });

  test("the claim is released when the job settles, so the video can be captured again", async () => {
    // No gate: the mocked capture settles immediately, which is what a real
    // `completeJob`/`failJob` does at the end of `summarizeVimeo`.
    const app = vmApp();
    const first = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as {
      job_id: string;
    };

    const second = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;

    expect(second.in_flight).toBeUndefined();
    expect(second.job_id).toBeTruthy();
    expect(second.job_id).not.toBe(first.job_id);
    expect(vimeoSummarizeCalls).toBe(2);
  });

  test("a capture that REJECTS releases the claim — the video is not wedged", async () => {
    // The claim is given back in a `.finally` on the fire-and-forget chain, and
    // nothing covered the rejecting half of it: every other case here resolves,
    // so "release on failure" was carried by a mechanism no test could see. A
    // release moved onto the SUCCESS side of the chain (`.then(release)` before
    // the `.catch`, the natural way to write it) leaves this video claimed for
    // the life of the process — every later POST answers `in_flight` pointing
    // at a job that failed. Deleting the release outright dies here too.
    //
    // What this case does NOT kill, stated because it looks like it should:
    // `.catch(log).finally(release)` → `.catch(log).then(release)`. Those two
    // differ in exactly ONE cell of the chain's state space, enumerated rather
    // than sampled — the capture settles fulfilled (the catch passes through,
    // both run) or rejected, and a rejection either logs cleanly (the catch
    // fulfils, both run) or throws INSIDE the catch, where only `.finally` still
    // releases. That last cell is reachable (`String(err)` runs the rejection
    // value's own `toString`) but not ASSERTABLE here: the catch's throw
    // rejects the chain's tail, which has no terminal handler, and bun's runner
    // fails the case on the escaped rejection whatever `process.on(
    // "unhandledRejection")` says — measured. So the mutant is unpinned, and
    // the missing terminal `.catch` is the follow-up.
    vimeoSummarizeRejectsWith = new Error("the harvester threw on its own stack");
    const app = vmApp();
    const first = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as {
      job_id: string;
    };
    // The POST answers 200 with a job id whatever the background capture does —
    // the route's own error path logs and returns, it never throws into the
    // handler (which already responded) and never rejects the response.
    expect(first.job_id).toBeTruthy();

    const second = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;

    expect(second.in_flight).toBeUndefined();
    expect(second.job_id).toBeTruthy();
    expect(second.job_id).not.toBe(first.job_id);
    expect(vimeoSummarizeCalls).toBe(2);
  });

  test("two registrations do not share a claim — the map belongs to the app", async () => {
    // The map was module-level while `vmApp()` builds a fresh app per case, so
    // it was process state with no seam: a claim leaked by one case (a handler
    // that threw between the claim and its release) outlived that case and
    // answered `in_flight` for every later one touching the same video —
    // measured, one mutation of the release produced 12 failures, none of them
    // in the case that leaked. One map per REGISTRATION is the truthful scope.
    let release!: () => void;
    vimeoSummarizeGate = new Promise<void>((resolve) => { release = resolve; });
    const appA = vmApp();
    const appB = vmApp();

    const a = (await (await post(appA, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    const b = (await (await post(appB, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;

    expect(a.in_flight).toBeUndefined();
    expect(b.in_flight).toBeUndefined();
    expect(b.job_id).toBeTruthy();
    expect(b.job_id).not.toBe(a.job_id);
    expect(vimeoSummarizeCalls).toBe(2);

    release();
    await Promise.resolve();
  });

  test("a refused POST releases the claim rather than wedging the video", async () => {
    // The claim is taken BEFORE the huginn lookup, so every early return under
    // it has to give it back — otherwise one 500 locks that video out until the
    // process restarts. NB this pins the OBSERVABLE property; two mechanisms
    // provide it (the `finally` release and the waiter loop's same-flight
    // break), so mutating either alone leaves this case green.
    summarizerBot = null;
    const app = vmApp();
    expect((await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).status).toBe(500);

    summarizerBot = cliBot;
    const res = await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("an unreachable huginn degrades to 'not a duplicate' and the capture runs", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { job_id?: string }).job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(1);
  });

  // --- The kind + language picker (v2 PR 1) ---------------------------------
  //
  // Both are validated BEFORE oEmbed: a picker value the server does not offer
  // is a 400 whatever the video, and it must not spend a network round-trip
  // (or a job) finding that out.

  test("an unknown kind 400s with code bad_kind, before oEmbed, and leaves NO job behind", async () => {
    const before = vmState.getRecentJobs().length;
    const oembedBefore = oembedCalls;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, kind: "should-i-watch" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_kind", kind: "should-i-watch" });
    expect(oembedCalls).toBe(oembedBefore);
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("the refusal's `error` is prose and its `code` is the machine token", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, kind: "should-i-watch" });
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bad_kind");
    expect(body.error).not.toBe("bad_kind");
    expect(body.error).toContain("should-i-watch");
    const lang = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, lang: "no" });
    const lb = (await lang.json()) as { error: string; code: string };
    expect(lb.code).toBe("bad_lang");
    expect(lb.error).toBe("Unknown output language: no");
  });

  test("deep on a summarizer bot whose connector cannot run opus is bad_kind — never a deep-stamped non-deep capture", async () => {
    summarizerBot = { ...cliBot, connector: "openai-compat", model: "qwen3.5:35b" };
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, kind: "deep" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_kind");
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a non-string kind is bad_kind too, not a crash", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, kind: 7 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_kind");
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("an unknown language 400s with code bad_lang, before oEmbed, and leaves NO job behind", async () => {
    const before = vmState.getRecentJobs().length;
    const oembedBefore = oembedCalls;

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, lang: "no" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_lang", lang: "no" });
    expect(oembedCalls).toBe(oembedBefore);
    expect(vmState.getRecentJobs().length).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("absent kind and lang are the defaults: standard, in the talk's language", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    expect(res.status).toBe(200);
    expect(vimeoSummarizeCalls).toBe(1);
    expect(lastVimeoMeta!.preset!.id).toBe("standard");
    expect(lastVimeoMeta!.lang).toBe("talk");
  });

  test("a picked kind and language ride on the job's meta", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, kind: "talk-notes", lang: "nb" });

    expect(res.status).toBe(200);
    expect(lastVimeoMeta!.preset!.id).toBe("talk-notes");
    expect(lastVimeoMeta!.lang).toBe("nb");
  });

  // --- oEmbed metadata rides on the meta (v2 PR 2) --------------------------

  test("author, thumbnail and upload date come from oEmbed; a conference title yields the speaker", async () => {
    oembedAnswer = { ...oembedAnswer, title: "Trust, But Verify - Handle - Ola Nordmann", author: "JavaZone" };
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });
    expect(res.status).toBe(200);
    expect(lastVimeoMeta).toMatchObject({
      author: "JavaZone",
      thumbnailUrl: "https://i.vimeocdn.com/x.jpg",
      uploadDate: "2026-08-20 09:33:04",
      speaker: "Ola Nordmann",
    });
  });

  test("an individual's upload has NO speaker key, whatever its title says", async () => {
    oembedAnswer = { ...oembedAnswer, title: "Kotlin - the good parts", author: "Some Person" };
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });
    expect(res.status).toBe(200);
    expect(lastVimeoMeta).not.toHaveProperty("speaker");
    expect(lastVimeoMeta!.author).toBe("Some Person");
  });

  test("a per-bot captureSummary.<id>.md is a kind this route accepts", async () => {
    summarizerBot = {
      ...cliBot,
      prompts: { captureSummaryVariants: [{ id: "brief", label: "Brief", content: "- three lines" }] },
    };

    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, kind: "brief" });

    expect(res.status).toBe(200);
    expect(lastVimeoMeta!.preset!.id).toBe("brief");
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

  // Acceptance: the page had the pasted URL and nothing else, so a capture ran
  // for minutes under a title a RELOAD then replaced with the real one.
  test("a fresh job answers with the video's TITLE, not only its id", async () => {
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });

    const body = (await res.json()) as { job_id: string; title?: string };
    expect(body.title).toBe("Trust but verify");
    // The same string the job carries, so a reload cannot relabel the card.
    expect(body.title).toBe(vmState.getJob(body.job_id)!.title);
  });

  test("an in_flight answer carries the RUNNING job's title, not the follower's own oEmbed", async () => {
    // The two are the same string in the ordinary case, so the fixture is
    // changed between the POSTs — otherwise "the running job's title" and "this
    // request's title" are indistinguishable and either implementation passes.
    // What the follower is being told is which title the CARD already shows.
    let release!: () => void;
    vimeoSummarizeGate = new Promise<void>((resolve) => { release = resolve; });
    const app = vmApp();

    const started = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as {
      job_id: string;
      title: string;
    };
    expect(started.title).toBe("Trust but verify");

    oembedAnswer = {
      ...(oembedAnswer as Record<string, unknown>),
      title: "Renamed while the capture ran",
    } as typeof oembedAnswer;

    const follower = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(follower.in_flight).toBe(true);
    expect(follower.job_id).toBe(started.job_id);
    expect(follower.title).toBe("Trust but verify");
    expect(follower.title).toBe(vmState.getJob(started.job_id)!.title);

    release();
    await Promise.resolve();
  });

  test("a title-less oEmbed answer sends the canonical url as the title, never \"\"", async () => {
    oembedAnswer = { ...(oembedAnswer as Record<string, unknown>), title: "" } as typeof oembedAnswer;
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });
    expect(((await res.json()) as { title?: string }).title).toBe(CANONICAL);
  });

  test("the summarize entry registers NO CORS preflight", async () => {
    // Deliberate: no Chrome extension for this vertical, and a cross-origin
    // summarize entry is a way for any page to spend the operator's budget.
    const res = await vmApp().request("/api/vimeo/summarize", { method: "OPTIONS" });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // State 3 of the video id's four: INGESTED, NOT YET LISTED.
  //
  // The state space is exactly four, and each has an owner:
  //   1. absent everywhere            → capture
  //   2. claimed in-flight            → `inFlight`, an `in_flight` body
  //   3. ingested, not yet listed     → THIS map (the reindex window)
  //   4. listed by huginn             → `findExistingByVideoId`, a `duplicate`
  //
  // State 3 was owned by nothing. `GET /api/collection/vimeo-summaries/documents`
  // is derived from huginn's `index_document_mapping.json`, which only moves when
  // the background reindex enqueued AFTER an ingest has actually run — seconds to
  // minutes later — while the in-flight claim is released the instant the capture
  // settles. Measured on a live instance (port 3016, `VIMEO_HARVEST_STUB` + a fake
  // oEmbed): job A completed and ingested, an immediate re-POST answered with a
  // FRESH job id, and both captures ran in full. Only one document survived,
  // because huginn's writer overwrote the same category/title/url — so the corpus
  // looked correct and the second model call was invisible in it.
  //
  // These three cases are ordered deliberately and the eviction one is LAST: it
  // creates 201 jobs in the process-wide store, and every case above that uses a
  // `getRecentJobs()` delta reads the default limit of 20.
  // ---------------------------------------------------------------------------

  test("a video ingested moments ago answers duplicate before huginn has listed it", async () => {
    // The listing is EMPTY throughout — that is the reindex window, and it is
    // what makes this case unsatisfiable by the state-4 guard.
    let listings = 0;
    knowledgeApiImpl = async () => {
      listings++;
      return { documents: [] };
    };
    vimeoIngestDocId = "ai/rag/Trust but verify.md";
    const app = vmApp();

    const first = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as {
      job_id?: string;
    };
    expect(first.job_id).toBeTruthy();
    expect(listings).toBe(1);

    const before = vmState.getRecentJobs(1000).length;
    const res = await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });
    const body = (await res.json()) as Record<string, unknown>;

    // State 3 is checked BEFORE state 4, which the route's own comment claims:
    // the duplicate is answered without asking huginn again. Without this the
    // ORDER is unpinned — measured, swapping the two blocks passed all 34 cases.
    expect(listings).toBe(1);

    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(body.document_id).toBe("ai/rag/Trust but verify.md");
    expect(body.existing_url).toBe(CANONICAL);
    // Byte-identical to the listing path's body — the reader cannot tell which
    // half of dedup answered, and neither can /summaries.
    expect(body.dashboard_url).toBe(
      `/summaries?source=vimeo&doc=${encodeURIComponent("ai/rag/Trust but verify.md")}&duplicate=1`,
    );
    expect(body.job_id).toBeUndefined();
    expect(vmState.getRecentJobs(1000).length).toBe(before);
    // The whole point: no SECOND capture, i.e. no second model call.
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("a capture that ingested NOTHING leaves no recently-ingested entry", async () => {
    // `ingestSummary` calls `onIngested` only when huginn answered ok, so a
    // capture whose ingest failed must fall straight through to the listing —
    // remembering an id-less capture would answer `duplicate` for a document
    // that does not exist anywhere.
    knowledgeApiImpl = async () => ({ documents: [] });
    vimeoIngestDocId = null;
    const app = vmApp();

    await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });

    const second = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;

    expect(second.duplicate).toBeUndefined();
    expect(second.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(2);
  });

  test("a recently-ingested entry is forgotten once the TTL has passed", async () => {
    // A local mirror of `VIMEO_RECENT_INGEST_TTL_MS`, deliberately not an import:
    // importing a name the unfixed module does not export is a LINK error, which
    // reds every case in this file for a reason that has nothing to do with the
    // property under test. If the route's constant moves, this case fails loudly,
    // which is the correct outcome for a contract.
    const TTL_MS = 30 * 60 * 1000;
    knowledgeApiImpl = async () => ({ documents: [] });
    vimeoIngestDocId = "ai/rag/Trust but verify.md";

    let clock = 1_700_000_000_000;
    const app = vmAppAt(() => clock);

    await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });

    // One millisecond inside the window: still the map's answer.
    clock += TTL_MS - 1;
    const inside = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(inside.duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(1);

    // Exactly AT the window: huginn's listing is authoritative again, and it is
    // empty — so the video is capturable. This is the half a mutant that never
    // reads `at` fails.
    clock += 1;
    const outside = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(outside.duplicate).toBeUndefined();
    expect(outside.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(2);
  });

  test("a /summaries Delete of the ingested document forgets it inside the TTL", async () => {
    // The map is a cache with no invalidation against the listing, and the
    // listing is the one place a delete shows up — so a capture deleted and
    // re-pasted inside 30 min was answered `duplicate` about a document that no
    // longer existed. The delete route's notification is the invalidation.
    knowledgeApiImpl = async () => ({ documents: [] });
    vimeoIngestDocId = "ai/rag/Trust but verify.md";
    const app = vmApp();

    await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });

    // Another collection's document of the same id is NOT this map's business.
    notifySummaryDocumentDeleted({ collection: "youtube-summaries", id: "ai/rag/Trust but verify.md" });
    const stillHeld = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(stillHeld.duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(1);

    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: "ai/rag/Trust but verify.md" });
    const after = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(after.duplicate).toBeUndefined();
    expect(after.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(2);
  });

  test("a deleted document huginn STILL LISTS does not answer duplicate — until it is captured again", async () => {
    // huginn's DELETE is a soft delete: it moves the file and enqueues a
    // reindex, and the listing keeps naming the document until that reindex
    // lands (seconds to minutes). Forgetting the map alone moved the stale
    // `duplicate` from state 3 to state 4 — same body, same link to nothing.
    const DOC = "ai/rag/Trust but verify.md";
    knowledgeApiImpl = async () => ({ documents: [{ id: DOC, url: CANONICAL }] });
    vimeoIngestDocId = DOC;
    const app = vmApp();

    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DOC });
    const first = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(first.duplicate).toBeUndefined();
    expect(first.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(1);

    // The re-capture ingested under the SAME id, so the listing row is a real
    // document again — and the map (state 3) answers for it.
    const second = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(second.duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("a re-capture under the deleted id is a real document again, even once its own map entry is gone", async () => {
    // The two maps expire on the same TTL and the ingest is always the later
    // stamp, so the only way the listing half is asked about a re-captured id
    // while the delete is still remembered is `recentIngests` being EVICTED by
    // the cap first. Enumerated, not sampled: TTL cannot produce it. Without
    // the clear on re-ingest, the listed row is treated as deleted and the
    // talk is captured a third time.
    const CAP = 200;
    const DOC = "ai/rag/Trust but verify.md";
    knowledgeApiImpl = async () => ({ documents: [{ id: DOC, url: CANONICAL }] });
    const app = vmApp();
    const urlFor = (i: number) => `https://vimeo.com/${String(1_100_000_000 + i)}`;

    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DOC });
    vimeoIngestDocId = DOC;
    await post(app, "/api/vimeo/summarize", { url: VIMEO_URL });
    expect(vimeoSummarizeCalls).toBe(1);

    // Evict the re-capture's own recently-ingested entry.
    for (let i = 0; i < CAP; i++) {
      vimeoIngestDocId = `ai/rag/other-${i}.md`;
      await post(app, "/api/vimeo/summarize", { url: urlFor(i) });
    }
    expect(vimeoSummarizeCalls).toBe(1 + CAP);

    const again = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(again.duplicate).toBe(true);
    expect(again.document_id).toBe(DOC);
    expect(vimeoSummarizeCalls).toBe(1 + CAP);
  });

  test("a deleted row FIRST in the listing does not hide a live row of the same video", async () => {
    // `vimeo.com/<id>` and `vimeo.com/<id>/<hash>` are two urls for one video,
    // and huginn suffixes a title collision at a different url, so the
    // collection can carry two rows resolving to one id. A guard that skipped
    // the FIRST match and gave up treated the video as absent while a live
    // document existed — a full capture spent for nothing.
    const DELETED = "ai/rag/Trust but verify.md";
    const LIVE = "ai/rag/Trust but verify (2).md";
    knowledgeApiImpl = async () => ({
      documents: [
        { id: DELETED, url: CANONICAL },
        { id: LIVE, url: `${CANONICAL}/abc1234567` },
      ],
    });
    const app = vmApp();
    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DELETED });

    const body = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(body.duplicate).toBe(true);
    expect(body.document_id).toBe(LIVE);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("a remembered delete expires on the TTL — the listing is authoritative again", async () => {
    const TTL_MS = 30 * 60 * 1000;
    const DOC = "ai/rag/Trust but verify.md";
    knowledgeApiImpl = async () => ({ documents: [{ id: DOC, url: CANONICAL }] });
    let clock = 1_700_000_000_000;
    const app = vmAppAt(() => clock);
    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DOC });

    clock += TTL_MS - 1;
    const inside = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    // Inside the window the listed row is treated as gone ⇒ captured. The
    // capture ingests nothing (`vimeoIngestDocId` is null from `beforeEach`,
    // read synchronously during the POST), so nothing clears the stamp.
    expect(inside.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(1);

    clock += 1;
    const outside = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(outside.duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("the delete map is bounded — the 201st delete evicts the oldest", async () => {
    const CAP = 200;
    const DOC = "ai/rag/Trust but verify.md";
    knowledgeApiImpl = async () => ({ documents: [{ id: DOC, url: CANONICAL }] });
    vimeoIngestDocId = null;
    const app = vmApp();
    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DOC });
    for (let i = 0; i < CAP; i++) {
      notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: `ai/rag/other-${i}.md` });
    }
    // DOC was the oldest of 201 ⇒ evicted ⇒ the listing's row counts again.
    const body = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(body.duplicate).toBe(true);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("deleting the same document twice re-stamps it as the NEWEST entry", async () => {
    // `Map.set` on an existing key keeps its ORIGINAL insertion position, so
    // without the delete-then-set a twice-deleted document would be evicted by
    // the cap in its first position and the stale `duplicate` would return
    // while huginn still lists it.
    const CAP = 200;
    const DOC = "ai/rag/Trust but verify.md";
    knowledgeApiImpl = async () => ({ documents: [{ id: DOC, url: CANONICAL }] });
    vimeoIngestDocId = null;
    const app = vmApp();
    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DOC });
    for (let i = 0; i < CAP - 1; i++) {
      notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: `ai/rag/other-${i}.md` });
    }
    // 200 entries, DOC oldest. Delete DOC again: it must move to the newest
    // position, so the next eviction takes other-0, not DOC.
    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: DOC });
    notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: "ai/rag/one-more.md" });

    const body = (await (await post(app, "/api/vimeo/summarize", { url: VIMEO_URL })).json()) as
      Record<string, unknown>;
    expect(body.duplicate).toBeUndefined();
    expect(body.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(1);
  });

  test("the map is bounded — the 201st ingest evicts the oldest entry", async () => {
    // Mirrors `VIMEO_RECENT_INGEST_MAX`, same reason as the TTL mirror above.
    const CAP = 200;
    knowledgeApiImpl = async () => ({ documents: [] });
    const app = vmApp();
    // Vimeo ids never carry a leading zero (`/0123` and `/123` would be two
    // dedup keys for one video), so the range starts well above it.
    const urlFor = (i: number) => `https://vimeo.com/${String(1_000_000_000 + i)}`;

    for (let i = 0; i <= CAP; i++) {
      vimeoIngestDocId = `ai/rag/talk-${i}.md`;
      await post(app, "/api/vimeo/summarize", { url: urlFor(i) });
    }
    const capturesSoFar = vimeoSummarizeCalls;
    expect(capturesSoFar).toBe(CAP + 1);

    // The newest ingest is remembered...
    const newest = (await (await post(app, "/api/vimeo/summarize", { url: urlFor(CAP) })).json()) as
      Record<string, unknown>;
    expect(newest.duplicate).toBe(true);
    expect(newest.document_id).toBe(`ai/rag/talk-${CAP}.md`);

    // ...and so is the SECOND-oldest, so the eviction took exactly one entry
    // rather than clearing the map. Asserted before the next POST, because a
    // duplicate answer creates nothing and therefore evicts nothing.
    const second = (await (await post(app, "/api/vimeo/summarize", { url: urlFor(1) })).json()) as
      Record<string, unknown>;
    expect(second.duplicate).toBe(true);
    expect(second.document_id).toBe("ai/rag/talk-1.md");

    // ...while the OLDEST is gone: it falls through to the (empty) listing and
    // is captured again, which is the honest degrade — the map only ever covers
    // the reindex window.
    const oldest = (await (await post(app, "/api/vimeo/summarize", { url: urlFor(0) })).json()) as
      Record<string, unknown>;
    expect(oldest.duplicate).toBeUndefined();
    expect(oldest.job_id).toBeTruthy();
    expect(vimeoSummarizeCalls).toBe(capturesSoFar + 1);
  });
});

describe("Vimeo: the frames flag (v2 PR 4)", () => {
  const VIMEO_URL = "https://vimeo.com/1223358361";

  test("absent ⇒ off; true rides to the job meta on a connector that can read files", async () => {
    summarizerBot = cliBot;
    let res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL });
    expect(res.status).toBe(200);
    expect(lastVimeoMeta!.frames).toBe(false);

    res = await post(vmApp(), "/api/vimeo/summarize", { url: "https://vimeo.com/1223358362", frames: true });
    expect(res.status).toBe(200);
    expect(lastVimeoMeta!.frames).toBe(true);
  });

  test("a non-boolean is a 400 bad_frames, before oEmbed", async () => {
    summarizerBot = cliBot;
    const before = oembedCalls;
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, frames: "yes" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_frames" });
    expect(oembedCalls).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
  });

  test("frames on a connector without extra-dirs support is a 503 frames_unsupported BEFORE oEmbed and before any job", async () => {
    summarizerBot = copilotBot;
    const before = oembedCalls;
    const jobsBefore = vmState.getRecentJobs(1000).length;
    const res = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, frames: true });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("frames_unsupported");
    expect(body.code).toBe("frames_unsupported");
    expect(body.detail).toContain("melosys");
    expect(oembedCalls).toBe(before);
    expect(vimeoSummarizeCalls).toBe(0);
    expect(vmState.getRecentJobs(1000).length).toBe(jobsBefore); // the module store is shared across cases
    // frames:false on the same bot is an ordinary capture.
    const ok = await post(vmApp(), "/api/vimeo/summarize", { url: VIMEO_URL, frames: false });
    expect(ok.status).toBe(200);
  });
});

describe("Vimeo: GET /api/vimeo/frames/:videoId/:file (v2 PR 4)", () => {
  function appWithFrames(root: string): Hono {
    const app = new Hono();
    registerVimeoRoutes(app, config, { framesRoot: root });
    return app;
  }

  test("serves a kept frame as image/jpeg with a day of caching; anything else is a 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "vimeo-frames-route-"));
    mkdirSync(join(root, "1223358361"));
    writeFileSync(join(root, "1223358361", "1390.jpg"), "JPEGBYTES");
    const app = appWithFrames(root);

    const ok = await app.request("/api/vimeo/frames/1223358361/1390.jpg");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(await ok.text()).toBe("JPEGBYTES");

    for (const path of [
      "/api/vimeo/frames/1223358361/1391.jpg",       // not kept
      "/api/vimeo/frames/1223358361/1390.png",       // wrong extension
      "/api/vimeo/frames/1223358361/x.jpg",          // not digits
      "/api/vimeo/frames/abc/1390.jpg",              // id not digits
      "/api/vimeo/frames/1223358361/..%2F1390.jpg",  // traversal shape
      "/api/vimeo/frames/1223358361/1390.jpg%00",    // charset
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
    }
  });

  test("the charset gate refuses a non-digit id even when that FILE EXISTS under the root", async () => {
    // Without a planted file, `/abc/1390.jpg` 404s because nothing is there —
    // a test that cannot tell "refused by charset" from "missing". Plant it.
    const root = mkdtempSync(join(tmpdir(), "vimeo-frames-route-"));
    mkdirSync(join(root, "abc"));
    writeFileSync(join(root, "abc", "1390.jpg"), "X");
    mkdirSync(join(root, "1223358361"));
    writeFileSync(join(root, "1223358361", "frame.jpg"), "X");
    const app = appWithFrames(root);
    expect((await app.request("/api/vimeo/frames/abc/1390.jpg")).status).toBe(404);
    expect((await app.request("/api/vimeo/frames/1223358361/frame.jpg")).status).toBe(404);
  });

  test("a kept frame is cached PRIVATELY: the route sits in the admin zone under MUNINN_AUTH, and a shared cache must not serve it past a 403", async () => {
    const root = mkdtempSync(join(tmpdir(), "vimeo-frames-route-"));
    mkdirSync(join(root, "1223358361"));
    writeFileSync(join(root, "1223358361", "1390.jpg"), "X");
    const res = await appWithFrames(root).request("/api/vimeo/frames/1223358361/1390.jpg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
  });

  test("is read-only: no POST, PUT or DELETE is registered on the path", async () => {
    const app = appWithFrames(mkdtempSync(join(tmpdir(), "vimeo-frames-route-")));
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await app.request("/api/vimeo/frames/1223358361/1390.jpg", { method });
      expect(res.status).toBe(404);
    }
  });
});
