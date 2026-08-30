import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  registerWikiGardenerRoutes,
  computeIngestBacklogResponse,
  computeBacklogFloorCounts,
  backlogDocLabel,
  sortBacklogDocsNewestFirst,
  attachDraftAttempts,
  getIngestBacklogCached,
  invalidateIngestBacklogCache,
  mergeBacklogLiveFields,
  __resetIngestBacklogCacheForTest,
  __setBotsForTest,
  type GardenerWatcherRef,
  type IngestBacklogDeps,
  type IngestBacklogResponse,
} from "./wiki-gardener-routes.ts";
import { runExclusive, __resetGardenerMutexForTest } from "../../gardener/backlog.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { computeWatcherNextRun } from "../agents-overview.ts";
import type { Watcher } from "../../types.ts";

/**
 * Route-level tests for `/api/wiki/linter-findings`. Mirrors the
 * `wiki-routes.test.ts` approach: only the deterministic branches that never reach
 * real bot discovery are exercised here — which, since the linter stopped being
 * bot-gated, includes the HAPPY path on a `WIKI_EXTRA` standalone wiki (linting is a
 * pure index read: no connector, no collections, no bot-keyed DB rows). Resolution
 * failures degrade to a 200 with an `error` field, never a 5xx. The check logic
 * itself is covered in `src/wiki/lint.test.ts`.
 */
