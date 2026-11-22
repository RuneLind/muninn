/** The Discover page's pure helpers: lengths, counts, ages, and which cards a shelf shows in what order. */
import { describe, expect, test } from "bun:test";
import {
  createJobFollower,
  dscAge,
  dscCount,
  dscDuration,
  dscHiddenNote,
  dscUndoState,
  dscVisibleHits,
  DSC_JOB_POLL_MAX_FAILS,
  type CaptureEnd,
} from "./discover-page-client.ts";
import type { DiscoverHit, DiscoverHitState } from "../../../db/youtube-discover.ts";
import { dscFilterSeeds } from "./discover-seed-bar-client.ts";
import type { SeedDoc } from "../../../youtube/discover-seeds.ts";

const hit = (videoId: string, over: Partial<DiscoverHit> = {}): DiscoverHit => ({
  videoId,
  title: videoId,
  channel: null,
  durationSec: 600,
  viewCount: null,
  score: 0.5,
  why: "",
  query: "",
  rank: 1,
  state: "new",
  details: null,
  ...over,
});
const detailsOn = (uploadDate: string) => ({
  description: null,
  chapters: [],
  likeCount: null,
  viewCount: null,
  uploadDate,
  channelFollowerCount: null,
  tags: [],
});

describe("formatting", () => {
  test("dscDuration", () => {
    expect(dscDuration(null)).toBe("");
    expect(dscDuration(65)).toBe("1:05");
    expect(dscDuration(3723)).toBe("1:02:03");
  });
  test("dscCount", () => {
    expect(dscCount(null)).toBe("");
    expect(dscCount(999)).toBe("999");
    expect(dscCount(22_400)).toBe("22K");
    expect(dscCount(2_400_000)).toBe("2.4M");
    expect(dscCount(3_000_000)).toBe("3M");
  });
  test("dscAge against a fixed now", () => {
    const now = Date.UTC(2026, 10, 14);
    expect(dscAge("20261114", now)).toBe("today");
    expect(dscAge("20261113", now)).toBe("1 day ago");
    expect(dscAge("20261101", now)).toBe("13 days ago");
    expect(dscAge("20260514", now)).toBe("6 months ago");
    expect(dscAge("20240101", now)).toBe("2 years ago");
    expect(dscAge("NA", now)).toBe("");
    expect(dscAge(null, now)).toBe("");
  });
});

describe("dscVisibleHits", () => {
  const hits = [
    hit("a", { rank: 1, score: 0.7, durationSec: 300, details: detailsOn("20250101") }),
    hit("b", { rank: 2, score: 0.9, durationSec: 2000 }),
    hit("c", { rank: 3, score: 0.9, durationSec: 900, details: detailsOn("20260101") }),
    hit("d", { rank: 4, score: 1, state: "dismissed" }),
    hit("e", { rank: 5, score: 0.4, durationSec: null }),
  ];
  const ids = (list: DiscoverHit[]) => list.map((h) => h.videoId);
  test("dismissed never shows; score ties keep the stored rank", () => {
    expect(ids(dscVisibleHits(hits, "score", 0))).toEqual(["b", "c", "a", "e"]);
  });
  test("newest upload sorts by the cached probe's date, unknown last", () => {
    expect(ids(dscVisibleHits(hits, "new", 0))).toEqual(["c", "a", "b", "e"]);
  });
  test("longest and shortest put an unknown length last", () => {
    expect(ids(dscVisibleHits(hits, "long", 0))).toEqual(["b", "c", "a", "e"]);
    expect(ids(dscVisibleHits(hits, "short", 0))).toEqual(["a", "c", "b", "e"]);
  });
  test("a length filter drops shorter and unknown lengths", () => {
    expect(ids(dscVisibleHits(hits, "score", 600))).toEqual(["b", "c"]);
    expect(ids(dscVisibleHits(hits, "score", 1800))).toEqual(["b"]);
  });
  test("later and queued videos still show", () => {
    expect(ids(dscVisibleHits([hit("x", { state: "later" }), hit("y", { state: "queued", rank: 2 })], "score", 0))).toEqual(["x", "y"]);
  });
});

describe("dscFilterSeeds (PR 3 pick list)", () => {
  const seed = (id: string, title: string, category: string | null): SeedDoc => ({ id, title, category, date: null });
  const docs = [
    seed("ai/agents/1.md", "Agent Evals in Practice", "ai/agents"),
    seed("ai/claude/2.md", "Claude Code hooks", "ai/claude"),
    seed("music/3.md", "Jazz agents of change", "music"),
    seed("4.md", "Root talk", null),
  ];
  test("every word must match title or category, any case, in listing order", () => {
    expect(dscFilterSeeds(docs, "AGENT").map((d) => d.id)).toEqual(["ai/agents/1.md", "music/3.md"]);
    expect(dscFilterSeeds(docs, "agents ai").map((d) => d.id)).toEqual(["ai/agents/1.md"]);
    expect(dscFilterSeeds(docs, "claude hooks").map((d) => d.id)).toEqual(["ai/claude/2.md"]);
    expect(dscFilterSeeds(docs, "nothing")).toEqual([]);
  });
  test("an empty filter lists everything, up to the limit", () => {
    expect(dscFilterSeeds(docs, "  ")).toHaveLength(4);
    expect(dscFilterSeeds(docs, "", 2).map((d) => d.id)).toEqual(["ai/agents/1.md", "ai/claude/2.md"]);
  });
});

