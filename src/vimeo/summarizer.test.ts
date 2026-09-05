/**
 * Vimeo summarizer — the capture job itself.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains) and MUST stay that way: `mock.module` here replaces `../ai/one-shot.ts`
 * and `../gardener/source-drafter-run.ts`, which a large share of the suite
 * imports transitively — mocking them inside a shared chunk breaks export
 * resolution in unrelated files. That is also why the chains name the four PR-1
 * `src/vimeo/*.test.ts` files plus `state.test.ts` explicitly instead of the
 * `src/vimeo/` directory: the directory glob would sweep this file into the
 * first chunk.
 */
import { test, expect, beforeEach, beforeAll, afterEach, mock } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { VimeoCaptions } from "./captions.ts";
import { CAPTURE_DEEP_MODEL, SHIPPED_CAPTURE_PRESETS } from "../summaries/presets.ts";

const VIDEO_ID = "1223358361";
const CANONICAL = "https://vimeo.com/1223358361";

let claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
let lastSystemPrompt: string | undefined;
let lastPrompt: string | undefined;

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    b: { model?: string },
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
    lastRunModel = b.model;
    lastThinking = opts?.thinkingMaxTokens;
    lastExtraDirs = opts?.extraDirs;
    lastTimeoutMs = opts?.timeoutMs;
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  connectorCapabilities: () => ({ supportsExtraDirs: true, supportsThinkingBudget: true }),
}));

/** The model the connector was handed, and the thinking cap it was (or was not) given. */
let lastRunModel: string | undefined;
let lastThinking: number | undefined;
let lastExtraDirs: string[] | undefined;
let lastTimeoutMs: number | undefined;
let sourceDraftCalls: Array<Record<string, unknown>> = [];
let sourceDraftThrows: Error | null = null;
mock.module("../gardener/source-drafter-run.ts", () => ({
  triggerSourceDraftFromCapture: (_bot: unknown, input: Record<string, unknown>) => {
    sourceDraftCalls.push(input);
    // The real function's first statements are synchronous (`isWikiReadonly`,
    // `isReadonlyWikiRoot`), so it CAN throw on the caller's stack.
    if (sourceDraftThrows) throw sourceDraftThrows;
  },
}));

/**
 * The BROWSER, refused at the door, so "the stub was refused" is observable.
 *
 * A refused `VIMEO_HARVEST_STUB` falls back to `REAL_DEPS`, whose harvest
 * launches a headless Chromium — the wrong thing to do in a unit test, and also
 * exactly the signal the memo-binding cases below need.
 *
 * The seam is `playwright-core`, deliberately NOT `./captions.ts`. Mocking the
 * module would be the obvious move and it is wrong twice over: `bun test
 * src/vimeo/` runs this file in the same process as `captions.test.ts`, whose
 * whole subject is `harvestVimeoCaptions` — measured, mocking it there reds 14
 * of that file's cases. `harvestVimeoCaptions` takes `opts.launcher` and falls
 * back to `await import("playwright-core")` only when none is given, and
 * `captions.test.ts` passes one in EVERY case, so this mock is invisible to it
 * while still being the only door `REAL_DEPS` can reach the browser through.
 */
let realHarvestCalls = 0;
const REAL_HARVEST_MARKER = "no browser in this test";
mock.module("playwright-core", () => ({
  chromium: {
    launch: async () => {
      realHarvestCalls++;
      throw new Error(REAL_HARVEST_MARKER);
    },
  },
}));

let ingestPayload: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;
function installFetchMock() {
  // @ts-expect-error — a minimal Response stand-in is all the summarizer reads.
  globalThis.fetch = async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/vimeo/ingest")) {
      ingestPayload = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ similar: [], file_path: "ai/rag/Trust but verify.md" }),
        text: async () => "{}",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
}

const {
  summarizeVimeo,
  AUTO_CAPTION_RIDER,
  NO_CAPTIONS_ERROR,
  VIMEO_COLLECTION,
  resolveHarvestStubDeps,
  stubCacheKey,
} = await import("./summarizer.ts");
const { createJob, getJob, subscribe } = await import("./state.ts");

const config = { knowledgeApiUrl: "http://kb.test", claudeTimeoutMs: 120_000 } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

const [STANDARD, DEEP, TALK_NOTES] = SHIPPED_CAPTURE_PRESETS as [
  (typeof SHIPPED_CAPTURE_PRESETS)[number],
  (typeof SHIPPED_CAPTURE_PRESETS)[number],
  (typeof SHIPPED_CAPTURE_PRESETS)[number],
];

const META = {
  videoId: VIDEO_ID,
  url: CANONICAL,
  title: "Trust but verify",
  durationSec: 3180,
  uploadDate: "2026-08-20 09:33:04",
  author: "JavaZone",
  thumbnailUrl: "https://i.vimeocdn.com/video/x-1280x720.jpg",
  speaker: "Ola Nordmann",
  // The route's defaults: the standard kind, in the talk's own language.
  preset: STANDARD,
  lang: "talk" as const,
  frames: false,
};

const NORWEGIAN_AUTO_TRACK = {
  lang: "no-x-autogen",
  label: "Norwegian (auto-generated)",
  vttUrl: "https://captions.vimeo.com/captions/no.vtt?sig=z",
};

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello and welcome to the talk.

