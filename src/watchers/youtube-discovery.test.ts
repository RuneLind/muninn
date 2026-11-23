/**
 * The weekly `youtube-discovery` watcher with every seam injected (no
 * mock.module): the listing, the raw reads, the two model calls, the search,
 * the store and the health recorder. Invented ids and titles only (public repo).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import type { Watcher } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { YouTubeHit } from "../youtube/discover.ts";
import type { CapturedDoc } from "../youtube/discover-deps.ts";
import type { DiscoverHitInput, DiscoverRunInput } from "../db/youtube-discover.ts";
import { buildHealthAlerts, recordOutcome, type SourceHealthMap, type SourceHealthRecorder, type SourceOutcome } from "./source-health.ts";
import { computeWatcherTimeoutMs, TICK_TIMEOUT_MS, WATCHER_TIMEOUT_MARGIN_MS } from "./timeout.ts";
import {
  checkYouTubeDiscovery,
  HEALTH_HUGINN,
  HEALTH_MODEL,
  HEALTH_SEARCH,
  HEALTH_STORE,
  resolveMaxSeeds,
  type DiscoveryState,
  type YouTubeDiscoveryDeps,
} from "./youtube-discovery.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const bot = { name: "invented-bot", dir: "/tmp/invented", connector: "claude-sdk" } as unknown as BotConfig;
const watcher = (config: Record<string, unknown> = {}): Watcher =>
  ({ id: "w1", userId: "owner-1", botName: "invented-bot", name: "YouTube discovery", type: "youtube-discovery", config }) as unknown as Watcher;

const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
const seedVid = (n: number) => `sed${String(n).padStart(8, "0")}`;
const raw = (n: number) =>
  `---\ndate: "2026-11-1${n}"\nurl: "https://www.youtube.com/watch?v=${seedVid(n)}"\ncategory: "ai"\n---\n\nInvented summary ${n}.\n`;
const doc = (n: number, date: string): CapturedDoc => ({ id: `ai/Seed ${n}.md`, url: `https://www.youtube.com/watch?v=${seedVid(n)}`, date });
const hit = (id: string): YouTubeHit => ({ videoId: id, title: `Video ${id}`, channel: "Invented", durationSec: 600, viewCount: 10, url: `https://www.youtube.com/watch?v=${id}` });

let listed: CapturedDoc[] | Error;
let raws: Map<string, string | Error>;
let queriesAnswer: (prompt: string) => Promise<string>;
let rankAnswer: (prompt: string) => Promise<string>;
let searchAnswer: (q: string) => Promise<YouTubeHit[] | null>;
let recent: Map<string, number>;
let stored: Set<string>;
let saved: { run: DiscoverRunInput; hits: readonly DiscoverHitInput[] }[];
let profileCalls: string[];
let marks: Map<string, { outcome: SourceOutcome; detail?: string }>;
let carried: string[];
let rankPrompts: string[];
let lastWatcherRun: number | null;
let state: DiscoveryState | null;

function deps(over: Partial<YouTubeDiscoveryDeps> = {}): YouTubeDiscoveryDeps {
  return {
    services: {
      listCaptured: async () => {
        if (listed instanceof Error) throw listed;
        return listed;
      },
      readRaw: async (_c, id) => {
        const r = raws.get(id);
        if (r instanceof Error) throw r;
        return r ?? null;
      },
      queriesCall: (p) => queriesAnswer(p),
      rankCall: (p) => {
        rankPrompts.push(p);
        return rankAnswer(p);
      },
      search: (q) => searchAnswer(q),
    },
    saveRun: async (run, hits) => {
      saved.push({ run, hits });
      return `run-${saved.length}`;
    },
    storedKnownIds: async () => stored,
    latestRunTimes: async (ids) => new Map([...recent].filter(([id]) => ids.includes(id))),
    lastWatcherRunAt: async () => lastWatcherRun,
    loadState: async () => state,
    saveState: async (_id, next) => void (state = structuredClone(next)),
    profile: async (userId, botName) => {
      profileCalls.push(`${userId}|${botName}`);
      return null;
    },
    health: async (): Promise<SourceHealthRecorder> => ({
      mark: (key, outcome, detail) => void marks.set(key, { outcome, detail }),
      carry: (key) => void carried.push(key),
      finish: async () => [],
    }),
    tracer: () => null,
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  listed = [doc(1, "2026-11-13"), doc(2, "2026-11-12"), doc(3, "2026-11-11"), doc(4, "2026-10-01")];
  raws = new Map([1, 2, 3, 4].map((n) => [`ai/Seed ${n}.md`, raw(n)]));
  queriesAnswer = async () => JSON.stringify([{ query: "agent evals", why: "same topic" }]);
  rankAnswer = async () => JSON.stringify([{ n: 1, score: 0.8, why: "fits" }]);
  searchAnswer = async () => [hit(vid(1)), hit(vid(2))];
  recent = new Map();
  stored = new Set();
  saved = [];
  profileCalls = [];
  marks = new Map();
  carried = [];
  rankPrompts = [];
  lastWatcherRun = null;
  state = null;
});

describe("checkYouTubeDiscovery", () => {
  test("searches each of the last week's seeds as its own watcher run; health all ok", async () => {
    let call = 0;
    searchAnswer = async () => {
      call++;
      return [hit(vid(call * 10 + 1)), hit(vid(call * 10 + 2))];
    };
    const alerts = await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(alerts).toEqual([]);
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 1.md", "ai/Seed 2.md", "ai/Seed 3.md"]);
    expect(saved.every((s) => s.run.origin === "watcher" && s.run.seedSource === "youtube" && s.run.botName === "invented-bot")).toBe(true);
    expect(saved[0]!.run.seedVideoId).toBe(seedVid(1));
    // Loaded once per run, not once per seed (the watchers notes' interest-profile rule).
    expect(profileCalls).toEqual(["owner-1|invented-bot"]);
    expect(Object.fromEntries([...marks].map(([k, v]) => [k, v.outcome]))).toEqual({
      [HEALTH_HUGINN]: "ok",
      [HEALTH_MODEL]: "ok",
      [HEALTH_SEARCH]: "ok",
      [HEALTH_STORE]: "ok",
    });
    expect(carried).toEqual([]);
  });

  test("a seed already searched (any origin, any time) is skipped", async () => {
    recent = new Map([
      ["ai/Seed 1.md", NOW - 60_000],
      ["ai/Seed 2.md", NOW - 3 * 86_400_000],
    ]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 3.md"]);
  });

  test("config.maxSeeds caps the seeds; out-of-range values fall back to 5", async () => {
    await checkYouTubeDiscovery(watcher({ maxSeeds: 2 }), bot, undefined, deps());
    expect(saved).toHaveLength(2);
    expect(resolveMaxSeeds({ maxSeeds: 0 })).toBe(5);
    expect(resolveMaxSeeds({ maxSeeds: 11 })).toBe(5);
    expect(resolveMaxSeeds({ maxSeeds: "3" })).toBe(5);
    expect(resolveMaxSeeds({ maxSeeds: 10 })).toBe(10);
    expect(resolveMaxSeeds(undefined)).toBe(5);
  });

  test("captured, dismissed and queued videos are never ranked", async () => {
    listed = [doc(1, "2026-11-13"), { id: "ai/Old.md", url: `https://youtu.be/${vid(1)}`, date: "2026-01-01" }];
    stored = new Set([vid(2)]);
    searchAnswer = async () => [hit(vid(1)), hit(vid(2)), hit(vid(3))];
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(rankPrompts).toHaveLength(1);
    expect(rankPrompts[0]).toContain(vid(3));
    expect(rankPrompts[0]).not.toContain(vid(1));
    expect(rankPrompts[0]).not.toContain(vid(2));
    expect(saved[0]!.hits.map((h) => h.videoId)).toEqual([vid(3)]);
  });

  test("a failed listing marks huginn error and carries the other three, searching nothing", async () => {
    listed = new Error("huginn down");
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_HUGINN)).toEqual({ outcome: "error", detail: "listing failed: huginn down" });
    expect(carried.sort()).toEqual([HEALTH_MODEL, HEALTH_SEARCH, HEALTH_STORE].sort());
    expect(saved).toEqual([]);
  });

  test("every search failing marks search error, model and huginn ok", async () => {
    searchAnswer = async () => null;
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_SEARCH)?.outcome).toBe("error");
    expect(marks.get(HEALTH_MODEL)?.outcome).toBe("ok");
    expect(marks.get(HEALTH_HUGINN)?.outcome).toBe("ok");
    expect(saved).toEqual([]);
  });

  test("every rank call failing marks model error with the cause", async () => {
    rankAnswer = async () => {
      throw new Error("429 overloaded");
    };
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_MODEL)).toEqual({ outcome: "error", detail: "3 of 3 seeds failed: rank call: 429 overloaded" });
    expect(marks.get(HEALTH_SEARCH)?.outcome).toBe("ok");
  });

  test("one seed passing a step is enough for ok", async () => {
    let n = 0;
    queriesAnswer = async () => {
      n++;
      if (n === 2) throw new Error("timeout");
      return JSON.stringify([{ query: "agent evals", why: "same topic" }]);
    };
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_MODEL)?.outcome).toBe("ok");
    expect(saved).toHaveLength(2);
  });

  test("a seed deleted since the listing is not a huginn failure; a failed read is", async () => {
    listed = [doc(1, "2026-11-13")];
    raws = new Map();
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_HUGINN)?.outcome).toBe("ok");
    expect(carried.sort()).toEqual([HEALTH_MODEL, HEALTH_SEARCH, HEALTH_STORE].sort());

    marks = new Map();
    carried = [];
    raws = new Map([["ai/Seed 1.md", new Error("socket hang up")]]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_HUGINN)?.outcome).toBe("error");
  });

  test("no seeds this week: huginn ok, model, search and store carried", async () => {
    listed = [doc(4, "2026-10-01")];
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_HUGINN)?.outcome).toBe("ok");
    expect(carried.sort()).toEqual([HEALTH_MODEL, HEALTH_SEARCH, HEALTH_STORE].sort());
    expect(saved).toEqual([]);
  });

  test("a failed save is logged and the next seed still runs", async () => {
    let n = 0;
    const d = deps({
      saveRun: async (run, hits) => {
        n++;
        if (n === 1) throw new Error("db down");
        saved.push({ run, hits });
        return "run-x";
      },
    });
    await checkYouTubeDiscovery(watcher(), bot, undefined, d);
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 2.md", "ai/Seed 3.md"]);
  });
});

describe("fix round 1 batch 1", () => {
  test("a run-wide deadline inside the runner's net: model calls get it, and no seed starts too close to it", async () => {
    listed = [1, 2, 3, 4, 5].map((n) => doc(n, "2026-11-13"));
    raws = new Map([1, 2, 3, 4, 5].map((n) => [`ai/Seed ${n}.md`, raw(n)]));
    let clock = NOW;
    const deadlines: (number | undefined)[] = [];
    const w = watcher({ timeoutMs: 300_000 });
    const d = deps({ now: () => clock });
    d.services.queriesCall = async (_p, _b, _t, opts) => {
      deadlines.push(opts?.deadlineAt);
      clock += 100_000; // a slow model: 100 s per seed
      return JSON.stringify([{ query: "agent evals", why: "same topic" }]);
    };
    d.services.rankCall = async (_p, _b, _t, opts) => {
      deadlines.push(opts?.deadlineAt);
      return JSON.stringify([{ n: 1, score: 0.8, why: "fits" }]);
    };
    await checkYouTubeDiscovery(w, bot, undefined, d);
    const deadline = NOW + computeWatcherTimeoutMs(w) - WATCHER_TIMEOUT_MARGIN_MS;
    expect(deadlines.length).toBeGreaterThan(0);
    expect(deadlines.every((x) => x === deadline)).toBe(true);
    // Seeds start at 0, 100 and 200 s; at 300 s the deadline (300 s) has no room left.
    expect(saved).toHaveLength(3);
  });

  test("a failed shelf save marks youtube:store error; a stored one ok; no seed carries it", async () => {
    await checkYouTubeDiscovery(
      watcher(),
      bot,
      undefined,
      deps({
        saveRun: async () => {
          throw new Error("relation youtube_discover_runs does not exist");
        },
      }),
    );
    expect(marks.get(HEALTH_STORE)).toEqual({ outcome: "error", detail: "3 of 3 seeds failed: relation youtube_discover_runs does not exist" });

    marks = new Map();
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(marks.get(HEALTH_STORE)?.outcome).toBe("ok");

    marks = new Map();
    carried = [];
    listed = [doc(4, "2026-10-01")];
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(carried).toContain(HEALTH_STORE);
  });

  test("a video one seed's shelf already holds is not ranked again for a later seed in the same run", async () => {
    listed = [doc(1, "2026-11-13"), doc(2, "2026-11-12")];
    searchAnswer = async () => [hit(vid(1)), hit(vid(2))];
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(saved[0]!.hits.map((h) => h.videoId)).toEqual([vid(1)]);
    expect(rankPrompts).toHaveLength(2);
    expect(rankPrompts[1]).not.toContain(vid(1));
    expect(rankPrompts[1]).toContain(vid(2));
  });
});

describe("fix round 1 batch 2", () => {
  test("a capture dated on the last run's day, after that run, is still a seed a week later", async () => {
    listed = [doc(1, "2026-11-07"), doc(2, "2026-11-13")];
    // The anchor is the newest stored watcher run (the runner writes last_success_at for email only).
    lastWatcherRun = Date.parse("2026-11-07T12:00:00Z");
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(saved.map((s) => s.run.seedDocId).sort()).toEqual(["ai/Seed 1.md", "ai/Seed 2.md"]);
  });

  test("the seed cap applies after the recent-run skip, however many recent seeds come first", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `ai/Many ${String(i).padStart(2, "0")}.md`, url: null, date: "2026-11-13" }));
    listed = many;
    raws = new Map(many.map((d, i) => [d.id, raw((i % 4) + 1)]));
    // The 42 first in listing order (ties sort by id) were all searched yesterday.
    recent = new Map(many.slice(0, 42).map((d) => [d.id, NOW - 86_400_000]));
    let call = 0;
    searchAnswer = async () => {
      call++;
      return [hit(vid(call * 10 + 1))];
    };
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Many 42.md", "ai/Many 43.md", "ai/Many 44.md"]);
  });
});

describe("fix round 2 batch 1", () => {
  test("the deadline is bounded by the scheduler tick, not only the runner's net", async () => {
    let seen: number | undefined;
    const d = deps();
    d.services.queriesCall = async (_p, _b, _t, opts) => {
      seen = opts?.deadlineAt;
      return JSON.stringify([{ query: "agent evals", why: "same topic" }]);
    };
    const w = watcher({ timeoutMs: 900_000 });
    expect(computeWatcherTimeoutMs(w)).toBeGreaterThan(TICK_TIMEOUT_MS);
    await checkYouTubeDiscovery(w, bot, undefined, d);
    expect(seen).toBe(NOW + TICK_TIMEOUT_MS - WATCHER_TIMEOUT_MARGIN_MS);
  });

  test("a seed on last run's day that the run searched is not searched again in the widened band", async () => {
    lastWatcherRun = Date.parse("2026-11-07T12:00:00Z");
    listed = [doc(1, "2026-11-07"), doc(2, "2026-11-13")];
    recent = new Map([["ai/Seed 1.md", Date.parse("2026-11-07T12:00:30Z")]]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 2.md"]);
  });
});

describe("fix round 2 batch 5 (pins)", () => {
  test("the profile read once reaches every seed's rank prompt", async () => {
    let call = 0;
    searchAnswer = async () => {
      call++;
      return [hit(vid(call * 10 + 1))];
    };
    const d = deps({ profile: async () => "INVENTED-PROFILE-TEXT" });
    await checkYouTubeDiscovery(watcher(), bot, undefined, d);
    expect(rankPrompts).toHaveLength(3);
    expect(rankPrompts.every((p) => p.includes("INVENTED-PROFILE-TEXT"))).toBe(true);
  });

  test("a video whose shelf failed to save stays rankable for a later seed", async () => {
    listed = [doc(1, "2026-11-13"), doc(2, "2026-11-12")];
    searchAnswer = async () => [hit(vid(1)), hit(vid(2))];
    let n = 0;
    const d = deps({
      saveRun: async (run, hits) => {
        n++;
        if (n === 1) throw new Error("db down");
        saved.push({ run, hits });
        return "run-x";
      },
    });
    await checkYouTubeDiscovery(watcher(), bot, undefined, d);
    expect(rankPrompts[1]).toContain(vid(1));
  });

  test("youtube:store's detail is the first failure, not the last", async () => {
    let n = 0;
    await checkYouTubeDiscovery(
      watcher(),
      bot,
      undefined,
      deps({
        saveRun: async () => {
          n++;
          throw new Error(`failure ${n}`);
        },
      }),
    );
    expect(marks.get(HEALTH_STORE)).toEqual({ outcome: "error", detail: "3 of 3 seeds failed: failure 1" });
  });
});

describe("fix round 2 batch 6 (pins)", () => {
  test("a seed searched long ago is still skipped when the window widens back to it", async () => {
    // The window's edge: 13 days back (DISCOVER_MAX_WINDOW_DAYS, today included). No search of a doc
    // in the window can be older, so any age threshold of 14 days or more equals "ever".
    lastWatcherRun = Date.parse("2026-11-01T00:30:00Z");
    listed = [doc(1, "2026-11-01"), doc(2, "2026-11-13")];
    recent = new Map([["ai/Seed 1.md", Date.parse("2026-11-01T00:31:00Z")]]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 2.md"]);
  });

  test("a failed read of the last watcher run falls back to the last 7 days and the run goes on", async () => {
    listed = [doc(1, "2026-11-04"), doc(2, "2026-11-13")];
    const d = deps({
      lastWatcherRunAt: async () => {
        throw new Error("db down");
      },
    });
    await checkYouTubeDiscovery(watcher(), bot, undefined, d);
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 2.md"]);
    expect(marks.get(HEALTH_STORE)?.outcome).toBe("ok");
  });
});

describe("F14: failed seeds, retries and the carried window (architecture review 2026-11-16)", () => {
  const DAY = 86_400_000;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  /** Queries name their seed (`q<n>`), so a search can fail per seed. */
  let failing: Set<string>;
  let searched: string[];
  let clock: number;
  /** One run per week: the store keeps `recent` and the watcher anchor the way the real DB does. */
  function weekly(over: Partial<YouTubeDiscoveryDeps> = {}): YouTubeDiscoveryDeps {
    return deps({
      now: () => clock,
      saveRun: async (run, hits) => {
        saved.push({ run, hits });
        recent.set(run.seedDocId, clock);
        lastWatcherRun = clock;
        return `run-${saved.length}`;
      },
      ...over,
    });
  }
  beforeEach(() => {
    failing = new Set();
    searched = [];
    clock = NOW;
    queriesAnswer = async (p) => {
      const n = /Title: Seed (\d+)/.exec(p)?.[1];
      return JSON.stringify([{ query: `q${n}`, why: "same topic" }]);
    };
    searchAnswer = async (q) => {
      searched.push(q);
      return failing.has(q) ? null : [hit(vid(Number(q.slice(1)) * 10 + 1))];
    };
  });
  const setDocs = (ns: number[], date: (n: number) => string) => {
    for (const n of ns) {
      if (!(listed as CapturedDoc[]).some((d) => d.id === `ai/Seed ${n}.md`)) (listed as CapturedDoc[]).push(doc(n, date(n)));
      raws.set(`ai/Seed ${n}.md`, raw(n));
    }
  };

  test("3 of 5 seeds failing every search: no row for them, search error (partial), and a retry record each", async () => {
    listed = [];
    setDocs([1, 2, 3, 4, 5], () => day(NOW - DAY));
    failing = new Set(["q3", "q4", "q5"]);
    let partial: boolean | undefined;
    const d = weekly({
      health: async () => ({
        mark: (key, outcome, detail, o) => {
          marks.set(key, { outcome, detail });
          if (key === HEALTH_SEARCH) partial = o?.partial;
        },
        carry: (key) => void carried.push(key),
        finish: async () => [],
      }),
    });
    await checkYouTubeDiscovery(watcher(), bot, undefined, d);
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 1.md", "ai/Seed 2.md"]);
    expect(marks.get(HEALTH_SEARCH)).toEqual({
      outcome: "error",
      detail: "3 of 5 seeds failed: Every YouTube search failed. Is yt-dlp installed and up to date?; 3 of 5 searches failed",
    });
    expect(partial).toBe(true);
    expect(Object.keys(state!.retry).sort()).toEqual(["ai/Seed 3.md", "ai/Seed 4.md", "ai/Seed 5.md"]);
    expect(Object.values(state!.retry).every((r) => r.attempts === 1 && !r.exhausted)).toBe(true);
  });

  test("a run with no shelf never says part of it succeeded: seed 1 fails its queries, seed 2 every search", async () => {
    listed = [];
    setDocs([1, 2], () => day(NOW - DAY));
    queriesAnswer = async (p) => {
      const n = /Title: Seed (\d+)/.exec(p)?.[1];
      if (n === "1") throw new Error("model timeout");
      return JSON.stringify([{ query: `q${n}`, why: "same topic" }]);
    };
    failing = new Set(["q2"]);
    // The real record and alert text, alerting on the first failed run (a weekly row's rule).
    const map: SourceHealthMap = {};
    const d = weekly({
      health: async () => ({
        mark: (key, outcome, detail, o) => void (map[key] = recordOutcome(undefined, outcome, clock, detail, o)),
        carry: () => {},
        finish: async () => buildHealthAlerts("YouTube discovery", map, clock, 1),
      }),
    });
    const alerts = await checkYouTubeDiscovery(watcher(), bot, undefined, d);
    expect(saved).toHaveLength(0);
    // youtube:model: seed 2 passed it, seed 1 failed it ⇒ error, yet the run made nothing.
    const model = alerts.find((a) => a.subject?.includes(HEALTH_MODEL));
    expect(model?.summary).toContain("1 of 2 seeds failed: queries call: model timeout");
    for (const a of alerts) {
      expect(a.summary).not.toContain("part of the last run still succeeded");
      expect(a.summary).not.toContain("failed for part of its work");
    }
    expect(model?.summary).toContain("this source alone is not producing data");
  });

  test("retries run after this week's seeds, beyond maxSeeds; nothing in the window is skipped over three weeks", async () => {
    listed = [];
    setDocs([1, 2, 3, 4, 5], () => day(NOW - DAY));
    failing = new Set(["q3", "q4", "q5"]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    // Week 2: yt-dlp healthy, 3 new captures, maxSeeds 5 ⇒ the 3 new first, then all 3 retries.
    clock = NOW + 7 * DAY;
    failing = new Set();
    setDocs([6, 7, 8], () => day(clock - DAY));
    saved = [];
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 6.md", "ai/Seed 7.md", "ai/Seed 8.md", "ai/Seed 3.md", "ai/Seed 4.md", "ai/Seed 5.md"]);
    // Week 3: two more captures, no retries left.
    clock = NOW + 14 * DAY;
    setDocs([9, 10], () => day(clock - DAY));
    saved = [];
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 10.md", "ai/Seed 9.md"]);
    expect([...recent.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `ai/Seed ${n}.md`).sort());
    expect(state!.retry).toEqual({});
  });

  test("seeds the cap leaves stay seeds next run, even past the 14-day window", async () => {
    listed = [];
    setDocs([1, 2, 3, 4, 5, 6, 7], (n) => day(NOW - (n - 1) * DAY));
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved).toHaveLength(5);
    expect(state!.carryFrom).toBe(day(NOW - 6 * DAY));
    clock = NOW + 7 * DAY;
    setDocs([11, 12, 13, 14], () => day(clock - DAY));
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    clock = NOW + 14 * DAY;
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    // Seed 7 is 20 days old by week 3: searched, not dropped.
    expect(saved.map((s) => s.run.seedDocId).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14].map((n) => `ai/Seed ${n}.md`).sort());
    expect(state!.carryFrom).toBeNull();
  });

  test("a deadline that stops the run leaves its unstarted seeds for the next run", async () => {
    listed = [];
    setDocs([1, 2, 3, 4, 5], () => day(NOW - DAY));
    const d = weekly();
    d.services.queriesCall = async (p) => {
      clock += 100_000;
      return queriesAnswer(p);
    };
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, d);
    expect(saved).toHaveLength(3);
    expect(state!.carryFrom).toBe(day(NOW - DAY));
    clock = NOW + 8 * DAY;
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, d);
    expect(saved.map((s) => s.run.seedDocId).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `ai/Seed ${n}.md`));
  });

  test("a partly failed seed keeps its shelf with its failed count; it is not retried; health ok with the count", async () => {
    listed = [];
    setDocs([1, 2, 3, 4, 5], () => day(NOW - DAY));
    queriesAnswer = async (p) => {
      const n = /Title: Seed (\d+)/.exec(p)?.[1];
      return JSON.stringify([1, 2, 3, 4].map((k) => ({ query: `q${n}${k}`, why: "x" })));
    };
    failing = new Set(["q32"]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved).toHaveLength(5);
    expect(saved.find((s) => s.run.seedDocId === "ai/Seed 3.md")!.run.failed).toBe(1);
    expect(saved.filter((s) => s.run.failed === 0)).toHaveLength(4);
    expect(marks.get(HEALTH_SEARCH)).toEqual({ outcome: "ok", detail: "1 of 20 searches failed" });
    expect(state!.retry).toEqual({});
  });

  test("a search that finds nothing is a success: failed 0", async () => {
    listed = [];
    setDocs([1], () => day(NOW - DAY));
    searchAnswer = async () => [];
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved[0]!.run.failed).toBe(0);
    expect(marks.get(HEALTH_SEARCH)).toEqual({ outcome: "ok", detail: undefined });
  });

  test("a seed failing every week: 3 attempts, then exhausted and left alone", async () => {
    listed = [];
    setDocs([1], () => day(NOW - DAY));
    failing = new Set(["q1"]);
    const attempts: number[] = [];
    for (let w = 0; w < 4; w++) {
      clock = NOW + w * 7 * DAY;
      searched = [];
      await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
      attempts.push(searched.length);
    }
    expect(attempts).toEqual([1, 1, 1, 0]);
    expect(state!.retry["ai/Seed 1.md"]).toMatchObject({ attempts: 3, exhausted: true });
    expect(saved).toEqual([]);
  });

  test("a retry whose read answers not_found is dropped", async () => {
    listed = [];
    setDocs([1], () => day(NOW - DAY));
    failing = new Set(["q1"]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(state!.retry["ai/Seed 1.md"]?.attempts).toBe(1);
    raws.delete("ai/Seed 1.md");
    clock = NOW + 7 * DAY;
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(state!.retry).toEqual({});
  });

  test("a run of the seed stored after its failure (the reader's Find) ends the retry", async () => {
    listed = [];
    setDocs([1], () => day(NOW - DAY));
    failing = new Set(["q1"]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    recent.set("ai/Seed 1.md", NOW + DAY);
    clock = NOW + 7 * DAY;
    searched = [];
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(searched).toEqual([]);
    expect(state!.retry).toEqual({});
  });

  test("an unreadable state is not overwritten", async () => {
    listed = [];
    setDocs([1], () => day(NOW - DAY));
    failing = new Set(["q1"]);
    let writes = 0;
    await checkYouTubeDiscovery(
      watcher(),
      bot,
      undefined,
      weekly({
        loadState: async () => {
          throw new Error("db down");
        },
        saveState: async () => void writes++,
      }),
    );
    expect(writes).toBe(0);
  });
});

