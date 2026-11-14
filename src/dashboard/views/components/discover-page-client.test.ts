/** The Discover page's pure helpers: lengths, counts, ages, and which cards a shelf shows in what order. */
import { describe, expect, test } from "bun:test";
import { dscAge, dscCount, dscDuration, dscVisibleHits } from "./discover-page-client.ts";
import type { DiscoverHit } from "../../../db/youtube-discover.ts";

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