00:02:30.000 --> 00:02:34.000
Now the demo.
`;

function captionsWith(tracks: VimeoCaptions["tracks"]): VimeoCaptions {
  return { videoId: VIDEO_ID, title: "", durationSec: 0, tracks };
}

const AUTO_TRACK = {
  lang: "en-x-autogen",
  label: "English (auto-generated)",
  vttUrl: "https://captions.vimeo.com/captions/a.vtt?sig=x",
};
const MANUAL_TRACK = {
  lang: "en",
  label: "English",
  vttUrl: "https://captions.vimeo.com/captions/m.vtt?sig=y",
};

function deps(over: Partial<{ tracks: VimeoCaptions["tracks"]; vtt: string }> = {}) {
  return {
    harvest: async () => captionsWith(over.tracks ?? [AUTO_TRACK]),
    downloadVtt: async () => over.vtt ?? VTT,
  };
}

/** Every warn this module logs, so the stub's per-capture line can be counted. */
let warns: LogRecord[] = [];
beforeAll(async () => {
  await configure({
    sinks: {
      capture: (r: LogRecord) => {
        if (r.category.join(".") === "muninn.vimeo.summarizer" && r.level === "warning") {
          warns.push(r);
        }
      },
    },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
});

beforeEach(() => {
  claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
  lastSystemPrompt = undefined;
  lastPrompt = undefined;
  lastRunModel = undefined;
  lastThinking = undefined;
  lastExtraDirs = undefined;
  lastTimeoutMs = undefined;
  manifestFetches = [];
  extractCalls = [];
  lastHarvestOpts = undefined;
  framesRoot = mkdtempSync(join(tmpdir(), "vimeo-frames-root-"));
  ingestPayload = undefined;
  sourceDraftCalls = [];
  sourceDraftThrows = null;
  warns = [];
  delete process.env.VIMEO_HARVEST_STUB;
  delete process.env.MUNINN_PROFILE;
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.VIMEO_HARVEST_STUB;
  delete process.env.MUNINN_PROFILE;
});

test("the happy path walks harvesting_captions → summarizing → ingesting → complete", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  const statuses: string[] = [];
  subscribe(jobId, (e) => { if (e.type === "status") statuses.push(e.status); });

  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(statuses).toEqual(["harvesting_captions", "summarizing", "ingesting"]);
  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.category).toBe("ai/rag");
});

test("the prompt is the windowed transcript, headed with absolute timestamps", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(lastPrompt).toContain("### [00:00:00]");
  expect(lastPrompt).toContain("Hello and welcome to the talk.");
  // The second cue is at 2:30, so it opens the 120s window at 00:02:00.
  expect(lastPrompt).toContain("### [00:02:00]");
});

test("the ingest body carries the canonical url, the transcript and the caption provenance", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(ingestPayload!.url).toBe(CANONICAL);
  expect(ingestPayload!.caption_lang).toBe("en-x-autogen");
  expect(ingestPayload!.caption_kind).toBe("auto");
  expect(ingestPayload!.duration_sec).toBe(3180);
  // The capture date, never oEmbed's upload_date (META carries 2026-08-20): the
  // shelf buckets on `date`, and the upload date filed a fresh capture under an
  // old week.
  expect(ingestPayload!.date).toBe(new Date().toISOString().split("T")[0]);
  expect(String(ingestPayload!.transcript_markdown)).toContain("### [00:00:00]");
  expect(ingestPayload!.summary).not.toContain("Hello and welcome");
});

test("the source-draft trigger keys off huginn's stored doc id and the vimeo collection", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(sourceDraftCalls.length).toBe(1);
  expect(sourceDraftCalls[0]!.collection).toBe(VIMEO_COLLECTION);
  expect(sourceDraftCalls[0]!.docId).toBe("ai/rag/Trust but verify.md");
  expect(sourceDraftCalls[0]!.url).toBe(CANONICAL);
});

// --- oEmbed metadata on the document (v2 PR 2) --------------------------------

test("the ingest body carries author, upload_date, speaker and thumbnail_url from the route's meta", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(ingestPayload!.author).toBe("JavaZone");
  expect(ingestPayload!.upload_date).toBe("2026-08-20 09:33:04");
  expect(ingestPayload!.speaker).toBe("Ola Nordmann");
  expect(ingestPayload!.thumbnail_url).toBe("https://i.vimeocdn.com/video/x-1280x720.jpg");
  // `date` stays the capture day — the upload date is its own key.
  expect(ingestPayload!.date).not.toBe("2026-08-20 09:33:04");
});

test("an empty oEmbed field is an ABSENT key, never an empty string on the document", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  const { speaker: _s, ...noSpeaker } = META;
  await summarizeVimeo(jobId, { ...noSpeaker, author: "", thumbnailUrl: "", uploadDate: "" }, config, bot, deps());

  expect(ingestPayload).not.toHaveProperty("author");
  expect(ingestPayload).not.toHaveProperty("upload_date");
  expect(ingestPayload).not.toHaveProperty("speaker");
  expect(ingestPayload).not.toHaveProperty("thumbnail_url");
});

// --- Kind + language (v2 PR 1) ----------------------------------------------

test("`talk` on a Norwegian track writes the summary in bokmål and stamps summary_lang: nb", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps({ tracks: [NORWEGIAN_AUTO_TRACK] }));

  expect(lastSystemPrompt).toContain("LANGUAGE: write the summary in Norwegian (bokmål)");
  expect(lastSystemPrompt).not.toContain("write the summary in English");
  expect(ingestPayload!.summary_lang).toBe("nb");
  expect(ingestPayload!.summary_kind).toBe("standard");
  expect(ingestPayload!.caption_lang).toBe("no-x-autogen");
});

test("`talk` on an English track writes English, stated explicitly", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(lastSystemPrompt).toContain("LANGUAGE: write the summary in English");
  expect(ingestPayload!.summary_lang).toBe("en");
});

test("an explicit language pick beats the track: `en` on a Norwegian talk", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, lang: "en" }, config, bot, deps({ tracks: [NORWEGIAN_AUTO_TRACK] }));

  expect(lastSystemPrompt).toContain("LANGUAGE: write the summary in English");
  expect(ingestPayload!.summary_lang).toBe("en");
});

test("the language rider comes LAST — after the structure and after the auto-caption rider", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, lang: "nb" }, config, bot, deps());

  const sys = lastSystemPrompt!;
  const structureAt = sys.indexOf("## Key takeaways");
  const autoAt = sys.indexOf(AUTO_CAPTION_RIDER.trim());
  const langAt = sys.indexOf("LANGUAGE:");
  expect(structureAt).toBeGreaterThan(-1);
  expect(autoAt).toBeGreaterThan(structureAt);
  expect(langAt).toBeGreaterThan(autoAt);
  expect(sys.trim().endsWith("translate the prose around them, not them.")).toBe(true);
});

test("the standard kind is the capped call on the bot's own model, with the shared structure", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(lastRunModel).toBe("sonnet");
  expect(lastThinking).toBe(8000);
  expect(lastSystemPrompt).toContain("- Then a `## Key takeaways` section FIRST");
  expect(lastSystemPrompt).not.toContain("## Timeline");
});

