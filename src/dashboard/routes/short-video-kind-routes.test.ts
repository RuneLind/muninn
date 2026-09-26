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
 * It also holds the two POSTs' url host gates (TikTok and X video), for the same
 * reason: a refused url must be refused above the listing read and `createJob`.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test` and
 * `test:unit` chains) and MUST stay that way: `mock.module` here replaces
 * `bots/config.ts`, which a large share of the suite imports transitively.
 */

import { test, expect, describe, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { resolveCapturePresets } from "../../summaries/presets.ts";

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
let lastTikTokUrl: string | undefined;
let lastTikTokJobId: string | undefined;
mock.module("../../tiktok/summarizer.ts", () => ({
  summarizeTikTok: async (
    jobId: string,
    url: string,
    _title: string,
    _c: unknown,
    _b: unknown,
    opts?: { frames?: boolean; preset?: { id: string } },
  ) => {
    tiktokCalls++;
    lastTikTokOpts = opts;
    lastTikTokUrl = url;
    lastTikTokJobId = jobId;
  },
}));

let xVideoCalls = 0;
let lastXVideoOpts: { frames?: boolean; preset?: { id: string } } | undefined;
let lastXVideoUrl: string | undefined;
let lastXVideoTitle: string | undefined;
let lastXVideoJobId: string | undefined;
const realXVideo = await import("../../x-article/video.ts");
mock.module("../../x-article/video.ts", () => ({
  ...realXVideo,
  summarizeXVideo: async (
    jobId: string,
    url: string,
    title: string,
    _c: unknown,
    _b: unknown,
    opts?: { frames?: boolean; preset?: { id: string } },
  ) => {
    xVideoCalls++;
    lastXVideoOpts = opts;
    lastXVideoUrl = url;
    lastXVideoTitle = title;
    lastXVideoJobId = jobId;
  },
}));

const { registerTikTokRoutes } = await import("./tiktok-routes.ts");
const { registerXArticleRoutes, parseAllowedXStatusUrl } = await import("./x-article-routes.ts");
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
  lastTikTokUrl = undefined;
  lastTikTokJobId = undefined;
  lastXVideoOpts = undefined;
  lastXVideoUrl = undefined;
  lastXVideoTitle = undefined;
  lastXVideoJobId = undefined;
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
        capture: { supported: boolean; reason?: string };
      };
      expect(body.kinds.map((k) => k.id)).toEqual(["standard", "deep", "talk-notes"]);
      // Labelled rows, not bare ids — a client that had to name them would be a
      // second catalog nobody updates.
      expect(body.kinds[0]).toEqual({ id: "standard", label: "Standard" });
      // The default is NAMED rather than "the first entry", so no client has to
      // assume an order.
      expect(body.default_kind).toBe("standard");
      expect(body.frames).toEqual({ supported: true });
      // What the POST will actually do, said in the payload. On this bot it runs.
      expect(body.capture).toEqual({ supported: true });
      // CORS: the entry point is a Chrome extension whose muninnUrl is editable
      // past the manifest's localhost grant, so without this header the picker
      // silently falls back to Standard-only.
      expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    });

    test("a connector that cannot name the opus MODEL loses the deep kind", async () => {
      // `connectorRunsOpus` is what drops it here — an openai-compat endpoint
      // serves whatever model it serves, and a Claude id is a 400 from it. This
      // case says NOTHING about `requireThinkingControl`; the copilot one below
      // is the case that does.
      summarizerBot = { name: "olly", connector: "openai-compat", dir: "/tmp/olly" };
      botsResult = [summarizerBot];
      const body = (await (await app().request(p.optionsPath)).json()) as {
        kinds: { id: string }[];
        frames: { supported: boolean };
      };
      expect(body.kinds.map((k) => k.id)).toEqual(["standard", "talk-notes"]);
      expect(body.frames.supported).toBe(false);
    });

    /**
     * The `requireThinkingControl: true` this set passes
     * (`src/video/short-video-kinds.ts`), on the ONE connector that isolates it.
     *
     * `copilot-sdk` CAN name the opus model — `connectorRunsOpus` admits it, so
     * the model gate leaves `deep` in — and cannot honour a thinking budget, so
     * only the thinking gate can drop it. Every other connector is decided by
     * the model gate first, which is why flipping the flag survived the whole
     * suite until this case existed. The rationale for the narrowing lives on
     * the option's docblock in `src/summaries/presets.ts`.
     */
    test("a copilot bot loses `deep` to the THINKING gate, which nothing else tests", async () => {
      summarizerBot = { name: "copper", connector: "copilot-sdk", dir: "/tmp/copper" };
      botsResult = [summarizerBot];
      const body = (await (await app().request(p.optionsPath)).json()) as {
        kinds: { id: string }[];
        capture: { supported: boolean };
      };
      expect(body.kinds.map((k) => k.id)).toEqual(["standard", "talk-notes"]);
      // The model half is NOT what dropped it: this connector carries the opus
      // id verbatim, and the shared set (no narrowing) still offers `deep` here.
      expect(
        resolveCapturePresets(undefined, "copilot-sdk").map((k) => k.id),
      ).toEqual(["standard", "deep", "talk-notes"]);
      // …and the capture itself is refused on this bot, frames or no frames.
      expect(body.capture.supported).toBe(false);
    });

    /**
     * The payload and the POST agreeing.
     *
     * `frames: { supported: false }` reads as "no keyframes, but a capture",
     * and the POST 503s a connector without `supportsExtraDirs` UNCONDITIONALLY
     * — `frames: false` included, because the job hands `extraDirs` to
     * `executeOneShot` either way and that throws on such a connector. So the
     * payload says `capture: { supported: false }` with the reason, and a client
     * can grey out the button instead of discovering it at submit time.
     */
    test("a connector without extra-dirs says the CAPTURE is unsupported, with the reason", async () => {
      summarizerBot = { name: "olly", connector: "openai-compat", dir: "/tmp/olly" };
      botsResult = [summarizerBot];
      const body = (await (await app().request(p.optionsPath)).json()) as {
        frames: { supported: boolean };
        capture: { supported: boolean; reason?: string };
      };
      expect(body.frames.supported).toBe(false);
      expect(body.capture.supported).toBe(false);
      expect(body.capture.reason).toContain("olly");
      expect(body.capture.reason).toContain("openai-compat");
      // A sentence a popup can render, not a machine token.
      expect(body.capture.reason).not.toContain("frames_unsupported");
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
      // `null` is a SENT key with nothing in it — a picker that failed to fill,
      // exactly like the blank string — so it is refused rather than read as
      // absent. Matches `POST /api/youtube/summarize`.
      ["an explicit null", null],
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

    /**
     * The other half of the options payload's honesty: the 503 does not depend
     * on `frames`, which is why the payload names the CAPTURE rather than only
     * the keyframes.
     */
    test("a connector without extra-dirs 503s even with frames off", async () => {
      summarizerBot = { name: "olly", connector: "openai-compat", dir: "/tmp/olly" };
      botsResult = [summarizerBot];
      for (const body of [{ url: p.url }, { url: p.url, frames: false }]) {
        const res = await post(app(), p.path, body);
        expect(res.status).toBe(503);
        expect(p.calls()).toBe(0);
      }
    });
  });
}

/**
 * The TikTok POST's host gate (architecture review 2026-09, finding 12): the
 * url reaches yt-dlp, so anything but an https TikTok link is refused before a
 * listing read, a job row or the summarizer. The X-video twin is the next describe.
 */
describe("tiktok: the POST's url host gate", () => {
  const REFUSED = [
    "http://127.0.0.1:9/x",
    "http://localhost/internal/admin",
    "https://evil.example/@a/video/1",
    "http://www.tiktok.com/@a/video/7523456789",
    "https://eviltiktok.com/@a/video/7523456789",
    "https://www.tiktok.com.evil.example/@a/video/7523456789",
    "https://www.tiktok.com:8443/@a/video/7523456789",
    "https://user@www.tiktok.com/@a/video/7523456789",
    "file:///etc/passwd",
    "not a url",
    // Parser differentials (fix round 1): WHATWG reads `\` as `/` and so sees
    // host www.tiktok.com; yt-dlp (Python) splits userinfo at the last `@` and
    // connects to 127.0.0.1. Measured end to end before this fix.
    "https://www.tiktok.com\\@127.0.0.1:39872/x",
    "https://vm.tiktok.com\\@127.0.0.1:39872/x",
    // Strings WHATWG normalises onto an allowed URL: refused, not normalised.
    " https://www.tiktok.com/@a/video/7523456789",
    "https://www.tiktok.com/@a/video/7523456789\n",
    "https://www.tik\ttok.com/@a/video/7523456789",
    "https://www.tiktok.com/@a/vid eo/7523456789",
    "https://www\u0000.tiktok.com/@a/video/7523456789",
    "https://www%2Etiktok.com/@a/video/7523456789",
    "https:www.tiktok.com/@a/video/7523456789",
    "https:\\\\www.tiktok.com/@a/video/7523456789",
    "https://\uff57\uff57\uff57.tiktok.com/@a/video/7523456789",
    "https://:@www.tiktok.com/@a/video/7523456789",
    "https://www.tiktok.com:443/@a/video/7523456789",
  ];
  for (const url of REFUSED) {
    test(`refuses ${url} with 400 bad_url, before the listing read and createJob`, async () => {
      const jobsBefore = ttState.getRecentJobs(50).length;
      const res = await post(app(), "/api/tiktok/summarize", { url });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_url");
      expect(tiktokCalls).toBe(0);
      expect(knowledgeApiCalls).toEqual([]);
      expect(ttState.getRecentJobs(50).length).toBe(jobsBefore);
    });
  }

  const ACCEPTED = [
    "https://www.tiktok.com/@coolcoder/video/7523456789",
    "https://tiktok.com/@coolcoder/video/7523456789",
    "https://m.tiktok.com/v/7523456789.html",
  ];
  for (const url of ACCEPTED) {
    test(`accepts ${url}`, async () => {
      const res = await post(app(), "/api/tiktok/summarize", { url });
      expect(res.status).toBe(200);
      expect(tiktokCalls).toBe(1);
    });
  }

  test("hands the canonical href downstream, never the raw string", async () => {
    const raw = "https://WWW.TikTok.com/@coolcoder/./video/7523456789";
    const res = await post(app(), "/api/tiktok/summarize", { url: raw });
    expect(res.status).toBe(200);
    const href = "https://www.tiktok.com/@coolcoder/video/7523456789";
    expect(lastTikTokUrl).toBe(href);
    const job = ttState.getJob(lastTikTokJobId!)!;
    expect(job.url).toBe(href);
    expect(job.title).toBe(href);
  });
});

/**
 * The short-link HEAD's redirect target is re-judged by the same gate before a
 * dedup id is read off it (fix round 1). `extractTikTokVideoId` alone accepts
 * any host ending in `tiktok.com`, so `eviltiktok.com` used to yield an id.
 */
describe("tiktok: the short-link redirect target is re-gated", () => {
  const realFetch = globalThis.fetch;
  let redirectTo = "";
  beforeEach(() => {
    globalThis.fetch = (async () => ({ url: redirectTo }) as Response) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("a redirect off TikTok yields no dedup id", async () => {
    redirectTo = "https://eviltiktok.com/@a/video/7523456789";
    const res = await post(app(), "/api/tiktok/summarize", { url: "https://vm.tiktok.com/ZMabc123/" });
    expect(res.status).toBe(200);
    expect(knowledgeApiCalls).toEqual([]);
    expect(ttState.getJob(lastTikTokJobId!)!.videoId).toBe("");
  });

  test("a redirect onto TikTok still drives the dedup lookup", async () => {
    redirectTo = "https://www.tiktok.com/@a/video/7523456789";
    const res = await post(app(), "/api/tiktok/summarize", { url: "https://vm.tiktok.com/ZMabc123/" });
    expect(res.status).toBe(200);
    expect(knowledgeApiCalls.length).toBe(1);
    expect(ttState.getJob(lastTikTokJobId!)!.videoId).toBe("7523456789");
  });
});

/**
 * The X-video POST's host gate — the TikTok gate's twin, for the same parser
 * differential: the old gate (`extractXStatusId`) judged the WHATWG parse and
 * passed the RAW string to yt-dlp, so `https://x.com\@127.0.0.1:PORT/status/1`
 * made yt-dlp connect to loopback (measured 2026-09-26).
 */
