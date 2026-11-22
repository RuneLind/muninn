/**
 * The weekly `youtube-discovery` watcher with every seam injected (no
 * mock.module): the listing, the raw reads, the two model calls, the search,
 * the store and the health recorder. Invented ids and titles only (public repo).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Watcher } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { YouTubeHit } from "../youtube/discover.ts";
import type { CapturedDoc } from "../youtube/discover-deps.ts";
import type { DiscoverHitInput, DiscoverRunInput } from "../db/youtube-discover.ts";
import type { SourceHealthRecorder, SourceOutcome } from "./source-health.ts";
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

  test("retries take only the slots this week's seeds leave; nothing in the window is skipped over three weeks", async () => {
    listed = [];
    setDocs([1, 2, 3, 4, 5], () => day(NOW - DAY));
    failing = new Set(["q3", "q4", "q5"]);
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    // Week 2: yt-dlp healthy, 3 new captures, maxSeeds 5 ⇒ the 3 new first, then 2 retries.
    clock = NOW + 7 * DAY;
    failing = new Set();
    setDocs([6, 7, 8], () => day(clock - DAY));
    saved = [];
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 6.md", "ai/Seed 7.md", "ai/Seed 8.md", "ai/Seed 3.md", "ai/Seed 4.md"]);
    // Week 3: two more captures, then the last retry.
    clock = NOW + 14 * DAY;
    setDocs([9, 10], () => day(clock - DAY));
    saved = [];
    await checkYouTubeDiscovery(watcher(), bot, undefined, weekly());
    expect(saved.map((s) => s.run.seedDocId)).toEqual(["ai/Seed 10.md", "ai/Seed 9.md", "ai/Seed 5.md"]);
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