test("the deep kind swaps in the opus model and lifts the thinking cap", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, preset: DEEP }, config, bot, deps());

  expect(lastRunModel).toBe(CAPTURE_DEEP_MODEL);
  // `null` on the seam means "inherit the bot's budget": no cap is passed.
  expect(lastThinking).toBeUndefined();
  expect(ingestPayload!.summary_kind).toBe("deep");
  expect(warns.map((w) => String(w.message))).not.toContainEqual(expect.stringContaining("opus"));
});

test("deep on a connector outside the Anthropic namespace keeps the bot's model and says so", async () => {
  const ollama = { ...bot, connector: "openai-compat", model: "qwen3.5:35b" } as unknown as BotConfig;
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, preset: DEEP }, config, ollama, deps());

  expect(lastRunModel).toBe("qwen3.5:35b");
  expect(getJob(jobId)!.status).toBe("complete");
  const opusWarn = warns.find((w) => String(w.message).includes("asks for the opus model"));
  expect(opusWarn).toBeDefined();
  expect(opusWarn!.properties).toMatchObject({ kind: "deep", connector: "openai-compat", model: "qwen3.5:35b" });
});

test("the talk-notes kind puts the timeline structure in the prompt and stamps summary_kind", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, preset: TALK_NOTES }, config, bot, deps());

  expect(lastSystemPrompt).toContain("## Timeline");
  expect(lastSystemPrompt).toContain("### [HH:MM:SS]");
  // Indented under step 3 like the shared bullets, so the envelope reads as one list.
  expect(lastSystemPrompt).toContain("\n   - Then a `## Timeline` section");
  expect(lastRunModel).toBe("sonnet");
  expect(lastThinking).toBe(8000);
  expect(ingestPayload!.summary_kind).toBe("talk-notes");
});

test("a per-bot kind runs with its own instruction, verbatim", async () => {
  const custom = { id: "should-i-watch", label: "Should I watch?", instruction: "- Five lines only.", run: STANDARD.run };
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, preset: custom }, config, bot, deps());

  expect(lastSystemPrompt).toContain("3. Then write a structured summary with:\n   - Five lines only.");
  expect(lastSystemPrompt).not.toContain("## Key takeaways");
  expect(ingestPayload!.summary_kind).toBe("should-i-watch");
});

// --- The onIngested hook -----------------------------------------------------
//
// The route's dedup has FOUR states to cover and this hook owns the third:
// ingested here, not yet in huginn's `/documents` listing (which is derived from
// an index the background reindex rebuilds seconds to minutes later). This is
// the only moment in the process that knows a document now exists, so the route
// cannot learn it any other way — measured, a re-POST inside that window ran a
// whole second capture.

test("a successful ingest hands the caller huginn's own doc id, before the job completes", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  const seen: Array<[string, string, string]> = [];

  await summarizeVimeo(jobId, META, config, bot, deps(), (videoId, documentId) => {
    // The job's status AT CALL TIME rides along: the hook has to fire before
    // the terminal transition, or a re-POST racing the completion event finds
    // nothing recorded.
    seen.push([videoId, documentId, getJob(jobId)!.status]);
  });

  expect(seen).toEqual([[VIDEO_ID, "ai/rag/Trust but verify.md", "ingesting"]]);
  expect(getJob(jobId)!.status).toBe("complete");
});

test("an ingest huginn refused tells the hook NOTHING", async () => {
  // `ingestSummary` reports a `file_path` only on an ok response, so there is no
  // document to name — and naming one anyway would make the route answer
  // `duplicate` for a document that exists nowhere, for the whole TTL.
  // @ts-expect-error — a minimal Response stand-in is all the summarizer reads.
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
    text: async () => "",
  });
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  let calls = 0;

  await summarizeVimeo(jobId, META, config, bot, deps(), () => { calls++; });

  expect(calls).toBe(0);
  expect(getJob(jobId)!.status).toBe("complete");
});