describe("x-video: the POST's url host gate", () => {
  const S = "2081279674966044799";
  const REFUSED: unknown[] = [
    `https://x.com\\@127.0.0.1:39872/status/1`,
    `https://twitter.com\\@127.0.0.1:39872/a/status/${S}`,
    `https://x.com@127.0.0.1/status/1`,
    `https://127.0.0.1/x.com/status/1`,
    `https://x.com:8443/a/status/${S}`,
    `https://x.com:443/a/status/${S}`,
    `https://:@x.com/a/status/${S}`,
    `https://%78.com/a/status/${S}`,
    `https://\uff58.com/a/status/${S}`,
    `http://x.com/a/status/${S}`,
    ` https://x.com/a/status/${S}`,
    `https://x.com/a/status/${S} `,
    `https://x.com/a/status/${S}\n`,
    `https://x.c\tom/a/status/${S}`,
    `https://x.com/a/sta\ntus/${S}`,
    `https:x.com/a/status/${S}`,
    `https:\\\\x.com/a/status/${S}`,
    `https://mobile.x.com/a/status/${S}`,
    `https://x.com.evil.example/a/status/${S}`,
    `https://evil.com/?u=https://x.com/a/status/${S}`,
    `https://evil.com/#https://x.com/a/status/${S}`,
    `https://x.com/a?next=/status/${S}`,
    `https://x.com/a#/status/${S}`,
    `https://x.com/a/status/`,
    `https://x.com/a/status/12ab`,
    // The anchored path rule: only the shapes yt-dlp's TwitterIE matches.
    `https://x.com/status/${S}`,
    `https://x.com//status/${S}`,
    `https://x.com/a/b/status/${S}`,
    `https://x.com/i/events/123/status/20`,
    `https://x.com/i/cards/tfw/v1/999/status/20`,
    `https://x.com/i/redirect/status/1`,
    `https://x.com/http://127.0.0.1:39872/status/1`,
    `https://x.com/a/status/${"9".repeat(5000)}`,
    `https://x.com/a/status/${"1".repeat(21)}`,
    `file:///etc/passwd`,
    `not a url`,
    42,
    { href: `https://x.com/a/status/${S}` },
  ];
  for (const url of REFUSED) {
    test(`refuses ${(JSON.stringify(url) ?? "").slice(0, 100)} with 400 bad_url, before the listing read and createJob`, async () => {
      const jobsBefore = xaState.getRecentJobs(50).length;
      const res = await post(app(), "/api/x-articles/summarize-video", { url });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_url");
      expect(xVideoCalls).toBe(0);
      expect(knowledgeApiCalls).toEqual([]);
      expect(xaState.getRecentJobs(50).length).toBe(jobsBefore);
    });
  }

  // What the X extension sends (content.js: `${origin}/${user}/status/${id}`,
  // on x.com or twitter.com) plus what a reader pastes from the tab: the
  // `/video/1` media slot, a `?s=20` share query, a fragment, `www.`, and an
  // upper-case scheme and host, which are normalised rather than refused.
  const ACCEPTED: Array<[string, string]> = [
    [`https://x.com/coolcoder/status/${S}`, `https://x.com/coolcoder/status/${S}`],
    [`https://twitter.com/coolcoder/status/${S}`, `https://twitter.com/coolcoder/status/${S}`],
    [`https://www.x.com/coolcoder/status/${S}`, `https://www.x.com/coolcoder/status/${S}`],
    [`https://www.twitter.com/coolcoder/status/${S}`, `https://www.twitter.com/coolcoder/status/${S}`],
    [`https://x.com/coolcoder/status/${S}/video/1`, `https://x.com/coolcoder/status/${S}/video/1`],
    [`https://x.com/coolcoder/status/${S}?s=20`, `https://x.com/coolcoder/status/${S}?s=20`],
    [`https://x.com/coolcoder/status/${S}#m`, `https://x.com/coolcoder/status/${S}#m`],
    [`https://x.com/i/web/status/${S}`, `https://x.com/i/web/status/${S}`],
    [`https://x.com/i/status/${S}`, `https://x.com/i/status/${S}`],
    [`https://x.com/coolcoder/status/${S}/photo/1`, `https://x.com/coolcoder/status/${S}/photo/1`],
    [`https://x.com/coolcoder/status/${S}/analytics`, `https://x.com/coolcoder/status/${S}/analytics`],
    [`https://x.com/coolcoder/status/${"1".repeat(20)}`, `https://x.com/coolcoder/status/${"1".repeat(20)}`],
    // Two rows where href differs from the raw string, so "href, not raw, goes
    // downstream" rests on more than one normalisation.
    [`HTTPS://X.COM/coolcoder/status/${S}`, `https://x.com/coolcoder/status/${S}`],
    [`https://x.com/用户/status/${S}`, `https://x.com/%E7%94%A8%E6%88%B7/status/${S}`],
  ];
  for (const [raw, href] of ACCEPTED) {
    test(`accepts ${raw} and hands ${href} to every consumer`, async () => {
      const res = await post(app(), "/api/x-articles/summarize-video", { url: raw });
      expect(res.status).toBe(200);
      expect(xVideoCalls).toBe(1);
      expect(knowledgeApiCalls.length).toBe(1);
      expect(lastXVideoUrl).toBe(href);
      expect(lastXVideoTitle).toBe(href);
      const job = xaState.getJob(lastXVideoJobId!)!;
      expect(job.url).toBe(href);
      expect(job.title).toBe(href);
    });
  }

  test("reads the status id off the pathname", () => {
    expect(parseAllowedXStatusUrl(`https://x.com/a/status/${S}/video/1?s=20`)?.statusId).toBe(S);
    expect(parseAllowedXStatusUrl(`https://x.com/a?next=/status/${S}`)).toBeNull();
  });
});
