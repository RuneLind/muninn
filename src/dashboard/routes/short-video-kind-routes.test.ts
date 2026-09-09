/**
 * The KIND picker on the two SHORT-VIDEO capture routes — `GET
 * /api/tiktok/options`, `GET /api/x-articles/video-options`, and the `bad_kind`
 * refusals on their POSTs.
 *
 * What only a route-level file can see: the ORDERING. A picker value this
 * instance does not offer is a 400 whatever the video, so it is refused above
 * the huginn listing read and above `createJob` — otherwise a typo'd kind costs
 * a network round-trip and leaves an unsettled job row at the top of /summaries
 * with a "running" /agents card for the whole in-flight grace. Each refusal case
 * therefore asserts the response AND that neither the listing nor the summarizer
 * was reached.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test` and
 * `test:unit` chains) and MUST stay that way: `mock.module` here replaces
 * `bots/config.ts`, which a large share of the suite imports transitively.
 */

import { test, expect, describe, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";

let botsResult: Array<Record<string, unknown>> = [];
let summarizerBot: Record<string, unknown> | null = null;

const realBots = await import("../../bots/config.ts");
mock.module("../../bots/config.ts", () => ({
  ...realBots,
  discoverAllBots: () => botsResult,
  resolveSummarizerBot: () => summarizerBot,
}));

/** Every huginn read this file's routes could make, counted and refused. */
let knowledgeApiCalls: string[] = [];
const realKnowledgeApi = await import("../../ai/knowledge-api-client.ts");
mock.module("../../ai/knowledge-api-client.ts", () => ({
  ...realKnowledgeApi,
  fetchKnowledgeApi: async (_baseUrl: string, path: string) => {
    knowledgeApiCalls.push(path);
    throw new Error("no knowledge api in this test");
  },
}));

let tiktokCalls = 0;
let lastTikTokOpts: { frames?: boolean; preset?: { id: string } } | undefined;
mock.module("../../tiktok/summarizer.ts", () => ({
  summarizeTikTok: async (
    _jobId: string,
    _url: string,
    _title: string,
    _c: unknown,
    _b: unknown,
    opts?: { frames?: boolean; preset?: { id: string } },
  ) => {
    tiktokCalls++;
    lastTikTokOpts = opts;
  },
}));

let xVideoCalls = 0;
let lastXVideoOpts: { frames?: boolean; preset?: { id: string } } | undefined;
const realXVideo = await import("../../x-article/video.ts");
mock.module("../../x-article/video.ts", () => ({
  ...realXVideo,
  summarizeXVideo: async (
    _jobId: string,
    _url: string,
    _title: string,
    _c: unknown,
    _b: unknown,
    opts?: { frames?: boolean; preset?: { id: string } },
  ) => {
    xVideoCalls++;
    lastXVideoOpts = opts;
  },
}));

const { registerTikTokRoutes } = await import("./tiktok-routes.ts");
const { registerXArticleRoutes } = await import("./x-article-routes.ts");
const ttState = await import("../../tiktok/state.ts");
const xaState = await import("../../x-article/state.ts");

const config = {
  knowledgeApiUrl: "http://127.0.0.1:1",
  claudeTimeoutMs: 120_000,
} as unknown as Config;

/**
 * Make the `yt-dlp` pre-flight succeed, for the whole file — the
 * `capture-route-job-ordering.test.ts` patch, for its reasons.
 *
 * Both handlers' FIRST pre-flight is `Bun.which("yt-dlp")` and it 500s when the
 * binary is absent, before the kind check these cases are about. `Bun.which`
 * does NOT see `process.env.PATH` mutations (it resolves against the snapshot
 * taken at process start), so a stub on PATH would be inert; only `yt-dlp` is
 * answered here, and this file runs in a process of its own.
 */
const realWhich = Bun.which;
beforeAll(() => {
  (Bun as { which: typeof Bun.which }).which = ((cmd: string, opts?: { PATH?: string; cwd?: string }) =>
    cmd === "yt-dlp" ? "/stub/bin/yt-dlp" : realWhich(cmd, opts)) as typeof Bun.which;
});
afterAll(() => {
  (Bun as { which: typeof Bun.which }).which = realWhich;
});

/** A bot whose connector CAN grant --add-dir, so the 503 pre-flight passes. */
const cliBot = { name: "jarvis", connector: "claude-cli", dir: "/tmp/jarvis" };

function app(): Hono {
  const a = new Hono();
  registerTikTokRoutes(a, config);
  registerXArticleRoutes(a, config);
  return a;
}

/** The two POSTs, side by side, so every case is asserted on both. */
const POSTS = [
  {
    name: "tiktok",
    path: "/api/tiktok/summarize",
    optionsPath: "/api/tiktok/options",
    url: "https://www.tiktok.com/@coolcoder/video/7523456789",
    calls: () => tiktokCalls,
    opts: () => lastTikTokOpts,
    jobCount: () => ttState.getRecentJobs(50).length,
  },
  {
    name: "x-video",
    path: "/api/x-articles/summarize-video",
    optionsPath: "/api/x-articles/video-options",
    url: "https://x.com/coolcoder/status/2081279674966044799",
    calls: () => xVideoCalls,
    opts: () => lastXVideoOpts,
    jobCount: () => xaState.getRecentJobs(50).length,
  },
] as const;

beforeEach(() => {
  botsResult = [cliBot];
  summarizerBot = cliBot;
  knowledgeApiCalls = [];
  tiktokCalls = 0;
  xVideoCalls = 0;
  lastTikTokOpts = undefined;
  lastXVideoOpts = undefined;
});

async function post(a: Hono, path: string, body: unknown): Promise<Response> {
  return await a.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

for (const p of POSTS) {
  describe(`${p.name}: the options endpoint`, () => {
    test("answers the kinds this bot offers, with the default named", async () => {
      const res = await app().request(p.optionsPath);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        kinds: { id: string; label: string }[];
        default_kind: string;
        frames: { supported: boolean };
      };
      expect(body.kinds.map((k) => k.id)).toEqual(["standard", "deep", "talk-notes"]);
      // Labelled rows, not bare ids — a client that had to name them would be a
      // second catalog nobody updates.
      expect(body.kinds[0]).toEqual({ id: "standard", label: "Standard" });
      // The default is NAMED rather than "the first entry", so no client has to
      // assume an order.
      expect(body.default_kind).toBe("standard");
      expect(body.frames).toEqual({ supported: true });
      // CORS: the entry point is a Chrome extension whose muninnUrl is editable
      // past the manifest's localhost grant, so without this header the picker
      // silently falls back to Standard-only.
      expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    });

    test("a connector that cannot name the opus model loses the deep kind", async () => {
      // `requireThinkingControl` — the short-video set is the YouTube one, and
      // the rationale for the narrowing lives on that option in presets.ts.
      summarizerBot = { name: "olly", connector: "openai-compat", dir: "/tmp/olly" };
      botsResult = [summarizerBot];
      const body = (await (await app().request(p.optionsPath)).json()) as {
        kinds: { id: string }[];
        frames: { supported: boolean };
      };
      expect(body.kinds.map((k) => k.id)).toEqual(["standard", "talk-notes"]);
      expect(body.frames.supported).toBe(false);
    });

    test("no bots configured is a 500 with a machine token", async () => {
      summarizerBot = null;
      botsResult = [];
      const res = await app().request(p.optionsPath);
      expect(res.status).toBe(500);
      expect((await res.json()).code).toBe("no_bot");
    });
  });

  describe(`${p.name}: the POST's kind validation`, () => {
    test("a known kind reaches the summarizer as a resolved preset", async () => {
      const res = await post(app(), p.path, { url: p.url, kind: "talk-notes" });
      expect(res.status).toBe(200);
      expect(p.calls()).toBe(1);
      expect(p.opts()?.preset?.id).toBe("talk-notes");
    });

    test("an ABSENT kind is `standard` — an older extension, or a curl", async () => {
      const res = await post(app(), p.path, { url: p.url });
      expect(res.status).toBe(200);
      expect(p.opts()?.preset?.id).toBe("standard");
    });

    for (const [label, kind] of [
      ["an unknown id", "bogus"],
      ["a PRESENT-but-blank string", "   "],
      ["a non-string", 7],
    ] as const) {
      test(`${label} is 400 bad_kind, above the listing read and above createJob`, async () => {
        const before = p.jobCount();
        const res = await post(app(), p.path, { url: p.url, kind });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe("bad_kind");
        // `error` is PROSE and `code` is the machine token — the shape a popup
        // renders as a sentence.
        expect(body.error).not.toContain("bad_kind");
        // Nothing was spent and nothing was left behind.
        expect(knowledgeApiCalls).toEqual([]);
        expect(p.calls()).toBe(0);
        expect(p.jobCount()).toBe(before);
      });
    }

    test("a kind this bot's connector cannot honour is refused, not silently downgraded", async () => {
      summarizerBot = { name: "olly", connector: "openai-compat", dir: "/tmp/olly" };
      botsResult = [summarizerBot];
      const res = await post(app(), p.path, { url: p.url, kind: "deep" });
      // Refused rather than run on the bot's own model and stamped `deep` — a
      // document lying about itself.
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_kind");
      expect(p.calls()).toBe(0);
    });
  });
}