test("an onIngested hook that THROWS leaves the job COMPLETE", async () => {
  // The same rule as the source-draft trigger: the hook runs on the capture's
  // stack after a successful ingest, and the job store has no guard against a
  // second terminal transition — so an unguarded throw would reach the job's
  // catch and turn a finished capture's card from complete into error.
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);

  await summarizeVimeo(jobId, META, config, bot, deps(), () => {
    throw new Error("the route's map blew up");
  });

  expect(getJob(jobId)!.status).toBe("complete");
  // And the tail after it still ran.
  expect(sourceDraftCalls.length).toBe(1);
});

test("an AUTO caption track appends the proper-noun rider", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps({ tracks: [AUTO_TRACK] }));

  expect(lastSystemPrompt).toContain(AUTO_CAPTION_RIDER.trim());
});

test("a MANUAL caption track does NOT append the rider", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps({ tracks: [MANUAL_TRACK] }));

  expect(lastSystemPrompt).toBeDefined();
  expect(lastSystemPrompt).not.toContain(AUTO_CAPTION_RIDER.trim());
  expect(lastSystemPrompt).not.toContain("MACHINE-GENERATED");
  expect(ingestPayload!.caption_kind).toBe("manual");
});

test("no usable track fails the job with the stable no_captions code and never calls the model", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, {
    harvest: async () => captionsWith([]),
    downloadVtt: async () => { throw new Error("must not download"); },
  });

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(job.error).toBe(NO_CAPTIONS_ERROR);
  expect(lastPrompt).toBeUndefined();
  expect(ingestPayload).toBeUndefined();
});

test("a VTT with no cues is no_captions, not an empty summary", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps({ vtt: "WEBVTT\n\n" }));

  expect(getJob(jobId)!.error).toBe(NO_CAPTIONS_ERROR);
  expect(lastPrompt).toBeUndefined();
});

test("a harvest failure lands on the job rather than throwing", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, {
    harvest: async () => { throw new Error("Vimeo answered its bot-detection page"); },
    downloadVtt: async () => VTT,
  });

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(job.error).toContain("bot-detection");
});

test("the private hash reaches the harvester when the ref carries one", async () => {
  let seenHash: string | undefined;
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, hash: "abc1234567" }, config, bot, {
    harvest: async (_id, opts) => { seenHash = opts.hash; return captionsWith([AUTO_TRACK]); },
    downloadVtt: async () => VTT,
  });

  expect(seenHash).toBe("abc1234567");
});

// --- Acceptance 9: ONE Chromium at a time -----------------------------------

test("two concurrent jobs harvest STRICTLY one at a time", async () => {
  // The overlap recorder: each stub harvest marks itself in-flight and asserts
  // nothing else already is. Without the module-level queue both jobs launch a
  // Chromium in the same tick.
  //
  // The scaffolding is the sibling case's, for the reason stated there: the
  // harvests park on the MODULE-level `harvestQueue`, so a parked harvest that
  // is never released does not fail this case — it wedges the queue for the rest
  // of the FILE. Two probes, both measured on this file rather than reasoned:
  //
  //  - a 40-turn delay injected ahead of `harvestQueue.run` used to produce
  //    EIGHT failures in 35.0 s, seven of them under unrelated names (the file
  //    wedged and the rest timed out at 5 s each). With the START SIGNAL below
  //    replacing the first guessed wait, the same probe produces ZERO failures
  //    in 0.04 s — the case simply waits for the harvest it is about.
  //  - the `finally` covers the other half, a case that genuinely FAILS with
  //    harvests still parked. Forcing the negative assertion below to fail
  //    (`toBe(999)`) strands harvest A parked and B queued behind it: with the
  //    drain that is ONE failure in well under a second; without it, every
  //    case queued behind the stranded harvests times out at 5 s each (8 of
  //    them when this drain was written, 11 once the memo cases joined the file).
  //    NB deleting the queue does NOT demonstrate this — measured 2 failures in
  //    0.07 s either way, because with no queue there is nothing left for a
  //    stranded harvest to block.
  //
  // So the signal keeps this case from failing spuriously and the drain keeps
  // its failure from becoming the file's.
  let inFlight = 0;
  let maxInFlight = 0;
  let parkingOpen = true;
  const releases: Array<() => void> = [];
  let startCount = 0;
  let startWaiters: Array<{ n: number; resolve: () => void }> = [];

  /** Resolves once `n` harvests have ENTERED (already resolved if they have). */
  function harvestStarted(n: number): Promise<void> {
    if (startCount >= n) return Promise.resolve();
    return new Promise<void>((resolve) => { startWaiters.push({ n, resolve }); });
  }

  const slowHarvest = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    startCount++;
    const due = startWaiters.filter((w) => startCount >= w.n);
    startWaiters = startWaiters.filter((w) => startCount < w.n);
    for (const w of due) w.resolve();
    // No await between the read and the push: a harvest either parks or is waved
    // through, never both and never neither.
    if (parkingOpen) await new Promise<void>((resolve) => { releases.push(resolve); });
    inFlight--;
    return captionsWith([AUTO_TRACK]);
  };
  const slowDeps = { harvest: slowHarvest, downloadVtt: async () => VTT };

  const jobA = createJob(VIDEO_ID, "A", CANONICAL);
  const jobB = createJob("1223642971", "B", "https://vimeo.com/1223642971");
  const runA = summarizeVimeo(jobA, META, config, bot, slowDeps);
  const runB = summarizeVimeo(jobB, { ...META, videoId: "1223642971" }, config, bot, slowDeps);

  try {
    await harvestStarted(1);

    // The one guessed wait that STAYS, because the assertion under it is a
    // NEGATIVE one and no signal can announce a harvest that never starts: give
    // job B every chance to reach the harvester, then require that it did not.
    // 20 turns is far past the ~4 the job needs to get from its own entry to
    // `harvestQueue.run` — a mutex-free build reaches it inside 1.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(inFlight).toBe(1);
    expect(startCount).toBe(1);

    releases[0]!();
    await harvestStarted(2);
    releases[1]!();

    await Promise.all([runA, runB]);

    expect(maxInFlight).toBe(1);
    // Both jobs really ran — a mutex that dropped one would also pass maxInFlight.
    expect(getJob(jobA)!.status).toBe("complete");
    expect(getJob(jobB)!.status).toBe("complete");
  } finally {
    parkingOpen = false;
    for (const release of releases.splice(0)) release();
    await Promise.allSettled([runA, runB]);
  }
});

