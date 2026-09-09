/**
 * Acceptance for the capture RE-RUN (`POST /api/summaries/rerun` and
 * `GET /api/summaries/rerun/options`).
 *
 * Every side-effecting seam is injected, so this file runs with no huginn, no
 * bots on disk, no model call and no database. What it pins is the five things
 * a re-run gets wrong silently:
 *
 *  1. **The ingest RE-SENDS every frontmatter field** — `url` and `date`
 *     included, `duration_sec` as a NUMBER — with only `summary_kind` changed.
 *     A field left out is a field erased, and a differing url forks a `(2)`.
 *  2. **`title` and `category` are PINNED to the stored document**, over the
 *     model's own `CATEGORY:` line, because either one moving is a second file.
 *  3. **A document with no `## Transcript` appendix is a synchronous 400**, not
 *     a job that fails a minute later on a card nobody is looking at.
 *  4. **The frame listing handed to the tail is COMPLETE and the write is
 *     union-only** — a frame the summary did not quote is still on disk
 *     afterwards, and a quote of a frame that IS in the listing survives.
 *  5. **The vertical's reindex-window memory is told**, or a paste of the same
 *     video right after a re-run is captured a second time.
 *
 * Every fixture is invented. This repo is public.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSummariesRerunRoutes,
  readStoredCapture,
  titleFromDocId,
  categoryFromDocId,
  listKeptFrames,
  extraTagsFromStored,
  titleRoundTripRefusal,
  TITLE_ROUND_TRIP_MAX,
  FULL_RERUN_UNSUPPORTED,
  type SummariesRerunDeps,
  type RerunDocument,
} from "./summaries-rerun.ts";
import {
  rerunLatchBudgetMs,
  RERUN_LATCH_SLACK_MS,
} from "./summaries-rerun.ts";
import { registerRecentIngestSink } from "../../summaries/recent-ingests.ts";
import { buildShortVideoSystemPrompt } from "../../video/short-video-prompt.ts";
import { shortVideoCaptureKinds, SHORT_VIDEO_THINKING } from "../../video/short-video-kinds.ts";
import { TIKTOK_SPEC } from "../../tiktok/summarizer.ts";
import { X_VIDEO_SPEC } from "../../x-article/video.ts";
import {
  capturePresetOptions,
  resolveCapturePresets,
  SHIPPED_CAPTURE_PRESETS,
} from "../../summaries/presets.ts";
import { TRANSCRIPT_MAX_BYTES, TRANSCRIPT_TRUNCATION_NOTE } from "../../summaries/transcript-appendix.ts";
import { summarizeTimeoutFor } from "../../video/media.ts";
import { CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS } from "../../summaries/summarizer-shared.ts";
import { VIMEO_FRAME_SOURCE } from "../../summaries/frames.ts";
import { YOUTUBE_FRAME_SOURCE, copyKeptFrame } from "../../summaries/frames.ts";
import { getJob } from "../../youtube/state.ts";
import type { BotConfig } from "../../bots/config.ts";

const config = { knowledgeApiUrl: "http://127.0.0.1:1", tracingEnabled: false } as never;

const BOT = { name: "testbot", dir: "/nowhere", connector: "claude-cli" } as unknown as BotConfig;

const VIDEO_ID = "abcdefghijk"; // 11 URL-safe base64 characters, the seam's gate
const DOC_ID = "ai/general/A Talk About Things.md";

/** An invented TikTok post url — the shape yt-dlp's canonical answer has. */
const TIKTOK_URL = "https://www.tiktok.com/@invented/video/7000000000000000000";
/** Whisper's shape: prose with no `### [HH:MM:SS]` windows anywhere in it. */
const FLAT_TRANSCRIPT =
  "So the first thing you notice is that nothing here is real. " +
  "Then the second thing, which is that this fixture was invented for a public repo.";

/** A stored YouTube capture: full frontmatter, a windowed appendix. */
function youtubeDoc(opts: { kind?: string; transcript?: string | null; body?: string } = {}): string {
  const front = [
    "---",
    'date: "2026-09-01"',
    `url: "https://www.youtube.com/watch?v=${VIDEO_ID}"`,
    `summary_kind: "${opts.kind ?? "standard"}"`,
    'category: "ai/general"',
    'tags: "ai, general"',
    "---",
    "",
  ].join("\n");
  const body = opts.body ?? "The stored summary.\n";
  const transcript =
    opts.transcript === null ? "" : `\n## Transcript\n\n${opts.transcript ?? "### [00:00:00]\n\nHello."}\n`;
  return front + body + transcript;
}

interface Recorded {
  ingests: Array<{ path: string; body: Record<string, unknown> }>;
  prompts: Array<{
    system: string;
    user: string;
    extraDirs?: string[];
    url: string;
    title: string;
    source: string;
    /** The RUN options, so a re-run's budget can be compared with the capture's.
     *  `undefined` here means the key was omitted, which is what
     *  `runCaptureOneShot` reads as "apply the shared 8k cap". */
    thinkingMaxTokens: number | null | undefined;
  }>;
}

function makeDeps(
  raw: string | null,
  opts: {
    framesRoot?: string;
    answer?: string;
    bot?: BotConfig | null;
    /** Never resolves — the shape a second POST has to 409 against. */
    stall?: boolean;
    /** The single-flight claim's own bound, so the EXPIRY is drivable. */
    latchBudgetMs?: number;
  } = {},
): { deps: SummariesRerunDeps; rec: Recorded } {
  const rec: Recorded = { ingests: [], prompts: [] };
  const deps: SummariesRerunDeps = {
    fetchRawDoc: async (): Promise<RerunDocument | null> => (raw === null ? null : { raw }),
    ingest: async (o) => {
      rec.ingests.push({ path: o.ingestPath, body: o.body });
      o.onIngested?.({ filePath: DOC_ID });
    },
    oneShot: (async (o: Record<string, unknown>) => {
      rec.prompts.push({
        system: o.systemPrompt as string,
        user: o.prompt as string,
        ...(o.extraDirs ? { extraDirs: o.extraDirs as string[] } : {}),
        url: o.url as string,
        title: o.title as string,
        source: o.source as string,
        thinkingMaxTokens: o.thinkingMaxTokens as number | null | undefined,
      });
      if (opts.stall) await new Promise(() => {});
      return { result: opts.answer ?? "CATEGORY: ai/general\n\nSUMMARY:\n\nA fresh summary.", outputTokens: 1 };
    }) as unknown as SummariesRerunDeps["oneShot"],
    bots: () => (opts.bot === null ? [] : [opts.bot ?? BOT]),
    ...(opts.framesRoot !== undefined ? { framesRoot: opts.framesRoot } : {}),
    ...(opts.latchBudgetMs !== undefined ? { latchBudgetMs: opts.latchBudgetMs } : {}),
  };
  return { deps, rec };
}

function appFor(deps: SummariesRerunDeps): Hono {
  const app = new Hono();
  registerSummariesRerunRoutes(app, config, deps);
  return app;
}

