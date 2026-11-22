/** The Discover page's pure helpers: lengths, counts, ages, and which cards a shelf shows in what order. */
import { describe, expect, test } from "bun:test";
import {
  dscAge,
  dscCount,
  dscDuration,
  dscFailedNote,
  dscHiddenNote,
  dscVisibleHits,
  followCaptureJob,
  summarizeFlow,
  type CaptureEnd,
  type CaptureStream,
  type SummarizeFlowDeps,
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

/** A scripted EventSource: `fire` delivers an event the way the browser would. */
function fakeStream() {
  const listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  const es: CaptureStream & { url?: string; closed: boolean } = {
    closed: false,
    onerror: null,
    addEventListener: (type, fn) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    close: () => void (es.closed = true),
  };
  const fire = (type: string, data?: string) => {
    const e = { data } as MessageEvent;
    for (const fn of listeners.get(type) ?? []) fn(e);
    // As in the browser: an `error` event (the server's `event: error` too) also reaches `onerror`.
    if (type === "error") es.onerror?.(e as unknown as Event);
  };
  return { es, fire };
}

describe("followCaptureJob (F17)", () => {
  test("the job's error event ends it with the job's message, and closes the stream", async () => {
    const { es, fire } = fakeStream();
    let url = "";
    const p = followCaptureJob("job 1", (u) => ((url = u), es));
    fire("status", JSON.stringify({ status: "fetching_transcript" }));
    fire("error", JSON.stringify({ message: "No transcript for this video" }));
    expect(await p).toEqual({ end: "error", message: "No transcript for this video" });
    expect(url).toBe("/api/youtube/stream/job%201");
    expect(es.closed).toBe(true);
  });
  test("complete ends it; a transport error (no data) is lost, not a failure", async () => {
    const a = fakeStream();
    const p1 = followCaptureJob("j", () => a.es);
    a.fire("complete", "{}");
    expect(await p1).toEqual({ end: "complete" });

    const b = fakeStream();
    const p2 = followCaptureJob("j", () => b.es);
    b.fire("error"); // EventSource's own error event carries no data
    expect(await p2).toEqual({ end: "lost" });
  });
});

describe("summarizeFlow (F17)", () => {
  const run = async (end: CaptureEnd, data: Record<string, unknown> = { job_id: "j1" }, before: DiscoverHitState = "new") => {
    let state: DiscoverHitState = before;
    const states: DiscoverHitState[] = [];
    const toasts: string[] = [];
    let queuedAt = -1;
    const deps: SummarizeFlowDeps = {
      start: async () => ({ ok: true, status: 200, data }),
      setState: async (s) => {
        state = s;
        states.push(s);
        return null;
      },
      follow: async () => end,
      toast: (m) => void toasts.push(m),
      queued: () => void (queuedAt = states.length),
    };
    await summarizeFlow(before, deps);
    return { state, states, toasts, queuedAt };
  };

  test("a failed capture clears queued back to the earlier state and says why", async () => {
    const r = await run({ end: "error", message: "No transcript for this video" });
    expect(r.states).toEqual(["queued", "new"]);
    expect(r.state).toBe("new");
    expect(r.queuedAt).toBe(1);
    expect(r.toasts.at(-1)).toBe("The summary failed: No transcript for this video. You can try again.");
  });
  test("a Later video goes back to Later", async () => {
    expect((await run({ end: "error", message: "x" }, { job_id: "j1" }, "later")).state).toBe("later");
  });
  test("a completed or lost job stays queued; a duplicate is not followed", async () => {
    expect((await run({ end: "complete" })).state).toBe("queued");
    expect((await run({ end: "lost" })).state).toBe("queued");
    expect((await run({ end: "error", message: "x" }, { duplicate: true, job_id: "j1" })).state).toBe("queued");
  });
  test("a refused start writes no state", async () => {
    const states: DiscoverHitState[] = [];
    const toasts: string[] = [];
    await summarizeFlow("new", {
      start: async () => ({ ok: false, status: 503, data: { error: "Summarizer offline" } }),
      setState: async (s) => (states.push(s), null),
      follow: async () => ({ end: "complete" }),
      toast: (m) => void toasts.push(m),
      queued: () => {},
    });
    expect(states).toEqual([]);
    expect(toasts).toEqual(["Summarizer offline"]);
  });
});

describe("shelf notes (F14, F18)", () => {
  test("hidden shelves", () => {
    expect(dscHiddenNote(0)).toBe("");
    expect(dscHiddenNote(1)).toBe("1 older shelf is not shown. A shelf holding a video saved for Later is always shown.");
    expect(dscHiddenNote(4)).toStartWith("4 older shelves are not shown.");
  });
  test("a failed run", () => {
    expect(dscFailedNote({ failed: 1 })).toStartWith("1 call of this search failed");
    expect(dscFailedNote({ failed: 3 })).toStartWith("3 calls of this search failed");
  });
});