describe("F14 fix round 1 batch 1: retry budget, floor drops, state robustness", () => {
  const DAY = 86_400_000;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  let clock: number;
  let outage: boolean;
  let searched: string[];
  let warnings: string[];
  function weekly(over: Partial<YouTubeDiscoveryDeps> = {}): YouTubeDiscoveryDeps {
    return deps({
      now: () => clock,
      saveRun: async (run, hits) => {
        saved.push({ run, hits });
        recent.set(run.seedDocId, clock);
        lastWatcherRun = clock;
        return `run-${saved.length}`;
      },
      ...over,
    });
  }
  const addDocs = (ns: number[], date: (n: number) => string) => {
    for (const n of ns) {
      (listed as CapturedDoc[]).push(doc(n, date(n)));
      raws.set(`ai/Seed ${n}.md`, raw(n));
    }
  };
  const id = (n: number) => `ai/Seed ${n}.md`;
  const shelvedIds = () => new Set(saved.map((s) => s.run.seedDocId));
  const warned = (re: RegExp) => warnings.filter((w) => re.test(w));
  beforeEach(async () => {
    clock = NOW;
    outage = false;
    searched = [];
    warnings = [];
    listed = [];
    queriesAnswer = async (p) => JSON.stringify([{ query: `q${/Title: Seed (\d+)/.exec(p)?.[1]}`, why: "same topic" }]);
    searchAnswer = async (q) => {
      searched.push(q);
      return outage ? null : [hit(vid(Number(q.slice(1)) * 10 + 1))];
    };
    await configure({
      sinks: {
        capture: (r: LogRecord) => {
          if (r.level === "warning") warnings.push(r.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(""));
        },
      },
      loggers: [{ category: ["muninn", "watchers", "youtube-discovery"], sinks: ["capture"], lowestLevel: "warning" }],
      reset: true,
    });
  });
  afterEach(async () => {
    await reset();
  });

  for (const perWeek of [3, 2]) {
    test(`a 3-week outage at ${perWeek} captures a week (maxSeeds 3): every failed seed is retried within its cap and shelved`, async () => {
      const w = watcher({ maxSeeds: 3, timeoutMs: 300_000 });
      let n = 0;
      const failedSeeds: string[] = [];
      for (let week = 0; week < 8; week++) {
        clock = NOW + week * 7 * DAY;
        outage = week < 3;
        const fresh = Array.from({ length: perWeek }, () => ++n);
        addDocs(fresh, () => day(clock - DAY));
        if (outage) failedSeeds.push(...fresh.map(id));
        await checkYouTubeDiscovery(w, bot, undefined, weekly());
      }
      // Every seed ever captured got a shelf: none lost, none reported lost.
      expect([...shelvedIds()].sort()).toEqual(Array.from({ length: n }, (_, i) => id(i + 1)).sort());
      expect(warned(/carry floor|not retried again/)).toEqual([]);
      // Within the cap: no failed seed was searched more than MAX_SEED_ATTEMPTS (3) times.
      const perSeed = new Map<string, number>();
      for (const q of searched) perSeed.set(q, (perSeed.get(q) ?? 0) + 1);
      for (const s of failedSeeds) expect(perSeed.get(`q${/Seed (\d+)/.exec(s)![1]}`)!).toBeLessThanOrEqual(3);
      expect(state!.retry).toEqual({});
    });
  }

  test("retries get a budget of their own and every record gets a turn before any gets a second", async () => {
    // One week seed fills maxSeeds 1; seven records wait, two of them already tried twice.
    addDocs([1], () => day(NOW - DAY));
    addDocs([2, 3, 4, 5, 6, 7, 8], (k) => day(NOW - (20 - k) * DAY));
    const retry: DiscoveryState["retry"] = {};
    for (const k of [2, 3]) retry[id(k)] = { attempts: 2, lastAt: NOW - 30 * DAY, error: "old" };
    for (const k of [4, 5, 6, 7, 8]) retry[id(k)] = { attempts: 1, lastAt: NOW - 7 * DAY, error: "old" };
    state = { carryFrom: null, retry };
    await checkYouTubeDiscovery(watcher({ maxSeeds: 1, timeoutMs: 300_000 }), bot, undefined, weekly());
    // The week seed, then the retry budget (5) on the five tried once, oldest seed first.
    expect(saved.map((s) => s.run.seedDocId)).toEqual([1, 4, 5, 6, 7, 8].map(id));
    expect(Object.keys(state!.retry).sort()).toEqual([id(2), id(3)]);
  });

  test("a retry record or a carried seed passing the 28-day floor is warned about once and counted on youtube:store", async () => {
    addDocs([1], () => day(NOW - DAY));
    addDocs([2], () => day(NOW - 30 * DAY));
    addDocs([3], () => day(NOW - 29 * DAY));
    addDocs([4], () => day(NOW - 31 * DAY)); // exhausted already: warned when it was, not again
    state = {
      carryFrom: day(NOW - 29 * DAY),
      retry: {
        [id(2)]: { attempts: 1, lastAt: NOW - 20 * DAY, error: "every search failed" },
        [id(4)]: { attempts: 3, lastAt: NOW - 20 * DAY, error: "x", exhausted: true },
      },
    };
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, weekly());
    expect(warned(/carry floor/).length).toBe(2);
    expect(warned(/carry floor/).some((w) => w.includes(id(2)))).toBe(true);
    expect(warned(/carry floor/).some((w) => w.includes(id(3)))).toBe(true);
    expect(marks.get(HEALTH_STORE)?.detail).toContain("2 seeds dropped unsearched at the 28-day carry floor");
    expect([...shelvedIds()]).toEqual([id(1)]);
    clock = NOW + 7 * DAY;
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, weekly());
    expect(warned(/carry floor/).length).toBe(2);
  });

  test("one malformed retry entry is dropped alone: carryFrom and the valid records survive", async () => {
    addDocs([3, 4], (k) => day(NOW - (k - 2) * DAY));
    addDocs([5], () => day(NOW - 10 * DAY));
    addDocs([1, 2], () => day(NOW - 9 * DAY));
    state = {
      carryFrom: day(NOW - 10 * DAY),
      retry: {
        [id(1)]: { attempts: "1", lastAt: NOW - 7 * DAY, error: "x" },
        [id(2)]: { attempts: 1, lastAt: NOW - 7 * DAY, error: "x" },
      },
    } as unknown as DiscoveryState;
    await checkYouTubeDiscovery(watcher({ maxSeeds: 1, timeoutMs: 300_000 }), bot, undefined, weekly());
    // The valid record was retried; the newest week seed ran; the carried band is still carried.
    expect(shelvedIds().has(id(2))).toBe(true);
    expect(state!.carryFrom).toBe(day(NOW - 10 * DAY));
    expect(warned(/malformed/).length).toBe(1);
  });

  // An earlier stored run 7 days back anchors the window; 5 seeds, maxSeeds 2: three runs shelve them all.
  const leftScenario = () => {
    lastWatcherRun = NOW - 7 * DAY;
    addDocs([1, 2, 3, 4, 5], (k) => day(NOW - k * DAY));
  };
  const nextRuns = async () => {
    for (const k of [1, 2, 3]) {
      clock = NOW + k * 7 * DAY;
      await checkYouTubeDiscovery(watcher({ maxSeeds: 2, timeoutMs: 300_000 }), bot, undefined, weekly());
    }
    expect([...shelvedIds()].sort()).toEqual([1, 2, 3, 4, 5].map(id));
  };

  test("an unreadable state: the run moves no seed, and the next runs lose none", async () => {
    leftScenario();
    let writes = 0;
    const d = weekly({
      loadState: async () => {
        throw new Error("db down");
      },
      saveState: async () => void writes++,
    });
    await checkYouTubeDiscovery(watcher({ maxSeeds: 2, timeoutMs: 300_000 }), bot, undefined, d);
    expect(writes).toBe(0);
    await nextRuns();
  });

  test("a state save that always fails: the run moves no seed, and the next runs lose none", async () => {
    leftScenario();
    const d = weekly({
      saveState: async () => {
        throw new Error("db down");
      },
    });
    await checkYouTubeDiscovery(watcher({ maxSeeds: 2, timeoutMs: 300_000 }), bot, undefined, d);
    await nextRuns();
  });

  test("a state save that fails after the seeds ran: no left seed is lost on the next runs", async () => {
    leftScenario();
    const d = weekly({
      saveState: async (_id, next) => {
        if (searched.length > 0) throw new Error("db gone mid-run");
        state = structuredClone(next);
      },
    });
    await checkYouTubeDiscovery(watcher({ maxSeeds: 2, timeoutMs: 300_000 }), bot, undefined, d);
    expect(saved).toHaveLength(2);
    await nextRuns();
  });

  test("a seed's last attempt in a run whose state save fails is not charged: retried next run, warned once when its exhaustion is saved", async () => {
    addDocs([1], () => day(NOW - 3 * DAY));
    state = { carryFrom: null, retry: { [id(1)]: { attempts: 2, lastAt: NOW - 7 * DAY, error: "x" } } };
    outage = true;
    const d = weekly({
      saveState: async (_id, next) => {
        if (searched.length > 0) throw new Error("db gone mid-run");
        state = structuredClone(next);
      },
    });
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, d);
    expect(warned(/not retried again/)).toEqual([]);
    expect(state!.retry[id(1)]).toMatchObject({ attempts: 2, pending: NOW });
    for (const k of [1, 2]) {
      clock = NOW + k * 7 * DAY;
      searched = [];
      await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, weekly());
      expect(searched).toEqual(k === 1 ? ["q1"] : []);
    }
    expect(state!.retry[id(1)]).toMatchObject({ attempts: 3, exhausted: true });
    expect(warned(/not retried again/).length).toBe(1);
  });

  // Pins of the checkpoint design (green on bdced0d6 too, which had no checkpoint).
  test("a retry that made its shelf in a run whose state save fails is not searched again", async () => {
    addDocs([1], () => day(NOW - 3 * DAY));
    state = { carryFrom: null, retry: { [id(1)]: { attempts: 1, lastAt: NOW - 7 * DAY, error: "x" } } };
    const d = weekly({
      saveState: async (_id, next) => {
        if (searched.length > 0) throw new Error("db gone mid-run");
        state = structuredClone(next);
      },
    });
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, d);
    expect(searched).toEqual(["q1"]);
    clock = NOW + 7 * DAY;
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, weekly());
    expect(searched).toEqual(["q1"]);
    expect(state!.retry).toEqual({});
  });

  test("a final state save that fails once is retried", async () => {
    addDocs([1], () => day(NOW - DAY));
    outage = true;
    let failures = 0;
    const d = weekly({
      saveState: async (_id, next) => {
        if (searched.length > 0 && failures++ === 0) throw new Error("blip");
        state = structuredClone(next);
      },
    });
    await checkYouTubeDiscovery(watcher({ timeoutMs: 300_000 }), bot, undefined, d);
    expect(state!.retry[id(1)]).toMatchObject({ attempts: 1, error: expect.stringContaining("search") });
  });

  describe("fix round 2 batch 1: unfinished runs, the floor after the ended check, outage-class stand-down", () => {
    const w = () => watcher({ timeoutMs: 300_000 });
    const rec = (attempts: number, error = "every search failed") => ({ attempts, lastAt: NOW - 7 * DAY, error });

    test("a run abandoned after its checkpoint charges nothing: a seed tried twice is searched again, and warned when it exhausts", async () => {
      addDocs([1], () => day(NOW - 10 * DAY));
      state = { carryFrom: null, retry: { [id(1)]: rec(2) } };
      let reading!: () => void;
      const inRead = new Promise<void>((r) => (reading = r));
      const hung = weekly();
      // The seed's raw read never answers (after the checkpoint): a restart or a `bun --watch` reload mid-run.
      hung.services.readRaw = () => {
        reading();
        return new Promise(() => {});
      };
      void checkYouTubeDiscovery(w(), bot, undefined, hung);
      await inRead;
      clock = NOW + 3_600_000;
      outage = true;
      await checkYouTubeDiscovery(w(), bot, undefined, weekly());
      expect(searched).toEqual(["q1"]);
      expect(state!.retry[id(1)]).toMatchObject({ attempts: 3, exhausted: true });
      expect(warned(/not retried again/).length).toBe(1);
      expect(warned(/never saved their outcome/).length).toBe(1);
    });

    test("a retry record past the floor whose seed has a run stored after its failure is ended, not reported lost", async () => {
      addDocs([1], () => day(NOW - 29 * DAY));
      addDocs([2], () => day(NOW - DAY));
      state = { carryFrom: null, retry: { [id(1)]: { attempts: 1, lastAt: NOW - 5 * DAY, error: "every search failed" } } };
      recent.set(id(1), NOW - 2 * DAY); // the reader's Find, after the failure
      await checkYouTubeDiscovery(w(), bot, undefined, weekly());
      expect(warned(/carry floor/)).toEqual([]);
      expect(marks.get(HEALTH_STORE)?.outcome).toBe("ok");
      expect(marks.get(HEALTH_STORE)?.detail).toBeUndefined();
      expect(state!.retry).toEqual({});
    });

    test("without the run times a record past the floor is kept, unretried and unwarned, for the next run to decide", async () => {
      addDocs([1], () => day(NOW - 29 * DAY));
      state = { carryFrom: null, retry: { [id(1)]: rec(1) } };
      const noTimes = weekly({
        latestRunTimes: async () => {
          throw new Error("db down");
        },
      });
      await checkYouTubeDiscovery(w(), bot, undefined, noTimes);
      expect(warned(/carry floor/)).toEqual([]);
      expect(searched).toEqual([]);
      expect(state!.retry).toEqual({ [id(1)]: rec(1) });
      // The next run reads the times: no run of the seed is stored, so it is reported lost then.
      clock = NOW + 7 * DAY;
      await checkYouTubeDiscovery(w(), bot, undefined, weekly());
      expect(warned(/carry floor/).length).toBe(1);
      expect(state!.retry).toEqual({});
    });

    test("a record held without the run times survives a run whose final saves fail (the checkpoint keeps it)", async () => {
      addDocs([1], () => day(NOW - 29 * DAY));
      addDocs([2], () => day(NOW - DAY));
      state = { carryFrom: null, retry: { [id(1)]: rec(1) } };
      const d = weekly({
        latestRunTimes: async () => {
          throw new Error("db down");
        },
        saveState: async (_id, next) => {
          if (searched.length > 0) throw new Error("db gone mid-run");
          state = structuredClone(next);
        },
      });
      await checkYouTubeDiscovery(w(), bot, undefined, d);
      expect(searched).toEqual(["q2"]);
      expect(state!.retry[id(1)]).toEqual(rec(1));
    });

    test("an outage-class failure after a shelf this run does not stand the remaining retries down", async () => {
      addDocs([1], () => day(NOW - DAY));
      addDocs([2, 3, 4], () => day(NOW - 10 * DAY));
      state = { carryFrom: null, retry: Object.fromEntries([2, 3, 4].map((k) => [id(k), rec(1)])) };
      searchAnswer = async (q) => {
        searched.push(q);
        return q === "q2" ? null : [hit(vid(Number(q.slice(1)) * 10 + 1))];
      };
      await checkYouTubeDiscovery(w(), bot, undefined, weekly());
      expect(searched).toEqual(["q1", "q2", "q3", "q4"]);
      expect([...shelvedIds()].sort()).toEqual([id(1), id(3), id(4)]);
      expect(warned(/stood down/)).toEqual([]);
    });

    test("the only week seed failing on its own document (model_unparseable) does not stand the retries down", async () => {
      addDocs([9], () => day(NOW - DAY));
      addDocs([1, 2], () => day(NOW - 10 * DAY));
      state = { carryFrom: null, retry: { [id(1)]: rec(1), [id(2)]: rec(1) } };
      queriesAnswer = async (p) => {
        const n = /Title: Seed (\d+)/.exec(p)?.[1];
        return n === "9" ? "I cannot help with that" : JSON.stringify([{ query: `q${n}`, why: "same topic" }]);
      };
      await checkYouTubeDiscovery(w(), bot, undefined, weekly());
      expect([...shelvedIds()].sort()).toEqual([id(1), id(2)]);
      expect(warned(/stood down/)).toEqual([]);
      expect(state!.retry[id(9)]).toMatchObject({ attempts: 1 });
    });

    // Each outage class of FAILURE_CLASS, on the first retry of a run with no week seeds.
    const outageCauses: [string, () => Partial<YouTubeDiscoveryDeps>][] = [
      ["search_failed", () => ((outage = true), {})],
      ["upstream (raw read)", () => ((raws = new Map([...raws].map(([k]) => [k, new Error("huginn 502")]))), {})],
      [
        "model_failed (queries)",
        () => (
          (queriesAnswer = async () => {
            throw new Error("429 overloaded");
          }),
          {}
        ),
      ],
      [
        "save_failed",
        () => ({
          saveRun: async () => {
            throw new Error("db refused");
          },
        }),
      ],
    ];
    for (const [cause, arrange] of outageCauses) {
      test(`no week seeds: the first retry failing with ${cause} stands the rest down, which keep their attempts`, async () => {
        addDocs([1, 2, 3], () => day(NOW - 10 * DAY));
        state = { carryFrom: null, retry: Object.fromEntries([1, 2, 3].map((k) => [id(k), rec(1)])) };
        const over = arrange();
        await checkYouTubeDiscovery(w(), bot, undefined, weekly(over));
        expect(state!.retry[id(1)]).toMatchObject({ attempts: 2 });
        expect(state!.retry[id(2)]).toEqual(rec(1));
        expect(state!.retry[id(3)]).toEqual(rec(1));
        expect(warned(/stood down/).length).toBe(1);
      });
    }
  });
});

