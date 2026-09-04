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
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { VimeoCaptions } from "./captions.ts";

const VIDEO_ID = "1223358361";
const CANONICAL = "https://vimeo.com/1223358361";

let claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
let lastSystemPrompt: string | undefined;
let lastPrompt: string | undefined;

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    _b: unknown,
    opts?: { systemPrompt?: string; onProgress?: (e: { type: string; text: string }) => void },
  ) => {
    lastPrompt = prompt;
    lastSystemPrompt = opts?.systemPrompt;
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  connectorCapabilities: () => ({ supportsExtraDirs: true, supportsThinkingBudget: true }),
}));

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
  ingestDate,
  resolveHarvestStubDeps,
} = await import("./summarizer.ts");
const { createJob, getJob, subscribe } = await import("./state.ts");

const config = { knowledgeApiUrl: "http://kb.test", claudeTimeoutMs: 120_000 } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

const META = {
  videoId: VIDEO_ID,
  url: CANONICAL,
  title: "Trust but verify",
  durationSec: 3180,
  uploadDate: "2026-08-20 09:33:04",
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
  // oEmbed's upload_date is a datetime; huginn's `date` frontmatter is a day.
  expect(ingestPayload!.date).toBe("2026-08-20");
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
  let inFlight = 0;
  let maxInFlight = 0;
  const releases: Array<() => void> = [];

  const slowHarvest = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => releases.push(resolve));
    inFlight--;
    return captionsWith([AUTO_TRACK]);
  };
  const slowDeps = { harvest: slowHarvest, downloadVtt: async () => VTT };

  const jobA = createJob(VIDEO_ID, "A", CANONICAL);
  const jobB = createJob("1223642971", "B", "https://vimeo.com/1223642971");
  const runA = summarizeVimeo(jobA, META, config, bot, slowDeps);
  const runB = summarizeVimeo(jobB, { ...META, videoId: "1223642971" }, config, bot, slowDeps);

  // Let both jobs get as far as they can before anything is released.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(inFlight).toBe(1);
  expect(releases.length).toBe(1);

  releases[0]!();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(releases.length).toBe(2);
  releases[1]!();

  await Promise.all([runA, runB]);

  expect(maxInFlight).toBe(1);
  // Both jobs really ran — a mutex that dropped one would also pass maxInFlight.
  expect(getJob(jobA)!.status).toBe("complete");
  expect(getJob(jobB)!.status).toBe("complete");
});

test("a QUEUED job stays pending — it reports harvesting only when its harvest starts", async () => {
  // `updateStatus` fired before `harvestQueue.run`, so the second job announced
  // a Chromium that was not running — for as long as the first harvest took
  // (up to the 60 s budget, and stacking with every further queued job).
  const releases: Array<() => void> = [];
  const slowDeps = {
    harvest: async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return captionsWith([AUTO_TRACK]);
    },
    downloadVtt: async () => VTT,
  };

  const jobA = createJob(VIDEO_ID, "A", CANONICAL);
  const jobB = createJob("1223642971", "B", "https://vimeo.com/1223642971");
  const runA = summarizeVimeo(jobA, META, config, bot, slowDeps);
  const runB = summarizeVimeo(jobB, { ...META, videoId: "1223642971" }, config, bot, slowDeps);

  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(getJob(jobA)!.status).toBe("harvesting_captions");
  expect(getJob(jobB)!.status).toBe("pending");

  releases[0]!();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(getJob(jobB)!.status).toBe("harvesting_captions");

  releases[1]!();
  await Promise.all([runA, runB]);
  expect(getJob(jobB)!.status).toBe("complete");
});

// --- ingestDate --------------------------------------------------------------

test("ingestDate takes the day off oEmbed's datetime and drops anything unparseable", () => {
  expect(ingestDate("2026-08-20 09:33:04")).toBe("2026-08-20");
  expect(ingestDate("2026-08-20")).toBe("2026-08-20");
  expect(ingestDate("")).toBeUndefined();
  expect(ingestDate("not a date")).toBeUndefined();
});

test("an unparseable upload date omits the field so huginn stamps today", async () => {
  const jobId = createJob(VIDEO_ID, META.title, CANONICAL);
  await summarizeVimeo(jobId, { ...META, uploadDate: "" }, config, bot, deps());

  expect("date" in ingestPayload!).toBe(false);
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