describe("dscHiddenNote (F18)", () => {
  test("nothing when none hidden; the count otherwise", () => {
    expect(dscHiddenNote(0)).toBe("");
    expect(dscHiddenNote(1)).toStartWith("1 older shelf not shown.");
    expect(dscHiddenNote(4)).toStartWith("4 older shelves not shown.");
  });
});

describe("createJobFollower (F17)", () => {
  /** A manual clock: each `run()` fires the pending poll. */
  function harness(answer: () => Promise<{ id: string; status: string; error?: string }[]>) {
    let pending: (() => void) | null = null;
    let polls = 0;
    const f = createJobFollower({
      fetchJobs: () => {
        polls++;
        return answer();
      },
      setTimer: (fn) => void (pending = fn),
    });
    const run = async () => {
      const fn = pending;
      pending = null;
      fn?.();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    return { f, run, polls: () => polls, idle: () => pending === null };
  }

  test("one poll serves every followed job; it stops once none is followed", async () => {
    let list = [{ id: "a", status: "summarizing" }, { id: "b", status: "summarizing" }];
    const h = harness(async () => list);
    const ends: string[] = [];
    void h.f.follow("a").then((e) => ends.push(`a:${e.end}`));
    void h.f.follow("b").then((e) => ends.push(`b:${e.end}`));
    await h.run();
    expect(h.polls()).toBe(1);
    list = [{ id: "a", status: "error" }, { id: "b", status: "complete" }];
    await h.run();
    expect(ends.sort()).toEqual(["a:error", "b:complete"]);
    expect(h.idle()).toBe(true);
  });

  test("a job followed while a poll is in flight is judged only by a later poll", async () => {
    let answerHeld: (jobs: { id: string; status: string; error?: string }[]) => void = () => {};
    let answer = () => new Promise<{ id: string; status: string; error?: string }[]>((r) => (answerHeld = r));
    const h = harness(() => answer());
    const ends: string[] = [];
    void h.f.follow("a").then((e) => ends.push(`a:${e.end}`));
    await h.run(); // poll 1 starts and holds
    expect(h.polls()).toBe(1);
    void h.f.follow("b").then((e) => ends.push(`b:${e.end}`));
    answerHeld([{ id: "a", status: "summarizing" }]); // poll 1's answer, asked before b was followed
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ends).toEqual([]);
    answer = async () => [{ id: "a", status: "summarizing" }, { id: "b", status: "error", error: "no captions" }];
    await h.run();
    expect(h.polls()).toBe(2);
    expect(ends).toEqual(["b:error"]);
  });

  test("a job the store no longer has is lost; failed polls give up after the bound", async () => {
    const h = harness(async () => []);
    const end = h.f.follow("gone");
    await h.run();
    expect(await end).toEqual({ end: "lost" });

    const down = harness(async () => {
      throw new Error("offline");
    });
    let settled: unknown = null;
    void down.f.follow("x").then((e) => (settled = e));
    for (let i = 0; i < DSC_JOB_POLL_MAX_FAILS - 1; i++) await down.run();
    expect(settled).toBeNull();
    await down.run();
    expect(settled).toEqual({ end: "lost" });
    expect(down.idle()).toBe(true);
  });
});

describe("dscUndoState (F17 fix round 2 batch 2)", () => {
  const capture = (end?: CaptureEnd) => ({ before: "later" as DiscoverHitState, ...(end ? { end } : {}) });
  test("a video queued by this page: queued while the job runs, after it completed, and when no job was followed", () => {
    expect(dscUndoState("queued", capture())).toBe("queued");
    expect(dscUndoState("queued", capture({ end: "complete" }))).toBe("queued");
  });
  test("after a failed or a lost capture: the state before Summarize", () => {
    expect(dscUndoState("queued", capture({ end: "error", message: "x" }))).toBe("later");
    expect(dscUndoState("queued", capture({ end: "lost" }))).toBe("later");
  });
  test("a video queued before this page loaded, or any other state, is written back as it was", () => {
    expect(dscUndoState("queued", undefined)).toBe("queued");
    for (const s of ["new", "later", "dismissed"] as DiscoverHitState[]) {
      expect(dscUndoState(s, capture({ end: "error", message: "x" }))).toBe(s);
      expect(dscUndoState(s, capture({ end: "lost" }))).toBe(s);
      expect(dscUndoState(s, capture({ end: "complete" }))).toBe(s);
    }
  });
});

