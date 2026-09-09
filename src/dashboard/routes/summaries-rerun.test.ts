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
import { registerRecentIngestSink } from "../../summaries/recent-ingests.ts";
import { YOUTUBE_FRAME_SOURCE, copyKeptFrame } from "../../summaries/frames.ts";
import { getJob } from "../../youtube/state.ts";
import type { BotConfig } from "../../bots/config.ts";

const config = { knowledgeApiUrl: "http://127.0.0.1:1", tracingEnabled: false } as never;

const BOT = { name: "testbot", dir: "/nowhere", connector: "claude-cli" } as unknown as BotConfig;

const VIDEO_ID = "abcdefghijk"; // 11 URL-safe base64 characters, the seam's gate
const DOC_ID = "ai/general/A Talk About Things.md";

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
      });
      if (opts.stall) await new Promise(() => {});
      return { result: opts.answer ?? "CATEGORY: ai/general\n\nSUMMARY:\n\nA fresh summary.", outputTokens: 1 };
    }) as unknown as SummariesRerunDeps["oneShot"],
    bots: () => (opts.bot === null ? [] : [opts.bot ?? BOT]),
    ...(opts.framesRoot !== undefined ? { framesRoot: opts.framesRoot } : {}),
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
  // huginn's `sanitize_filename` STRIPS and only then truncates to 200, so a
  // stem cut on a space comes back one character shorter on the next pass — a
  // second file rather than an edit. Refused before any model spend.
  test("a stem at or past the cap is refused, and a shorter one is not", () => {
    expect(titleRoundTripRefusal("A Talk About Things")).toBeNull();
    expect(titleRoundTripRefusal("x".repeat(TITLE_ROUND_TRIP_MAX - 1))).toBeNull();
    expect(titleRoundTripRefusal("x".repeat(TITLE_ROUND_TRIP_MAX))).toContain("file name is 200 characters");
    expect(titleRoundTripRefusal("x".repeat(TITLE_ROUND_TRIP_MAX + 40))).toContain("240 characters");
  });

  test("a stem ending in whitespace is refused", () => {
    expect(titleRoundTripRefusal("A Talk ")).toContain("ends in whitespace");
    expect(titleRoundTripRefusal("A Talk")).toBeNull();
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
