/**
 * A summary re-run against a `/summaries` Delete, on the REAL test database:
 * the re-run route and the delete route mounted on one app, sharing the
 * process-wide claim registry, with huginn faked in-process (one `docRaw`
 * standing for the file) and the model call gated by the test.
 *
 * The three races the plan's acceptance names (mimir
 * `plans/muninn-architecture-review-2026-10.mdx`, finding 3):
 *
 *  1. a delete while a re-run holds the claim is 409, and the document — the
 *     file and its fact-check row — is untouched;
 *  2. a re-run whose claim lapsed, then a delete, then the re-run's save: the
 *     save is refused and huginn sees ZERO ingest POSTs (before the fix the
 *     lapsed claim was re-taken and the deleted document written back);
 *  3. a delete between the re-run's read and its claim cannot happen, because
 *     the re-run claims before it reads.
 *
 * DB-backed because "untouched" includes the fact-check row the delete's
 * listener removes (`summary_factchecks`) and the delete's proposal cleanup.
 * Its own `bun test` link in the `test` and `test:db` chains. Fixtures invented.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTestDb } from "../../test/setup-db.ts";
import { getSummaryFactcheck, upsertSummaryFactcheck } from "../../db/summary-factchecks.ts";
import { summarySaveClaims } from "../../summaries/summary-save.ts";
import { registerSummariesRerunRoutes, type SummariesRerunDeps } from "./summaries-rerun.ts";
import {
  DEFAULT_BACKLOG_ROUTE_DEPS,
  registerWikiGardenerRoutes,
  __resetIngestBacklogCacheForTest,
  __setBotsForTest,
} from "./wiki-gardener-routes.ts";
import { defaultSummariesFactcheckDeps, registerSummariesFactcheckRoutes } from "./summaries-factcheck.ts";
import { __resetGardenerMutexForTest } from "../../gardener/backlog.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import type { BotConfig } from "../../bots/config.ts";

setupTestDb();

const VIDEO_ID = "abcdefghijk";
const DOC_ID = "ai/general/A Talk About Things.md";
const COLLECTION = "youtube-summaries";
const RAW = [
  "---",
  'date: "2026-09-01"',
  `url: "https://www.youtube.com/watch?v=${VIDEO_ID}"`,
  'summary_kind: "standard"',
  'category: "ai/general"',
  "---",
  "",
  "The stored summary.",
  "",
  "## Transcript",
  "",
  "### [00:00:00]",
  "",
  "Hello.",
  "",
].join("\n");

const BOT = { name: "racebot", dir: "/nowhere", connector: "claude-cli" } as unknown as BotConfig;

/** huginn, faked: the file, the DELETE count, and the ingest POSTs. */
let docRaw: string | null;
let deleteCalls: number;
let ingests: Array<Record<string, unknown>>;
/** Releases the gated model call. */
let releaseModel: () => void;
let modelGate: Promise<void>;
let root: string;
let framesRoot: string;
let origFetch: typeof fetch;
let app: Hono;

/** Set by a test that wants to observe the claim at the moment of the read. */
let onRead: (() => Promise<void>) | null;

function rerunDeps(over: Partial<SummariesRerunDeps> = {}): SummariesRerunDeps {
  return {
    fetchRawDoc: async () => {
      if (onRead) await onRead();
      return docRaw === null ? null : { raw: docRaw };
    },
    ingest: async (o) => {
      ingests.push(o.body);
      return { ok: true, status: 200, data: { file_path: DOC_ID } };
    },
    oneShot: (async () => {
      await modelGate;
      return { result: "CATEGORY: ai/general\n\nSUMMARY:\n\nA fresh summary.", outputTokens: 1 };
    }) as unknown as SummariesRerunDeps["oneShot"],
    bots: () => [BOT],
    framesRoot,
    // The SAME registry the delete route claims from — the whole point.
    claims: summarySaveClaims,
    ...over,
  };
}

function mount(over: Partial<SummariesRerunDeps> = {}): void {
  app = new Hono();
  registerSummariesRerunRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:1", tracingEnabled: false } as never, rerunDeps(over));
  registerWikiGardenerRoutes(app, {
    ...DEFAULT_BACKLOG_ROUTE_DEPS,
    getWikiGardenerWatcher: async () => ({
      id: "w-race",
      enabled: true,
      lastRunAt: null,
      intervalMs: 604_800_000,
      forceNextRun: false,
      config: {},
    }),
    getSnapshot: async () => null,
    setSnapshot: async () => {},
  });
}