describe("GET /api/wiki/linter-findings — standalone wikis + resolution errors", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-linter-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // A STANDALONE wiki (source !== "bot"), owned by no bot and backed by no
    // collections — exactly the shape the route used to refuse outright.
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

  test("standalone (non-bot) wiki → real findings, NOT a bot-only refusal", async () => {
    const res = await app.request("/api/wiki/linter-findings?wiki=lintwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      findings: { check: string; relPath: string; message: string }[];
      counts: Record<string, number>;
      error?: string;
    };
    expect(body.error).toBeUndefined();
    // The fixture page is a frontmatter concept with no `updated:`, no sources and
    // no inbound links — one finding per frontmatter-shaped check, on a wiki that
    // previously produced none at all.
    expect(body.findings.length).toBeGreaterThan(0);
    const checks = new Set(body.findings.map((f) => f.check));
    expect(checks.has("stale-updated")).toBe(true);
    expect(checks.has("missing-sources")).toBe(true);
    expect(checks.has("orphan")).toBe(true);
    expect(body.counts["stale-updated"]).toBe(1);
  });

  test("a future frontmatter stamp on a standalone wiki reaches the lint surface", async () => {
    // The regression this whole route change exists for: the reader's recency sort
    // drops an implausible future stamp SILENTLY by design, so the lint is its only
    // operator-visible signal — and on a standalone wiki there was no lint at all.
    const future = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    await Bun.write(
      path.join(root, "Future Page.md"),
      `---\ntype: concept\ntitle: Future Page\nupdated: ${future}\nsources:\n  - https://example.com\n---\n\nBody.`,
    );
    __resetWikiCacheForTest();

    const res = await app.request("/api/wiki/linter-findings?wiki=lintwiki");
    const body = (await res.json()) as { findings: { relPath: string; message: string }[] };
    const finding = body.findings.find((f) => f.relPath === "Future Page.md" && /in the future/.test(f.message));
    expect(finding).toBeDefined();
    expect(finding!.message).toContain(`updated: "${future}"`);
  });

  test("the legacy ?bot= alias resolves a standalone wiki too (the page's own client sends it)", async () => {
    const res = await app.request("/api/wiki/linter-findings?bot=lintwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.findings.length).toBeGreaterThan(0);
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
      lastSuccessAt: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: { finishedAt: 222, offered: 2, drafted: 1 },
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 5,
      lastBacklogRun: null,
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 3,
      freshBySource: [{ label: "YouTube", count: 3, collection: "youtube-summaries" }],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      weeklyRun: null,
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
      dismissed: 0,
      dismissedByCollection: {},
      fresh: 0,
      freshBySource: [],
      freshWindowDays: 14,
      minClusterSize: 3,
      lastBacklogRun: null,
      weeklyRun: null,
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

  /**
   * The backlog inspector's per-doc list rides on the SAME single pass as the
   * counts, so a count and its bucket membership can never disagree.
   */
  test("emits the classified doc list alongside the counts (buckets match the counts exactly)", () => {
    const queuedKeys = [
      { key: "youtube-summaries/2026-07-16-a", id: "2026-07-16-a", collection: "youtube-summaries", date: "2026-07-16", url: "https://youtu.be/a" }, // fresh
      { key: "youtube-summaries/2026-06-01-b", id: "2026-06-01-b", collection: "youtube-summaries", date: "2026-06-01" }, // drainable
      { key: "x-articles/2026-05-01-c", id: "2026-05-01-c", collection: "x-articles", date: "2026-05-01" }, // offered
    ];
    const offered = new Set(["x-articles/2026-05-01-c"]);
    const { remaining, offeredStillQueued, freshByCollection, docs } = computeBacklogFloorCounts(
      queuedKeys,
      offered,
      MIN_AGE_DAYS,
      NOW,
    );
    expect(remaining).toBe(1);
    expect(offeredStillQueued).toBe(1);
    expect(freshByCollection).toEqual({ "youtube-summaries": 1 });
    expect(docs.map((d) => d.bucket)).toEqual(["fresh", "drainable", "offered"]);
    // Bucket membership adds up to the counts it was derived from.
    expect(docs.filter((d) => d.bucket === "drainable").length).toBe(remaining);
    expect(docs.filter((d) => d.bucket === "offered").length).toBe(offeredStillQueued);
    // The url rides through from the listing for the row's "open ↗" link; a
    // url-less doc simply omits it (never a bogus empty string).
    expect(docs[0]!.url).toBe("https://youtu.be/a");
    expect(docs[1]!.url).toBeUndefined();
    expect(docs[0]!.label).toBe("2026-07-16-a");
  });
});

describe("backlogDocLabel + sortBacklogDocsNewestFirst — inspector row shaping", () => {
  test("label is the id basename with the extension stripped (huginn carries no title)", () => {
    expect(backlogDocLabel("career/Why 2026 Is the Year.md")).toBe("Why 2026 Is the Year");
    expect(backlogDocLabel("plain-id")).toBe("plain-id");
    expect(backlogDocLabel("a/b/c.mdx")).toBe("c");
    // A dotfile-ish basename keeps its name rather than collapsing to empty.
    expect(backlogDocLabel(".hidden")).toBe(".hidden");
    expect(backlogDocLabel("")).toBe("");
  });

  test("newest-first, undated last, input array untouched", () => {
    const docs = [
      { collection: "c", id: "b", label: "b", bucket: "fresh" as const, date: "2026-01-01" },
      { collection: "c", id: "u", label: "u", bucket: "fresh" as const },
      { collection: "c", id: "a", label: "a", bucket: "fresh" as const, date: "2026-06-01" },
    ];
    const sorted = sortBacklogDocsNewestFirst(docs);
    expect(sorted.map((d) => d.id)).toEqual(["a", "b", "u"]);
    expect(docs.map((d) => d.id)).toEqual(["b", "u", "a"]); // copy, not in place
  });
});

describe("attachDraftAttempts — the drafter's last outcome on a row", () => {
  const docs = [
    { collection: "x-articles", id: "ai/general/First, the graph itself.md", label: "First, the graph itself", bucket: "drainable" as const },
    { collection: "x-articles", id: "never-attempted.md", label: "never-attempted", bucket: "fresh" as const },
  ];
  const attempt = {
    collection: "x-articles",
    docId: "ai/general/First, the graph itself.md",
    outcome: "skipped" as const,
    degraded: false,
    reason: 'drafter judged the existing page "Graph Engineering" already covers this doc',
    title: "Graph Engineering",
    collidingPath: "concepts/Graph Engineering.md",
    proposalId: null,
    trigger: "capture" as const,
    attemptedAt: 1_700_000_000_000,
  };

  test("joins by <collection>/<id> and leaves un-attempted rows untouched", () => {
    const out = attachDraftAttempts(docs, new Map([[`${attempt.collection}/${attempt.docId}`, attempt]]));
    expect(out[0]!.draft?.outcome).toBe("skipped");
    expect(out[0]!.draft?.collidingPath).toBe("concepts/Graph Engineering.md");
    expect(out[0]!.draft?.at).toBe(1_700_000_000_000);
    // Absent means "never attempted" — the one honest reading of no row.
    expect(out[1]!.draft).toBeUndefined();
  });

  test("an empty map (missing migration / degraded read) returns the rows unchanged", () => {
    const out = attachDraftAttempts(docs, new Map());
    expect(out).toBe(docs); // same reference — the pre-ledger payload, byte for byte
  });

  test("null columns are omitted rather than emitted as nulls", () => {
    const out = attachDraftAttempts(docs.slice(0, 1), new Map([
      [`${attempt.collection}/${attempt.docId}`, { ...attempt, reason: null, title: null, collidingPath: null }],
    ]));
    expect(out[0]!.draft).toEqual({ outcome: "skipped", degraded: false, trigger: "capture", at: 1_700_000_000_000 });
  });
});

describe("docs=1 opt-in — the count-only default payload is unchanged", () => {
  const cachedDocs: IngestBacklogResponse = {
    byCollection: [],
    total: 2,
    ingested: 0,
    queued: 2,
    wikiUrlCount: 0,
    generatedAt: 5,
    queuedKeys: [{ key: "c/a", id: "a", collection: "c", url: "https://example.com/a" }],
  };
  const live = {
    running: false,
    offered: 0,
    remaining: 1,
    offeredStillQueued: 0,
    dismissed: 0,
    dismissedByCollection: {},
    fresh: 0,
    freshBySource: [],
    freshWindowDays: 14,
    minClusterSize: 3,
    lastBacklogRun: null,
    weeklyRun: null,
    watcherSeeded: true,
    gardenerEnabled: true,
    progress: null,
  };

  test("no docs field without the opt-in; present (and never the raw queuedKeys) with it", () => {
    const plain = mergeBacklogLiveFields(cachedDocs, live);
    expect("docs" in plain).toBe(false);
    expect("queuedKeys" in plain).toBe(false);

    const withDocs = mergeBacklogLiveFields(cachedDocs, {
      ...live,
      docs: [{ collection: "c", id: "a", label: "a", bucket: "drainable", url: "https://example.com/a" }],
    });
    expect("queuedKeys" in withDocs).toBe(false);
    expect(withDocs.docs).toEqual([
      { collection: "c", id: "a", label: "a", bucket: "drainable", url: "https://example.com/a" },
    ]);
    // Every other field is byte-identical to the count-only payload.
    const { docs: _drop, ...rest } = withDocs as Record<string, unknown>;
    expect(rest).toEqual(plain);
  });

  test("withDocs=false skips building the doc list; the counts are identical", () => {
    const queuedKeys = [
      { key: "c/2026-01-01-a", id: "2026-01-01-a", collection: "c" },
      { key: "c/2026-06-01-b", id: "2026-06-01-b", collection: "c" },
    ];
    const now = Date.parse("2026-07-17T00:00:00Z");
    const withDocs = computeBacklogFloorCounts(queuedKeys, new Set<string>(), 7, now, true);
    const countsOnly = computeBacklogFloorCounts(queuedKeys, new Set<string>(), 7, now, false);
    expect(countsOnly.docs).toEqual([]);
    expect(countsOnly.remaining).toBe(withDocs.remaining);
    expect(countsOnly.offeredStillQueued).toBe(withDocs.offeredStillQueued);
    expect(countsOnly.freshByCollection).toEqual(withDocs.freshByCollection);
  });
});

/**
 * Route-level integration through `registerWikiGardenerRoutes` — the whole GET
 * handler (resolution → cached compute → live merge → wire), not just the pure
 * helpers. A fabricated bot + registry (test-only pins) stands in for real bot
 * discovery, huginn listings come from a stubbed `fetch`, and the backlog deps are
 * injected, so nothing here touches the DB, huginn, or the real `bots/` folder.
 */
describe("GET /api/wiki/ingest-backlog — docs=1 through the route", () => {
  let root: string;
  let app: Hono;
  let origFetch: typeof fetch;

  /** Two YouTube docs: one with an explicit date, one dated only by its id prefix. */
  const listings: Record<string, Array<{ id: string; url?: string; date?: string }>> = {
    "youtube-summaries": [
      // Explicit date, OLDER than the prefix-dated doc below.
      { id: "old-doc.md", url: "https://youtu.be/old", date: "2020-01-01" },
      // No `date` field — its date lives in the id prefix (the docDateMs fallback).
      { id: "2026-01-05-prefixed.md", url: "https://youtu.be/pre" },
    ],
    "x-articles": [],
    "anthropic-summaries": [],
    "tiktok-summaries": [],
    "article-summaries": [],
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-inspector-route-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\nNothing cited here.\n");
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const m = String(input).match(/\/api\/collection\/([^/]+)\/documents/);
      const collection = m ? m[1]! : "";
      return new Response(JSON.stringify({ documents: listings[collection] ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    __setBotsForTest([
      { name: "inspectorbot", dir: root, persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], wikiDir: root },
    ] as unknown as Parameters<typeof __setBotsForTest>[0]);
    __setWikiRegistryForTest([{ name: "inspectorbot", root, source: "bot" }]);
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();

    app = new Hono();
    // No watcher seeded ⇒ empty offered set; no snapshots, no proposals.
    registerWikiGardenerRoutes(app, {
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => null,
      getSnapshot: async () => null,
      setSnapshot: async () => {},
      listProposals: async () => [],
      // Approve-path seams — unused by these backlog cases, present so the deps
      // object satisfies `BacklogRouteDeps` (see the approve read-only test).
      getProposalById: async () => null,
      approveProposal: async () => null,
    });
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    __setBotsForTest(null);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("no docs field without the opt-in", async () => {
    const res = await app.request("/api/wiki/ingest-backlog?wiki=inspectorbot");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBeUndefined();
    expect(body.queued).toBe(2);
    expect("docs" in body).toBe(false);
    expect("queuedKeys" in body).toBe(false);
  });

  test("docs=1 returns the classified list, ordered by the SAME date the drain selects by", async () => {
    const res = await app.request("/api/wiki/ingest-backlog?wiki=inspectorbot&docs=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      docs?: { id: string; label: string; bucket: string; date?: string }[];
    };
    expect(body.docs).toBeDefined();
    expect(body.docs!.length).toBe(2);
    // Both are years old ⇒ past the age floor ⇒ drainable; labels are the stripped basenames.
    expect(body.docs!.map((d) => d.bucket)).toEqual(["drainable", "drainable"]);
    // The id-prefix-dated doc is NEWER than the explicitly-dated one, so it sorts
    // FIRST and renders its prefix date — the pre-fix behaviour sank it to the
    // bottom with a "—" date although the drain would take it first.
    expect(body.docs!.map((d) => d.label)).toEqual(["2026-01-05-prefixed", "old-doc"]);
    expect(body.docs![0]!.date).toBe("2026-01-05");
    expect(body.docs![1]!.date).toBe("2020-01-01");
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

/**
 * The invalidation GENERATION counter. `invalidateIngestBacklogCache` (fired when a
 * delete's reindex poll goes terminal) must fence every compute that started BEFORE
 * it: such a compute already read huginn's pre-delete listing, so on settle it must
 * neither `backlogCache.set` that stale payload (re-poisoning the cache for the full
 * 5-min TTL) nor let its `.finally` evict the NEWER in-flight compute out of the map.
 */
describe("ingest-backlog cache — invalidation generation fencing", () => {
  let root: string;
  let origFetch: typeof fetch;
  let fetchCalls: string[];
  /** Resolvers parked at the LAST collection listing — one per in-flight compute. */
  let gates: Array<() => void>;
  /** The youtube listing the NEXT compute will see (mutated between computes). */
  let youtubeDocs: Array<{ id: string; url: string; date?: string }>;

  const deps: IngestBacklogDeps = {
    getConsumed: async () => new Set<string>(),
    getPending: async () => new Set<string>(),
  };

  /** Spin until `n` computes have parked at the gate. */
  async function waitForGates(n: number): Promise<void> {
    for (let i = 0; i < 200 && gates.length < n; i++) await new Promise((r) => setTimeout(r, 1));
    expect(gates.length).toBe(n);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-backlog-gen-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\nnothing cited here.\n");
    fetchCalls = [];
    gates = [];
    youtubeDocs = [
      { id: "d1", url: "https://youtu.be/d1", date: "2026-01-01" },
      { id: "d2", url: "https://youtu.be/d2", date: "2026-01-02" },
    ];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      const m = url.match(/\/api\/collection\/([^/]+)\/documents/);
      const collection = m ? m[1]! : "";
      const documents = collection === "youtube-summaries" ? youtubeDocs : [];
      // Park each compute on its LAST collection so the test controls settle order.
      if (collection === "article-summaries") {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      return new Response(JSON.stringify({ documents }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    __resetIngestBacklogCacheForTest();
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    for (const release of gates) release();
    __resetIngestBacklogCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("a pre-invalidation compute neither re-caches its stale payload nor evicts the newer one", async () => {
    // Compute A starts and reads the PRE-delete listing (2 queued docs).
    const a = getIngestBacklogCached(root, "genbot", deps, false);
    await waitForGates(1);

    // The delete's reindex went terminal: the cache is invalidated, and huginn's
    // listing no longer carries d2. Compute B (the client's `refresh=1`) starts.
    invalidateIngestBacklogCache("genbot");
    youtubeDocs = [{ id: "d1", url: "https://youtu.be/d1", date: "2026-01-01" }];
    const b = getIngestBacklogCached(root, "genbot", deps, true);
    await waitForGates(2);

    // A settles FIRST, while B is still in flight.
    gates[0]!();
    expect((await a).queued).toBe(2);

    // A's `.finally` must NOT have removed B's in-flight entry — a third caller
    // joins B rather than kicking off a fourth compute.
    const callsBefore = fetchCalls.length;
    const joined = getIngestBacklogCached(root, "genbot", deps, false);
    expect(fetchCalls.length).toBe(callsBefore);

    gates[1]!();
    expect((await b).queued).toBe(1);
    expect((await joined).queued).toBe(1);

    // The cache holds B's post-delete payload — A must not have re-poisoned it.
    const callsBeforeServe = fetchCalls.length;
    const served = await getIngestBacklogCached(root, "genbot", deps, false);
    expect(served.queued).toBe(1);
    expect(fetchCalls.length).toBe(callsBeforeServe); // served from cache, not recomputed
  });
});

/**
 * PR 2 prune verbs — the FOUR-bucket partition, the dismiss/un-dismiss/reset routes
 * and their guards, and the huginn DELETE proxy.
 *
 * Layering note the tests pin: dismissal is a LIVE overlay (read per request beside
 * the offered set, outside the 5-min cache), never a filter inside
 * `computeIngestBacklog` — so a dismiss moves the counters on a PLAIN refetch.
 */
describe("computeBacklogFloorCounts — the dismissed bucket (PR 2)", () => {
  const NOW = Date.UTC(2026, 6, 20);
  const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
  const keys = [
    { key: "c/fresh", id: "fresh", collection: "c", date: day(1) },
    { key: "c/old", id: "old", collection: "c", date: day(90) },
    { key: "c/offered", id: "offered", collection: "c", date: day(90) },
    { key: "c/dismissed", id: "dismissed", collection: "c", date: day(90) },
  ];

  test("the four buckets partition the queued set exactly", () => {
    const { remaining, offeredStillQueued, dismissed, freshByCollection } =
      computeBacklogFloorCounts(
        keys,
        new Set(["c/offered"]),
        7,
        NOW,
        true,
        new Set(["c/dismissed"]),
      );
    const fresh = Object.values(freshByCollection).reduce((s, n) => s + n, 0);
    expect(remaining).toBe(1);
    expect(offeredStillQueued).toBe(1);
    expect(dismissed).toBe(1);
    expect(fresh).toBe(1);
    expect(remaining + offeredStillQueued + dismissed + fresh).toBe(keys.length);
  });

  test("dismissed WINS over offered — the doc leaves offeredStillQueued entirely", () => {
    // Same doc in BOTH sets. If it counted as `offered`, "Reset offered" would
    // silently make a dismissed doc eligible again.
    const both = computeBacklogFloorCounts(
      keys,
      new Set(["c/offered", "c/dismissed"]),
      7,
      NOW,
      true,
      new Set(["c/dismissed"]),
    );
    expect(both.dismissed).toBe(1);
    expect(both.offeredStillQueued).toBe(1); // only c/offered
    expect(both.docs.find((d) => d.id === "dismissed")!.bucket).toBe("dismissed");
    // And a FRESH doc that is dismissed leaves the fresh bucket too (dismissal
    // outranks every other classification).
    const freshDismissed = computeBacklogFloorCounts(
      keys,
      new Set<string>(),
      7,
      NOW,
      true,
      new Set(["c/fresh"]),
    );
    expect(freshDismissed.freshByCollection["c"] ?? 0).toBe(0);
    expect(freshDismissed.dismissed).toBe(1);
  });

  test("an empty dismissed set is byte-identical to the pre-PR-2 three-bucket split", () => {
    const withArg = computeBacklogFloorCounts(keys, new Set(["c/offered"]), 7, NOW, true, new Set());
    const without = computeBacklogFloorCounts(keys, new Set(["c/offered"]), 7, NOW, true);
    expect(withArg.dismissed).toBe(0);
    expect({ ...withArg, dismissed: undefined }).toEqual({ ...without, dismissed: undefined });
  });
});

describe("prune routes — dismiss / un-dismiss / reset guards (PR 2)", () => {
  let root: string;
  let app: Hono;
  let snapshots: Map<string, unknown>;
  let watcher: GardenerWatcherRef | null;
  let origFetch: typeof fetch;

  const seededWatcher = (): GardenerWatcherRef => ({
    id: "w1",
    enabled: true,
    lastRunAt: null,
    intervalMs: 604_800_000,
    forceNextRun: false,
    config: {},
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-prune-route-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\n");
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ documents: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    snapshots = new Map();
    watcher = seededWatcher();
    __setBotsForTest([
      { name: "prunebot", dir: root, persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], wikiDir: root },
    ] as unknown as Parameters<typeof __setBotsForTest>[0]);
    __setWikiRegistryForTest([{ name: "prunebot", root, source: "bot" }]);
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();

    app = new Hono();
    registerWikiGardenerRoutes(app, {
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => watcher,
      getSnapshot: async (_id, key) => snapshots.get(key) ?? null,
      setSnapshot: async (_id, key, value) => {
        snapshots.set(key, value);
      },
      listProposals: async () => [],
      // Approve-path seams — unused by these backlog cases, present so the deps
      // object satisfies `BacklogRouteDeps` (see the approve read-only test).
      getProposalById: async () => null,
      approveProposal: async () => null,
    });
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    __setBotsForTest(null);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();
    await rm(root, { recursive: true, force: true });
  });

  const post = async (path_: string, body?: unknown): Promise<Response> =>
    await app.request(`${path_}${path_.includes("?") ? "&" : "?"}wiki=prunebot`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });

  test("dismiss persists the keys, un-dismiss removes them, reset clears the set", async () => {
    const r1 = await post("/api/wiki/gardener/backlog-docs-dismiss", { keys: ["c/a", "c/b"] });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, dismissed: 2 });
    expect(new Set(snapshots.get("backlog:dismissed") as string[])).toEqual(new Set(["c/a", "c/b"]));

    // Idempotent — re-dismissing an already-dismissed key doesn't grow the set.
    await post("/api/wiki/gardener/backlog-docs-dismiss", { keys: ["c/a"] });
    expect((snapshots.get("backlog:dismissed") as string[]).length).toBe(2);

    const r2 = await post("/api/wiki/gardener/backlog-docs-undismiss", { keys: ["c/a"] });
    expect(r2.status).toBe(200);
    expect(snapshots.get("backlog:dismissed")).toEqual(["c/b"]);

    const r3 = await post("/api/wiki/gardener/backlog-docs-dismiss-reset");
    expect(r3.status).toBe(200);
    expect(snapshots.get("backlog:dismissed")).toEqual([]);
  });

  test("the GET emits `dismissed` as its own live field", async () => {
    const res = await app.request("/api/wiki/ingest-backlog?wiki=prunebot");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dismissed?: number };
    // No queued docs in this fixture — the point is the field is present + numeric,
    // merged OUTSIDE the 5-min cache like `offered` (so a dismiss lands on a PLAIN
    // refetch, no expensive `refresh=1` recompute).
    expect(body.dismissed).toBe(0);
  });

  test("no seeded watcher → 404 (the snapshot's FK is the watcher id), exactly like Reset", async () => {
    watcher = null;
    for (const p of [
      "/api/wiki/gardener/backlog-docs-dismiss",
      "/api/wiki/gardener/backlog-docs-undismiss",
      "/api/wiki/gardener/backlog-docs-dismiss-reset",
      "/api/wiki/gardener/backlog-doc-delete",
    ]) {
      const res = await post(p, { keys: ["c/a"], collection: "youtube-summaries", id: "a" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error?: string }).error).toContain("no wiki-gardener watcher");
    }
  });

  test("a gardener run in flight → 409 on every prune verb (the backlog-recover precedent)", async () => {
    let release!: () => void;
    const held = runExclusive("prunebot", () => new Promise<void>((r) => (release = r)));
    expect(held).not.toBeNull();
    try {
      for (const [p, body] of [
        ["/api/wiki/gardener/backlog-docs-dismiss", { keys: ["c/a"] }],
        ["/api/wiki/gardener/backlog-docs-undismiss", { keys: ["c/a"] }],
        ["/api/wiki/gardener/backlog-docs-dismiss-reset", undefined],
        ["/api/wiki/gardener/backlog-doc-delete", { collection: "youtube-summaries", id: "a" }],
      ] as const) {
        const res = await post(p, body);
        expect(res.status).toBe(409);
      }
      // Nothing was written while the mutex was held.
      expect(snapshots.has("backlog:dismissed")).toBe(false);
    } finally {
      release();
      await held;
    }
  });

  test("a malformed body is a 400, never a silent no-op write", async () => {
    for (const body of [{}, { keys: [] }, { keys: "c/a" }]) {
      const res = await post("/api/wiki/gardener/backlog-docs-dismiss", body);
      expect(res.status).toBe(400);
    }
    expect(snapshots.has("backlog:dismissed")).toBe(false);
  });

  // An over-cap batch is a DIFFERENT failure from a malformed body: the old shared
  // "expected a non-empty keys array" message sent the caller hunting the wrong bug.
  // (The client chunks under the cap, so this is a fence, not a UX limit.)
  test("an over-cap key list 400s with a message that names the cap", async () => {
    const keys = Array.from({ length: 2001 }, (_, i) => `c/${i}`);
    const res = await post("/api/wiki/gardener/backlog-docs-dismiss", { keys });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error?: string };
    expect(error).toContain("too many keys");
    expect(error).toContain("2000");
    expect(error).not.toContain("non-empty");
    expect(snapshots.has("backlog:dismissed")).toBe(false);
    // Exactly at the cap still succeeds.
    const ok = await post("/api/wiki/gardener/backlog-docs-dismiss", { keys: keys.slice(0, 2000) });
    expect(ok.status).toBe(200);
  });

  test("the prune routes share the standard wiki-resolution guards", async () => {
    const res = await app.request("/api/wiki/gardener/backlog-docs-dismiss?wiki=nope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["c/a"] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toContain("no wiki configured");
  });
});

describe("backlog-doc-delete — the huginn DELETE proxy (PR 2)", () => {
  let root: string;
  let app: Hono;
  let snapshots: Map<string, unknown>;
  let origFetch: typeof fetch;
  let deleteCalls: string[];
  /** How many huginn collection LISTINGS were made — the backlog cache's observable. */
  let listCalls: number;
  /** Stubbed huginn behaviour for the DELETE + the update-status poll. */
  let deleteResponse: () => Response;
  let statusResponse: () => Response;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-delete-route-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\n");
    deleteCalls = [];
    listCalls = 0;
    deleteResponse = () =>
      new Response(
        JSON.stringify({
          status: "deleted",
          collection: "youtube-summaries",
          doc_id: "junk.md",
          movedTo: "/tmp/deleted/junk.md",
          reindex: { "youtube-summaries": "started", wiki: "skipped_already_running" },
          pollUrls: { "youtube-summaries": "/api/collections/youtube-summaries/update-status" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    statusResponse = () =>
      new Response(JSON.stringify({ status: "succeeded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    origFetch = globalThis.fetch;
    // NEVER the real huginn: the running server predates the endpoint anyway.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        deleteCalls.push(url);
        return deleteResponse();
      }
      if (url.includes("/update-status")) return statusResponse();
      if (url.includes("/api/collection/")) listCalls++;
      return new Response(JSON.stringify({ documents: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    snapshots = new Map<string, unknown>([
      ["backlog:offered", ["youtube-summaries/junk.md", "youtube-summaries/keep.md"]],
      ["backlog:dismissed", ["youtube-summaries/junk.md"]],
    ]);
    __setBotsForTest([
      { name: "delbot", dir: root, persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], wikiDir: root },
    ] as unknown as Parameters<typeof __setBotsForTest>[0]);
    __setWikiRegistryForTest([{ name: "delbot", root, source: "bot" }]);
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();

    app = new Hono();
    registerWikiGardenerRoutes(app, {
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => ({
        id: "w1",
        enabled: true,
        lastRunAt: null,
        intervalMs: 604_800_000,
        forceNextRun: false,
        config: {},
      }),
      getSnapshot: async (_id, key) => snapshots.get(key) ?? null,
      setSnapshot: async (_id, key, value) => {
        snapshots.set(key, value);
      },
      listProposals: async () => [],
      // Approve-path seams — unused by these backlog cases, present so the deps
      // object satisfies `BacklogRouteDeps` (see the approve read-only test).
      getProposalById: async () => null,
      approveProposal: async () => null,
    });
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    __setBotsForTest(null);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();
    await rm(root, { recursive: true, force: true });
  });

  const del = async (body: unknown): Promise<Response> =>
    await app.request("/api/wiki/gardener/backlog-doc-delete?wiki=delbot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("happy path: calls huginn's DELETE, splits reindex into pollable vs skipped, prunes both sets", async () => {
    const res = await del({ collection: "youtube-summaries", id: "junk.md" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      polling: string[];
      skipped: string[];
      movedTo: string | null;
    };
    expect(body.ok).toBe(true);
    // `started` is pollable; `skipped_already_running` is surfaced honestly instead
    // (that run began BEFORE the move, so its success says nothing about this delete).
    expect(body.polling).toEqual(["youtube-summaries"]);
    expect(body.skipped).toEqual(["wiki"]);
    expect(body.movedTo).toBe("/tmp/deleted/junk.md");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]).toContain("/api/document/youtube-summaries/junk.md");
    // The deleted key leaves BOTH snapshot sets; the untouched key survives.
    expect(snapshots.get("backlog:offered")).toEqual(["youtube-summaries/keep.md"]);
    expect(snapshots.get("backlog:dismissed")).toEqual([]);
  });

  test("huginn 404 (id not in that collection) → 404, and neither snapshot set is touched", async () => {
    deleteResponse = () => new Response("not found", { status: 404 });
    const res = await del({ collection: "youtube-summaries", id: "junk.md" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toContain("not in that collection");
    expect((snapshots.get("backlog:offered") as string[]).length).toBe(2);
  });

  test("huginn error / unreachable → 502 with the message, never a muninn 5xx crash", async () => {
    deleteResponse = () => new Response("boom", { status: 500 });
    const res = await del({ collection: "youtube-summaries", id: "junk.md" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error?: string }).error).toContain("huginn refused the delete");
  });

  test("a bad body / unknown collection is a 400 before any huginn call", async () => {
    expect((await del({})).status).toBe(400);
    expect((await del({ collection: "not-a-collection", id: "x" })).status).toBe(400);
    expect(deleteCalls.length).toBe(0);
  });

  test("the status poll invalidates the bot's cached backlog only once TERMINAL", async () => {
    const statusUrl =
      "/api/wiki/gardener/backlog-doc-delete-status?wiki=delbot&collection=youtube-summaries";
    // Listing calls are the observable: a served-from-cache GET makes none, a
    // recompute re-lists every summary collection.
    const get = async (): Promise<void> => {
      await app.request("/api/wiki/ingest-backlog?wiki=delbot");
    };
    await get();
    const warm = listCalls;
    expect(warm).toBeGreaterThan(0);
    await get();
    expect(listCalls).toBe(warm); // cached (5-min TTL)

    // A RUNNING reindex must NOT invalidate — the doc is still in huginn's listing,
    // so recomputing now would just re-cache the wrong payload for the whole TTL.
    statusResponse = () =>
      new Response(JSON.stringify({ status: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect(((await (await app.request(statusUrl)).json()) as { status: string }).status).toBe("running");
    await get();
    expect(listCalls).toBe(warm);

    // Terminal ⇒ the entry (and any in-flight compute) is dropped, so the client's
    // follow-up `refresh=1` recomputes against the post-prune listing.
    statusResponse = () =>
      new Response(JSON.stringify({ status: "succeeded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect(((await (await app.request(statusUrl)).json()) as { status: string }).status).toBe("succeeded");
    await get();
    expect(listCalls).toBeGreaterThan(warm);
  });

  test("an unreachable huginn on the poll reports `unknown` (never a hung 'removing…')", async () => {
    statusResponse = () => new Response("down", { status: 503 });
    const res = await app.request(
      "/api/wiki/gardener/backlog-doc-delete-status?wiki=delbot&collection=youtube-summaries",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string };
    expect(body.status).toBe("unknown");
    expect(body.error).toBeDefined();
  });
});

// Every guard that fires BEFORE any huginn/model I/O, so the whole set is testable
// without a real one-shot. The post-guard body (fetch → draft → ledger) is covered by
// `source-drafter.test.ts` + `source-drafter-run.test.ts`; what regressed silently
// before this block existed was the route's own gating.
describe("POST /api/wiki/gardener/source-draft-doc — pre-I/O guards", () => {
  let root: string;
  let app: Hono;
  let gardenerEnabled: boolean;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-draft-doc-route-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\n");
    gardenerEnabled = true;
    __setBotsForTest([
      {
        name: "draftbot",
        dir: root,
        persona: "",
        telegramAllowedUserIds: [],
        slackAllowedUserIds: [],
        wikiDir: root,
        get gardener() {
          return { enabled: gardenerEnabled };
        },
      },
    ] as unknown as Parameters<typeof __setBotsForTest>[0]);
    __setWikiRegistryForTest([{ name: "draftbot", root, source: "bot" }]);
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();

    app = new Hono();
    registerWikiGardenerRoutes(app, {
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => null,
      getSnapshot: async () => null,
      setSnapshot: async () => {},
      listProposals: async () => [],
      // Approve-path seams — unused by these backlog cases, present so the deps
      // object satisfies `BacklogRouteDeps` (see the approve read-only test).
      getProposalById: async () => null,
      approveProposal: async () => null,
    });
  });

  afterEach(async () => {
    __setBotsForTest(null);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();
    await rm(root, { recursive: true, force: true });
  });

  const post = async (body: unknown, query = "wiki=draftbot"): Promise<Response> =>
    await app.request(`/api/wiki/gardener/source-draft-doc?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("unknown bot → 404, before any work", async () => {
    expect((await post({ collection: "x-articles", id: "a.md" }, "wiki=nobody")).status).toBe(404);
  });

  test("gardener disabled → 400 (the route must not run what the UI hides)", async () => {
    gardenerEnabled = false;
    const res = await post({ collection: "x-articles", id: "a.md" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("disabled");
  });

  test("malformed / incomplete body → 400", async () => {
    expect((await post(undefined)).status).toBe(400); // no body at all
    expect((await post({ id: "a.md" })).status).toBe(400);
    expect((await post({ collection: "x-articles" })).status).toBe(400);
    expect((await post({ collection: "x-articles", id: 42 })).status).toBe(400);
  });

  test("unknown collection → 400 (never a huginn fetch for a made-up name)", async () => {
    const res = await post({ collection: "not-a-collection", id: "a.md" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("unknown summary collection");
  });

  test("an over-length title → 400 naming the cap, before a model call is spent", async () => {
    const res = await post({ collection: "x-articles", id: "a.md", title: "x".repeat(121) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("120");
  });

  test("409 while a gardener run holds the per-bot mutex — never a second model run", async () => {
    let release = (): void => {};
    const held = runExclusive("draftbot", () => new Promise<void>((r) => (release = r)));
    expect(held).not.toBeNull();
    const res = await post({ collection: "x-articles", id: "a.md" });
    expect(res.status).toBe(409);
    release();
    await held;
  });
});

/**
 * The run-now source drafter under the per-bot gardener mutex.
 *
 * Its sibling `source-draft-backlog` has carried this guard since it shipped; this
 * route did not, so two clicks (or a click racing a drain) each started a real model
 * one-shot. The proposal dedup only stops the duplicate ROW — the money is spent
 * before the insert — which is why the guard has to be the mutex, not the insert.
 *
 * The listing fetch (`/api/collection/<name>/documents`) is the first thing the run
 * body does and the model call is strictly downstream of it, so counting listings
 * counts STARTED runs: 0 means the body never began, 1 means it began exactly once.
 */
describe("POST /api/wiki/gardener/source-draft-run — the per-bot mutex", () => {
  let root: string;
  let app: Hono;
  let origFetch: typeof fetch;
  let listings: number;
  let releaseListing: () => void = () => {};

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-draft-run-route-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\n");
    __setBotsForTest([
      {
        name: "draftbot",
        dir: root,
        persona: "",
        telegramAllowedUserIds: [],
        slackAllowedUserIds: [],
        wikiDir: root,
        gardener: { enabled: true },
      },
    ] as unknown as Parameters<typeof __setBotsForTest>[0]);
    __setWikiRegistryForTest([{ name: "draftbot", root, source: "bot" }]);
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();

    listings = 0;
    // The listing hangs until released, so the first run is still in flight (still
    // holding the mutex) when the second request arrives — the real race, not a
    // simulation of it.
    const gate = new Promise<void>((r) => (releaseListing = r));
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/documents")) {
        listings += 1;
        await gate;
        return new Response(JSON.stringify({ documents: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    app = new Hono();
    registerWikiGardenerRoutes(app, {
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => null,
      getSnapshot: async () => null,
      setSnapshot: async () => {},
      listProposals: async () => [],
      // Approve-path seams — unused by these backlog cases, present so the deps
      // object satisfies `BacklogRouteDeps` (see the approve read-only test).
      getProposalById: async () => null,
      approveProposal: async () => null,
    });
  });

  afterEach(async () => {
    releaseListing();
    globalThis.fetch = origFetch;
    __setBotsForTest(null);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();
    await rm(root, { recursive: true, force: true });
  });

  const post = async (): Promise<Response> =>
    await app.request("/api/wiki/gardener/source-draft-run?wiki=draftbot&collection=x-articles", {
      method: "POST",
    });

  test("409 while a gardener run holds the per-bot mutex — the run body never starts", async () => {
    let release = (): void => {};
    const held = runExclusive("draftbot", () => new Promise<void>((r) => (release = r)));
    expect(held).not.toBeNull();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already in flight");
    expect(listings).toBe(0);
    release();
    await held;
  });

  test("two back-to-back POSTs → exactly one run body starts, the second 409", async () => {
    const first = post(); // deliberately not awaited: the race is the point
    const second = post();

    const secondRes = await second;
    // Release as soon as the race has been decided and BEFORE any assert: with the
    // release sitting at the bottom, the first failing expectation aborted the test
    // with `first` still parked on the gate, and the real assertion arrived buried
    // under a 5s timeout. (`afterEach` releases too — this one is idempotent.)
    releaseListing();

    expect(secondRes.status).toBe(409);
    expect((await secondRes.json()).error).toContain("already in flight");
    expect((await first).status).toBe(200);
    expect(listings).toBe(1);
  });
});

/**
 * The run-now source drafter's failure contract.
 *
 * Both mutex siblings (`source-draft-backlog`, `source-draft-doc`) wrap their awaited
 * run in try/catch → `{error}` 500, and this route did not: an unexpected throw fell
 * through Hono's default handler as a text/plain "Internal Server Error", which the
 * client reads as neither an outcome nor a message.
 *
 * The throw is injected at the `getDismissed` seam — real DB I/O (`getSnapshot` on
 * `watcher_snapshots`), reached AFTER the listing and BEFORE the model call, so the
 * test spends nothing and exercises the route's own catch rather than the drafter's.
 */
describe("POST /api/wiki/gardener/source-draft-run — an unexpected throw is a JSON 500", () => {
  let root: string;
  let app: Hono;
  let origFetch: typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-draft-run-throw-"));
    await Bun.write(path.join(root, "notes.md"), "# Notes\n");
    __setBotsForTest([
      {
        name: "draftbot",
        dir: root,
        persona: "",
        telegramAllowedUserIds: [],
        slackAllowedUserIds: [],
        wikiDir: root,
        gardener: { enabled: true },
      },
    ] as unknown as Parameters<typeof __setBotsForTest>[0]);
    __setWikiRegistryForTest([{ name: "draftbot", root, source: "bot" }]);
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();

    origFetch = globalThis.fetch;
    // One listed doc, so the run body gets past the empty-collection early return
    // and reaches the dismissed-set read.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/documents")) {
        return new Response(JSON.stringify({ documents: [{ id: "a.md", date: "2026-01-01" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    app = new Hono();
    registerWikiGardenerRoutes(app, {
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => ({
        id: "w1",
        enabled: true,
        lastRunAt: null,
        intervalMs: 604_800_000,
        forceNextRun: false,
        config: {},
      }),
      getSnapshot: async () => {
        throw new Error("watcher_snapshots read failed");
      },
      setSnapshot: async () => {},
      listProposals: async () => [],
      // Approve-path seams — unused by these backlog cases, present so the deps
      // object satisfies `BacklogRouteDeps` (see the approve read-only test).
      getProposalById: async () => null,
      approveProposal: async () => null,
    });
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    __setBotsForTest(null);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetIngestBacklogCacheForTest();
    __resetGardenerMutexForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("the run body throwing → JSON {error} 500, not a text/plain framework 500", async () => {
    const res = await app.request(
      "/api/wiki/gardener/source-draft-run?wiki=draftbot&collection=x-articles",
      { method: "POST" },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error).toContain("watcher_snapshots read failed");
  });

  test("the mutex is released after a throw — a retry is not permanently 409'd", async () => {
    const first = await app.request(
      "/api/wiki/gardener/source-draft-run?wiki=draftbot&collection=x-articles",
      { method: "POST" },
    );
    expect(first.status).toBe(500);
    const second = await app.request(
      "/api/wiki/gardener/source-draft-run?wiki=draftbot&collection=x-articles",
      { method: "POST" },
    );
    // 500 (the same throw), NOT the 409 a leaked mutex would produce.
    expect(second.status).toBe(500);
    expect((await second.json()).error).toContain("watcher_snapshots read failed");
  });
});

/**
 * The stem-collision guard on `POST /api/wiki/proposals/:id/approve`.
 *
 * The historical shape, reproduced: a source page was drafted FIRST as
 * `sources/<Stem>.mdx`, and an approved ENTITY proposal then landed
 * `entities/<Stem>.md` beside it. `applyWikiProposal`'s only create-mode guard is
 * path-exact (`current !== null` ⇒ "target path already exists"), so the apply
 * wrote the twin — after which the store's same-stem precedence rule (`.md` >
 * `.mdx`) DROPS the source page from the index entirely and Obsidian resolves the
 * title ambiguously.
 *
 * These drive the REAL route into the REAL `applyWikiProposal` against a REAL temp
 * wiki; only the two DB seams are faked, so the gap between the read and the
 * draft→approved CAS is drivable (the `wiki-readonly-roots.test.ts` rationale).
 * Every fixture string is synthesized — muninn is a public repo.
 */
describe("approve — stem-collision refusal (the apply path had no check at all)", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;
  /** Ids the fake CAS claimed — a refusal must leave this empty. */
  let approved: string[];

  const STEM = "Aurora Ledger Protocol";

  const proposalRow = (over: Record<string, unknown> = {}) =>
    ({
      id: "p1",
      botName: "jarvis",
      wikiName: "stemwiki",
      topicKey: "aurora-ledger-protocol",
      kind: "entity",
      mode: "create",
      targetPath: `entities/${STEM}.md`,
      baseHash: null,
      sourceDocs: [],
      relatedPages: [],
      rationale: "Synthesized fixture.",
      draft: `---\ntitle: ${STEM}\ntype: entity\n---\n\n# ${STEM}\n\nSynthesized fixture body.\n`,
      status: "draft",
      ...over,
    }) as never;

  const deps = (proposal: unknown) =>
    ({
      getConsumed: async () => new Set<string>(),
      getPending: async () => new Set<string>(),
      getWikiGardenerWatcher: async () => null,
      getSnapshot: async () => null,
      setSnapshot: async () => {},
      listProposals: async () => [],
      getProposalById: async () => proposal,
      approveProposal: async (id: string) => {
        approved.push(id);
        return proposal ? { ...(proposal as object), status: "approved" } : null;
      },
    }) as unknown as Parameters<typeof registerWikiGardenerRoutes>[1];

  beforeEach(async () => {
    approved = [];
    root = await mkdtemp(path.join(tmpdir(), "wiki-stem-collide-"));
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `stemwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("an existing .mdx source page blocks a same-stem .md entity apply — 409, no CAS, no write", async () => {
    await Bun.write(
      path.join(root, "sources", `${STEM}.mdx`),
      `---\ntitle: ${STEM}\ntype: source\nurl: https://example.invalid/aurora\n---\n\n# ${STEM}\n\nSynthesized fixture body.\n`,
    );
    registerWikiGardenerRoutes(app, deps(proposalRow()));

    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; collision?: boolean; blockingPath?: string };
    expect(body.collision).toBe(true);
    expect(body.blockingPath).toBe(`sources/${STEM}.mdx`);
    // The reason names the blocking page — the gate renders `data.error` verbatim.
    expect(body.error).toContain(STEM);

    // The two observables that separate this from a refusal one layer down: the
    // row is still a draft (so the gate still offers Approve/Reject), and the
    // stem twin was never written.
    expect(approved).toEqual([]);
    expect(await Bun.file(path.join(root, "entities", `${STEM}.md`)).exists()).toBe(false);
  });

  test("a re-click refuses again, identically — the refusal is repeatable", async () => {
    await Bun.write(
      path.join(root, "sources", `${STEM}.mdx`),
      `---\ntitle: ${STEM}\ntype: source\n---\n\nBody.\n`,
    );
    registerWikiGardenerRoutes(app, deps(proposalRow()));
    const first = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    const second = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(approved).toEqual([]);
  });

  test("an `approved` row whose page is already at the target still applies (crash recovery)", async () => {
    // The proposal's OWN page sits at the target — a crash between the write and
    // the terminal CAS. The stem twin the guard looks for must EXCLUDE that page,
    // or the recovery re-apply refuses with the row named as its own blocker.
    const draft = `---\ntitle: ${STEM}\ntype: entity\n---\n\n# ${STEM}\n\nSynthesized fixture body.\n`;
    await Bun.write(path.join(root, "entities", `${STEM}.md`), draft);
    registerWikiGardenerRoutes(app, deps(proposalRow({ status: "approved", draft })));

    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    // Assert on the GUARD's own observable, never on `status !== 409`: 409 is also
    // the route's "proposal state changed during apply" answer, which this fixture
    // reaches whenever a DB happens to be connected (it is, in the full suite —
    // another file opens the pool — and is not, file-alone). Only the collision
    // refusal carries `collision`.
    expect(((await res.json()) as { collision?: boolean }).collision).toBeUndefined();
    // …and the recovery really did short-circuit on the existing page.
    expect(await Bun.file(path.join(root, "entities", `${STEM}.md`)).text()).toBe(draft);
  });

  test("UPDATE mode is never refused, even with a pre-existing same-stem twin", async () => {
    // The guard is scoped to create mode. An update rewrites a page that already
    // exists; a twin standing elsewhere is a pre-existing collision this write did
    // not create, and refusing would make that page permanently un-updatable — the
    // reviewer would have no verb for a proposal whose only fault is the wiki's.
    // The twin must SURVIVE the index build to exercise this: same-stem pages of
    // DIFFERENT extensions are resolved by precedence in `store.ts` (`.md` > `.mdx`)
    // and the loser is dropped, so a `.mdx` sibling of a `.md` target is not in
    // `index.pages` at all. A same-extension pair in two folders is what stays.
    const body = `---\ntitle: ${STEM}\ntype: entity\n---\n\n# ${STEM}\n\nOriginal fixture body.\n`;
    await Bun.write(path.join(root, "entities", `${STEM}.md`), body);
    await Bun.write(
      path.join(root, "concepts", `${STEM}.md`),
      `---\ntitle: ${STEM}\ntype: concept\n---\n\nBody.\n`,
    );
    registerWikiGardenerRoutes(
      app,
      deps(proposalRow({ mode: "update", baseHash: Bun.SHA256.hash(body, "hex") })),
    );
    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    expect(((await res.json()) as { collision?: boolean }).collision).toBeUndefined();
    // The row was CLAIMED — the guard sits above the CAS, so reaching it proves
    // the guard let this through rather than refusing it.
    expect(approved).toEqual(["p1"]);
  });

  test("a SAME-extension cross-folder twin blocks a create too (one title namespace)", async () => {
    await Bun.write(
      path.join(root, "concepts", `${STEM}.md`),
      `---\ntitle: ${STEM}\ntype: concept\n---\n\nBody.\n`,
    );
    registerWikiGardenerRoutes(app, deps(proposalRow()));
    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { blockingPath: string }).blockingPath).toBe(
      `concepts/${STEM}.md`,
    );
    expect(approved).toEqual([]);
  });

  test("a near-miss stem is not a collision — the apply proceeds", async () => {
    await Bun.write(
      path.join(root, "sources", "Aurora Ledger Protocols.mdx"),
      "---\ntitle: Aurora Ledger Protocols\ntype: source\n---\n\nBody.\n",
    );
    registerWikiGardenerRoutes(app, deps(proposalRow()));
    const res = await app.request("/api/wiki/proposals/p1/approve", { method: "POST" });
    expect(((await res.json()) as { collision?: boolean }).collision).toBeUndefined();
    expect(approved).toEqual(["p1"]);
    // The apply ran: the page really was written at the near-miss-free stem.
    expect(await Bun.file(path.join(root, "entities", `${STEM}.md`)).exists()).toBe(true);
  });
});