async function post(app: Hono, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/api/summaries/rerun", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A POST with a caller-chosen content type — the 415 gate's own axis. */
async function postWithType(
  app: Hono,
  contentType: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/api/summaries/rerun", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The job settles on its own microtask chain; give it a few turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await Bun.sleep(5);
}

const tempRoots: string[] = [];
function tempFramesRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rerun-frames-"));
  tempRoots.push(root);
  return root;
}
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("reading a stored capture", () => {
  test("the appendix comes back TRIMMED, so re-appending cannot grow the file", () => {
    const stored = readStoredCapture(youtubeDoc());
    expect(stored.transcript).toBe("### [00:00:00]\n\nHello.");
    expect(stored.body).toBe("The stored summary.");
    expect(stored.windowed).toBe(true);
    expect(stored.truncated).toBe(false);
    expect(stored.frontmatter.summary_kind).toBe("standard");
  });

  test("a document with no appendix reports none", () => {
    expect(readStoredCapture(youtubeDoc({ transcript: null })).transcript).toBeNull();
  });

  test("an appendix carrying the truncation note is flagged", () => {
    const raw = youtubeDoc({
      transcript: "### [00:00:00]\n\nHello.\n\n_(transcript truncated — the talk continues past this point.)_",
    });
    expect(readStoredCapture(raw).truncated).toBe(true);
  });

  test("the title is the file name and the category is its directory", () => {
    expect(titleFromDocId(DOC_ID)).toBe("A Talk About Things");
    expect(categoryFromDocId(DOC_ID)).toBe("ai/general");
    expect(categoryFromDocId("loose.md")).toBeNull();
  });
});

describe("the ingest body", () => {
  test("re-sends every field unchanged except summary_kind", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    const app = appFor(deps);
    const res = await post(app, { source: "youtube", docId: DOC_ID, kind: "talk-notes" });
    expect(res.status).toBe(200);
    await settle();

    expect(rec.ingests.length).toBe(1);
    const body = rec.ingests[0]!.body;
    expect(rec.ingests[0]!.path).toBe("/api/youtube/ingest");
    expect(body.url).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    expect(body.date).toBe("2026-09-01");
    expect(body.title).toBe("A Talk About Things");
    expect(body.category).toBe("ai/general");
    // The ONE field a re-run changes.
    expect(body.summary_kind).toBe("talk-notes");
  });

  test("the appendix rides back BYTE-EQUAL under its own heading", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    const summary = String(rec.ingests[0]!.body.summary);
    expect(summary).toBe("A fresh summary.\n\n## Transcript\n\n### [00:00:00]\n\nHello.\n");
  });

  test("a Vimeo re-run carries every extra field, duration_sec as a NUMBER", async () => {
    // Driven through the REAL route, so the assertion is over the shipped
    // per-vertical field list rather than a second copy of it in this file.
    const raw = [
      "---",
      'date: "2026-09-01"',
      'url: "https://vimeo.com/1234567"',
      'vimeo_video_id: "1234567"',
      'caption_lang: "no-x-autogen"',
      'caption_kind: "auto"',
      'summary_kind: "standard"',
      'summary_lang: "nb"',
      'author: "Example Conf"',
      'upload_date: "2026-08-01T09:00:00+00:00"',
      'speaker: "A Speaker"',
      'thumbnail_url: "https://example.invalid/p.jpg"',
      "duration_sec: 3180",
      'category: "ai/general"',
      'tags: "ai, general"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      "### [00:00:00]",
      "",
      "Hei.",
      "",
    ].join("\n");
    const { deps, rec } = makeDeps(raw);
    const res = await post(appFor(deps), {
      source: "vimeo",
      docId: "ai/general/En Talk.md",
      kind: "talk-notes",
    });
    expect(res.status).toBe(200);
    await settle();

    const body = rec.ingests[0]!.body;
    expect(rec.ingests[0]!.path).toBe("/api/vimeo/ingest");
    expect(body.duration_sec).toBe(3180);
    expect(body.date).toBe("2026-09-01");
    expect(body.url).toBe("https://vimeo.com/1234567");
    expect(body.caption_lang).toBe("no-x-autogen");
    expect(body.caption_kind).toBe("auto");
    expect(body.summary_lang).toBe("nb");
    expect(body.author).toBe("Example Conf");
    expect(body.upload_date).toBe("2026-08-01T09:00:00+00:00");
    expect(body.speaker).toBe("A Speaker");
    expect(body.thumbnail_url).toBe("https://example.invalid/p.jpg");
    expect(body.summary_kind).toBe("talk-notes");
    expect(body.title).toBe("En Talk");
    expect(body.category).toBe("ai/general");
    // huginn DERIVES this from the url and takes no such request field.
    expect(body).not.toHaveProperty("vimeo_video_id");
    // Vimeo carries the transcript in its own field, not on the summary string.
    expect(body.transcript_markdown).toBe("### [00:00:00]\n\nHei.");
    expect(body.summary).toBe("A fresh summary.");
    // The stored language wins: a re-run never re-resolves `talk`.
    expect(rec.prompts[0]!.system).toContain("bokm");
  });
  test("a QUOTED value that looks numeric is re-sent as a STRING, not a number", async () => {
    // The double-decode trap: the reader decodes once for the fields the route
    // reads as text (`summary_lang`, `caption_kind`, `author`) and the ingest
    // builder decodes again for the wire. Decoding the ALREADY-decoded value
    // turns huginn's quoted `caption_lang: "2026"` into the number 2026, which
    // its `Optional[str]` model refuses. The builder must read the RAW text.
    const raw = [
      "---",
      'date: "2026-09-01"',
      'url: "https://vimeo.com/1234567"',
      'caption_lang: "2026"',
      'summary_kind: "standard"',
      "duration_sec: 3180",
      'category: "ai/general"',
      'tags: "ai, general"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      "### [00:00:00]",
      "",
      "Hei.",
      "",
    ].join("\n");
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "vimeo", docId: "ai/general/En Talk.md" });
    await settle();
    expect(rec.ingests[0]!.body.caption_lang).toBe("2026");
    // …while the genuinely bare integer beside it stays a number.
    expect(rec.ingests[0]!.body.duration_sec).toBe(3180);
  });
});

describe("the pinned title and category", () => {
  test("a disagreeing model CATEGORY: line does not move the document", async () => {
    // `coding` and not `dev/tools`: the latter is not in huginn's `CATEGORIES`,
    // so a tail that clamps an unknown category answers `ai/general` — the same
    // string the pin produces — and the assertion passes whichever value won.
    // A VALID category the document is not filed under is the only input that
    // can tell the two apart.
    const { deps, rec } = makeDeps(youtubeDoc(), {
      answer: "CATEGORY: coding\n\nSUMMARY:\n\nA fresh summary.",
    });
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.ingests[0]!.body.category).toBe("ai/general");
    expect(rec.ingests[0]!.body.title).toBe("A Talk About Things");
  });

  test("the disagreement is LOGGED, or a re-filed document moves silently", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [
        { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
        { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });
    try {
      const { deps } = makeDeps(youtubeDoc(), {
        answer: "CATEGORY: coding\n\nSUMMARY:\n\nA fresh summary.",
      });
      await post(appFor(deps), { source: "youtube", docId: DOC_ID });
      await settle();
      const line = records.find(
        (r) => r.properties.modelCategory === "coding" && r.properties.category === "ai/general",
      );
      expect(line).toBeDefined();
      expect(line!.properties.docId).toBe(DOC_ID);
    } finally {
      await configure({
        sinks: {},
        loggers: [{ category: ["logtape", "meta"], sinks: [], lowestLevel: "error" }],
        reset: true,
      });
    }
  });
});