async function rerun(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/api/summaries/rerun", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "youtube", docId: DOC_ID }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function del(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/api/wiki/gardener/backlog-doc-delete?wiki=racebot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collection: COLLECTION, id: DOC_ID }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await Bun.sleep(20);
}

beforeAll(() => {
  // The fact-check row goes with a deleted document through this listener; it
  // subscribes once per registration, so once per file.
  registerSummariesFactcheckRoutes(new Hono(), { knowledgeApiUrl: "http://127.0.0.1:1" } as never, {
    ...defaultSummariesFactcheckDeps("http://127.0.0.1:1"),
  });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "race-wiki-"));
  framesRoot = await mkdtemp(path.join(tmpdir(), "race-frames-"));
  await Bun.write(path.join(root, "notes.md"), "# Notes\n");
  docRaw = RAW;
  deleteCalls = 0;
  ingests = [];
  onRead = null;
  modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  summarySaveClaims.clear();

  origFetch = globalThis.fetch;
  // NEVER the real huginn: the DELETE moves `docRaw` away, anything else is an
  // empty listing.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      if (docRaw === null) {
        return Response.json({ detail: "not a member" }, { status: 404 });
      }
      deleteCalls++;
      docRaw = null;
      return Response.json({ status: "deleted", movedTo: "/tmp/deleted/x.md", reindex: { [COLLECTION]: "started" } });
    }
    void input;
    return Response.json({ documents: [] });
  }) as typeof fetch;

  __setBotsForTest([
    { name: "racebot", dir: root, persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], wikiDir: root },
  ] as unknown as Parameters<typeof __setBotsForTest>[0]);
  __setWikiRegistryForTest([{ name: "racebot", root, source: "bot" }]);
  __resetWikiCacheForTest();
  __resetIngestBacklogCacheForTest();
  __resetGardenerMutexForTest();

  await upsertSummaryFactcheck({
    collection: COLLECTION,
    docId: DOC_ID,
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    bodySha256: "a".repeat(64),
    answer: "### ❌ Claim 1/1 — Invented\n\nInvented correction.",
    claims: [{ index: 1, title: "Invented", verdict: "❌", outcome: "verified", sources: [] }],
    botName: "racebot",
  });
});

afterEach(async () => {
  releaseModel();
  await settle();
  globalThis.fetch = origFetch;
  summarySaveClaims.clear();
  __setBotsForTest(null);
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  __resetIngestBacklogCacheForTest();
  __resetGardenerMutexForTest();
  await rm(root, { recursive: true, force: true });
  await rm(framesRoot, { recursive: true, force: true });
});

afterAll(() => {
  summarySaveClaims.clear();
});

describe("summary re-run vs Delete", () => {
  test("a delete while a re-run holds the claim is 409 in_flight, and the document is untouched", async () => {
    mount();
    const started = await rerun();
    expect(started.status).toBe(200);
    expect(summarySaveClaims.isHeld("youtube", DOC_ID)).toBe(true);

    const refused = await del();
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("in_flight");
    // huginn was never asked, the file is still there, and so is its check.
    expect(deleteCalls).toBe(0);
    expect(docRaw).toBe(RAW);
    await settle();
    expect(await getSummaryFactcheck(COLLECTION, DOC_ID)).not.toBeNull();
  });

  test("a lapsed re-run's save is refused after a delete, with zero ingest POSTs", async () => {
    // A 30 ms claim: the model call outlives it, so the key is free for the
    // delete. The delete's own claim is what tells the lapsed run that a
    // newer writer touched the document.
    mount({ latchBudgetMs: 30 });
    const started = await rerun();
    expect(started.status).toBe(200);
    await Bun.sleep(60);
    expect(summarySaveClaims.isHeld("youtube", DOC_ID)).toBe(false);

    const deleted = await del();
    expect(deleted.status).toBe(200);
    expect(deleteCalls).toBe(1);
    expect(docRaw).toBeNull();

    releaseModel();
    await settle();
    expect(ingests).toHaveLength(0);
    expect(await getSummaryFactcheck(COLLECTION, DOC_ID)).toBeNull();
  });

  test("the re-run claims before it reads, so a delete during the read is 409", async () => {
    const seen: Array<{ held: boolean; deleteStatus: number }> = [];
    onRead = async () => {
      const held = summarySaveClaims.isHeld("youtube", DOC_ID);
      const res = await del();
      seen.push({ held, deleteStatus: res.status });
    };
    mount();
    const started = await rerun();
    expect(seen).toEqual([{ held: true, deleteStatus: 409 }]);
    expect(started.status).toBe(200);
    expect(deleteCalls).toBe(0);
    expect(docRaw).toBe(RAW);
  });
});
