import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  registerWikiGardenerRoutes,
  computeIngestBacklogResponse,
  computeBacklogFloorCounts,
  getIngestBacklogCached,
  mergeBacklogLiveFields,
  __resetIngestBacklogCacheForTest,
  type IngestBacklogDeps,
  type IngestBacklogResponse,
} from "./wiki-gardener-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { computeWatcherNextRun } from "../agents-overview.ts";
import type { Watcher } from "../../types.ts";

/**
 * Route-level resolution tests for `/api/wiki/linter-findings`. Mirrors the
 * `wiki-routes.test.ts` approach: only the deterministic resolution branches
 * that never reach real bot discovery are exercised here (a `WIKI_EXTRA`
 * standalone wiki is source !== "bot"; an unknown name resolves to nothing).
 * Both degrade to a 200 with an `error` field, never a 5xx. The actual lint
 * findings (broken link + orphan) are covered end-to-end in `src/wiki/lint.test.ts`.
 */
describe("GET /api/wiki/linter-findings — resolution errors", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-linter-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki (source !== "bot") — the linter is bot-wiki only.
    process.env.WIKI_EXTRA = `lintwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiGardenerRoutes(app);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("standalone (non-bot) wiki → 200 with a bot-only error, no findings", async () => {
    const res = await app.request("/api/wiki/linter-findings?wiki=lintwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; error?: string };
    expect(body.error).toContain("only available for bot wikis");
    expect(body.findings).toEqual([]);
  });

  test("unknown wiki → 200 with a not-configured error", async () => {
    const res = await app.request("/api/wiki/linter-findings?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; error?: string };
    expect(body.error).toContain("no wiki configured");
    expect(body.findings).toEqual([]);
  });

  // The ingest-backlog route shares the linter route's resolution + never-5xx
  // contract, so its deterministic resolution branches are exercised the same way.
  test("ingest-backlog: standalone (non-bot) wiki → 200 with a bot-only error", async () => {
    const res = await app.request("/api/wiki/ingest-backlog?wiki=lintwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { byCollection: unknown[]; queued: number; error?: string };
    expect(body.error).toContain("only available for bot wikis");
    expect(body.byCollection).toEqual([]);
    expect(body.queued).toBe(0);
  });

  test("ingest-backlog: unknown wiki → 200 with a not-configured error", async () => {
    const res = await app.request("/api/wiki/ingest-backlog?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { byCollection: unknown[]; error?: string };
    expect(body.error).toContain("no wiki configured");
    expect(body.byCollection).toEqual([]);
  });

  // The backlog-run + reset POSTs share the same resolution guards.
  test("backlog-run: standalone (non-bot) wiki → 400 bot-only error", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-run?wiki=lintwiki", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("only available for bot wikis");
  });

  test("backlog-run: unknown wiki → 404 not-configured", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-run?wiki=does-not-exist", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  test("backlog-reset: standalone (non-bot) wiki → 400 bot-only error", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-reset?wiki=lintwiki", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("only available for bot wikis");
  });

  // backlog-cancel shares the same resolution guards as reset.
  test("backlog-cancel: standalone (non-bot) wiki → 400 bot-only error", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-cancel?wiki=lintwiki", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("only available for bot wikis");
  });

  test("backlog-cancel: unknown wiki → 404 not-configured", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-cancel?wiki=does-not-exist", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  // backlog-recover / backlog-dismiss (PR 3) share the same resolution guards.
  test("backlog-recover: standalone (non-bot) wiki → 400 bot-only error", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-recover?wiki=lintwiki", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("only available for bot wikis");
  });

  test("backlog-recover: unknown wiki → 404 not-configured", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-recover?wiki=does-not-exist", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  test("backlog-dismiss: standalone (non-bot) wiki → 400 bot-only error", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-dismiss?wiki=lintwiki", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("only available for bot wikis");
  });

  test("backlog-dismiss: unknown wiki → 404 not-configured", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-dismiss?wiki=does-not-exist", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });
});

/**
 * The extended GET merges per-request live fields OUTSIDE the TTL cache. This
 * pins the non-mutation contract: `mergeBacklogLiveFields` must never touch the
 * cached (by-reference) payload, so a second merge with fresh `running` reflects
 * the new value while the cached object is unchanged (and never leaks `queuedKeys`).
 */
describe("watcher nextRunAt projection honors the time-of-day gate (FIX 1)", () => {
  // The wire `nextRunAt` is `computeWatcherNextRun(...).nextRunAt`, mapped so any
  // result at-or-before `now` becomes null ("due on next tick"). This mirrors the
  // route's exact mapping. The bug being guarded: naive `lastRunAt + intervalMs`
  // math projected a PAST instant once the 7d interval elapsed at, say, 03:00 Oslo,
  // making the strip say "due on next tick" though the run actually fires ~10:00.
  const DAY = 86_400_000;
  const HOUR = 3_600_000;

  function gardenerWatcher(over: Partial<Watcher> = {}): Watcher {
    return {
      id: "gard-1",
      userId: "u",
      botName: "jarvis",
      name: "wiki-gardener",
      type: "wiki-gardener",
      config: { hour: 10 }, // Oslo time-of-day gate
      intervalMs: 7 * DAY,
      enabled: true,
      lastRunAt: null,
      lastNotifiedIds: [],
      forceNextRun: false,
      createdAt: 0,
      updatedAt: 0,
      ...over,
    } as Watcher;
  }

  /** The route's exact mapping from the projection onto the `number | null` wire field. */
  function wireNextRunAt(w: Watcher, now: number): number | null {
    const projected = computeWatcherNextRun(w, now).nextRunAt;
    return projected > now ? projected : null;
  }

  test("interval elapsed at 03:00 Oslo ⇒ projects the ~10:00 slot, NOT null/past-due", () => {
    // 2026-06-15 03:00 Oslo (CEST = UTC+2) ⇒ 01:00 UTC.
    const now = Date.parse("2026-06-15T01:00:00Z");
    // Last run ~7d+1h ago ⇒ the 7d interval gate has just elapsed (naive math =
    // lastRunAt + 7d = now − 1h, which is in the PAST → the old bug).
    const lastRunAt = now - (7 * DAY + HOUR);
    expect(lastRunAt + 7 * DAY).toBeLessThan(now); // naive math is past-due

    const wire = wireNextRunAt(gardenerWatcher({ lastRunAt }), now);
    // The canonical projection returns today's 10:00 Oslo slot (08:00 UTC) — a real
    // FUTURE instant, so the wire carries a number the strip renders as "~7h".
    expect(wire).not.toBeNull();
    expect(wire).toBe(Date.parse("2026-06-15T08:00:00Z"));
    expect(wire! - now).toBe(7 * HOUR);
  });

  test("never-run gardener still projects the next 10:00 slot (the hour gate applies)", () => {
    // At 03:00 Oslo, a never-run watcher WITH an hour gate projects today's 10:00
    // slot (08:00 UTC), not the pure-interval "due now" sentinel — the gate applies.
    const now = Date.parse("2026-06-15T01:00:00Z");
    expect(wireNextRunAt(gardenerWatcher({ lastRunAt: null }), now)).toBe(
      Date.parse("2026-06-15T08:00:00Z"),
    );
  });

  test("force-queued ⇒ maps to null (due on next tick; the queued note owns the copy)", () => {
    const now = Date.parse("2026-06-15T01:00:00Z");
    // Force-queued: computeWatcherNextRun returns `now` regardless of the gate ⇒ the
    // route maps it to null, so the strip's queued note owns the "starts on the next
    // scheduler tick" copy instead of a contradicting next-run time.
    expect(
      wireNextRunAt(gardenerWatcher({ lastRunAt: now - 3 * DAY, forceNextRun: true }), now),
    ).toBeNull();
  });
});

describe("mergeBacklogLiveFields — live fields outside the cache", () => {
  const cached: IngestBacklogResponse = {
    byCollection: [],
    total: 3,
    ingested: 1,
    queued: 2,
    wikiUrlCount: 5,
    generatedAt: 111,
    queuedKeys: [{ key: "c/a", id: "a", collection: "c" }, { key: "c/b", id: "b", collection: "c" }],
  };

  test("merges live fields without mutating the cached payload; strips queuedKeys", () => {
    const first = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 0,
      remaining: 2,
      offeredStillQueued: 0,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      watcherSeeded: true,
      gardenerEnabled: true,
      progress: null,
    });
    expect(first.running).toBe(false);
    expect(first.queued).toBe(2);
    expect(first.progress).toBeNull();
    expect("queuedKeys" in first).toBe(false); // server-only, never on the wire

    // A later request sees fresh `running: true` + live progress from the SAME cached object.
    const second = mergeBacklogLiveFields(cached, {
      running: true,
      offered: 2,
      remaining: 0,
      offeredStillQueued: 2,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: { finishedAt: 222, offered: 2, drafted: 1 },
      watcherSeeded: true,
      gardenerEnabled: true,
      progress: {
        stage: "drafting",
        draftsDone: 1,
        draftsTotal: 3,
        currentTopic: "ai-agents",
        startedAt: 999,
        cancelRequested: false,
      },
    });
    expect(second.running).toBe(true);
    expect(second.remaining).toBe(0);
    expect(second.lastBacklogRun).toEqual({ finishedAt: 222, offered: 2, drafted: 1 });
    expect(second.progress).toEqual({
      stage: "drafting",
      draftsDone: 1,
      draftsTotal: 3,
      currentTopic: "ai-agents",
      startedAt: 999,
      cancelRequested: false,
    });

    // The cached object was never mutated by either merge.
    expect(cached.queuedKeys).toEqual([{ key: "c/a", id: "a", collection: "c" }, { key: "c/b", id: "b", collection: "c" }]);
    expect("running" in cached).toBe(false);
  });

  test("always emits the shared batch constants for the client confirm panel", () => {
    const merged = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 0,
      remaining: 2,
      offeredStillQueued: 0,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      watcherSeeded: true,
      gardenerEnabled: true,
      progress: null,
    });
    // Sourced from src/gardener/backlog.ts — the client never hardcodes them.
    expect(merged.batchSize).toBe(40);
    expect(merged.maxProposals).toBe(8);
  });

  test("carries the per-bot minClusterSize through to the wire (run-suggestion meter threshold)", () => {
    // Unlike batchSize/maxProposals (merge-time constants), minClusterSize is per-bot
    // (from resolveGardenerConfig) and rides on the live fields so the strip's meter
    // never hardcodes 3.
    const merged = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 0,
      remaining: 2,
      offeredStillQueued: 0,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 5,
      lastBacklogRun: null,
      watcherSeeded: true,
      gardenerEnabled: true,
      progress: null,
    });
    expect(merged.minClusterSize).toBe(5);
  });

  test("carries the watcher block through to the wire (Run-gardener-now affordance)", () => {
    const merged = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 0,
      remaining: 2,
      offeredStillQueued: 0,
      fresh: 3,
      freshBySource: [{ label: "YouTube", count: 3 }],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      watcherSeeded: true,
      gardenerEnabled: true,
      watcher: { id: "w-1", enabled: true, lastRunAt: 1000, nextRunAt: 1000 + 604_800_000, forceQueued: false },
      progress: null,
    });
    expect(merged.watcher).toEqual({
      id: "w-1",
      enabled: true,
      lastRunAt: 1000,
      nextRunAt: 1000 + 604_800_000,
      forceQueued: false,
    });

    // No seeded watcher ⇒ null carries through cleanly (no affordance).
    const noWatcher = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 0,
      remaining: 2,
      offeredStillQueued: 0,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      watcherSeeded: false,
      gardenerEnabled: true,
      watcher: null,
      progress: null,
    });
    expect(noWatcher.watcher).toBeNull();
  });

  test("carries the interrupted-run field through to the wire (PR 3 recovery banner)", () => {
    const merged = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 2,
      remaining: 0,
      offeredStillQueued: 2,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      watcherSeeded: true,
      gardenerEnabled: true,
      progress: null,
      interrupted: { at: 1700, batchSize: 40, drafted: 0 },
    });
    expect(merged.interrupted).toEqual({ at: 1700, batchSize: 40, drafted: 0 });

    // Absent/null interrupted still merges cleanly (no banner).
    const clean = mergeBacklogLiveFields(cached, {
      running: false,
      offered: 0,
      remaining: 2,
      offeredStillQueued: 0,
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      watcherSeeded: true,
      gardenerEnabled: true,
      progress: null,
      interrupted: null,
    });
    expect(clean.interrupted).toBeNull();
  });
});

/**
 * The route's `remaining`/`offeredStillQueued` floor branch — driven through the
 * exported pure `computeBacklogFloorCounts` (the same helper the GET handler calls).
 * Pins: a fresh dated doc is held back from `remaining`; an old dated doc counts; an
 * undated doc counts; an offered doc lands in `offeredStillQueued` (never `remaining`),
 * even when it is fresh. `minAgeDays` = 7; `now` fixed for determinism.
 */
describe("computeBacklogFloorCounts — route age-floor branch", () => {
  const NOW = Date.parse("2026-07-17T00:00:00Z");
  const MIN_AGE_DAYS = 7;
  const day = (iso: string) => iso; // readability alias

  test("fresh dated doc excluded from remaining; old + undated counted", () => {
    const queuedKeys = [
      { key: "youtube-summaries/2026-07-16-fresh", id: "2026-07-16-fresh", collection: "youtube-summaries", date: day("2026-07-16") }, // 1 day old → too fresh
      { key: "youtube-summaries/2026-06-01-old", id: "2026-06-01-old", collection: "youtube-summaries", date: day("2026-06-01") }, // 46 days → eligible
      { key: "youtube-summaries/undated", id: "undated", collection: "youtube-summaries" }, // no date → old backlog, eligible
    ];
    const { remaining, offeredStillQueued, freshByCollection } = computeBacklogFloorCounts(
      queuedKeys,
      new Set<string>(),
      MIN_AGE_DAYS,
      NOW,
    );
    expect(remaining).toBe(2); // old + undated
    expect(offeredStillQueued).toBe(0);
    // The held-back fresh doc lands in the fresh bucket, keyed by its collection —
    // the three buckets partition the queued set exactly.
    expect(freshByCollection).toEqual({ "youtube-summaries": 1 });
  });

  test("offered docs land in offeredStillQueued and never in remaining (even when old)", () => {
    const queuedKeys = [
      { key: "youtube-summaries/2026-06-01-old", id: "2026-06-01-old", collection: "youtube-summaries", date: day("2026-06-01") },
      { key: "youtube-summaries/2026-05-01-older", id: "2026-05-01-older", collection: "youtube-summaries", date: day("2026-05-01") },
    ];
    const offered = new Set(["youtube-summaries/2026-06-01-old"]);
    const { remaining, offeredStillQueued } = computeBacklogFloorCounts(queuedKeys, offered, MIN_AGE_DAYS, NOW);
    expect(remaining).toBe(1); // only the not-offered old doc
    expect(offeredStillQueued).toBe(1); // the offered old doc
  });

  test("offered fresh docs count as tail, never fresh (pre-#288 burns stay in the offered bucket)", () => {
    const queuedKeys = [
      { key: "youtube-summaries/2026-07-16-a", id: "2026-07-16-a", collection: "youtube-summaries", date: day("2026-07-16") }, // fresh, offered
      { key: "x-articles/2026-07-16-b", id: "2026-07-16-b", collection: "x-articles", date: day("2026-07-16") }, // fresh, un-offered
    ];
    const offered = new Set(["youtube-summaries/2026-07-16-a"]);
    const { remaining, offeredStillQueued, freshByCollection } = computeBacklogFloorCounts(
      queuedKeys,
      offered,
      MIN_AGE_DAYS,
      NOW,
    );
    expect(remaining).toBe(0);
    expect(offeredStillQueued).toBe(1); // the offered-while-fresh doc
    expect(freshByCollection).toEqual({ "x-articles": 1 }); // only the un-offered one
  });

  test("bare id drives the filename-prefix date fallback (composite key would defeat it)", () => {
    // No explicit `date` — the floor must read the YYYY-MM-DD prefix from the BARE
    // id. A fresh-prefixed undated doc is therefore correctly held back.
    const queuedKeys = [
      { key: "youtube-summaries/2026-07-16-fresh", id: "2026-07-16-fresh", collection: "youtube-summaries" }, // fresh via id prefix
      { key: "youtube-summaries/2026-06-01-old", id: "2026-06-01-old", collection: "youtube-summaries" }, // old via id prefix
    ];
    const { remaining } = computeBacklogFloorCounts(queuedKeys, new Set<string>(), MIN_AGE_DAYS, NOW);
    expect(remaining).toBe(1); // only the old-prefixed doc
  });
});

/**
 * End-to-end backlog pipeline (wiki URL sweep + huginn listings + partition) and
 * the TTL cache/single-flight/refresh mechanics — driven directly against the
 * exported compute + cache helpers with a temp wiki dir, a stubbed huginn fetch,
 * and injected coverage deps (no DB, no real bot discovery, no `claude` spawn).
 */
describe("ingest-backlog pipeline + cache", () => {
  let root: string;
  let fetchCalls: string[] = [];
  let origFetch: typeof fetch;
  let failCollections = new Set<string>();

  /** Per-collection listing fixtures — all docs carry a url (huginn omits url-less). */
  const listings: Record<string, Array<{ id: string; url: string; date?: string }>> = {
    "youtube-summaries": [
      { id: "y1", url: "https://youtu.be/y1", date: "2026-06-01" }, // referenced in wiki
      { id: "y2", url: "https://youtu.be/y2", date: "2026-06-02" }, // consumed
      { id: "y3", url: "https://youtu.be/y3", date: "2026-06-03" }, // queued
    ],
    "x-articles": [{ id: "x1", url: "https://x.com/a/1" }], // referenced in wiki
    "anthropic-summaries": [],
    "tiktok-summaries": [],
    "article-summaries": [],
  };

  function deps(overrides?: { consumed?: string[]; pending?: string[] }): IngestBacklogDeps {
    return {
      getConsumed: async () => new Set(overrides?.consumed ?? []),
      getPending: async () => new Set(overrides?.pending ?? []),
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-backlog-"));
    // A wiki page that cites y1 (with a timestamp — normalization must collapse
    // it) and x1. anthropic/tiktok are cited nowhere.
    await Bun.write(
      path.join(root, "notes.md"),
      "# Notes\nWatch [it](https://youtu.be/y1?t=42s) and read https://x.com/a/1 for context.\n",
    );
    fetchCalls = [];
    failCollections = new Set();
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      const m = url.match(/\/api\/collection\/([^/]+)\/documents/);
      const collection = m ? m[1]! : "";
      if (failCollections.has(collection)) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ documents: listings[collection] ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    __resetIngestBacklogCacheForTest();
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    __resetIngestBacklogCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("reconciles: URL-referenced + consumed count as ingested, the rest queued", async () => {
    const data = await computeIngestBacklogResponse(root, "jarvis", deps({ consumed: ["youtube-summaries/y2"] }));

    // Two distinct normalized URLs swept from the wiki (y1 timestamp stripped).
    expect(data.wikiUrlCount).toBe(2);

    const yt = data.byCollection.find((c) => c.collection === "youtube-summaries")!;
    expect(yt.source).toBe("youtube");
    expect(yt.label).toBe("YouTube");
    expect(yt.total).toBe(3);
    expect(yt.ingested).toBe(2); // y1 (url-referenced) + y2 (consumed)
    expect(yt.queued).toBe(1); // y3
    // Counts only over the wire — the module's queuedDocs list (PR 2's drain
    // input, up to ~hundreds of doc objects) must NOT ship in the HTTP payload.
    expect("queuedDocs" in yt).toBe(false);

    const x = data.byCollection.find((c) => c.collection === "x-articles")!;
    expect(x.total).toBe(1);
    expect(x.queued).toBe(0); // x1 referenced by url in the wiki

    // byCollection is in SUMMARY_SOURCES order and covers every collection.
    expect(data.byCollection.map((c) => c.source)).toEqual(["youtube", "x-article", "anthropic", "tiktok", "article"]);

    expect(data.total).toBe(4);
    expect(data.ingested).toBe(3);
    expect(data.queued).toBe(1);
    expect(data.total).toBe(data.ingested + data.queued);
    expect(data.errors).toBeUndefined();
  });

  test("fetches each collection SEQUENTIALLY, one request per collection", async () => {
    await computeIngestBacklogResponse(root, "jarvis", deps());
    expect(fetchCalls.length).toBe(5);
  });

  test("a failed collection lands in errors with partial data (never a throw)", async () => {
    failCollections = new Set(["anthropic-summaries"]);
    const data = await computeIngestBacklogResponse(root, "jarvis", deps());
    expect(data.errors).toBeDefined();
    expect(data.errors!.map((e) => e.source)).toContain("anthropic");
    // The other collections still partitioned.
    expect(data.byCollection.find((c) => c.collection === "youtube-summaries")!.total).toBe(3);
  });

  test("caches within the TTL and ?refresh bypasses; single-flights concurrent misses", async () => {
    const d = deps({ consumed: ["youtube-summaries/y2"] });

    await getIngestBacklogCached(root, "jarvis", d, false);
    expect(fetchCalls.length).toBe(5);

    // Served from cache — no new fetches.
    await getIngestBacklogCached(root, "jarvis", d, false);
    expect(fetchCalls.length).toBe(5);

    // refresh bypasses the cache read.
    await getIngestBacklogCached(root, "jarvis", d, true);
    expect(fetchCalls.length).toBe(10);

    // Concurrent misses share one computation (single-flight).
    __resetIngestBacklogCacheForTest();
    fetchCalls = [];
    await Promise.all([
      getIngestBacklogCached(root, "jarvis", d, false),
      getIngestBacklogCached(root, "jarvis", d, false),
    ]);
    expect(fetchCalls.length).toBe(5);
  });

  test("a degraded (errors) result is NOT cached — the next request re-fetches", async () => {
    const d = deps();
    failCollections = new Set(["anthropic-summaries"]);
    const first = await getIngestBacklogCached(root, "jarvis", d, false);
    expect(first.errors).toBeDefined();
    expect(fetchCalls.length).toBe(5);

    // Huginn recovers — a plain request must re-fetch (not serve the degraded cache).
    failCollections = new Set();
    const second = await getIngestBacklogCached(root, "jarvis", d, false);
    expect(second.errors).toBeUndefined();
    expect(fetchCalls.length).toBe(10);

    // The clean result IS cached now.
    await getIngestBacklogCached(root, "jarvis", d, false);
    expect(fetchCalls.length).toBe(10);
  });
});