describe("F14 fix round 1 batch 3: search tally after a rank failure; a deadline cut is no failure", () => {
  const DAY = 86_400_000;
  const id = (n: number) => `ai/Seed ${n}.md`;

  test("a rank failure after partly failed searches still counts the seed's searches: 2 of 6 failed", async () => {
    listed = [doc(1, "2026-11-13"), doc(2, "2026-11-12")];
    queriesAnswer = async (p) => {
      const n = /Title: Seed (\d+)/.exec(p)?.[1];
      return JSON.stringify([1, 2, 3].map((i) => ({ query: `s${n}q${i}`, why: "same topic" })));
    };
    searchAnswer = async (q) => (q === "s2q1" || q === "s2q2" ? null : [hit(vid(Number(q[1]) * 10 + Number(q[3])))]);
    let ranks = 0;
    rankAnswer = async () => {
      if (++ranks === 2) throw new Error("429 overloaded");
      return JSON.stringify([{ n: 1, score: 0.8, why: "fits" }]);
    };
    await checkYouTubeDiscovery(watcher(), bot, undefined, deps());
    expect(ranks).toBe(2);
    expect(marks.get(HEALTH_SEARCH)).toEqual({ outcome: "ok", detail: "2 of 6 searches failed" });
  });

  const deadlineOf = (w: Watcher) => NOW + Math.min(computeWatcherTimeoutMs(w), TICK_TIMEOUT_MS) - WATCHER_TIMEOUT_MARGIN_MS;
  /**
   * The first rank call is cut by the run's deadline: a slow search leaves it 10 s (under
   * CUT_START_MAX_MS), the clock reaches the deadline and the router's deadline error rejects.
   * `slowRead` puts the slow step before the queries call instead.
   */
  function cutRun(slowRead = false): { d: YouTubeDiscoveryDeps; w: Watcher; setClock: (t: number) => void } {
    let clock = NOW;
    const w = watcher({ timeoutMs: 300_000 });
    const d = deps({
      now: () => clock,
      saveRun: async (run, hits) => {
        saved.push({ run, hits });
        recent.set(run.seedDocId, clock);
        return `run-${saved.length}`;
      },
    });
    const late = () => {
      if (clock < NOW + DAY) clock = deadlineOf(w) - 10_000;
    };
    const { readRaw, search } = d.services;
    if (slowRead) d.services.readRaw = async (c, id) => (late(), readRaw(c, id));
    else d.services.search = async (q, n) => (late(), search(q, n));
    d.services.rankCall = async () => {
      if (clock < NOW + DAY) {
        clock = deadlineOf(w);
        throw new Error("haiku-router: deadline passed before the CLI call");
      }
      return rankAnswer("");
    };
    return { d, w, setClock: (t) => void (clock = t) };
  }

  test("a week seed whose rank call the deadline cuts: no retry record, carried to the next run, model not error", async () => {
    listed = [doc(1, "2026-11-13")];
    const { d, w, setClock } = cutRun();
    await checkYouTubeDiscovery(w, bot, undefined, d);
    expect(saved).toEqual([]);
    expect(state!.retry).toEqual({});
    expect(state!.carryFrom).toBe("2026-11-13");
    expect(marks.get(HEALTH_MODEL)?.outcome).not.toBe("error");
    expect(carried).toContain(HEALTH_MODEL);
    // Next week the seed runs again and makes its shelf.
    setClock(NOW + 7 * DAY);
    await checkYouTubeDiscovery(w, bot, undefined, d);
    expect(saved.map((s) => s.run.seedDocId)).toEqual([id(1)]);
  });

  test("a retry whose rank call the deadline cuts keeps its attempt count", async () => {
    listed = [doc(1, "2026-11-10")];
    state = { carryFrom: null, retry: { [id(1)]: { attempts: 1, lastAt: NOW - 7 * DAY, error: "rank call: 429" } } };
    const { d, w } = cutRun();
    await checkYouTubeDiscovery(w, bot, undefined, d);
    expect(saved).toEqual([]);
    expect(state!.retry[id(1)]).toEqual({ attempts: 1, lastAt: NOW - 7 * DAY, error: "rank call: 429" });
    expect(marks.get(HEALTH_MODEL)?.outcome).not.toBe("error");
  });

  test("a queries call the deadline cuts is no failure either", async () => {
    listed = [doc(1, "2026-11-13")];
    const { d, w } = cutRun(true);
    d.services.queriesCall = d.services.rankCall;
    await checkYouTubeDiscovery(w, bot, undefined, d);
    expect(state!.retry).toEqual({});
    expect(state!.carryFrom).toBe("2026-11-13");
    expect(carried).toContain(HEALTH_MODEL);
  });
});