test("a QUEUED job stays pending — it reports harvesting only when its harvest starts", async () => {
  // `updateStatus` fired before `harvestQueue.run`, so the second job announced
  // a Chromium that was not running — for as long as the first harvest took
  // (up to the 60 s budget, and stacking with every further queued job).
  //
  // TWO things about the scaffolding are load-bearing, both learned the hard
  // way in this file:
  //
  //  - the harvests are released in a `finally`. `harvestQueue` is MODULE-level
  //    and shared with every other test here, so a parked harvest that is never
  //    released does not fail this test — it wedges the queue for the rest of
  //    the FILE, and the run reports five 5 s timeouts under unrelated names.
  //    `parkingOpen` closes the door for harvests that have not started yet, so
  //    the drain cannot miss one that parks after the loop.
  //  - the test waits on a SIGNAL the stub harvest raises when it STARTS, not
  //    on a fixed number of microtask turns. `for (i < 20) await
  //    Promise.resolve()` is a guess about how many awaits the code under test
  //    performs before it gets there, which is exactly the thing this test is
  //    allowed to change.
  let parkingOpen = true;
  const releases: Array<() => void> = [];
  let startCount = 0;
  let startWaiters: Array<{ n: number; resolve: () => void }> = [];

  /** Resolves once `n` harvests have ENTERED (already resolved if they have). */
  function harvestStarted(n: number): Promise<void> {
    if (startCount >= n) return Promise.resolve();
    return new Promise<void>((resolve) => { startWaiters.push({ n, resolve }); });
  }

  const slowDeps = {
    harvest: async () => {
      startCount++;
      const due = startWaiters.filter((w) => startCount >= w.n);
      startWaiters = startWaiters.filter((w) => startCount < w.n);
      for (const w of due) w.resolve();
      // No await between the read and the push: a harvest either parks or is
      // waved through, never both and never neither.
      if (parkingOpen) await new Promise<void>((resolve) => { releases.push(resolve); });
      return captionsWith([AUTO_TRACK]);
    },
    downloadVtt: async () => VTT,
  };

  const jobA = createJob(VIDEO_ID, "A", CANONICAL);
  const jobB = createJob("1223642971", "B", "https://vimeo.com/1223642971");
  const runA = summarizeVimeo(jobA, META, config, bot, slowDeps);
  const runB = summarizeVimeo(jobB, { ...META, videoId: "1223642971" }, config, bot, slowDeps);

  try {
    await harvestStarted(1);
    expect(getJob(jobA)!.status).toBe("harvesting_captions");
    expect(getJob(jobB)!.status).toBe("pending");

    releases[0]!();
    await harvestStarted(2);
    expect(getJob(jobB)!.status).toBe("harvesting_captions");

    releases[1]!();
    await Promise.all([runA, runB]);
    expect(getJob(jobB)!.status).toBe("complete");
  } finally {
    parkingOpen = false;
    for (const release of releases.splice(0)) release();
    await Promise.allSettled([runA, runB]);
  }
});

// --- VIMEO_HARVEST_STUB: three gates, all required ---------------------------

test("the stub is REFUSED on a non-default serving profile", async () => {
  const path = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  expect(
    await resolveHarvestStubDeps({ VIMEO_HARVEST_STUB: path, MUNINN_PROFILE: "nais" }),
  ).toBeNull();
});

test("the stub is REFUSED for a relative path", async () => {
  expect(
    await resolveHarvestStubDeps({ VIMEO_HARVEST_STUB: "src/vimeo/fixtures/x.vtt" }),
  ).toBeNull();
});

test("the stub is REFUSED when the file does not exist", async () => {
  expect(
    await resolveHarvestStubDeps({ VIMEO_HARVEST_STUB: "/nonexistent/absolutely-not.vtt" }),
  ).toBeNull();
});