describe("refusals", () => {
  test("a document with no appendix is a synchronous 400, and no job is created", async () => {
    const { deps, rec } = makeDeps(youtubeDoc({ transcript: null }));
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("no_transcript");
    await settle();
    expect(rec.ingests.length).toBe(0);
    expect(rec.prompts.length).toBe(0);
    expect(res.json).not.toHaveProperty("job_id");
  });

  test("an unknown source is 400 before anything is read", async () => {
    const { deps } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "article", docId: DOC_ID });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("bad_source");
  });

  test("a dot-segment docId is refused", async () => {
    const { deps } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "youtube", docId: "../secrets.md" });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("bad_doc_id");
  });

  test("an unknown kind is refused", async () => {
    const { deps } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID, kind: "nope" });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("bad_kind");
  });

  test("`full: true` is 501 and says why", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID, full: true });
    expect(res.status).toBe(501);
    expect(res.json.error).toBe(FULL_RERUN_UNSUPPORTED);
    expect(rec.prompts.length).toBe(0);
  });

  test("a missing document is 404", async () => {
    const { deps } = makeDeps(null);
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    expect(res.status).toBe(404);
  });

  test("a non-JSON content type is 415 and reads nothing", async () => {
    // `text/plain` is a CORS *simple* request: no preflight, so without the gate
    // a cross-origin page spends a model call and rewrites a stored document
    // while the browser never asks. Hono parses the body whatever the header
    // says, which is what makes the header the only thing that can refuse.
    const { deps, rec } = makeDeps(youtubeDoc());
    const app = appFor(deps);
    const res = await postWithType(app, "text/plain;charset=UTF-8", { source: "youtube", docId: DOC_ID });
    expect(res.status).toBe(415);
    expect(res.json.code).toBe("bad_content_type");
    await settle();
    expect(rec.prompts.length).toBe(0);
    expect(rec.ingests.length).toBe(0);
  });

  test("a charset parameter on application/json is fine", async () => {
    const { deps } = makeDeps(youtubeDoc());
    const res = await postWithType(appFor(deps), "application/json; charset=utf-8", {
      source: "youtube",
      docId: DOC_ID,
    });
    expect(res.status).toBe(200);
    await settle();
  });

  test("a document with no url is 400 before a job exists", async () => {
    const raw = youtubeDoc().replace(`url: "https://www.youtube.com/watch?v=${VIDEO_ID}"\n`, "");
    const { deps, rec } = makeDeps(raw);
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("no_url");
    await settle();
    expect(rec.prompts.length).toBe(0);
  });

  test("a document filed under no category is 400", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "youtube", docId: "loose.md" });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("no_category");
    await settle();
    expect(rec.prompts.length).toBe(0);
  });

  test("kept frames plus a connector that cannot read files is 503, before a job", async () => {
    const root = tempFramesRoot();
    const dir = join(root, "youtube", VIDEO_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "30.jpg"), "x");
    const copilot = { ...BOT, connector: "copilot-sdk" } as unknown as BotConfig;
    const { deps, rec } = makeDeps(youtubeDoc(), { framesRoot: root, bot: copilot });
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("frames_unsupported");
    await settle();
    // The refusal is the point: a run would have produced a summary whose slide
    // quotes the tail then stripped, i.e. pictures gone with no error anywhere.
    expect(rec.prompts.length).toBe(0);
    expect(rec.ingests.length).toBe(0);
  });
});

describe("the title round trip", () => {
  // The check is the exact FIXED-POINT test over huginn's own rule
  // (`sanitizeFilenameLikeHuginn`): a stem the rule would rewrite comes back as
  // a different file name, and huginn keys the path on that name, so a re-run of
  // it writes a second document. Refused before any model spend.
  test("a clean stem passes, and one PAST the cap does not", () => {
    expect(titleRoundTripRefusal("A Talk About Things")).toBeNull();
    expect(titleRoundTripRefusal("x".repeat(TITLE_ROUND_TRIP_MAX - 1))).toBeNull();
    // At the cap huginn truncates nothing, so this really is a fixed point —
    // the first cut of the guard refused it anyway, on a symptom rather than
    // the rule. Past the cap it is not.
    expect(titleRoundTripRefusal("x".repeat(TITLE_ROUND_TRIP_MAX))).toBeNull();
    expect(titleRoundTripRefusal("x".repeat(TITLE_ROUND_TRIP_MAX + 40))).toContain("second document");
  });

  test("a stem ending in whitespace is refused — a tab as much as a space", () => {
    expect(titleRoundTripRefusal("A Talk ")).toContain("second document");
    expect(titleRoundTripRefusal("A Talk\t")).toContain("second document");
    expect(titleRoundTripRefusal("A Talk")).toBeNull();
  });

  // The half a symptom check cannot see, and the reason the rule is ported: the
  // collapse class is `[\s_]+`, so an underscore or a double space is a stem
  // huginn RENAMES. Measured on the live corpus 2026-09-09: 59 such stems, none
  // of which the trailing-whitespace/length pair would have caught.
  test("a stem carrying `_` or a double space is refused", () => {
    expect(titleRoundTripRefusal("Invented Talk_ Part Two")).toContain(
      'would file it as "Invented Talk Part Two"',
    );
    expect(titleRoundTripRefusal("Two  spaces")).toContain("second document");
  });

  test("a 200-CODE-POINT stem of astral characters is accepted", () => {
    // 200 code points, 400 UTF-16 units: a `String.length` port refuses this,
    // and huginn does not touch it.
    const astral = "\u{1F600}".repeat(TITLE_ROUND_TRIP_MAX);
    expect(astral.length).toBe(TITLE_ROUND_TRIP_MAX * 2);
    expect(titleRoundTripRefusal(astral)).toBeNull();
  });

  test("the POST answers 409 and spends nothing", async () => {
    const longTitle = "L".repeat(TITLE_ROUND_TRIP_MAX + 5);
    const { deps, rec } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "youtube", docId: `ai/general/${longTitle}.md` });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("title_not_round_trippable");
    await settle();
    expect(rec.prompts.length).toBe(0);
    expect(rec.ingests.length).toBe(0);
  });

  test("the options payload carries the same verdict, so the menu can disable the items", async () => {
    const longTitle = "L".repeat(TITLE_ROUND_TRIP_MAX + 5);
    const app = appFor(makeDeps(youtubeDoc()).deps);
    const bad = (await (
      await app.request(
        `/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(`ai/general/${longTitle}.md`)}`,
      )
    ).json()) as { titleRoundTrip: { ok: boolean; reason: string | null } };
    expect(bad.titleRoundTrip.ok).toBe(false);
    expect(bad.titleRoundTrip.reason).toContain("second document");

    const good = (await (
      await app.request(`/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`)
    ).json()) as { titleRoundTrip: { ok: boolean; reason: string | null } };
    expect(good.titleRoundTrip).toEqual({ ok: true, reason: null });
  });
});