describe("F14 fix round 2 batch 2: a model call that hangs to the deadline is a model failure, not a cut", () => {
  const id = (n: number) => `ai/Seed ${n}.md`;
  /**
   * The Haiku router on a non-CLI backend under `deadlineAt`: the backend attempt gets
   * min(60 s, left/2), the CLI fallback min(60 s, what is left), and both stall to their bounds.
   */
  const hangingCall = (clock: { t: number }, deadlineAt: number) => async (): Promise<string> => {
    const backend = Math.min(60_000, Math.floor((deadlineAt - clock.t) / 2));
    clock.t += backend;
    clock.t += Math.min(60_000, deadlineAt - clock.t);
    throw new Error("Haiku timed out after 45000 ms");
  };

  test("default row (no timeoutMs, 90 s): a queries call that stalls both attempts charges youtube:model and records a retry", async () => {
    listed = [doc(1, "2026-11-13")];
    const w = watcher();
    const deadlineAt = NOW + Math.min(computeWatcherTimeoutMs(w), TICK_TIMEOUT_MS) - WATCHER_TIMEOUT_MARGIN_MS;
    expect(deadlineAt - NOW).toBe(90_000);
    const clock = { t: NOW };
    const d = deps({ now: () => clock.t });
    d.services.queriesCall = hangingCall(clock, deadlineAt);
    await checkYouTubeDiscovery(w, bot, undefined, d);
    // The call rejected AT the deadline, after 45 s + 45 s: the time alone would read as a cut.
    expect(clock.t).toBe(deadlineAt);
    expect(saved).toEqual([]);
    expect(marks.get(HEALTH_MODEL)?.outcome).toBe("error");
    expect(state!.retry[id(1)]).toMatchObject({ attempts: 1, lastAt: deadlineAt });
  });

  test("a retry whose rank call stalls to the deadline is charged an attempt", async () => {
    listed = [doc(1, "2026-11-10")];
    state = { carryFrom: null, retry: { [id(1)]: { attempts: 1, lastAt: NOW - 7 * 86_400_000, error: "rank call: 429" } } };
    const w = watcher();
    const deadlineAt = NOW + 90_000;
    const clock = { t: NOW };
    const d = deps({ now: () => clock.t });
    d.services.rankCall = hangingCall(clock, deadlineAt);
    await checkYouTubeDiscovery(w, bot, undefined, d);
    expect(clock.t).toBe(deadlineAt);
    expect(state!.retry[id(1)]).toMatchObject({ attempts: 2, lastAt: deadlineAt });
    expect(marks.get(HEALTH_MODEL)?.outcome).toBe("error");
  });
});