test("the memo key separates a path holding a SPACE from a profile", () => {
  // Both witnesses below are pairs a SPACE separator maps to one key, so
  // whichever configuration asks first decides for the other — and the memo
  // hands back deps, i.e. the stub RUNS where it should have been refused.
  // Derived, not sampled: `path + SEP + profile` collides exactly when the
  // profile contributes the separator, so with SEP=" " a profile that carries
  // a space is the whole collision class, and both reachable shapes of that are
  // pinned here. NUL is the one byte a path cannot contain, so there is no
  // such shape for it.
  //
  // (1) an untrimmed `MUNINN_PROFILE` — `resolveServingProfile` trims, so
  //     "nais " really is a nais process, and it must refuse the stub.
  expect(stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/x nais" })).not.toBe(
    stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/x", MUNINN_PROFILE: "nais " }),
  );
  // (2) an INVALID profile, which must throw rather than resolve to anything —
  //     the fail-open direction, and the worse of the two.
  expect(stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/a b", MUNINN_PROFILE: "c" })).not.toBe(
    stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/a", MUNINN_PROFILE: "b c" }),
  );
  // Trimming is part of the key, not of the caller: two spellings of ONE
  // configuration must still share an answer.
  expect(stubCacheKey({ VIMEO_HARVEST_STUB: "  /tmp/x  ", MUNINN_PROFILE: "nais" })).toBe(
    stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/x", MUNINN_PROFILE: "nais" }),
  );
  // And an absent profile is not a different configuration from a blank one.
  expect(stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/x" })).toBe(
    stubCacheKey({ VIMEO_HARVEST_STUB: "/tmp/x", MUNINN_PROFILE: "" }),
  );
});

test("an unset stub resolves to null (the real deps stay)", async () => {
  expect(await resolveHarvestStubDeps({})).toBeNull();
  expect(await resolveHarvestStubDeps({ VIMEO_HARVEST_STUB: "   " })).toBeNull();
});

test("an absolute, existing fixture on the default profile serves one auto track", async () => {
  const path = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  const stub = (await resolveHarvestStubDeps({ VIMEO_HARVEST_STUB: path }))!;
  expect(stub).not.toBeNull();

  const captions = await stub.harvest(VIDEO_ID, {});
  expect(captions.tracks.length).toBe(1);
  expect(captions.tracks[0]!.lang).toBe("en-x-autogen");
  const vtt = await stub.downloadVtt(captions.tracks[0]!.vttUrl);
  expect(vtt.startsWith("WEBVTT")).toBe(true);
});

test("the stub drives a whole capture with no browser and no live Vimeo", async () => {
  process.env.VIMEO_HARVEST_STUB = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);

  // No `deps` argument at all: the stub must replace the REAL harvest, which
  // would otherwise launch Chromium against vimeo.com.
  await summarizeVimeo(jobId, META, config, bot);

  expect(getJob(jobId)!.status).toBe("complete");
  // The DOCUMENT says it was stubbed. The track is `-x-autogen`, so the prompt
  // still gets the auto rider — but a document written off a local file must
  // never be indistinguishable from one harvested off vimeo.com.
  expect(ingestPayload!.caption_kind).toBe("stub");
  expect(String(ingestPayload!.transcript_markdown)).toContain("### [00:00:00]");
});

test("an explicit deps argument still beats the stub", async () => {
  process.env.VIMEO_HARVEST_STUB = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, META, config, bot, deps({ tracks: [MANUAL_TRACK] }));

  expect(ingestPayload!.caption_kind).toBe("manual");
});

test("EVERY stubbed capture warns, naming the fixture and the job", async () => {
  const path = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  process.env.VIMEO_HARVEST_STUB = path;

  const jobA = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobA, META, config, bot);
  const jobB = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobB, META, config, bot);

  // Two captures, two lines — the once-per-value dedup made a long-running dev
  // server say this once and then never again, while every later capture was
  // just as stubbed.
  expect(warns.length).toBe(2);
  expect(warns.map((w) => w.properties.jobId)).toEqual([jobA, jobB]);
  for (const w of warns) {
    expect(w.properties.path).toBe(path);
    expect(w.message.join("")).toContain("VIMEO_HARVEST_STUB");
  }
});

// --- The MEMO is bound to `stubCacheKey`, not merely adjacent to it ---------
//
// `stubCacheKey` has its own unit test above, and it passes against a memo that
// never calls it: `harvestStub` could inline any key at all and the whole suite
// stayed green. These three cases drive the MEMO — two `summarizeVimeo` calls in
// one process at two configurations — and each kills a different way of getting
// the key wrong. The observable is deliberately coarse and unfakeable: either
// the capture ran off the local fixture (`caption_kind: "stub"`, and WHICH
// fixture, from the transcript) or the stub was refused and `REAL_DEPS` reached
// the mocked harvester.
//
// The stub's own gates are what make the second configuration observable: a
// non-default profile REFUSES, so a memo that hands back the first
// configuration's answer runs the backdoor on a nais process — which is the
// whole reason this is worth a test rather than a comment.

/** A temp dir, so a path can carry a SPACE without editing the repo. */
let memoDir = "";
beforeAll(async () => {
  memoDir = await mkdtemp(join(tmpdir(), "muninn-vimeo-memo-"));
});

/** The same VTT shape as the fixture, with a caller-chosen marker line. */
function markerVtt(marker: string): string {
  return `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${marker}\n`;
}

test("the memo does not serve a space-colliding (path, profile) pair one answer", async () => {
  // Witness (1) from the key's own test, driven through the memo this time:
  // `<dir>/x nais` with NO profile and `<dir>/x` with MUNINN_PROFILE="nais " are
  // one key under a SPACE separator (`resolveServingProfile` trims, so "nais "
  // really is a nais process). The paths differ, so this is the one case a
  // path-only key would survive and the separator is what it is about.
  const spaced = join(memoDir, "x nais");
  await Bun.write(spaced, markerVtt("spaced fixture"));

  process.env.VIMEO_HARVEST_STUB = spaced;
  const first = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(first, META, config, bot);
  expect(getJob(first)!.status).toBe("complete");
  expect(ingestPayload!.caption_kind).toBe("stub");

  process.env.VIMEO_HARVEST_STUB = join(memoDir, "x");
  process.env.MUNINN_PROFILE = "nais ";
  const before = realHarvestCalls;
  const second = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(second, META, config, bot);

  // Refused on the profile ⇒ REAL deps ⇒ the mocked harvester ran and threw.
  expect(realHarvestCalls).toBe(before + 1);
  expect(getJob(second)!.status).toBe("error");
  expect(getJob(second)!.error).toContain(REAL_HARVEST_MARKER);
});