describe("single flight", () => {
  test("a second POST for the same document is 409 while the first is running", async () => {
    // A stalled `oneShot` holds the first run open. Without the latch both runs
    // spend a model call and then race each other's ingest for ONE FILE, which
    // huginn rewrites whole from the request body — so the loser's summary is
    // simply gone, and which one loses is decided by the network.
    const { deps, rec } = makeDeps(youtubeDoc(), { stall: true });
    const app = appFor(deps);
    const first = await post(app, { source: "youtube", docId: DOC_ID });
    expect(first.status).toBe(200);
    await settle();

    const second = await post(app, { source: "youtube", docId: DOC_ID });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("in_flight");
    await settle();
    expect(rec.prompts.length).toBe(1);
  });

  test("the latch is per document, not per route", async () => {
    const { deps, rec } = makeDeps(youtubeDoc(), { stall: true });
    const app = appFor(deps);
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200);
    await settle();
    const other = await post(app, { source: "youtube", docId: "ai/general/Another Talk.md" });
    expect(other.status).toBe(200);
    await settle();
    expect(rec.prompts.length).toBe(2);
  });

  test("the latch is released when the run settles", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    const app = appFor(deps);
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200);
    await settle();
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200);
    await settle();
    expect(rec.prompts.length).toBe(2);
  });
});

describe("the frames listing", () => {
  test("lists every kept frame, ascending, with no notes", async () => {
    const root = tempFramesRoot();
    const dir = join(root, "youtube", VIDEO_ID);
    mkdirSync(dir, { recursive: true });
    for (const sec of [120, 60, 30]) writeFileSync(join(dir, `${sec}.jpg`), "x");
    // Three strays, and the last two are the ones that matter: `notes.txt` fails
    // on the digit prefix, so it can never tell whether the EXTENSION half of
    // the pattern is anchored. `30.jpg.tmp` (a half-written copy) and `45.png`
    // both begin with digits, and a rule that took the digits and stopped would
    // list them — putting an address in the prompt that the frames route, which
    // serves exactly `<digits>.jpg`, answers 404 for.
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, "30.jpg.tmp"), "x");
    writeFileSync(join(dir, "45.png"), "x");
    const frames = await listKeptFrames(YOUTUBE_FRAME_SOURCE, VIDEO_ID, root);
    expect(frames.map((f) => f.tSeconds)).toEqual([30, 60, 120]);
    expect(frames.map((f) => f.path).some((x) => x.endsWith(".tmp") || x.endsWith(".png"))).toBe(false);
    expect(frames.every((f) => f.note === "")).toBe(true);
    expect(frames[0]!.path).toBe(join(dir, "30.jpg"));
  });

  test("the WHOLE listing reaches the prompt and the tail, and the write is union-only", async () => {
    // The hazard PR 2's review found: `finishYouTubeSummary` strips every quote
    // of a frame that is NOT in the list it is handed, so an incomplete listing
    // narrows the re-summary silently. The fake model quotes ONE kept frame and
    // omits another; both files must still be on disk afterwards and the quote
    // must survive.
    const root = tempFramesRoot();
    const dir = join(root, "youtube", VIDEO_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "30.jpg"), "thirty");
    writeFileSync(join(dir, "60.jpg"), "sixty");
    const quote = `![Slide at 00:00:30](/api/frames/youtube/${VIDEO_ID}/30.jpg)`;
    const { deps, rec } = makeDeps(youtubeDoc(), {
      framesRoot: root,
      answer: `CATEGORY: ai/general\n\nSUMMARY:\n\nA fresh summary.\n\n${quote}\n`,
    });
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();

    // Both frames were offered to the model…
    expect(rec.prompts[0]!.user).toContain(join(dir, "30.jpg"));
    expect(rec.prompts[0]!.user).toContain(join(dir, "60.jpg"));
    expect(rec.prompts[0]!.extraDirs).toEqual([dir]);
    // …the quote of the one it used survived the tail…
    expect(String(rec.ingests[0]!.body.summary)).toContain(quote);
    // …and NOTHING was pruned: the unquoted frame is still there, and the
    // quoted one still holds its own bytes (the same-path copy is skipped).
    expect(existsSync(join(dir, "60.jpg"))).toBe(true);
    expect(readFileSync(join(dir, "30.jpg"), "utf8")).toBe("thirty");
  });
});

describe("copyKeptFrame", () => {
  test("does NOT copy a frame that is already at its destination", async () => {
    // Invisible from the filesystem on macOS, where `copyFile(p, p)` resolves
    // with the file intact — which is why the copy is injectable here.
    const calls: Array<[string, string]> = [];
    await copyKeptFrame("/a/b/30.jpg", "/a/b/30.jpg", async (from, to) => {
      calls.push([from, to]);
    });
    expect(calls).toEqual([]);
  });

  test("compares RESOLVED paths, so a differently-spelled root still matches", async () => {
    const calls: Array<[string, string]> = [];
    await copyKeptFrame("/a/b/../b/30.jpg", "/a/b/30.jpg", async (from, to) => {
      calls.push([from, to]);
    });
    expect(calls).toEqual([]);
  });

  test("copies when the two really are different files", async () => {
    const calls: Array<[string, string]> = [];
    await copyKeptFrame("/work/30.jpg", "/kept/30.jpg", async (from, to) => {
      calls.push([from, to]);
    });
    expect(calls).toEqual([["/work/30.jpg", "/kept/30.jpg"]]);
  });

  test("a SYMLINKED root is the same file, which a lexical resolve cannot see", async () => {
    // The case `resolve` misses: it normalizes `..` and `.` and nothing else, so
    // a served root reached through a symlink spells one file two ways and the
    // guard falls through to `copyFile(p, p)` — undefined by POSIX, and the
    // plausible Linux failure is a truncate-then-write that destroys the only
    // copy of the frame. `/tmp` -> `/private/tmp` gives every macOS temp dir
    // this shape for free.
    const root = tempFramesRoot();
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "30.jpg"), "thirty");
    const link = join(root, "link");
    symlinkSync(real, link, "dir");

    const calls: Array<[string, string]> = [];
    await copyKeptFrame(join(link, "30.jpg"), join(real, "30.jpg"), async (from, to) => {
      calls.push([from, to]);
    });
    expect(calls).toEqual([]);
    // And a real pair through the same symlinked root still copies.
    await copyKeptFrame(join(link, "30.jpg"), join(real, "60.jpg"), async (from, to) => {
      calls.push([from, to]);
    });
    expect(calls).toEqual([[join(link, "30.jpg"), join(real, "60.jpg")]]);
  });
});

describe("the reindex-window memory", () => {
  test("a finished re-run announces its document to the vertical's sink", async () => {
    const seen: Array<[string, string, string]> = [];
    const off = registerRecentIngestSink("youtube", (videoId, documentId, url) => {
      seen.push([videoId, documentId, url]);
    });
    try {
      const { deps } = makeDeps(youtubeDoc());
      await post(appFor(deps), { source: "youtube", docId: DOC_ID });
      await settle();
      expect(seen).toEqual([[VIDEO_ID, DOC_ID, `https://www.youtube.com/watch?v=${VIDEO_ID}`]]);
    } finally {
      off();
    }
  });
});