test("the memo re-resolves when only MUNINN_PROFILE changes", async () => {
  // Kills a key that carries the path alone — the likeliest inlining, since the
  // path is the variable the function is named after. Same path both times, so
  // nothing but the profile can distinguish the two configurations.
  const path = join(memoDir, "profile-only.vtt");
  await Bun.write(path, markerVtt("profile-only fixture"));
  process.env.VIMEO_HARVEST_STUB = path;

  const first = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(first, META, config, bot);
  expect(ingestPayload!.caption_kind).toBe("stub");

  process.env.MUNINN_PROFILE = "nais";
  const before = realHarvestCalls;
  const second = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(second, META, config, bot);

  expect(realHarvestCalls).toBe(before + 1);
  expect(getJob(second)!.status).toBe("error");
});

test("the memo re-resolves when only VIMEO_HARVEST_STUB changes", async () => {
  // Kills a key that carries the profile alone. Both configurations resolve to
  // a stub, so the observable is WHICH file was read — the marker line rides
  // through `downloadVtt` into the windowed transcript in the prompt.
  const a = join(memoDir, "path-a.vtt");
  const b = join(memoDir, "path-b.vtt");
  await Bun.write(a, markerVtt("fixture ALPHA speaking"));
  await Bun.write(b, markerVtt("fixture BRAVO speaking"));

  process.env.VIMEO_HARVEST_STUB = a;
  await summarizeVimeo(createJob(VIDEO_ID, META.title, CANONICAL), META, config, bot);
  expect(lastPrompt).toContain("fixture ALPHA speaking");

  process.env.VIMEO_HARVEST_STUB = b;
  await summarizeVimeo(createJob(VIDEO_ID, META.title, CANONICAL), META, config, bot);
  expect(lastPrompt).toContain("fixture BRAVO speaking");
  expect(lastPrompt).not.toContain("fixture ALPHA speaking");
});

// --- The stub resolution is a failure path of its own -----------------------

test("a stub resolution that THROWS lands on the job, not on the caller", async () => {
  // `resolveServingProfile` throws on an unrecognised MUNINN_PROFILE, and the
  // resolution used to sit OUTSIDE the try — so the throw escaped `summarizeVimeo`
  // into the route's fire-and-forget `.catch`, leaving the job `pending` forever
  // (12 h of in-flight grace at the top of /summaries with a "running" card).
  process.env.MUNINN_PROFILE = "not-a-profile";
  process.env.VIMEO_HARVEST_STUB = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);

  await summarizeVimeo(jobId, META, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(job.error).toContain("MUNINN_PROFILE");
});

test("explicit deps skip the stub resolution ENTIRELY", async () => {
  // Same throwing environment as above: if the resolution ran at all this call
  // would fail. A caller that brought its own harvest never needs the stub, and
  // every unit-test capture was paying a stat for an answer it then overrode.
  process.env.MUNINN_PROFILE = "not-a-profile";
  process.env.VIMEO_HARVEST_STUB = `${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`;
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);

  await summarizeVimeo(jobId, META, config, bot, deps());

  expect(getJob(jobId)!.status).toBe("complete");
  expect(ingestPayload!.caption_kind).toBe("auto");
});

// --- The source-draft trigger is OUTSIDE the job's failure envelope ----------

test("a source-draft trigger that throws leaves the job COMPLETE", async () => {
  // The trigger runs after `completeJob` and its first statements are
  // synchronous, so a throw there used to reach the job's own catch and call
  // `failJob` on a completed job — the store has no second-terminal-transition
  // guard, so the card went complete → error.
  sourceDraftThrows = new Error("wiki root is read-only");
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  const events: string[] = [];
  subscribe(jobId, (e) => events.push(e.type));

  await summarizeVimeo(jobId, META, config, bot, deps());

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.error).toBeUndefined();
  expect(events).not.toContain("error");
  expect(sourceDraftCalls.length).toBe(1);
});

// ── v2 PR 4: frames ─────────────────────────────────────────────────────────

const FRAMES_META = { ...META, frames: true, durationSec: 600 };
const MANIFEST_URL = "https://vod-adaptive-ak.vimeocdn.com/exp=0/x/v2/playlist/av/primary/prot/x/playlist.json";
const FAKE_MANIFEST = { clipId: "c", baseUrl: "", video: [], audio: [] } as unknown as import("./media.ts").VimeoManifest;