describe("the job", () => {
  test("is created in the SOURCE vertical's store", async () => {
    const { deps } = makeDeps(youtubeDoc());
    const res = await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    expect(res.status).toBe(200);
    const job = getJob(String(res.json.job_id));
    expect(job).toBeDefined();
    // No `rerun` flag on the JOB: nothing reads one (there is no shelf badge),
    // and the question is asked on the TRACE, which the attribute below carries.
    expect(job!.videoId).toBe(VIDEO_ID);
    expect(res.json.dashboard_url).toBe(`/summaries?source=youtube&job=${res.json.job_id}`);
    await settle();
    expect(getJob(String(res.json.job_id))!.status).toBe("complete");
  });

  test("the prompt is keyed on the STORED url, so the snapshot stays one per document", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.prompts[0]!.url).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    expect(rec.prompts[0]!.title).toBe("A Talk About Things");
    // The windowed rider rides on the TRANSCRIPT's own headings.
    expect(rec.prompts[0]!.system).toContain("[HH:MM:SS]");
  });

  test("a flat transcript gets NO windowed rider", async () => {
    const { deps, rec } = makeDeps(youtubeDoc({ transcript: "a flat wall of text" }));
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.prompts[0]!.system).not.toContain("[HH:MM:SS]");
  });
});

describe("GET /api/summaries/rerun/options", () => {
  let app: Hono;
  beforeEach(() => {
    app = appFor(makeDeps(youtubeDoc({ kind: "talk-notes" })).deps);
  });

  test("reports the transcript, the stored kind and the kinds on offer", async () => {
    const res = await app.request(
      `/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.hasTranscript).toBe(true);
    expect(data.windowed).toBe(true);
    expect(data.truncated).toBe(false);
    expect(data.storedKind).toBe("talk-notes");
    expect((data.kinds as Array<{ id: string }>).map((k) => k.id)).toContain("standard");
    expect(data.framesKept).toBe(0);
    expect(data.promptUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    expect((data.full as { supported: boolean }).supported).toBe(false);
  });

  test("a transcript-less document says so instead of 400ing the menu", async () => {
    const res = await appFor(makeDeps(youtubeDoc({ transcript: null })).deps).request(
      `/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasTranscript: boolean }).hasTranscript).toBe(false);
  });

  test("a `## Visual reference` appendix is the only evidence of `detailed`", async () => {
    const withAppendix = appFor(
      makeDeps(youtubeDoc({ body: "Body.\n\n## Visual reference\n\ncaptions\n" })).deps,
    );
    const a = (await (
      await withAppendix.request(`/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`)
    ).json()) as { storedVisualDetail: string };
    expect(a.storedVisualDetail).toBe("detailed");

    const b = (await (
      await app.request(`/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`)
    ).json()) as { storedVisualDetail: string };
    expect(b.storedVisualDetail).toBe("selected");
  });

  test("every spelling the visual-detail pass accepts is read the same way here", async () => {
    // The both-directions failure a local re-spelling of the heading pattern
    // reintroduces: each of these is a real appendix the pass itself matches, so
    // reading it as "no appendix" answers `selected` and "Same settings again"
    // silently DOWNGRADES a `detailed` document — caps 20 to 8, appendix cut.
    const spellings = [
      "## Visual References",
      "## **Visual reference**",
      "  ### Visual reference:",
    ];
    for (const heading of spellings) {
      const one = appFor(makeDeps(youtubeDoc({ body: `Body.\n\n${heading}\n\ncaptions\n` })).deps);
      const data = (await (
        await one.request(`/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`)
      ).json()) as { storedVisualDetail: string };
      expect([heading, data.storedVisualDetail]).toEqual([heading, "detailed"]);
    }
  });

  test("a heading QUOTED inside a fence is not an appendix", async () => {
    const fenced = appFor(
      makeDeps(
        youtubeDoc({ body: "Body.\n\n```md\n## Visual reference\n\ncaptions\n```\n" }),
      ).deps,
    );
    const data = (await (
      await fenced.request(`/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`)
    ).json()) as { storedVisualDetail: string };
    expect(data.storedVisualDetail).toBe("selected");
  });

  test("a kind-less document reports storedKind null beside the default that will run", async () => {
    // Absent `summary_kind` means "written before kinds existed", which is NOT
    // the same claim as `standard`. The ingest still stamps the default (it IS
    // what ran); the menu has to be able to say which.
    const raw = youtubeDoc().replace('summary_kind: "standard"\n', "");
    const bare = appFor(makeDeps(raw).deps);
    const data = (await (
      await bare.request(`/api/summaries/rerun/options?source=youtube&docId=${encodeURIComponent(DOC_ID)}`)
    ).json()) as { storedKind: string | null; defaultKind: string };
    expect(data.storedKind).toBeNull();
    expect(data.defaultKind).toBe("standard");
  });

  test("a blank docId is a 400", async () => {
    const res = await app.request("/api/summaries/rerun/options?source=youtube&docId=");
    expect(res.status).toBe(400);
  });
});

describe("a kind-less document still gets the default STAMPED", () => {
  test("the ingest carries summary_kind, because that is what ran", async () => {
    const raw = youtubeDoc().replace('summary_kind: "standard"\n', "");
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.ingests[0]!.body.summary_kind).toBe("standard");
  });
});

describe("the frame list is not a cadence", () => {
  test("the prompt states no spacing, because the survivors are not a sample", async () => {
    // A re-run lists whatever the PREVIOUS summary quoted. Two survivors 30 s and
    // 900 s apart would make `framesPromptSection` announce "one every ~870 s of
    // the talk" — a number nothing measured, in a sentence the model reasons
    // from. The clause is omitted, not zeroed.
    const root = tempFramesRoot();
    const dir = join(root, "youtube", VIDEO_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "30.jpg"), "x");
    writeFileSync(join(dir, "900.jpg"), "x");
    const { deps, rec } = makeDeps(youtubeDoc(), { framesRoot: root });
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.prompts[0]!.user).toContain("Slide frames (read EVERY image");
    expect(rec.prompts[0]!.user).not.toContain("one every ~");
  });
});

describe("the trace source", () => {
  test("an x-article re-run traces under the X VIDEO capture's name", async () => {
    // The documents live on the `x-article` shelf; the capture that wrote them
    // is `src/x-article/video.ts`, which traces `capture:x-video`. A re-run
    // tracing `capture:x-article` puts the two runs under different span names,
    // which is the one comparison the attribute exists for.
    const raw = [
      "---",
      'date: "2026-09-01"',
      'url: "https://x.com/someone/status/1234567890"',
      'author: "someone"',
      'category: "ai/general"',
      'tags: "ai, general"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      "Spoken words.",
      "",
    ].join("\n");
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "x-article", docId: "ai/general/An X video.md" });
    await settle();
    expect(rec.prompts[0]!.source).toBe("x-video");
  });

  test("the three others trace under their own name", async () => {
    const { deps, rec } = makeDeps(youtubeDoc());
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.prompts[0]!.source).toBe("youtube");
  });
});

describe("tags", () => {
  test("the stored line minus the category parts is what round-trips", () => {
    // huginn REBUILDS the line as `category.split("/") + req.tags`, deduped, so
    // the remainder is exactly what has to be re-sent for the stored line to
    // come back byte-equal — and re-sending it is idempotent.
    expect(extraTagsFromStored('"ai, general, javascript"', "ai/general")).toEqual(["javascript"]);
    expect(extraTagsFromStored('"ai, general"', "ai/general")).toEqual([]);
    expect(extraTagsFromStored(undefined, "ai/general")).toEqual([]);
    // A hand-added tag EQUAL to a category part was never a separate entry.
    expect(extraTagsFromStored('"coding, coding"', "coding")).toEqual([]);
    // A single-segment category, and a tag list carrying blanks.
    expect(extraTagsFromStored('"coding, rust,  , wasm"', "coding")).toEqual(["rust", "wasm"]);
  });

  test("the LINE huginn rebuilds is category-first-deduped, and the second pass is a fixed point", () => {
    // What the re-send preserves is the tag SET, not the stored line's bytes.
    // `build_summary_tags` composes `category.split("/") + req.tags`, deduped,
    // order preserved — so a HAND-EDITED line is rewritten into that shape on
    // the FIRST re-run and is a fixed point from then on. Stating the stronger
    // "byte for byte" (as the first comment here did) is false of exactly the
    // lines a person touched.
    const category = "ai/general";
    const rebuild = (stored: string): string =>
      [...category.split("/"), ...extraTagsFromStored(stored, category)].join(", ");

    // Hand-edited: reordered, and carrying a duplicate.
    expect(rebuild('"javascript, ai, general, javascript"')).toBe("ai, general, javascript");
    // Feeding huginn's own answer back changes nothing — convergence, in one pass.
    expect(rebuild('"ai, general, javascript"')).toBe("ai, general, javascript");
    // A line huginn wrote comes back byte-identical on the first pass already.
    expect(rebuild('"ai, general"')).toBe("ai, general");
  });

  test("a hand-added tag survives a Vimeo re-run", async () => {
    const raw = [
      "---",
      'date: "2026-09-01"',
      'url: "https://vimeo.com/1234567"',
      'summary_kind: "standard"',
      'category: "ai/general"',
      'tags: "ai, general, javazone"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      "Hei.",
      "",
    ].join("\n");
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "vimeo", docId: "ai/general/En Talk.md" });
    await settle();
    expect(rec.ingests[0]!.body.tags).toEqual(["javazone"]);
  });

  test("YouTube sends none, because its ingest model has no such field", async () => {
    // Re-sending a key pydantic drops (`extra='ignore'`) would look like a fix
    // and be inert. The loss is huginn's; it is stated, not worked around.
    const raw = youtubeDoc().replace('tags: "ai, general"', 'tags: "ai, general, javascript"');
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    expect(rec.ingests[0]!.body).not.toHaveProperty("tags");
  });
});

describe("the Vimeo output language", () => {
  function vimeoDoc(opts: { summaryLang?: string; captionLang?: string; transcript: string }): string {
    return [
      "---",
      'date: "2026-09-01"',
      'url: "https://vimeo.com/1234567"',
      `caption_lang: "${opts.captionLang ?? "en-x-autogen"}"`,
      'caption_kind: "auto"',
      'summary_kind: "standard"',
      ...(opts.summaryLang === undefined ? [] : [`summary_lang: "${opts.summaryLang}"`]),
      'category: "ai/general"',
      'tags: "ai, general"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      opts.transcript,
      "",
    ].join("\n");
  }

  /** Enough Norwegian function words to clear `detectTextLang`'s floors. */
  const NORWEGIAN =
    "og det er som ikke på til et jeg vi har med av den kan skal var også om så her da " +
    "når hva hvordan litt veldig bare noe mye eller fra seg man denne dette være blir";

  test("a stored summary_lang wins", async () => {
    const { deps, rec } = makeDeps(vimeoDoc({ summaryLang: "nb", transcript: "the and is to of that it in you" }));
    await post(appFor(deps), { source: "vimeo", docId: "ai/general/En Talk.md" });
    await settle();
    expect(rec.prompts[0]!.system).toContain("Norwegian (bokm");
  });

  test("with the field ABSENT the language is resolved the way the capture resolves it", async () => {
    // What this replaces answered English for every document written before
    // `summary_lang` existed — a Norwegian talk re-summarized in English under a
    // reader who asked for the same settings again. The caption TAG here says
    // English (Vimeo really does mis-tag: measured 2026-09-05), so the TEXT is
    // what has to decide.
    const { deps, rec } = makeDeps(vimeoDoc({ transcript: NORWEGIAN }));
    await post(appFor(deps), { source: "vimeo", docId: "ai/general/En Talk.md" });
    await settle();
    expect(rec.prompts[0]!.system).toContain("Norwegian (bokm");
  });

  test("an English transcript with no stored language still resolves English", async () => {
    const english =
      "the and is to of that it in you this are was with have we be on not they what can so but do if";
    const { deps, rec } = makeDeps(vimeoDoc({ captionLang: "no-x-autogen", transcript: english }));
    await post(appFor(deps), { source: "vimeo", docId: "ai/general/En Talk.md" });
    await settle();
    expect(rec.prompts[0]!.system).toContain("write the summary in English");
  });
});


// ---------------------------------------------------------------------------
// The SHORT-VIDEO pair, after muninn #544 merged their capture into one job
// ---------------------------------------------------------------------------