/** Deps with a harvest that saw the manifest, a manifest fetch and a frame extractor that writes real files. */
function framesDeps(overrides: Record<string, unknown> = {}) {
  const base = deps();
  return {
    ...base,
    framesRoot,
    harvest: async (_videoId: string, opts: { awaitManifestMs?: number }) => {
      lastHarvestOpts = opts;
      return { ...(await base.harvest()), manifestUrl: MANIFEST_URL };
    },
    fetchManifest: async (url: string) => {
      manifestFetches.push(url);
      return FAKE_MANIFEST;
    },
    extractFrames: async (input: { workDir: string; durationSec: number; manifestUrl: string }) => {
      extractCalls.push(input);
      const out = [10, 30, 50].map((t) => ({ path: join(input.workDir, `${t}.jpg`), tSeconds: t }));
      for (const f of out) writeFileSync(f.path, `frame ${f.tSeconds}`);
      return out;
    },
    ...overrides,
  };
}
let manifestFetches: string[] = [];
let lastHarvestOpts: { awaitManifestMs?: number } | undefined;
let extractCalls: Array<{ workDir: string; durationSec: number; manifestUrl: string }> = [];
let framesRoot = "";

test("frames ON: extracting_frames runs between harvest and summarize, the frame list rides the USER prompt, extraDirs is the work dir", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  const statuses: string[] = [];
  subscribe(jobId, (e) => { if (e.type === "status") statuses.push(e.status); });
  await summarizeVimeo(jobId, FRAMES_META, config, bot, framesDeps());

  expect(statuses).toEqual(["harvesting_captions", "extracting_frames", "summarizing", "ingesting"]);
  expect(getJob(jobId)!.status).toBe("complete");
  expect(manifestFetches).toEqual([MANIFEST_URL]);
  expect(extractCalls.length).toBe(1);
  expect(extractCalls[0]!.durationSec).toBe(600);
  expect(extractCalls[0]!.manifestUrl).toBe(MANIFEST_URL);
  // The transcript still opens the prompt; the frame list follows it.
  expect(lastPrompt!.startsWith("### [00:00:00]")).toBe(true);
  expect(lastPrompt).toContain(`t=00:00:10 ${join(extractCalls[0]!.workDir, "10.jpg")}`);
  expect(lastPrompt).toContain(`![Slide at HH:MM:SS](/api/vimeo/frames/${VIDEO_ID}/<sec>.jpg)`);
  // The SYSTEM prompt says nothing about frames — a frames-off capture's prompt is unchanged.
  expect(lastSystemPrompt).not.toContain("Slide");
  expect(lastExtraDirs).toEqual([extractCalls[0]!.workDir]);
  expect(lastTimeoutMs).toBe(600_000); // 3 frames: the floor
  // The harvest is told to WAIT for the manifest: measured on the first live
  // frames capture, the captions arrive before the player asks for its
  // playlist, and a harvest that closes on the captions reports no manifest.
  expect(lastHarvestOpts?.awaitManifestMs).toBe(10_000);
});

test("frames OFF: no manifest fetch, no extraction, no extraDirs, prompt byte-identical to before", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...FRAMES_META, frames: false }, config, bot, framesDeps());
  expect(lastHarvestOpts?.awaitManifestMs).toBe(0); // frames off: close on the captions
  expect(manifestFetches).toEqual([]);
  expect(extractCalls).toEqual([]);
  expect(lastExtraDirs).toBeUndefined();
  expect(lastPrompt).not.toContain("Slide frames");
});

test("the frames the summary QUOTES are kept under <root>/<videoId>/<sec>.jpg; the rest die with the work dir", async () => {
  claudeResult =
    "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n" +
    `![Slide at 00:00:30](/api/vimeo/frames/${VIDEO_ID}/30.jpg)\n- point\n` +
    `![Slide at 00:01:00](/api/vimeo/frames/${VIDEO_ID}/60.jpg)`; // 60 was never extracted
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, FRAMES_META, config, bot, framesDeps());
  expect(readdirSync(join(framesRoot, VIDEO_ID))).toEqual(["30.jpg"]);
  expect(existsSync(extractCalls[0]!.workDir)).toBe(false);
  // The summary text is ingested with the image markdown intact.
  expect(String(ingestPayload!.summary)).toContain(`/api/vimeo/frames/${VIDEO_ID}/30.jpg`);
});

test("frames requested but the harvest saw no manifest: transcript-only, one warn, status skips extracting_frames", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  const statuses: string[] = [];
  subscribe(jobId, (e) => { if (e.type === "status") statuses.push(e.status); });
  await summarizeVimeo(jobId, FRAMES_META, config, bot, deps()); // the plain deps' harvest has no manifestUrl
  expect(statuses).toEqual(["harvesting_captions", "summarizing", "ingesting"]);
  expect(getJob(jobId)!.status).toBe("complete");
  expect(warns.some((w) => /frames requested but the player requested no manifest/.test(String(w.message)))).toBe(true);
  expect(lastExtraDirs).toBeUndefined();
});

test("frame extraction failing degrades to transcript-only with a warn, never an error job", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, FRAMES_META, config, bot, framesDeps({
    extractFrames: async () => { throw new Error("ffmpeg frame grab failed (exit 1)"); },
  }));
  expect(getJob(jobId)!.status).toBe("complete");
  expect(warns.some((w) => /frame extraction failed — transcript only/.test(String(w.message)))).toBe(true);
  expect(lastExtraDirs).toBeUndefined();
  expect(lastPrompt).not.toContain("Slide frames");
});

test("the summarize timeout scales with the frame count", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ tSeconds: i * 10, path: "" }));
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, FRAMES_META, config, bot, framesDeps({
    extractFrames: async (input: { workDir: string }) => {
      return many.map((f) => { const path = join(input.workDir, `${f.tSeconds}.jpg`); writeFileSync(path, "x"); return { ...f, path }; });
    },
  }));
  expect(lastTimeoutMs).toBe(600_000 + 30 * 24_000);
});