describe("the short-video verticals", () => {
  /**
   * A stored TikTok capture with the appendix PR 4 gives it — flat whisper
   * prose, no `### [HH:MM:SS]` windows — and the full frontmatter huginn writes.
   */
  function tiktokDoc(opts: { transcript?: string; body?: string } = {}): string {
    return [
      "---",
      'date: "2026-09-01"',
      `url: "${TIKTOK_URL}"`,
      'author: "an invented account"',
      'summary_kind: "standard"',
      'category: "ai/general"',
      'tags: "ai, general"',
      "---",
      "",
      opts.body ?? "The stored short-video summary.",
      "",
      "## Transcript",
      "",
      opts.transcript ?? FLAT_TRANSCRIPT,
      "",
    ].join("\n");
  }

  const TIKTOK_DOC_ID = "ai/general/An invented short video.md";

  test("the acceptance sweep: same settings again re-sends every field but summary_kind", async () => {
    const { deps, rec } = makeDeps(tiktokDoc());
    const res = await post(appFor(deps), { source: "tiktok", docId: TIKTOK_DOC_ID });
    expect(res.status).toBe(200);
    await settle();

    // ONE model call, ONE ingest — the whole run.
    expect(rec.prompts).toHaveLength(1);
    expect(rec.ingests).toHaveLength(1);
    const { path, body } = rec.ingests[0]!;
    expect(path).toBe("/api/tiktok/ingest");
    // Every field the vertical's ingest model accepts, re-sent verbatim; the
    // title from the file name and the category from its directory.
    expect(body.title).toBe("An invented short video");
    expect(body.category).toBe("ai/general");
    expect(body.url).toBe(TIKTOK_URL);
    expect(body.date).toBe("2026-09-01");
    expect(body.author).toBe("an invented account");
    expect(body.tags).toBeUndefined(); // `ai, general` IS the category, nothing extra
    // The one field a re-run changes — here to the same value, because "same
    // settings again" ran the stored kind. The POINT is that it was SENT.
    expect(body.summary_kind).toBe("standard");

    // The appendix comes back byte-equal after the trim, under its own heading.
    const summary = String(body.summary);
    expect(summary.endsWith(`\n\n## Transcript\n\n${FLAT_TRANSCRIPT}\n`)).toBe(true);
    expect(summary).toContain("A fresh summary.");
  });

  test("the system prompt is the ZERO-FRAME form: it never mentions a frame", async () => {
    // A re-run has no work dir and no JPEGs. The frames-present form orders the
    // model to "Read ALL the frame images listed below" over a user prompt that
    // lists none, and tells it not to narrate them — three instructions about
    // material that is not there.
    const { deps, rec } = makeDeps(tiktokDoc());
    await post(appFor(deps), { source: "tiktok", docId: TIKTOK_DOC_ID });
    await settle();
    const system = rec.prompts[0]!.system;
    expect(system).not.toMatch(/frames?/i);
    expect(system).toContain("from its speech transcript");
    // The rule about the whole ANSWER stays on both forms; only its
    // frame-specific second sentence goes.
    expect(system).toContain("produce NO commentary");
    // And the CAPTURE's own form still mentions them, so this is a branch and
    // not a builder that lost the clause.
    const capture = buildShortVideoSystemPrompt(TIKTOK_SPEC, {
      preset: SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "standard")!,
      title: "An invented short video",
      url: TIKTOK_URL,
      author: "an invented account",
    });
    expect(capture).toMatch(/frames?/i);
  });

  test("the run's thinking budget is the VERTICAL's, the same one the capture sends", async () => {
    // `src/video/short-video.ts` passes `SHORT_VIDEO_THINKING` on every kind
    // while the presets say `capped`, so deriving this from the preset would
    // send an 8k cap where the capture it re-runs sends the bot's own budget.
    const { deps, rec } = makeDeps(tiktokDoc());
    await post(appFor(deps), { source: "tiktok", docId: TIKTOK_DOC_ID });
    await settle();
    expect(rec.prompts[0]!.thinkingMaxTokens).toBe(SHORT_VIDEO_THINKING);
    // Not merely "null-ish": `undefined` is what `runCaptureOneShot` reads as
    // the 8k cap, and that is the wrong answer this pins against.
    expect(rec.prompts[0]!.thinkingMaxTokens).not.toBeUndefined();
  });

  async function optionKinds(bot: BotConfig): Promise<string[]> {
    const app = appFor(makeDeps(tiktokDoc(), { bot }).deps);
    const payload = (await (
      await app.request(
        `/api/summaries/rerun/options?source=tiktok&docId=${encodeURIComponent(TIKTOK_DOC_ID)}`,
      )
    ).json()) as { kinds: Array<{ id: string }> };
    return payload.kinds.map((k) => k.id);
  }

  test("the menu offers the short-video kinds at all — the picker these two gained in #544", async () => {
    expect(await optionKinds(BOT)).toEqual(capturePresetOptions(shortVideoCaptureKinds(BOT)).map((k) => k.id));
    expect(await optionKinds(BOT)).toContain("deep");
  });

  test("it is the SHORT-VIDEO set, which a Copilot bot narrows and the shared one does not", async () => {
    // The one connector where `requireThinkingControl` is observable: Copilot
    // carries the opus id verbatim (so `resolveCapturePresets` keeps `deep`)
    // but honours no thinking budget (so the short-video set drops it). On
    // claude-cli the two sets are extensionally equal, which is why a
    // claude-cli-only comparison could not tell the two resolvers apart.
    const copilot = { ...BOT, connector: "copilot-sdk" } as BotConfig;
    expect(resolveCapturePresets(copilot.prompts, copilot.connector).map((p) => p.id)).toContain("deep");
    expect(shortVideoCaptureKinds(copilot).map((p) => p.id)).not.toContain("deep");
    expect(await optionKinds(copilot)).not.toContain("deep");
    expect(await optionKinds(copilot)).toEqual(
      capturePresetOptions(shortVideoCaptureKinds(copilot)).map((k) => k.id),
    );
  });

  test("the X twin runs on its OWN spec, warn and all", async () => {
    // `visualWarning` is TRUE on TikTok and FALSE on X; handing either the
    // neighbour's spec is how a re-run acquires or loses a warn its capture
    // declared. Both are re-run with ZERO frames, so neither can fire here —
    // what this pins is that the two specs reach their own entries at all.
    expect(TIKTOK_SPEC.visualWarning).toBe(true);
    expect(X_VIDEO_SPEC.visualWarning).toBe(false);
    const xDoc = tiktokDoc().replace(TIKTOK_URL, "https://x.com/someone/status/1234567890");
    const { deps, rec } = makeDeps(xDoc);
    await post(appFor(deps), { source: "x-article", docId: TIKTOK_DOC_ID });
    await settle();
    // The X platform noun, not TikTok's — the one string the two prompt specs
    // differ in on the zero-frame form.
    expect(rec.prompts[0]!.system).toContain("X/Twitter");
    expect(rec.prompts[0]!.system).not.toContain("TikTok");
    // …and it is the ZERO-FRAME form here too. The flag is per ENTRY, so the
    // TikTok assertion above says nothing about this one.
    expect(rec.prompts[0]!.system).not.toMatch(/frames?/i);
    expect(rec.prompts[0]!.system).toContain("from its speech transcript");
    expect(rec.ingests[0]!.path).toBe("/api/x-articles/ingest");
  });
});

// ---------------------------------------------------------------------------
// Re-appending the appendix
// ---------------------------------------------------------------------------

describe("the transcript capper the re-append picks", () => {
  /**
   * A FLAT transcript over the cap must go through the FLAT capper.
   *
   * The window capper's unit is a `\n\n`-separated `### [HH:MM:SS]` bucket; a
   * whisper transcript has none, so it is ONE element that fits no budget and
   * the answer falls through to a head cut at whatever newline the layout
   * offers — which for a first line longer than the budget is the ~64-byte
   * truncation note ALONE. Measured in `transcript-appendix.ts`.
   */
  test("a flat over-cap transcript keeps its HEAD, not the note alone", async () => {
    // One line longer than the cap, then more — the shape the window capper
    // answers with the note by itself.
    const flat = `${"a".repeat(TRANSCRIPT_MAX_BYTES + 10)}\nand a second line.`;
    const raw = [
      "---",
      'date: "2026-09-01"',
      `url: "${TIKTOK_URL}"`,
      'author: "an invented account"',
      'category: "ai/general"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      flat,
      "",
    ].join("\n");
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "tiktok", docId: "ai/general/A long flat one.md" });
    await settle();
    const summary = String(rec.ingests[0]!.body.summary);
    const appendix = summary.slice(summary.indexOf("\n\n## Transcript\n\n") + "\n\n## Transcript\n\n".length);
    expect(appendix).toContain(TRANSCRIPT_TRUNCATION_NOTE);
    // The head survived: hundreds of thousands of bytes of talk, not 64.
    expect(appendix.startsWith("aaaa")).toBe(true);
    expect(Buffer.byteLength(appendix, "utf8")).toBeGreaterThan(TRANSCRIPT_MAX_BYTES / 2);
  });

  test("a WINDOWED over-cap transcript still cuts at a window boundary", async () => {
    // The other half of the same decision: the window capper is right here, and
    // a flat cut mid-window would leave a `### [HH:MM:SS]` heading over half a
    // sentence for huginn's heading splitter to carry into a chunk.
    const window = (i: number) =>
      `### [0${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00]\n\n${"w".repeat(4000)}`;
    const windows: string[] = [];
    for (let i = 0; Buffer.byteLength(windows.join("\n\n"), "utf8") < TRANSCRIPT_MAX_BYTES + 8000; i++) {
      windows.push(window(i));
    }
    const transcript = windows.join("\n\n");
    const raw = youtubeDoc({ transcript });
    const { deps, rec } = makeDeps(raw);
    await post(appFor(deps), { source: "youtube", docId: DOC_ID });
    await settle();
    const summary = String(rec.ingests[0]!.body.summary);
    const appendix = summary.slice(summary.indexOf("\n\n## Transcript\n\n") + "\n\n## Transcript\n\n".length);
    expect(appendix).toContain(TRANSCRIPT_TRUNCATION_NOTE);
    const body = appendix.slice(0, appendix.indexOf(`\n\n${TRANSCRIPT_TRUNCATION_NOTE}`));
    // The cut is at a `\n\n` BOUNDARY of the original — the property the flat
    // capper does not have: `capTextWithNote` cuts at the last code point inside
    // the byte budget, which lands in the middle of a window's own text.
    expect(transcript.startsWith(body)).toBe(true);
    expect(transcript.slice(body.length).startsWith("\n\n")).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The single-flight claim's own bound
// ---------------------------------------------------------------------------

describe("the single-flight claim is bounded", () => {
  test("a run that never settles releases its claim, and a later POST gets through", async () => {
    // Without the bound this document is `409 in_flight` for the life of the
    // process: `runRerunJob` awaits the model call, and a call that never
    // settles never reaches the `finally`.
    const { deps, rec } = makeDeps(youtubeDoc(), { stall: true, latchBudgetMs: 30 });
    const app = appFor(deps);
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200);
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(409);
    await Bun.sleep(60);
    const third = await post(app, { source: "youtube", docId: DOC_ID });
    expect(third.status).toBe(200);
    // And it really did start a second run rather than reusing the first.
    await settle();
    expect(rec.prompts.length).toBe(2);
  });

  test("a run that settles AFTER its claim expired releases nothing", async () => {
    // The token half. Once the timer has released a stalled run's claim and a
    // SECOND run has taken the slot, the first run's `finally` must find a token
    // that is no longer the one on the key and do nothing — a bare `delete`
    // would open the second run's slot while it is still writing the file,
    // which is the exact race the single flight exists to stop.
    const gates: Array<() => void> = [];
    const rec: Recorded = { ingests: [], prompts: [] };
    const deps: SummariesRerunDeps = {
      fetchRawDoc: async () => ({ raw: youtubeDoc() }),
      ingest: async (o) => { rec.ingests.push({ path: o.ingestPath, body: o.body }); },
      oneShot: (async (o: Record<string, unknown>) => {
        rec.prompts.push({
          system: o.systemPrompt as string,
          user: o.prompt as string,
          url: o.url as string,
          title: o.title as string,
          source: o.source as string,
          thinkingMaxTokens: o.thinkingMaxTokens as number | null | undefined,
        });
        // Every call hangs until its own gate is opened, so run B is still in
        // flight at the moment run A settles.
        await new Promise<void>((r) => gates.push(r));
        return { result: "CATEGORY: ai/general\n\nSUMMARY:\n\nA fresh summary.", outputTokens: 1 };
      }) as unknown as SummariesRerunDeps["oneShot"],
      bots: () => [BOT],
      latchBudgetMs: 200,
    };
    const app = appFor(deps);

    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200); // A claims
    await Bun.sleep(260); // A's claim expires, untouched by A itself
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200); // B claims
    expect(gates).toHaveLength(2);
    gates[0]!(); // A settles, long after it lost the claim
    await settle();

    // B is still in flight and still holds the slot. With a token-less release,
    // A's `finally` deleted B's key and this answers 200.
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(409);
    // …and it really is B's own claim: it expires on B's timer, not A's.
    await Bun.sleep(220);
    expect((await post(app, { source: "youtube", docId: DOC_ID })).status).toBe(200);
    for (const open of gates) open();
    await settle();
  });

  test("the default bound outlives the model call it guards", () => {
    // A latch that expired before the run would hand a second POST a slot while
    // the first is still writing the file.
    const zero = rerunLatchBudgetMs(0, BOT);
    expect(zero).toBe(summarizeTimeoutFor(0, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS) + RERUN_LATCH_SLACK_MS);
    expect(zero).toBeGreaterThan(summarizeTimeoutFor(0, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS));
    // It grows with the frame count, exactly as the call's own budget does.
    expect(rerunLatchBudgetMs(60, BOT)).toBeGreaterThan(zero);
    // And a bot whose OWN timeout is longer than the capture budget wins.
    const slow = { ...BOT, timeoutMs: 3_600_000 } as BotConfig;
    expect(rerunLatchBudgetMs(0, slow)).toBe(3_600_000 + RERUN_LATCH_SLACK_MS);
  });
});

// ---------------------------------------------------------------------------
// The Vimeo half of the cadence opt-out
// ---------------------------------------------------------------------------

describe("the Vimeo frame list is not a cadence either", () => {
  test("the prompt states no spacing over a list of survivors", async () => {
    // `framesPromptSection` derives "one every ~N s of the talk" from the
    // MEDIAN gap. True of a sampler, false of `listKeptFrames` — which is
    // whatever the previous summary happened to QUOTE, so two survivors 30 s
    // and 900 s apart would tell the model the talk is sampled every ~870 s.
    const root = tempFramesRoot();
    const dir = join(root, VIMEO_FRAME_SOURCE.name, "1234567");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "30.jpg"), "x");
    writeFileSync(join(dir, "900.jpg"), "x");
    const raw = [
      "---",
      'date: "2026-09-01"',
      'url: "https://vimeo.com/1234567"',
      'caption_lang: "en"',
      'caption_kind: "manual"',
      'summary_kind: "standard"',
      'category: "ai/general"',
      "---",
      "",
      "Body.",
      "",
      "## Transcript",
      "",
      "### [00:00:00]\n\nHello.",
      "",
    ].join("\n");
    const { deps, rec } = makeDeps(raw, { framesRoot: root });
    await post(appFor(deps), { source: "vimeo", docId: "ai/general/A Vimeo talk.md" });
    await settle();
    const user = rec.prompts[0]!.user;
    // The frame list IS there — this is the opt-out, not a lost section.
    expect(user).toContain("Slide frames (read EVERY image");
    expect(user).not.toContain("one every ~");
  });
});
